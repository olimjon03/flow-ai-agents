import asyncio
import json
import tempfile
import unittest
from unittest.mock import patch

import httpx

from flow_api.agents import AgentError, AgentTask, Budget, OpenAIProvider, STEPS, budget_limit
from flow_api.app import create_app


TASK = {"topic": "Urban gardens", "language": "English", "style": "Conversational", "durationSeconds": 60}


def completed(text):
    return httpx.Response(200, json={
        "status": "completed", "usage": {"input_tokens": 100, "output_tokens": 50},
        "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}],
    })


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_retry_limit_and_budget_reserve_every_attempt(self):
        calls = []
        def transport(request):
            calls.append(request)
            return httpx.Response(429, text="private upstream details")

        async with httpx.AsyncClient(base_url="https://example.test", transport=httpx.MockTransport(transport)) as client:
            provider = OpenAIProvider(client, retries=1)
            task = AgentTask(**TASK)
            updates = []
            budget = Budget(budget_limit("0.05"))
            with self.assertRaisesRegex(AgentError, "HTTP 429"):
                await provider.generate(STEPS[0], task, {}, budget, updates.append)
            self.assertEqual(len(calls), 2)
            self.assertEqual(len(updates), 1)
            self.assertNotIn("private", updates[0])
            self.assertEqual(budget.agents["scout"].requests, 2)
            self.assertGreater(budget.agents["scout"].cost, 0)

            with self.assertRaisesRegex(AgentError, "cost limit"):
                await provider.generate(STEPS[0], task, {}, Budget(budget_limit("0.001")), updates.append)
            self.assertEqual(len(calls), 2)

    async def test_timeout_stops_request_and_keeps_reservation(self):
        async def transport(request):
            await asyncio.sleep(2)

        async with httpx.AsyncClient(base_url="https://example.test", transport=httpx.MockTransport(transport)) as client:
            budget = Budget(budget_limit("0.05"))
            provider = OpenAIProvider(client, timeout=0.02, retries=0)
            with self.assertRaisesRegex(AgentError, "timed out"):
                await provider.generate(STEPS[0], AgentTask(**TASK), {}, budget, lambda _: None)
            self.assertEqual(budget.agents["scout"].requests, 1)
            self.assertGreater(budget.agents["scout"].cost, 0)


class AgentApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.media = tempfile.TemporaryDirectory()
        self.addCleanup(self.media.cleanup)

    async def test_default_mock_validates_and_returns_script_and_review(self):
        with patch.dict("os.environ", {"FLOW_OFFICE_PROVIDER": "mock", "OPENAI_API_KEY": "unused"}):
            app = create_app(tick_seconds=0.01, media_root=self.media.name)
            async with app.router.lifespan_context(app), httpx.AsyncClient(
                base_url="http://test", transport=httpx.ASGITransport(app=app)
            ) as client:
                for invalid in ({"durationSeconds": 14}, {"topic": "   "}, {"allowPaid": "true"}):
                    response = await client.post("/api/office/tasks", json={**TASK, **invalid})
                    self.assertEqual(response.status_code, 422)
                response = await client.post("/api/office/tasks", json=TASK)
                self.assertEqual(response.status_code, 202)
                await asyncio.wait_for(app.state.office.worker, 1)
                snapshot = app.state.office.snapshot()
                self.assertTrue(snapshot["simulation"])
                self.assertEqual(snapshot["run"]["status"], "completed")
                self.assertIn("Urban gardens", snapshot["run"]["script"])
                self.assertIn("Mock review", snapshot["run"]["review"])
                self.assertTrue(all(agent["usage"]["requests"] == 0 for agent in snapshot["agents"]))

    async def test_paid_mode_requires_consent_and_passes_results_between_agents(self):
        requests = []
        outputs = ["Research brief", "Final script", "Review result"]
        def transport(request):
            requests.append(json.loads(request.content))
            return completed(outputs[len(requests) - 1])

        async with httpx.AsyncClient(base_url="https://example.test", transport=httpx.MockTransport(transport)) as upstream:
            app = create_app(provider=OpenAIProvider(upstream), media_root=self.media.name)
            async with app.router.lifespan_context(app), httpx.AsyncClient(
                base_url="http://test", transport=httpx.ASGITransport(app=app)
            ) as client:
                self.assertEqual((await client.post("/api/office/tasks", json=TASK)).status_code, 409)
                self.assertEqual(requests, [])
                response = await client.post("/api/office/tasks", json={**TASK, "allowPaid": True})
                self.assertEqual(response.status_code, 202)
                await asyncio.wait_for(app.state.office.worker, 1)

            self.assertEqual(len(requests), 3)
            self.assertIn("Research brief", requests[1]["input"])
            self.assertIn("Final script", requests[2]["input"])
            self.assertTrue(all(request["store"] is False for request in requests))
            snapshot = app.state.office.snapshot()
            self.assertFalse(snapshot["simulation"])
            self.assertEqual(snapshot["run"]["script"], "Final script")
            self.assertEqual(snapshot["run"]["review"], "Review result")
            self.assertEqual(sum(agent["usage"]["requests"] for agent in snapshot["agents"]), 3)

    async def test_cancel_interrupts_provider_and_prevents_next_stage(self):
        started = asyncio.Event()
        requests = []
        async def transport(request):
            requests.append(request)
            started.set()
            await asyncio.sleep(5)

        async with httpx.AsyncClient(base_url="https://example.test", transport=httpx.MockTransport(transport)) as upstream:
            app = create_app(provider=OpenAIProvider(upstream), media_root=self.media.name)
            async with app.router.lifespan_context(app), httpx.AsyncClient(
                base_url="http://test", transport=httpx.ASGITransport(app=app)
            ) as client:
                response = await client.post("/api/office/tasks", json={**TASK, "allowPaid": True})
                run_id = response.json()["runId"]
                await asyncio.wait_for(started.wait(), 1)
                worker = app.state.office.worker
                self.assertEqual((await client.delete(f"/api/office/tasks/{run_id}")).status_code, 204)
                with self.assertRaises(asyncio.CancelledError):
                    await worker
                self.assertEqual(app.state.office.snapshot()["run"]["status"], "cancelled")
                self.assertEqual(len(requests), 1)
