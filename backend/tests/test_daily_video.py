import asyncio
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import httpx

from flow_api.app import create_app

from flow_api.daily_video import Control, DailyVideo, SaveSettings, Settings
from flow_api.orchestrator import DemoOrchestrator
from flow_api.studio.media import MediaError
from flow_api.studio.store import ProjectStore
from flow_api.studio.workflow import Studio


class DailyVideoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.office = DemoOrchestrator()
        self.addAsyncCleanup(self.office.close)
        self.studio = Studio(ProjectStore(self.root), self.office)
        self.now = datetime(2026, 11, 11, 20, 59, tzinfo=timezone.utc)
        self.scheduler = DailyVideo(self.studio, lambda: self.now)

    def test_defaults_activation_pause_and_seoul_time(self):
        self.assertEqual(self.scheduler.snapshot()["settings"], Settings().model_dump())
        self.assertIsNone(self.scheduler.enqueue())
        with self.assertRaisesRegex(MediaError, "dry run"):
            self.scheduler.configure(Control(action="activate"))
        self.scheduler.configure(Control(action="dry-run"))
        self.assertEqual(self.scheduler.snapshot()["used_today"], 0)
        self.scheduler.configure(Control(action="activate"))
        self.assertIsNone(self.scheduler.enqueue())
        self.now += timedelta(minutes=1)
        self.scheduler.configure(Control(action="pause"))
        self.assertIsNone(self.scheduler.enqueue())
        self.scheduler.configure(Control(action="resume"))
        self.assertIsNotNone(self.scheduler.enqueue())
        self.assertIsNone(self.scheduler.enqueue())
        restarted = DailyVideo(self.studio, lambda: self.now)
        self.assertEqual(restarted.snapshot()["used_today"], 1)
        self.assertTrue(restarted.snapshot()["activated"])
        restarted.configure(SaveSettings(action="save", settings=Settings(daily_limit=2)))
        self.assertFalse(restarted.snapshot()["activated"])
        self.assertFalse(restarted.snapshot()["dry_run_complete"])

    def test_shared_quota_and_round_robin_across_days(self):
        self.scheduler.configure(SaveSettings(action="save", settings=Settings(daily_limit=3)))
        ids = [self.scheduler.enqueue(str(number) * 32) for number in (1, 2, 3)]
        self.assertEqual(self.scheduler.enqueue("1" * 32), ids[0])
        with self.assertRaisesRegex(MediaError, "quota"):
            self.scheduler.enqueue("4" * 32)
        self.now += timedelta(days=1)
        self.assertIsNotNone(self.scheduler.enqueue("4" * 32))
        self.assertIsNotNone(self.scheduler.enqueue("5" * 32))
        self.assertEqual([job["profile"] for job in reversed(self.scheduler.snapshot()["jobs"])],
                         ["mock-chrome-1", "mock-chrome-2", "mock-chrome-3", "mock-chrome-4", "mock-chrome-1"])

    def test_dst_fall_back_uses_one_daily_quota(self):
        self.now = datetime(2026, 10, 31, 13, 0, tzinfo=timezone.utc)
        self.scheduler.configure(SaveSettings(action="save", settings=Settings(
            timezone="America/New_York", start_time="01:30",
        )))
        self.now = datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc)
        self.scheduler.configure(Control(action="dry-run"))
        self.scheduler.configure(Control(action="activate"))
        self.assertIsNotNone(self.scheduler.enqueue())
        self.now += timedelta(hours=1)
        self.assertIsNone(self.scheduler.enqueue())
        self.assertEqual(self.scheduler.snapshot()["used_today"], 1)

    async def test_manual_job_exports_mock_video_and_keeps_final_approval_pending(self):
        if not self.studio.ffmpeg.executable:
            self.skipTest("FFmpeg is required for the daily mock export test")
        job_id = self.scheduler.enqueue("a" * 32)
        # A queued job survives rebuilding the scheduler.
        restarted = DailyVideo(self.studio, lambda: self.now)
        restarted.step()
        await asyncio.wait_for(self.studio.worker, 35)
        restarted.step()
        project = self.studio.store.get(job_id)
        self.assertEqual(project["status"], "awaiting_approval", project["error"])
        self.assertEqual(project["approval"], "pending")
        self.assertFalse(project["scriptApproved"])
        self.assertEqual(project["dailyProfile"], "mock-chrome-1")
        self.assertIsNotNone(self.studio.store.asset(project, project["finalAssetId"]))
        self.assertEqual(restarted.snapshot()["jobs"][0]["state"], "completed")
        self.assertEqual(restarted.enqueue("a" * 32), job_id)

    def test_interrupted_project_is_terminal_and_never_recreated(self):
        job_id = self.scheduler.enqueue("a" * 32)
        project = self.studio.create({"topic": "Interrupted"}, project_id=job_id, daily_profile="mock-chrome-1")
        project["status"] = "working"
        self.studio.save(project)
        restarted = DailyVideo(Studio(self.studio.store, self.office), lambda: self.now)
        restarted.step()
        self.assertEqual(restarted.snapshot()["jobs"][0]["state"], "failed")
        self.assertEqual(self.studio.store.get(job_id)["status"], "failed")
        self.assertEqual(restarted.enqueue("a" * 32), job_id)

    def test_unstarted_slot_expires_before_using_next_days_quota(self):
        expired = self.scheduler.enqueue("a" * 32)
        self.now += timedelta(days=1)
        self.scheduler.step()
        self.assertEqual(self.scheduler.snapshot()["jobs"][0]["state"], "expired")
        self.assertIsNone(self.studio.store.get(expired))
        self.assertEqual(self.scheduler.snapshot()["used_today"], 0)

    def test_timezone_round_trip_preserves_quota_until_boundary(self):
        self.now = datetime(2026, 11, 11, 23, tzinfo=timezone.utc)
        seoul = Settings(daily_limit=3)
        utc = Settings(daily_limit=3, timezone="UTC")
        self.scheduler.configure(SaveSettings(action="save", settings=seoul))
        for i in range(3):
            self.scheduler.enqueue(f"{i:032x}")
        self.now = datetime(2026, 11, 12, 12, tzinfo=timezone.utc)
        self.scheduler.configure(SaveSettings(action="save", settings=utc))
        state = self.scheduler.snapshot()
        self.assertEqual(state["settings"]["timezone"], "Asia/Seoul")
        self.assertEqual(state["pending_timezone"], {"timezone": "UTC", "effective_at": "2026-11-12T15:00:00+00:00"})
        with self.assertRaisesRegex(MediaError, "quota"):
            self.scheduler.enqueue("f" * 32)
        self.scheduler.configure(SaveSettings(action="save", settings=seoul))
        self.assertIsNone(self.scheduler.snapshot()["pending_timezone"])
        with self.assertRaisesRegex(MediaError, "quota"):
            self.scheduler.enqueue("f" * 32)

        # Admissions in the overlapping part of the new local day still count.
        self.now += timedelta(hours=3)
        self.scheduler.enqueue("a" * 32)
        self.scheduler.configure(SaveSettings(action="save", settings=utc))
        self.now += timedelta(hours=20)
        self.scheduler.enqueue("b" * 32)
        self.now += timedelta(hours=4)
        state = DailyVideo(self.studio, lambda: self.now).snapshot()
        self.assertEqual(state["settings"]["timezone"], "UTC")
        self.assertIsNone(state["pending_timezone"])
        self.assertFalse(state["activated"])
        self.assertEqual(state["used_today"], 1)

    async def test_direct_mutations_require_verified_local_authority(self):
        root = self.enterContext(tempfile.TemporaryDirectory())
        with patch.dict("os.environ", {"FLOW_OFFICE_PROVIDER": "mock", "FLOW_STUDIO_IMAGE_PROVIDER": "mock"}):
            app = create_app(media_root=root)
            async with app.router.lifespan_context(app):
                cases = [
                    ("192.0.2.10", "127.0.0.1:8001", None, {}, 403),
                    ("::ffff:192.0.2.10", "[::1]:8001", None, {}, 403),
                    ("127.0.0.1", "untrusted.example:8001", "http://untrusted.example:8001", {}, 403),
                    ("127.0.0.1", "localhost:8001@untrusted.example", None, {}, 403),
                    ("127.0.0.1", "localhost:8001", "https://untrusted.example", {}, 403),
                    ("127.0.0.1", "localhost:8001", "http://127.0.0.1:8001", {}, 403),
                    ("127.0.0.1", "localhost:8001", None, {"x-forwarded-for": "127.0.0.1"}, 403),
                    ("127.0.0.1", "localhost:8001", "http://localhost:8001", {}, 200),
                    ("::1", "[::1]:8001", "http://[::1]:8001", {}, 200),
                    ("::ffff:127.0.0.1", "127.0.0.1:8001", None, {}, 200),
                ]
                for peer, host, origin, extra, status in cases:
                    with self.subTest(peer=peer, host=host, origin=origin):
                        async with httpx.AsyncClient(base_url="http://localhost", transport=httpx.ASGITransport(
                            app=app, client=(peer, 1234),
                        )) as client:
                            headers = {"Host": host, **extra}
                            if origin:
                                headers["Origin"] = origin
                            response = await client.post("/api/daily-video", json={"action": "dry-run"}, headers=headers)
                        self.assertEqual(response.status_code, status)
                self.assertTrue(app.state.daily_video.snapshot()["dry_run_complete"])
