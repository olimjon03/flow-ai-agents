import asyncio
import unittest

from flow_api.orchestrator import AGENTS, DemoOrchestrator


class DemoOrchestratorTest(unittest.IsolatedAsyncioTestCase):
    async def test_streams_queued_progress_and_completion_in_workflow_order(self):
        office = DemoOrchestrator(tick_seconds=0.01)
        self.addAsyncCleanup(office.close)

        async with office.subscribe() as stream:
            initial = await stream.get()
            self.assertTrue(initial["simulation"])
            self.assertIsNone(initial["run"])
            self.assertEqual(len(initial["agents"]), 12)
            self.assertTrue(all(agent["status"] == "idle" for agent in initial["agents"]))

            run_id = office.start()
            self.assertIsNotNone(run_id)
            self.assertIsNone(office.start())
            queued = await stream.get()
            self.assertEqual(queued["run"], {"id": run_id, "status": "running"})
            self.assertTrue(all(agent["status"] == "queued" and agent["task"] for agent in queued["agents"]))

            states = []
            async with asyncio.timeout(2):
                while True:
                    snapshot = await stream.get()
                    agents = {agent["id"]: agent for agent in snapshot["agents"]}
                    states.append((agents["scout"]["status"], agents["scout"]["progress"]))
                    if agents["quill"]["status"] in ("working", "completed"):
                        self.assertEqual(agents["scout"]["status"], "completed")
                    if snapshot["run"]["status"] == "completed":
                        break

            self.assertIn(("working", 25), states)
            self.assertTrue(all(agent["status"] == "completed" and agent["progress"] == 100
                                for agent in snapshot["agents"]))
            self.assertTrue(all(agent["usage"]["estimatedCostUsd"] == 0 for agent in snapshot["agents"]))
            self.assertIn("Completed: Scan content trends", [event["message"] for event in snapshot["activity"]])
            self.assertNotEqual(office.start(), run_id)

        self.assertFalse(office.subscribers)

    async def test_slow_subscriber_and_reconnect_receive_latest_snapshot(self):
        office = DemoOrchestrator(tick_seconds=0.001)
        self.addAsyncCleanup(office.close)

        async with office.subscribe() as slow:
            office.start()
            await asyncio.wait_for(office.worker, 2)
            self.assertEqual(slow.qsize(), 1)
            final = await slow.get()

        async with office.subscribe() as reconnected:
            self.assertEqual(await reconnected.get(), final)
            self.assertEqual([agent["id"] for agent in final["agents"]], [agent.id for agent in AGENTS])

    async def test_shutdown_cancels_active_worker(self):
        office = DemoOrchestrator()
        office.start()
        worker = office.worker
        await office.close()
        self.assertTrue(worker.cancelled())
