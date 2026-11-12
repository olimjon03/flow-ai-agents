"""Local mock providers and asynchronous FFmpeg processing."""

import asyncio
import math
import os
import shutil
import stat
import struct
import tempfile
import wave
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from PIL import Image, ImageOps


class MediaError(Exception):
    pass


@dataclass(frozen=True)
class ImageRequest:
    prompt: str
    scene_index: int
    width: int
    height: int


@dataclass(frozen=True)
class ImageResult:
    provider: str


class ImageProvider(Protocol):
    async def generate(self, request: ImageRequest, destination: Path) -> ImageResult: ...


MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000


def normalize_png(source: Path, destination: Path, request: ImageRequest) -> tuple[int, int]:
    try:
        file = source.lstat()
        if not stat.S_ISREG(file.st_mode) or not 0 < file.st_size <= MAX_IMAGE_BYTES:
            raise MediaError("The image is missing or exceeds the file size limit.")
        with Image.open(source, formats=["PNG"]) as image:
            width, height = image.size
            if width * height > MAX_IMAGE_PIXELS:
                raise MediaError("The image exceeds the pixel limit.")
            if image.is_animated:
                raise MediaError("The image must be a single PNG frame.")
            image.verify()
        with Image.open(source, formats=["PNG"]) as image:
            image.load()
            normalized = image.convert("RGB")
            if width * request.height != height * request.width:
                normalized = ImageOps.fit(normalized, (request.width, request.height), Image.Resampling.LANCZOS)
            normalized.info.clear()
            normalized.save(destination, format="PNG")
            if destination.stat().st_size > MAX_IMAGE_BYTES:
                raise MediaError("The normalized image exceeds the file size limit.")
            return normalized.size
    except Image.DecompressionBombError:
        raise MediaError("The image exceeds the pixel limit.") from None
    except (OSError, SyntaxError, ValueError):
        raise MediaError("The provider did not produce a valid PNG.") from None


async def publish_image(provider: ImageProvider, request: ImageRequest, destination: Path):
    # Stage on the same filesystem so the validated file can be published atomically.
    with tempfile.TemporaryDirectory(prefix=".image-", dir=destination.parent) as directory:
        source = Path(directory) / "source.png"
        normalized = Path(directory) / "validated.png"
        result = await provider.generate(request, source)
        width, height = await write_local(normalize_png, source, normalized, request)
        normalized.chmod(0o600)
        normalized.replace(destination)
    return {"width": width, "height": height, "provider": result.provider,
            "label": "Mock scene image" if result.provider == "mock" else "Generated scene image"}


class VoiceProvider(Protocol):
    async def generate(self, output: Path, narration: str, language: str, gender: str, duration: int): ...


class VideoProvider(Protocol):
    async def generate(self, image: Path, output: Path, duration: int, size: tuple[int, int]): ...


def write_png(path, width, height, index):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    pixels = bytearray()
    for y in range(height):
        pixels.append(0)
        for x in range(width):
            inside = abs(x - width // 2) + abs(y - height // 2) < min(width, height) // 3
            offset = 42 if inside else 0
            pixels.extend((20 + index * 26 + offset, 36 + y * 75 // height, 68 + x * 100 // width + offset))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
    )


def write_audio(path, duration, frequency):
    rate = 16_000
    second = bytearray()
    for sample in range(rate):
        t = sample / rate
        fade = min(1, t * 30, (1 - t) * 30)
        second.extend(struct.pack("<h", int(1200 * fade * math.sin(2 * math.pi * frequency * t))))
    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        for _ in range(duration):
            audio.writeframesraw(second)


async def write_local(writer, *args):
    worker = asyncio.create_task(asyncio.to_thread(writer, *args))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        await asyncio.gather(worker, return_exceptions=True)
        raise


class MockImage:
    async def generate(self, request: ImageRequest, destination: Path) -> ImageResult:
        size = (180, 320) if request.width < request.height else (320, 180)
        await write_local(write_png, destination, *size, request.scene_index)
        return ImageResult(provider="mock")


class MockVoice:
    async def generate(self, output, narration, language, gender, duration):
        await write_local(write_audio, output, duration, 220)


class FFmpeg:
    def __init__(self, executable=None, timeout=120):
        self.executable = executable or os.getenv("FLOW_FFMPEG_BIN") or shutil.which("ffmpeg")
        self.timeout = timeout

    async def run(self, *args):
        if not self.executable:
            raise MediaError("FFmpeg is missing. Install it with brew install ffmpeg and restart the backend.")
        try:
            process = await asyncio.create_subprocess_exec(
                self.executable, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *map(str, args),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError:
            raise MediaError("Could not start FFmpeg. Check the executable path.") from None

        try:
            await asyncio.wait_for(process.wait(), self.timeout)
        except (TimeoutError, asyncio.CancelledError) as error:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
            if isinstance(error, asyncio.CancelledError):
                raise
            raise MediaError("FFmpeg processing timed out.") from None
        if process.returncode:
            raise MediaError("FFmpeg could not process the project media. Check that libx264 and AAC are available.")

    async def generate(self, image, output, duration, size):
        width, height = size
        await self.run(
            "-loop", "1", "-framerate", "24", "-i", image, "-t", duration,
            "-vf", f"scale={width}:{height},format=yuv420p", "-c:v", "libx264",
            "-threads", "2", "-preset", "ultrafast", "-movflags", "+faststart", output,
        )

    async def export(self, clips, scene_durations, audio, subtitles, output, duration, background=None):
        # Asset filenames are validated hex IDs and all paths are in one project directory.
        manifest = output.with_suffix(".txt")
        manifest.write_text("".join(
            f"file '{clip.name}'\noutpoint {seconds}\n"
            for clip, seconds in zip(clips, scene_durations, strict=True)
        ))
        try:
            inputs = ["-f", "concat", "-safe", "1", "-i", manifest, "-i", audio, "-i", subtitles]
            audio_map = ["-map", "1:a:0"]
            if background:
                inputs += ["-i", background]
                audio_map = ["-filter_complex", "[3:a]volume=0.16[bg];[1:a][bg]amix=inputs=2:duration=first[a]", "-map", "[a]"]
            await self.run(
                *inputs, "-map", "0:v:0", *audio_map, "-map", "2:s:0",
                "-c:v", "copy", "-c:a", "aac", "-c:s", "mov_text",
                "-t", duration, "-movflags", "+faststart", output,
            )
        finally:
            manifest.unlink(missing_ok=True)
