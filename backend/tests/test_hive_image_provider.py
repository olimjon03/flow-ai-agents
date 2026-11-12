import asyncio
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image

from flow_api.agents import budget_limit
from flow_api.app import create_app
from flow_api.studio.hive_image_provider import ENDPOINT, HiveImageProvider
from flow_api.studio.media import ImageRequest, MediaError

DOWNLOAD = "https://cdn.thehive.ai/image.png?signature=private"
REQUEST = ImageRequest("A garden in the city", 0, 360, 640)


def png():
    buffer = io.BytesIO()
    Image.new("RGB", (180, 320), "green").save(buffer, "PNG")
    return buffer.getvalue()


def output(url=DOWNLOAD):
    return httpx.Response(200, json={"output": [{"url": url}]})


def downloaded():
    return httpx.Response(200, content=png(), headers={"Content-Type": "image/png"})


class HiveAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.path = Path(self.enterContext(tempfile.TemporaryDirectory())) / "image.png"

    async def provider(self, handler, **settings):
        client = await self.enterAsyncContext(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        return HiveImageProvider(client, "server-secret", **settings)

    async def test_download_retry_does_not_repeat_generation_or_forward_key(self):
        calls = []

        def upstream(request):
            calls.append(request.method)
            if request.method == "POST":
                self.assertEqual(str(request.url), ENDPOINT)
                self.assertEqual(request.headers["authorization"], "Bearer server-secret")
                self.assertEqual(json.loads(request.content)["input"], {
                    "prompt": REQUEST.prompt, "num_images": 1, "num_inference_steps": 4, "output_format": "png",
                    "image_size": {"width": 576, "height": 1024},
                })
                return output()
            self.assertEqual(str(request.url), DOWNLOAD)
            self.assertNotIn("authorization", request.headers)
            return httpx.Response(503) if len(calls) == 2 else downloaded()

        provider = await self.provider(upstream)
        self.assertEqual((await provider.generate(REQUEST, self.path)).provider, "hive")
        self.assertEqual(calls, ["POST", "GET", "GET"])
        self.assertEqual(self.path.read_bytes(), png())

    async def test_rejects_invalid_or_untrusted_urls_and_redirects(self):
        for url in ("http://cdn.thehive.ai/image.png", "https://cdn.thehive.ai.evil.test/x",
                    "https://user@cdn.thehive.ai/x", "https://cdn.thehive.ai:444/x",
                    "https://127.0.0.1/x", None):
            with self.subTest(url=url):
                def upstream(request):
                    self.assertEqual(request.method, "POST")
                    return output(url)
                provider = await self.provider(upstream)
                with self.assertRaisesRegex(MediaError, "invalid or untrusted"):
                    await provider.generate(REQUEST, self.path)
        calls = []

        def redirect(request):
            calls.append(request.method)
            return output() if request.method == "POST" else httpx.Response(
                302, headers={"Location": "https://127.0.0.1/private"},
            )

        with self.assertRaisesRegex(MediaError, "downloadable PNG"):
            await (await self.provider(redirect)).generate(REQUEST, self.path)
        self.assertEqual(calls, ["POST", "GET"])

    async def test_rejects_oversized_stream_and_invalid_response_shape(self):
        def oversized(request):
            if request.method == "POST":
                return output()
            return httpx.Response(200, content=b"x" * 50, headers={
                "content-type": "image/png", "content-length": "20",
            })

        with patch("flow_api.studio.hive_image_provider.MAX_IMAGE_BYTES", 30):
            with self.assertRaisesRegex(MediaError, "download size limit"):
                await (await self.provider(oversized)).generate(REQUEST, self.path)

        provider = await self.provider(lambda _: httpx.Response(200, json={"output": []}))
        with self.assertRaisesRegex(MediaError, "invalid or untrusted"):
            await provider.generate(REQUEST, self.path)

    async def test_timeout_and_cancellation_never_replay_generation(self):
        calls = []
        started = asyncio.Event()

        async def upstream(request):
            calls.append(request.method)
            started.set()
            await asyncio.sleep(10)

        with self.assertRaisesRegex(MediaError, "outcome is unknown"):
            await (await self.provider(upstream, generation_timeout=0.01)).generate(REQUEST, self.path)
        self.assertEqual(calls, ["POST"])

        started.clear()
        provider = await self.provider(upstream)
        task = asyncio.create_task(provider.generate(REQUEST, self.path))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(calls, ["POST", "POST"])


class HiveStudioTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.prompts = []
        self.fail_at = None
        self.block_at = None
        self.started = asyncio.Event()
        root = self.enterContext(tempfile.TemporaryDirectory())
        app = create_app(media_root=root)
        # Inject only a mock HTTP transport while exercising normal startup configuration.
        original_client = httpx.AsyncClient
        self.api = await self.enterAsyncContext(original_client(
            base_url="http://test", transport=httpx.ASGITransport(app=app),
        ))
        with patch.dict("os.environ", {
            "FLOW_STUDIO_IMAGE_PROVIDER": "hive", "HIVE_API_KEY": "server-secret",
        }, clear=True), patch("flow_api.app.httpx.AsyncClient", side_effect=lambda **kwargs:
                              original_client(**kwargs, transport=httpx.MockTransport(self.upstream))):
            await self.enterAsyncContext(app.router.lifespan_context(app))
        self.studio = app.state.studio

        async def local(_):
            pass

        self.studio.narration = self.studio.clips = self.studio.export = local
        result = await self.api.post("/api/studio/projects", json={"topic": "City gardens"})
        self.path = f"/api/studio/projects/{result.json()['id']}"
        self.assertEqual((await self.action("start")).status_code, 200)
        await self.finish()

    async def upstream(self, request):
        if request.method == "POST":
            self.prompts.append(json.loads(request.content)["input"]["prompt"])
            if len(self.prompts) == self.block_at:
                self.started.set()
                await asyncio.sleep(10)
            if len(self.prompts) == self.fail_at:
                return httpx.Response(451, text="secret upstream body")
            return output()
        return downloaded()

    async def action(self, action, **extra):
        return await self.api.post(self.path + "/actions", json={"action": action, **extra})

    async def finish(self):
        await asyncio.wait_for(self.studio.worker, 5)
        return (await self.api.get(self.path)).json()

    async def test_consent_budget_and_paid_regeneration(self):
        project = (await self.api.get(self.path)).json()
        self.assertEqual(project["imageQuote"]["estimatedCostUsd"], 0.015)
        self.assertNotIn("server-secret", json.dumps(project))
        self.assertEqual((await self.action("regenerate", stage="voice", allowPaidImages=True)).status_code, 422)
        self.studio.image_cap = budget_limit("0.01")
        self.assertEqual((await self.action("approve-script", allowPaidImages=True)).status_code, 409)
        self.assertEqual(self.prompts, [])
        self.studio.image_cap = budget_limit("0.03")
        self.assertEqual((await self.action("approve-script")).status_code, 200)
        self.assertEqual((await self.finish())["estimatedImageSpendUsd"], 0)
        self.assertEqual(self.prompts, [])
        self.assertEqual((await self.action("regenerate", stage="image", allowPaidImages=True)).status_code, 200)
        paid = await self.finish()
        self.assertEqual(paid["estimatedImageSpendUsd"], 0.015)
        self.assertEqual([a["provider"] for a in paid["assets"]], ["hive"] * 5)
        self.assertEqual(self.studio.office.budget.agents["pixel"].requests, 5)
        self.assertFalse(self.studio.office.snapshot()["simulation"])

        self.assertEqual((await self.action("regenerate", stage="image")).status_code, 200)
        mock = await self.finish()
        self.assertEqual(mock["estimatedImageSpendUsd"], 0.015)
        self.assertEqual(len(self.prompts), 5)
        self.assertEqual([a["provider"] for a in mock["assets"]], ["mock"] * 5)

    async def test_partial_failure_preserves_completed_scene_and_resumes_missing_only(self):
        self.fail_at = 2
        self.assertEqual((await self.action("approve-script", allowPaidImages=True)).status_code, 200)
        failed = await self.finish()
        self.assertEqual(failed["status"], "failed")
        self.assertNotIn("secret upstream body", failed["error"])
        self.assertEqual(failed["estimatedImageSpendUsd"], 0.006)
        saved = failed["assets"][0]
        self.assertEqual((await self.action("regenerate", stage="image", allowPaidImages=True)).status_code, 200)
        resumed = await self.finish()
        self.assertEqual(resumed["status"], "awaiting_approval")
        self.assertEqual(len(self.prompts), 6)
        self.assertEqual(self.prompts.count(self.prompts[0]), 1)
        self.assertIn(saved, resumed["assets"])

    async def test_storyboard_consent_alone_does_not_authorize_hive(self):
        class StoryboardProvider:
            mode = "deploy"

            async def complete(self, *_):
                return json.dumps({"scenes": [
                    {"order": order, "duration": 6, "visualPrompt": f"Shot {order}", "voiceover": f"Line {order}"}
                    for order in range(1, 6)
                ]})

        self.studio.office.provider = StoryboardProvider()
        self.assertEqual((await self.action("approve-script", allowPaid=True)).status_code, 200)
        result = await self.finish()
        self.assertEqual(result["status"], "awaiting_approval")
        self.assertEqual(result["scenes"][0]["prompt"], "Shot 1")
        self.assertEqual(result["estimatedImageSpendUsd"], 0)
        self.assertEqual(self.prompts, [])
        self.assertEqual([asset["provider"] for asset in result["assets"]], ["mock"] * 5)

    async def test_cancelled_post_keeps_reservation_and_cleans_temporary_files(self):
        self.block_at = 2
        self.assertEqual((await self.action("approve-script", allowPaidImages=True)).status_code, 200)
        await asyncio.wait_for(self.started.wait(), 3)
        self.assertEqual((await self.action("cancel")).status_code, 200)
        with self.assertRaises(asyncio.CancelledError):
            await self.studio.worker
        cancelled = (await self.api.get(self.path)).json()
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["estimatedImageSpendUsd"], 0.006)
        self.assertEqual(len(cancelled["assets"]), 1)
        self.assertEqual(len(self.prompts), 2)
        self.assertEqual(list(self.studio.store.directory(cancelled["id"]).glob(".image-*")), [])
