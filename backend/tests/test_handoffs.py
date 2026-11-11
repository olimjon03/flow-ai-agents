import asyncio
import tempfile
import unittest

from flow_api.agents import AgentTask, MockProvider
from flow_api.app import create_app


class HandoffTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_sends_live_handoffs_and_never_replays_them_to_new_subscribers(self):
        with tempfile.TemporaryDirectory() as root:
            app = create_app(tick_seconds=0.01, provider=MockProvider(0.03), media_root=root)
            stream_endpoint = next(route.endpoint for route in app.routes if getattr(route, "path", "") == "/api/office/events")
            request = type("Request", (), {"app": app})()
            async with app.router.lifespan_context(app):
                office = app.state.office
                live = stream_endpoint(request)
                self.assertEqual((await anext(live)).event, "office.snapshot")
                task = AgentTask(topic="Test", language="Uzbek", style="Clear", durationSeconds=30)
                run_id = office.start_agents(task)
                observed = []
                async with asyncio.timeout(2):
                    async for message in live:
                        if message.event == "task.handoff":
                            observed.append(message.data)
                        elif message.data["run"]["status"] == "completed":
                            break
                await live.aclose()
                self.assertEqual([(event["fromAgentId"], event["toAgentId"]) for event in observed],
                                 [("scout", "quill"), ("quill", "guard")])
                self.assertTrue(all(event["runId"] == run_id for event in observed))

                reconnected = stream_endpoint(request)
                self.assertEqual((await anext(reconnected)).event, "office.snapshot")
                with self.assertRaises(TimeoutError):
                    await asyncio.wait_for(anext(reconnected), 0.05)
