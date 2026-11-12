"""Bounded local MP4 probing and normalization for the Studio VideoProvider seam."""

import asyncio
import json
import math
import os
import shutil
from fractions import Fraction
from pathlib import Path

from .media import FFmpeg, MediaError

MAX_MP4_BYTES = 32 * 1024 * 1024
MP4_BRANDS = {b"isom", b"iso2", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1", b"dash", b"M4V "}
LOCAL_INPUT = ("-max_alloc", "134217728", "-protocol_whitelist", "file", "-f", "mov",
               "-enable_drefs", "0", "-use_absolute_path", "0")


def verify_mp4_signature(source: Path):
    with source.open("rb") as file:
        prefix = file.read(4096)
    size = int.from_bytes(prefix[:4], "big")
    if (prefix[4:8] != b"ftyp" or size < 16 or size > len(prefix) or (size - 16) % 4
        or not ({prefix[8:12]} | {prefix[i:i + 4] for i in range(16, size, 4)}) & MP4_BRANDS):
        raise MediaError("The upload does not have a supported MP4 file signature.")


class ManualVideoProvider:
    def __init__(self, ffmpeg: FFmpeg):
        self.ffmpeg = ffmpeg
        self.ffprobe = os.getenv("FLOW_FFPROBE_BIN") or shutil.which("ffprobe")

    async def inspect(self, source: Path, entries: str):
        if not self.ffprobe:
            raise MediaError("ffprobe is missing. Install FFmpeg with ffprobe to import clips.")
        try:
            process = await asyncio.create_subprocess_exec(
                self.ffprobe, "-v", "error", *LOCAL_INPUT,
                "-show_entries", entries,
                "-of", "json", "-i", str(source), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError:
            raise MediaError("Could not start ffprobe.") from None
        try:
            async with asyncio.timeout(10):
                try:
                    await process.stdout.readexactly(256 * 1024 + 1)
                except asyncio.IncompleteReadError as end:
                    output = end.partial
                else:
                    raise MediaError("The MP4 contains excessive stream metadata.")
                await process.wait()
        except (TimeoutError, asyncio.CancelledError, MediaError) as error:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.communicate()
            if not isinstance(error, TimeoutError):
                raise
            raise MediaError("MP4 inspection timed out.") from None
        if process.returncode:
            raise MediaError("The MP4 container could not be read.")
        try:
            return json.loads(output)
        except ValueError:
            raise MediaError("The MP4 has invalid stream metadata.") from None

    async def probe(self, source: Path):
        info = await self.inspect(
            source, "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,duration:stream_disposition=attached_pic",
        )
        try:
            tracks = [track for track in info["streams"] if track["codec_type"] == "video"]
            if len(tracks) != 1 or tracks[0].get("disposition", {}).get("attached_pic", 0):
                raise MediaError("The MP4 must contain one video track.")
            video = tracks[0]
            duration = float(info["format"]["duration"])
            video_duration = float(video.get("duration", duration))
            width, height = video["width"], video["height"]
            fps = Fraction(video["avg_frame_rate"])
        except (ValueError, TypeError, KeyError, ZeroDivisionError):
            raise MediaError("The MP4 has incomplete or invalid video metadata.") from None
        if video.get("codec_name") not in {"h264", "hevc"}:
            raise MediaError("Import an H.264 or HEVC MP4.")
        if not all(math.isfinite(value) and 0.25 <= value <= 120 for value in (duration, video_duration)):
            raise MediaError("The imported video must be between 0.25 and 120 seconds.")
        if not (2 <= width <= 4096 and 2 <= height <= 4096 and width * height <= 8_847_360 and 0 < fps <= 120):
            raise MediaError("The imported video exceeds supported dimensions or frame rate.")
        return video_duration

    async def validate_export(self, source: Path, duration: int, size: tuple[int, int]):
        verify_mp4_signature(source)
        info = await self.inspect(source, "format=duration:stream=codec_type,codec_name,width,height,duration")
        try:
            streams = {stream["codec_type"]: stream for stream in info["streams"]}
            video = streams["video"]
            durations = (float(info["format"]["duration"]), float(video["duration"]),
                         float(streams["audio"]["duration"]))
            valid = (len(info["streams"]) == 3 and video["codec_name"] == "h264"
                     and (video["width"], video["height"]) == size
                     and streams["audio"]["codec_name"] == "aac"
                     and streams["subtitle"]["codec_name"] == "mov_text"
                     and all(math.isfinite(seconds) and abs(seconds - duration) <= 0.15 for seconds in durations))
        except (ValueError, TypeError, KeyError):
            valid = False
        if not valid:
            raise MediaError("The staged export does not match the expected video, audio, subtitles or duration.")
        await self.ffmpeg.run("-xerror", "-threads", "2", *LOCAL_INPUT, "-i", source,
                              "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-")

    async def generate(self, source: Path, output: Path, duration: int, size: tuple[int, int]):
        verify_mp4_signature(source)
        source_duration = await self.probe(source)
        width, height = size
        filters = (f"fps=24,scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
                   f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,"
                   f"tpad=stop_mode=clone:stop_duration={duration},format=yuv420p")
        await self.ffmpeg.run(
            "-xerror", "-filter_threads", "1", "-threads", "2", *LOCAL_INPUT, "-i", source,
            "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
            "-t", duration, "-vf", filters, "-c:v", "libx264", "-threads", "2",
            "-preset", "ultrafast", "-movflags", "+faststart", output,
        )
        return {"sourceDuration": source_duration}
