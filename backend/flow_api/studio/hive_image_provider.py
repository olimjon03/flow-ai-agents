"""Hive V3 Flux Schnell adapter. Generation POSTs are never replayed."""

import asyncio
import json
import logging
import re
from contextlib import asynccontextmanager
from contextvars import ContextVar
from pathlib import Path

import httpx

from .media import ImageRequest, ImageResult, MAX_IMAGE_BYTES, MediaError

MODEL = "black-forest-labs/flux-schnell"
ENDPOINT = f"https://api.thehive.ai/api/v3/{MODEL}"
IMAGE_COST = 3_000_000  # $0.003 in nanodollars, based on the published four-step estimate.
DOWNLOAD_HOSTS = frozenset({"cdn.thehive.ai", "hive-data-prod-cdn.thehive.ai"})


class HiveImageRejected(MediaError):
    """Hive definitively rejected the request before producing an image."""


_hive_request: ContextVar[tuple[str, str] | None] = ContextVar("hive_request", default=None)


class HiveTransportLogFilter(logging.Filter):
    event = re.compile(
        r"(?:connect_tcp|start_tls|send_request_headers|send_request_body|receive_response_headers|"
        r"receive_response_body|response_closed|close)\.(?:started|complete|failed)"
    )

    def filter(self, record):
        scope = _hive_request.get()
        if scope is None:
            return True
        method, host = scope
        summary = f"Hive {method} {host}"
        if record.name == "httpx":
            args = record.args
            if isinstance(args, tuple) and len(args) == 5 and type(args[3]) is int:
                summary += f" HTTP {args[3]}"
        else:
            # Transport traces can contain raw headers and exception details. Keep the event only.
            event = str(record.msg).partition(" ")[0]
            if self.event.fullmatch(event):
                summary += f" {event}"
        record.msg, record.args = summary, ()
        record.exc_info = record.exc_text = record.stack_info = None
        return True


hive_log_filter = HiveTransportLogFilter()


class RetryDownload(Exception):
    pass


class HiveImageProvider:
    def __init__(self, client: httpx.AsyncClient, key: str, *, generation_timeout=45, download_timeout=15):
        for name in ("httpx", "httpcore.connection", "httpcore.http11", "httpcore.http2",
                     "httpcore.proxy", "httpcore.socks"):
            logging.getLogger(name).addFilter(hive_log_filter)
        self.client = client
        self.key = key
        self.generation_timeout = generation_timeout
        self.download_timeout = download_timeout

    @asynccontextmanager
    async def request(self, method: str, url: httpx.URL, **kwargs):
        token = _hive_request.set((method, url.host))
        try:
            async with self.client.stream(method, url, follow_redirects=False, **kwargs) as response:
                yield response
        finally:
            _hive_request.reset(token)

    async def generate(self, request: ImageRequest, destination: Path) -> ImageResult:
        payload = {"input": {
            "prompt": request.prompt, "num_images": 1, "num_inference_steps": 4, "output_format": "png",
            "image_size": {"width": 576, "height": 1024},
        }}
        try:
            async with asyncio.timeout(self.generation_timeout):
                async with self.request("POST", httpx.URL(ENDPOINT), json=payload, headers={
                    "Authorization": f"Bearer {self.key}", "Accept-Encoding": "identity",
                }) as response:
                    if response.status_code == 451:
                        raise HiveImageRejected("Hive blocked this image through moderation.")
                    if not response.is_success:
                        raise MediaError(f"Hive image generation failed (HTTP {response.status_code}).")
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise MediaError("Hive returned an unsupported response encoding.")
                    body = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=8192):
                        if len(body) + len(chunk) > 64 * 1024:
                            raise MediaError("Hive returned an oversized generation response.")
                        body.extend(chunk)
        except (TimeoutError, httpx.RequestError):
            raise MediaError("Hive generation outcome is unknown. The request was not repeated and may be billed.") from None

        try:
            output = json.loads(body)["output"]
            if not isinstance(output, list) or len(output) != 1:
                raise ValueError
            raw_url = output[0]["url"]
            if not isinstance(raw_url, str) or len(raw_url) > 4096 or any(ord(c) < 33 or c == "\\" for c in raw_url):
                raise ValueError
            url = httpx.URL(raw_url)
            if (url.scheme != "https" or url.host not in DOWNLOAD_HOSTS or url.port not in (None, 443)
                or url.userinfo or url.fragment or not url.path.strip("/")):
                raise ValueError
        except (ValueError, TypeError, KeyError, httpx.InvalidURL):
            raise MediaError("Hive returned an invalid or untrusted image URL.") from None

        for attempt in range(2):
            try:
                await self.download(url, destination)
                return ImageResult(provider="hive")
            except (TimeoutError, httpx.RequestError, RetryDownload):
                if attempt:
                    raise MediaError("Could not download the generated Hive image. Generation may be billed.") from None
                await asyncio.sleep(0.25)
        raise AssertionError("Unreachable download state")

    async def download(self, url: httpx.URL, destination: Path):
        async with asyncio.timeout(self.download_timeout):
            async with self.request("GET", url, headers={"Accept-Encoding": "identity"}) as response:
                if response.status_code in (408, 429, 500, 502, 503, 504):
                    raise RetryDownload
                if (not response.is_success or response.headers.get("content-encoding", "identity").lower() != "identity"
                    or response.headers.get("content-type", "").split(";")[0].strip().lower() != "image/png"):
                    raise MediaError("Hive did not return a downloadable PNG.")
                length = response.headers.get("content-length")
                if length is not None and (not length.isascii() or not length.isdigit() or len(length) > 9
                                           or not 0 < int(length) <= MAX_IMAGE_BYTES):
                    raise MediaError("The Hive image exceeds the download size limit.")
                received = 0
                with destination.open("wb") as file:
                    async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                        received += len(chunk)
                        if received > MAX_IMAGE_BYTES:
                            raise MediaError("The Hive image exceeds the download size limit.")
                        file.write(chunk)
