import asyncio
import json
import tempfile
import unittest
from unittest.mock import patch

import httpx

from flow_api.agents import AgentError, AgentTask, Budget, STEPS, budget_limit
from flow_api.app import create_app
from flow_api.deploy_provider import DEFAULT_BASE_URL, MODEL, DeployProvider, validate_base_url, validate_model

TASK = {"topic": "Urban gardens", "language": "English", "style": "Clear", "durationSeconds": 60}


def completion(text):
    return httpx.Response(200, json={
        "choices": [{"finish_reason": "stop", "message": {"content": text, "reasoning_content": "internal"}}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 50},
    })


class DeployProviderTests(unittest.IsolatedAsyncioTestCase):
    def test_only_documented_endpoint_and_priced_model_are_accepted(self):
        self.assertEqual(validate_base_url(DEFAULT_BASE_URL + "/"), DEFAULT_BASE_URL)
        for url in ("https://api.deepseek.com", DEFAULT_BASE_URL + "?x=1", "http://api.deploy.com/api/v1",
                    "https://api.deploy.com.evil.example/api/v1"):
            with self.assertRaises(ValueError):
                validate_base_url(url)
        with self.assertRaises(ValueError):
            validate_model("deepseek-flash")

    async def test_full_workflow_with_secret_key_and_explicit_consent(self):
        requests = []
        outputs = iter(("Research brief", "Final script", "Review result"))

        def upstream(request):
            self.assertEqual(str(request.url), DEFAULT_BASE_URL + "/chat/completions")
            self.assertEqual(request.headers["Authorization"], "Bearer test-secret")
            requests.append(json.loads(request.content))
            return completion(next(outputs))

        original_client = httpx.AsyncClient

        def mocked_client(**kwargs):
            self.assertFalse(kwargs["follow_redirects"])
            self.assertFalse(kwargs["trust_env"])
            return original_client(**kwargs, transport=httpx.MockTransport(upstream))

        with tempfile.TemporaryDirectory() as media, patch.dict("os.environ", {
            "FLOW_OFFICE_PROVIDER": "deploy", "DEPLOY_API_KEY": "test-secret",
        }, clear=True):
            app = create_app(media_root=media)
            async with original_client(base_url="http://test", transport=httpx.ASGITransport(app=app)) as client:
                with patch("flow_api.app.httpx.AsyncClient", side_effect=mocked_client):
                    async with app.router.lifespan_context(app):
                        office = app.state.office
                        self.assertEqual(office.max_cost, budget_limit("0.01"))
                        for consent in ({}, {"allowPaid": True}, {"provider": "deploy"},
                                        {"allowPaid": True, "provider": "openai"}):
                            response = await client.post("/api/office/tasks", json={**TASK, **consent})
                            self.assertEqual(response.status_code, 409)
                        self.assertEqual(requests, [])
                        response = await client.post("/api/office/tasks", json={
                            **TASK, "allowPaid": True, "provider": "deploy",
                        })
                        self.assertEqual(response.status_code, 202)
                        await asyncio.wait_for(office.worker, 1)
                        snapshot = office.snapshot()

        self.assertEqual(len(requests), 3)
        self.assertTrue(all(request["model"] == MODEL and request["max_completion_tokens"] > 0 for request in requests))
        self.assertIn("imply that you browsed", requests[0]["messages"][0]["content"])
        self.assertIn("Research brief", requests[1]["messages"][0]["content"])
        self.assertIn("Final script", requests[2]["messages"][0]["content"])
        self.assertNotIn("internal", json.dumps(requests))
        self.assertNotIn("test-secret", json.dumps(snapshot))
        self.assertFalse(snapshot["simulation"])
        self.assertEqual(snapshot["providerMode"], "deploy")
        self.assertEqual(snapshot["run"]["status"], "completed")
        self.assertEqual(snapshot["run"]["script"], "Final script")
        self.assertEqual(snapshot["run"]["review"], "Review result")
        self.assertEqual(len(snapshot["handoffs"]), 2)
        self.assertEqual(sum(agent["usage"]["inputTokens"] for agent in snapshot["agents"]), 300)
        self.assertEqual(sum(agent["usage"]["outputTokens"] for agent in snapshot["agents"]), 150)
        self.assertAlmostEqual(sum(agent["usage"]["estimatedCostUsd"] for agent in snapshot["agents"]), 0.000108)

    async def test_retries_respect_budget_and_redact_provider_body(self):
        attempts = []
        updates = []

        def upstream(request):
            attempts.append(request)
            return httpx.Response(429, text="private upstream detail")

        async with httpx.AsyncClient(base_url=DEFAULT_BASE_URL, transport=httpx.MockTransport(upstream)) as client:
            provider = DeployProvider(client)
            budget = Budget(budget_limit("0.001"))
            with self.assertRaisesRegex(AgentError, "cost limit"):
                await provider.generate(STEPS[0], AgentTask(**TASK), {}, budget, updates.append)
            self.assertEqual(len(attempts), 1)
            self.assertEqual(budget.agents["scout"].requests, 1)
            self.assertEqual(len(updates), 1)
            self.assertNotIn("private", updates[0])
            with self.assertRaisesRegex(AgentError, "HTTP 429"):
                await provider.generate(STEPS[0], AgentTask(**TASK), {}, Budget(budget_limit("0.01")), updates.append)
            self.assertEqual(len(attempts), 3)

    async def test_timeout_and_cancellation_keep_the_reservation(self):
        started = asyncio.Event()

        async def upstream(request):
            started.set()
            await asyncio.sleep(5)

        async with httpx.AsyncClient(base_url=DEFAULT_BASE_URL, transport=httpx.MockTransport(upstream)) as client:
            budget = Budget(budget_limit("0.01"))
            with self.assertRaisesRegex(AgentError, "timed out"):
                await DeployProvider(client, timeout=0.01, retries=0).generate(
                    STEPS[0], AgentTask(**TASK), {}, budget, self.fail,
                )
            started.clear()
            task = asyncio.create_task(DeployProvider(client).generate(STEPS[1], AgentTask(**TASK), {}, budget, self.fail))
            await asyncio.wait_for(started.wait(), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            for agent in ("scout", "quill"):
                self.assertEqual(budget.agents[agent].requests, 1)
                self.assertGreater(budget.agents[agent].cost, 0)
