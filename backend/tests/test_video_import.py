import asyncio
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from flow_api.app import create_app
from flow_api.studio.media import MediaError
from flow_api.studio.store import ProjectStore


class VideoImportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.app = create_app(media_root=self.root / "studio")
        await self.enterAsyncContext(self.app.router.lifespan_context(self.app))
        self.studio = self.app.state.studio
        self.client = await self.enterAsyncContext(httpx.AsyncClient(
            base_url="http://127.0.0.1:8001", transport=httpx.ASGITransport(app=self.app),
        ))

    async def prepare(self):
        response = await self.client.post("/api/studio/projects", json={"topic": "Moving scene"})
        self.base = "/api/studio/projects/" + response.json()["id"]
        for action in ("start", "approve-script"):
            self.assertEqual((await self.client.post(self.base + "/actions", json={"action": action})).status_code, 200)
            await asyncio.wait_for(self.studio.worker, 35)
        project = await self.project()
        self.assertEqual(project["status"], "awaiting_approval", project["error"])
        self.assertEqual((await self.client.post(self.base + "/actions", json={
            "action": "approve", "reviewedAssetId": project["finalAssetId"],
        })).status_code, 200)
        return await self.project()

    async def project(self):
        return (await self.client.get(self.base)).json()

    def route(self, project):
        return f"{self.base}/scenes/{project['scenes'][0]['id']}/import?expected_export={project['finalAssetId']}"

    async def fixture(self, codec, *, size="160x120", duration="1"):
        path = self.root / f"{codec}.mp4"
        await self.studio.ffmpeg.run("-f", "lavfi", "-i", f"testsrc2=size={size}:rate=24",
                                     "-t", duration, "-c:v", codec, "-threads", "2", path)
        return path.read_bytes()

    async def test_probe_rejects_out_of_bounds_video_duration_and_dimensions(self):
        for options, message in (({"duration": "0.1"}, "between 0.25 and 120 seconds"),
                                 ({"size": "4098x16"}, "exceeds supported dimensions")):
            with self.subTest(options=options):
                await self.fixture("libx264", **options)
                with self.assertRaisesRegex(MediaError, message):
                    await self.studio.manual_video.probe(self.root / "libx264.mp4")

    async def test_validated_import_preserves_old_export_until_new_moving_mp4_is_ready(self):
        self.assertTrue(self.studio.manual_video.ffprobe, "ffprobe is required")
        original = await self.prepare()
        old_id = original["finalAssetId"]
        for content_type, content, headers, status in (
            ("text/plain", b"test", {}, 415),
            ("video/mp4", b"not an MP4", {}, 409),
            ("video/mp4", b"x", {"Content-Length": str(33 * 1024 * 1024)}, 413),
            ("video/mp4", b"x", {"Origin": "https://untrusted.example"}, 403),
        ):
            response = await self.client.post(self.route(original), content=content,
                                              headers={"Content-Type": content_type, **headers})
            self.assertEqual(response.status_code, status, response.text)
        unsupported = await self.client.post(self.route(original), content=await self.fixture("mpeg4"),
                                             headers={"Content-Type": "video/mp4"})
        self.assertEqual(unsupported.status_code, 202)
        await asyncio.wait_for(self.studio.worker, 35)
        failed = await self.project()
        self.assertEqual(failed["status"], "failed")
        self.assertIn("H.264 or HEVC", failed["error"])
        self.assertEqual(failed["approvedAssetId"], old_id)
        self.assertEqual(failed["assets"], original["assets"])
        self.assertEqual((await self.client.get(f"{self.base}/assets/{old_id}")).status_code, 200)
        self.assertFalse(list(self.studio.store.directory(original["id"]).glob(".upload-*")))
        self.assertFalse(list(self.studio.store.directory(original["id"]).glob(".replacement-*")))

        accepted = await self.client.post(self.route(original), content=await self.fixture("libx264"),
                                          headers={"Content-Type": "video/mp4"})
        self.assertEqual(accepted.status_code, 202, accepted.text)
        self.assertEqual(accepted.json()["finalAssetId"], old_id)
        self.assertEqual(accepted.json()["approvedAssetId"], old_id)
        await asyncio.wait_for(self.studio.worker, 35)
        project = await self.project()
        self.assertEqual(project["status"], "awaiting_approval", project["error"])
        self.assertNotEqual(project["finalAssetId"], old_id)
        self.assertIsNone(project["approvedAssetId"])
        manual = [asset for asset in project["assets"] if asset.get("provider") == "manual"]
        self.assertEqual(len(manual), 1)
        self.assertEqual(manual[0]["sceneId"], original["scenes"][0]["id"])
        final, _ = self.studio.store.asset(project, project["finalAssetId"])
        probe = subprocess.run([self.studio.ffmpeg.executable, "-hide_banner", "-i", str(final)],
                               capture_output=True, text=True, timeout=10).stderr
        for marker in ("360x640", "Video: h264", "Audio: aac", "Subtitle: mov_text", "Duration: 00:00:30"):
            self.assertIn(marker, probe)
        hashes = [subprocess.check_output([self.studio.ffmpeg.executable, "-v", "error", "-ss", at,
                                         "-i", str(final), "-map", "0:v:0", "-frames:v", "1", "-f", "md5", "-"],
                                        timeout=10) for at in ("0.1", "0.7")]
        self.assertNotEqual(*hashes)
        stale = await self.client.post(self.base + "/actions", json={"action": "approve", "reviewedAssetId": old_id})
        self.assertEqual(stale.status_code, 409)
        approved = await self.client.post(self.base + "/actions", json={
            "action": "approve", "reviewedAssetId": project["finalAssetId"],
        })
        self.assertEqual(approved.json()["approvedAssetId"], project["finalAssetId"])

    async def test_hevc_import_corrupt_mp4_and_upload_admission(self):
        project = await self.prepare()
        hevc = await self.fixture("libx265")
        uploading = asyncio.Event()
        release = asyncio.Event()

        async def body():
            yield hevc[:32]
            uploading.set()
            await release.wait()
            yield hevc[32:]

        headers = {"Content-Type": "video/mp4"}
        first = asyncio.create_task(self.client.post(self.route(project), content=body(), headers=headers))
        try:
            await asyncio.wait_for(uploading.wait(), 5)
            other = await self.client.post(self.route(project), content=hevc, headers=headers)
            self.assertEqual(other.status_code, 429)
            directory = self.studio.store.directory(project["id"])
            active, = directory.glob(".upload-*")
            os.utime(active, (1, 1))
            ProjectStore(self.studio.store.root).recover_uploads()
            self.assertTrue(active.is_dir())
        finally:
            release.set()
            accepted = await first
        self.assertEqual(accepted.status_code, 202)
        await asyncio.wait_for(self.studio.worker, 35)
        current = await self.project()
        self.assertEqual(current["status"], "awaiting_approval", current["error"])
        self.assertTrue(any(asset.get("provider") == "manual" for asset in current["assets"]))

        ftyp_size = int.from_bytes(hevc[:4], "big")
        corrupt = hevc[:ftyp_size] + b"corrupt media"
        unconfirmed = await self.client.post(self.route(current), content=corrupt, headers=headers)
        self.assertEqual(unconfirmed.status_code, 409)
        self.assertIn("Confirm", unconfirmed.json()["detail"])
        response = await self.client.post(self.route(current) + "&confirm_replace=yes", content=corrupt, headers=headers)
        self.assertEqual(response.status_code, 202)
        await asyncio.wait_for(self.studio.worker, 35)
        failed = await self.project()
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["assets"], current["assets"])
        self.assertEqual(failed["lastApprovedAssetId"], project["finalAssetId"])

        old = directory / ".upload-abcd1234"
        fresh = directory / ".upload-abcd5678"
        symlink = directory / ".upload-abcd0000"
        old.mkdir()
        fresh.mkdir()
        symlink.symlink_to(fresh, target_is_directory=True)
        os.utime(old, (1, 1))
        ProjectStore(self.studio.store.root).recover_uploads()
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())
        self.assertTrue(symlink.is_symlink())

    async def test_regeneration_rollback_on_cancellation_and_invalid_export(self):
        original = await self.prepare()
        response = await self.client.post(self.route(original), content=await self.fixture("libx264"),
                                          headers={"Content-Type": "video/mp4"})
        self.assertEqual(response.status_code, 202)
        await asyncio.wait_for(self.studio.worker, 35)
        imported = await self.project()
        approved_id = imported["finalAssetId"]
        self.assertEqual((await self.client.post(self.base + "/actions", json={
            "action": "approve", "reviewedAssetId": approved_id,
        })).status_code, 200)
        approved = await self.project()
        started = asyncio.Event()

        async def slow_export(*args):
            started.set()
            await asyncio.Event().wait()

        async def invalid_export(clips, durations, audio, subtitles, path, duration, background):
            path.write_bytes(clips[0].read_bytes())  # Real H.264 MP4, with no audio and wrong duration.

        for stage, operation, status in (("video", slow_export, "cancelled"), ("image", invalid_export, "failed")):
            with self.subTest(stage=stage), patch.object(self.studio.ffmpeg, "export", operation):
                response = await self.client.post(self.base + "/actions", json={"action": "regenerate", "stage": stage})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["lastApprovedAssetId"], approved_id)
                worker = self.studio.worker
                if status == "cancelled":
                    await asyncio.wait_for(started.wait(), 10)
                    self.assertEqual((await self.client.post(self.base + "/actions", json={"action": "cancel"})).status_code, 200)
                    await asyncio.gather(worker, return_exceptions=True)
                else:
                    await asyncio.wait_for(worker, 35)
                project = await self.project()
                self.assertEqual(project["status"], status, project["error"])
                if status == "failed":
                    self.assertIn("staged export", project["error"])
                self.assertEqual(project["assets"], approved["assets"])
                self.assertEqual(project["lastApprovedAssetId"], approved_id)
                self.assertEqual((await self.client.get(f"{self.base}/assets/{approved_id}")).status_code, 200)

    async def test_five_uzbek_scenes_export_approve_and_preserve_under_storage_floor(self):
        original = await self.prepare()
        project = original
        self.assertEqual(project["brief"]["language"], "Uzbek")
        self.assertEqual([scene["duration"] for scene in project["scenes"]], [6] * 5)
        self.assertEqual(project["scenes"][0]["narration"], "Bugun Moving scene haqida gaplashamiz.")
        clip = await self.fixture("libx264")
        for index, scene in enumerate(original["scenes"], 1):
            route = f"{self.base}/scenes/{scene['id']}/import?expected_export={project['finalAssetId']}"
            uploaded = await self.client.post(route, content=clip, headers={
                "Content-Type": "video/mp4", "X-Flow-Clip-Name": f"..%2F{index}-sahna.mp4",
            })
            self.assertEqual(uploaded.status_code, 202, uploaded.text)
            await asyncio.wait_for(self.studio.worker, 35)
            project = await self.project()
            self.assertEqual(project["status"], "awaiting_approval", project["error"])
            final = next(a for a in project["assets"] if a["id"] == project["finalAssetId"])
            self.assertEqual((final["importedScenes"], final["sceneCount"], final["duration"]), (index, 5, 30))
            imported = next(a for a in project["assets"] if a["sceneId"] == scene["id"] and a.get("provider") == "manual")
            self.assertEqual(imported["filename"], f"{index}-sahna.mp4")
            self.assertAlmostEqual(imported["sourceDuration"], 1, places=2)
        subtitles = next(asset for asset in project["assets"] if asset["extension"] == ".srt")
        track = await self.client.get(f"{self.base}/assets/{subtitles['id']}")
        self.assertEqual(track.status_code, 200)
        for scene in project["scenes"]:
            self.assertIn(scene["narration"], track.content.decode("utf-8"))
        approved_id = project["finalAssetId"]
        approved = await self.client.post(self.base + "/actions", json={"action": "approve", "reviewedAssetId": approved_id})
        self.assertEqual(approved.status_code, 200)
        storage = (await self.client.get("/api/studio/storage")).json()
        self.assertEqual(storage["archivedExports"], 1)
        self.assertGreater(storage["archiveBytes"], 0)
        archived = await self.client.get(f"{self.base}/assets/{original['finalAssetId']}")
        self.assertEqual(archived.status_code, 200)

        with patch.dict(os.environ, {"FLOW_STUDIO_MIN_FREE_MIB": "128"}), patch(
            "flow_api.studio.store.shutil.disk_usage", return_value=type("Disk", (), {"free": 64 * 1024 * 1024})(),
        ):
            storage = (await self.client.get("/api/studio/storage")).json()
            self.assertTrue(storage["renderPaused"])
            self.assertEqual(storage["floorBytes"], 128 * 1024 * 1024)
            for request in (
                self.client.post(self.base + "/actions", json={"action": "regenerate", "stage": "video"}),
                self.client.post(self.route(approved.json()) + "&confirm_replace=yes", content=clip, headers={"Content-Type": "video/mp4"}),
            ):
                blocked = await request
                self.assertEqual(blocked.status_code, 507, blocked.text)
                self.assertIn("free disk space", blocked.json()["detail"])
        self.assertEqual((await self.project())["approvedAssetId"], approved_id)
        self.assertEqual((await self.client.get(f"{self.base}/assets/{approved_id}")).status_code, 200)
        self.assertEqual((await self.client.get(f"{self.base}/assets/{original['finalAssetId']}")).content, archived.content)

        self.assertEqual((await self.client.post(self.base + "/actions", json={
            "action": "regenerate", "stage": "image",
        })).status_code, 200)
        await asyncio.wait_for(self.studio.worker, 35)
        regenerated = await self.project()
        self.assertEqual(regenerated["status"], "awaiting_approval", regenerated["error"])
        self.assertEqual(regenerated["lastApprovedAssetId"], approved_id)
        self.assertEqual({a["id"] for a in regenerated["assets"] if a.get("provider") == "manual"},
                         {a["id"] for a in project["assets"] if a.get("provider") == "manual"})
