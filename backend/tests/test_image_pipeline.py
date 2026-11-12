import asyncio
import copy
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from flow_api.orchestrator import DemoOrchestrator
from flow_api.studio.media import ImageResult, MediaError
from flow_api.studio.routes import Brief
from flow_api.studio.store import ProjectStore
from flow_api.studio.workflow import Studio


class FixtureImage:
    def __init__(self):
        self.requests = []

    async def generate(self, request, destination):
        self.requests.append(request)
        Image.new("RGB", (512, 512), "#437861").save(destination)
        return ImageResult(provider="fixture")


class ImagePipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        root = self.enterContext(tempfile.TemporaryDirectory())
        office = DemoOrchestrator()
        self.addAsyncCleanup(office.close)
        self.store = ProjectStore(Path(root))
        self.studio = Studio(self.store, office)
        self.project = self.studio.create(Brief(topic="City gardens").model_dump())
        await self.studio.plan(self.project)
        self.scenes = copy.deepcopy(self.project["scenes"])

    async def test_mock_keeps_scene_data_dimensions_and_label(self):
        await self.studio.images(self.project)
        self.assertEqual(self.project["scenes"], self.scenes)
        self.assertEqual(len(self.project["assets"]), 5)
        for scene, asset in zip(self.scenes, self.project["assets"], strict=True):
            self.assertEqual(asset["sceneId"], scene["id"])
            self.assertEqual((asset["width"], asset["height"], asset["label"]), (180, 320, "Mock scene image"))
            path, _ = self.store.asset(self.project, asset["id"])
            with Image.open(path) as image:
                self.assertEqual(image.size, (180, 320))
                self.assertEqual(image.getpixel((0, 0)), (20 + scene["index"] * 26, 36, 68))

    async def test_normalized_fixtures_export_vertical_video_with_audio_and_subtitles(self):
        if not self.studio.ffmpeg.executable:
            self.skipTest("FFmpeg is required for the fixture export test")
        provider = FixtureImage()
        self.studio.image = provider
        self.project["status"] = "awaiting_script_approval"
        self.studio.action(self.project, "approve-script", None, None)
        await asyncio.wait_for(self.studio.worker, 35)
        self.assertEqual(self.project["status"], "awaiting_approval", self.project["error"])
        self.assertEqual(self.project["scenes"], self.scenes)
        self.assertEqual([request.prompt for request in provider.requests], [scene["prompt"] for scene in self.scenes])
        self.assertEqual([request.scene_index for request in provider.requests], list(range(5)))
        for asset in self.project["assets"]:
            if asset["stage"] == "image":
                path, _ = self.store.asset(self.project, asset["id"])
                with Image.open(path) as image:
                    self.assertEqual(image.size, (360, 640))
                    self.assertEqual(image.getpixel((180, 320)), (67, 120, 97))
                self.assertEqual((asset["width"], asset["height"], asset["provider"]), (360, 640, "fixture"))
        final, _ = self.store.asset(self.project, self.project["finalAssetId"])
        probe = subprocess.run([self.studio.ffmpeg.executable, "-hide_banner", "-i", str(final)],
                               capture_output=True, text=True, timeout=10).stderr
        for marker in ("Video: h264", "360x640", "Audio: aac", "Subtitle: mov_text", "Duration: 00:00:30"):
            self.assertIn(marker, probe)

    async def test_invalid_and_oversized_images_leave_no_files_or_metadata(self):
        class InvalidImage:
            async def generate(self, request, destination):
                destination.write_bytes(b"\x89PNG\r\n\x1a\ntruncated")
                return ImageResult(provider="fixture")

        directory = self.store.directory(self.project["id"])
        self.studio.image = InvalidImage()
        with self.assertRaisesRegex(MediaError, "valid PNG"):
            await self.studio.images(self.project)
        self.assertEqual(list(directory.iterdir()), [])
        self.studio.image = FixtureImage()
        with patch("flow_api.studio.media.MAX_IMAGE_PIXELS", 10_000):
            with self.assertRaisesRegex(MediaError, "pixel limit"):
                await self.studio.images(self.project)
        self.assertEqual(list(directory.iterdir()), [])
        self.assertEqual(self.project["assets"], [])
        self.assertEqual(self.store.get(self.project["id"])["assets"], [])

    async def test_failed_metadata_save_removes_published_image(self):
        with patch.object(self.store, "save", side_effect=OSError("disk error")):
            with self.assertRaisesRegex(OSError, "disk error"):
                await self.studio.images(self.project)
        self.assertEqual(list(self.store.directory(self.project["id"]).iterdir()), [])
        self.assertEqual(self.project["assets"], [])
        self.assertEqual(self.store.get(self.project["id"])["assets"], [])
