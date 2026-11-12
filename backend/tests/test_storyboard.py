import asyncio
import json
import tempfile
import unittest

import httpx

from flow_api.agents import budget_limit
from flow_api.app import create_app
from flow_api.deploy_provider import DEFAULT_BASE_URL, DeployProvider


def storyboard():
    return {"scenes": [
        {"order": order, "duration": 6, "visualPrompt": f"Shot {order}", "voiceover": f"Line {order}"}
        for order in range(1, 6)
    ]}


class StoryboardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.output = storyboard()
        media = tempfile.TemporaryDirectory()
        self.addCleanup(media.cleanup)
        upstream = await self.enterAsyncContext(httpx.AsyncClient(
            base_url=DEFAULT_BASE_URL, transport=httpx.MockTransport(self.complete),
        ))
        app = create_app(provider=DeployProvider(upstream), media_root=media.name)
        await self.enterAsyncContext(app.router.lifespan_context(app))
        self.studio = app.state.studio
        self.client = await self.enterAsyncContext(httpx.AsyncClient(
            base_url="http://test", transport=httpx.ASGITransport(app=app),
        ))
        self.local_stages = []

        async def local(project):
            self.local_stages.append(project["scenes"])

        self.studio.images = self.studio.narration = self.studio.clips = self.studio.export = local
        created = await self.client.post("/api/studio/projects", json={"topic": "City gardens"})
        self.assertEqual(created.status_code, 201)
        self.path = f"/api/studio/projects/{created.json()['id']}"

    def complete(self, request):
        self.requests.append(json.loads(request.content))
        return httpx.Response(200, json={
            "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(self.output)}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 80},
        })

    async def action(self, action, **extra):
        return await self.client.post(f"{self.path}/actions", json={"action": action, **extra})

    async def plan(self):
        self.assertEqual((await self.action("start")).status_code, 200)
        await asyncio.wait_for(self.studio.worker, 3)
        result = (await self.client.get(self.path)).json()
        self.assertEqual(result["status"], "awaiting_script_approval")
        self.assertEqual([scene["duration"] for scene in result["scenes"]], [6] * 5)
        self.assertTrue(all(scene["narration"] and scene["prompt"] for scene in result["scenes"]))
        self.assertEqual(self.requests, [])
        return result

    async def test_paid_storyboard_uses_approved_script_and_existing_budget(self):
        self.assertEqual((await self.action("approve-script", allowPaid=True)).status_code, 409)
        self.assertEqual((await self.action("start", allowPaid=True)).status_code, 422)
        draft = await self.plan()
        self.assertTrue(draft["deployStoryboardAvailable"])
        self.assertEqual((await self.action("approve-script", allowPaid=True)).status_code, 200)
        await asyncio.wait_for(self.studio.worker, 3)
        result = (await self.client.get(self.path)).json()
        self.assertTrue(result["scriptApproved"])
        self.assertEqual(result["script"], draft["script"])
        self.assertEqual(result["status"], "awaiting_approval")
        self.assertEqual(len(self.requests), 1)
        self.assertIn("Approved script:\n" + draft["script"], self.requests[0]["messages"][0]["content"])
        self.assertEqual([(s["index"], s["start"], s["duration"]) for s in result["scenes"]],
                         [(i, i * 6, 6) for i in range(5)])
        self.assertEqual([s["prompt"] for s in result["scenes"]], [f"Shot {i}" for i in range(1, 6)])
        self.assertEqual([s["narration"] for s in result["scenes"]], [f"Line {i}" for i in range(1, 6)])
        self.assertEqual(self.local_stages, [result["scenes"]] * 4)
        self.assertEqual(self.studio.office.budget.agents["muse"].requests, 1)
        self.assertFalse(self.studio.office.snapshot()["simulation"])

    async def test_mock_storyboard_ignores_timestamp_like_text_in_script_header(self):
        created = await self.client.post("/api/studio/projects", json={
            "topic": "City gardens", "language": "English", "style": "Conversational\n6s — Style example",
        })
        self.assertEqual(created.status_code, 201)
        self.path = f"/api/studio/projects/{created.json()['id']}"
        result = await self.plan()
        self.assertEqual(result["script"], (
            "Mock script\nCity gardens · English · Conversational\n6s — Style example · 30s\n"
            "0s — Introduce City gardens.\n6s — Set the scene.\n12s — Explain one key idea.\n"
            "18s — Show the idea in action.\n24s — Close with a recap."
        ))
        self.assertEqual(result["scenes"][1]["narration"], "Set the scene.")

    async def test_invalid_storyboard_preserves_preview_and_allows_mock_retry(self):
        draft = await self.plan()
        self.output["scenes"][0]["order"] = 2
        self.assertEqual((await self.action("approve-script", allowPaid=True)).status_code, 200)
        await asyncio.wait_for(self.studio.worker, 3)
        failed = (await self.client.get(self.path)).json()
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["scenes"], draft["scenes"])
        self.assertFalse(failed["scriptApproved"])
        self.assertEqual(self.local_stages, [])
        self.assertEqual((await self.action("approve-script")).status_code, 200)
        await asyncio.wait_for(self.studio.worker, 3)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.local_stages, [draft["scenes"]] * 4)

    async def test_budget_denies_request_before_transport(self):
        await self.plan()
        self.studio.office.max_cost = budget_limit("0.001")
        self.assertEqual((await self.action("approve-script", allowPaid=True)).status_code, 200)
        await asyncio.wait_for(self.studio.worker, 3)
        result = (await self.client.get(self.path)).json()
        self.assertIn("cost limit", result["error"])
        self.assertEqual(self.requests, [])
        self.assertEqual(self.local_stages, [])
