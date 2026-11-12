import asyncio
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import httpx

from flow_api.app import create_app
from flow_api.orchestrator import DemoOrchestrator
from flow_api.studio.media import FFmpeg, MediaError
from flow_api.studio.store import ProjectStore
from flow_api.studio.workflow import Studio


BRIEF = {
    "topic": "City gardens", "language": "Uzbek", "style": "Conversational",
    "durationSeconds": 30, "aspect": "9:16", "gender": "male",
    "resolution": "test", "backgroundAudio": True,
}


class StudioTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.office = DemoOrchestrator()
        self.addAsyncCleanup(self.office.close)
        self.studio = Studio(ProjectStore(self.root), self.office)

    async def plan(self):
        project = self.studio.create(BRIEF)
        self.studio.action(project, "start", None, None)
        await self.studio.worker
        self.assertEqual(project["status"], "awaiting_script_approval")
        self.assertEqual(sum(scene["duration"] for scene in project["scenes"]), 30)
        self.assertFalse(project["assets"])
        return project

    async def test_parallel_dependencies_and_office_snapshots(self):
        project = await self.plan()
        image_started = asyncio.Event()
        voice_started = asyncio.Event()
        video_done = asyncio.Event()
        voice_done = asyncio.Event()

        async def image(_):
            image_started.set()
            await asyncio.wait_for(voice_started.wait(), 2)

        async def voice(_):
            voice_started.set()
            await asyncio.wait_for(video_done.wait(), 2)
            voice_done.set()

        async def video(current):
            self.assertEqual(current["stages"]["image"]["status"], "completed")
            self.assertFalse(voice_done.is_set())
            video_done.set()

        async def editor(_):
            self.assertTrue(video_done.is_set() and voice_done.is_set())

        self.studio.images, self.studio.narration = image, voice
        self.studio.clips, self.studio.export = video, editor
        async with self.office.subscribe() as events:
            await events.get()
            self.studio.action(project, "approve-script", None, None)
            queued = await events.get()
            self.assertEqual(next(a for a in queued["agents"] if a["id"] == "pixel")["status"], "queued")
            await asyncio.wait_for(self.studio.worker, 3)
            final = await events.get()
            self.assertEqual(next(a for a in final["agents"] if a["id"] == "relay")["progress"], 100)
        self.assertEqual(project["status"], "awaiting_approval")

    async def test_failure_and_cancellation(self):
        project = await self.plan()

        async def missing(_):
            raise MediaError("Required image media is missing.")

        self.studio.images = missing
        self.studio.action(project, "approve-script", None, None)
        await self.studio.worker
        self.assertEqual(project["status"], "failed")
        self.assertEqual(project["stages"]["image"]["status"], "failed")
        self.assertEqual(project["stages"]["video"]["status"], "cancelled")

        started = asyncio.Event()

        async def slow(_):
            started.set()
            await asyncio.sleep(20)

        self.studio.images = slow
        self.studio.action(project, "regenerate", "image", None)
        await asyncio.wait_for(started.wait(), 2)
        self.assertTrue(self.studio.cancel(project["id"]))
        with self.assertRaises(asyncio.CancelledError):
            await self.studio.worker
        self.assertEqual(ProjectStore(self.root).get(project["id"])["status"], "cancelled")
        self.assertEqual(next(a for a in self.office.snapshot()["agents"] if a["id"] == "pixel")["status"], "cancelled")

    async def test_ffmpeg_export_approval_regeneration_and_persistence(self):
        if not self.studio.ffmpeg.executable:
            self.skipTest("FFmpeg is required for the real export test")
        project = await self.plan()
        project["brief"]["resolution"] = "full"
        self.studio.action(project, "approve-script", None, None)
        await asyncio.wait_for(self.studio.worker, 35)
        self.assertEqual(project["status"], "awaiting_approval", project["error"])
        old_id = project["finalAssetId"]
        final, metadata = self.studio.store.asset(project, project["finalAssetId"])
        self.assertEqual((metadata["width"], metadata["height"], metadata["duration"]), (1080, 1920, 30))
        probe = subprocess.run([self.studio.ffmpeg.executable, "-hide_banner", "-i", str(final)],
                               capture_output=True, text=True, timeout=10).stderr
        for marker in ("Video: h264", "1080x1920", "Audio: aac", "Subtitle: mov_text", "Duration: 00:00:30"):
            self.assertIn(marker, probe)

        self.studio.action(project, "reject", None, "Revise the export.", reviewed_asset_id=project["finalAssetId"])
        self.assertEqual(ProjectStore(self.root).get(project["id"])["feedback"], "Revise the export.")
        original_images = {asset["id"] for asset in project["assets"] if asset["stage"] == "image"}
        self.studio.action(project, "regenerate", "editor", None)
        self.assertTrue(final.exists())
        await asyncio.wait_for(self.studio.worker, 20)
        self.assertEqual(project["status"], "awaiting_approval", project["error"])
        self.assertFalse(final.exists())
        self.assertEqual({asset["id"] for asset in project["assets"] if asset["stage"] == "image"}, original_images)
        with self.assertRaisesRegex(MediaError, "export changed"):
            self.studio.action(project, "approve", None, None, reviewed_asset_id=old_id)
        self.assertIsNone(ProjectStore(self.root).get(project["id"])["approvedAssetId"])
        self.studio.action(project, "approve", None, None, reviewed_asset_id=project["finalAssetId"])
        restarted = create_app(media_root=self.root)
        async with restarted.router.lifespan_context(restarted), httpx.AsyncClient(
            base_url="http://test", transport=httpx.ASGITransport(app=restarted)
        ) as client:
            response = await client.get(f"/api/studio/projects/{project['id']}")
            self.assertEqual(response.json()["approval"], "approved")
            self.assertEqual(response.json()["approvedAssetId"], project["finalAssetId"])
            stale = await client.post(f"/api/studio/projects/{project['id']}/actions",
                                      json={"action": "approve", "reviewedAssetId": old_id})
            self.assertEqual(stale.status_code, 409)
            missing = await client.post(f"/api/studio/projects/{project['id']}/actions", json={"action": "approve"})
            self.assertEqual(missing.status_code, 422)
            download = await client.get(f"/api/studio/projects/{project['id']}/assets/{project['finalAssetId']}",
                                        headers={"Range": "bytes=0-63"})
            self.assertEqual(download.status_code, 206)
            self.assertIn(b"ftyp", download.content)

    async def test_asset_and_input_validation(self):
        app = create_app(media_root=self.root)
        async with app.router.lifespan_context(app), httpx.AsyncClient(
            base_url="http://test", transport=httpx.ASGITransport(app=app)
        ) as client:
            self.assertEqual((await client.post("/api/studio/projects", json={"topic": " "})).status_code, 422)
            self.assertEqual((await client.post("/api/studio/projects", json={"topic": "a" * 5000})).status_code, 413)
            response = await client.post("/api/studio/projects", json=BRIEF)
            self.assertEqual(response.status_code, 201)
            project = response.json()
            base = f"/api/studio/projects/{project['id']}"
            self.assertEqual((await client.get(base + "/assets/" + "1" * 32)).status_code, 404)
            self.assertEqual((await client.get(base + "/assets/projects.sqlite3")).status_code, 404)
            with self.assertRaises(ValueError):
                self.studio.store.path(project["id"], "../secret", ".mp4")

    async def test_missing_ffmpeg_is_actionable(self):
        encoder = FFmpeg()
        encoder.executable = None
        with self.assertRaisesRegex(MediaError, "FFmpeg is missing"):
            await encoder.run("-version")

    async def test_ffmpeg_timeout_and_cancellation_reap_process(self):
        pid_file = self.root / "process.pid"
        command = self.root / "slow-encoder"
        command.write_text(
            "#!/bin/sh\n"
            f"printf '%s' \"$$\" > '{pid_file}'\nexec /bin/sleep 30\n"
        )
        command.chmod(0o700)

        async def wait_for_pid():
            async with asyncio.timeout(2):
                while not pid_file.exists() or not pid_file.stat().st_size:
                    await asyncio.sleep(0.01)
            return int(pid_file.read_text())

        process = asyncio.create_task(FFmpeg(str(command), timeout=1.0).run("-version"))
        pid = await wait_for_pid()
        with self.assertRaisesRegex(MediaError, "timed out"):
            await process
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

        pid_file.unlink()
        process = asyncio.create_task(FFmpeg(str(command)).run("-version"))
        pid = await wait_for_pid()
        process.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await process
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
