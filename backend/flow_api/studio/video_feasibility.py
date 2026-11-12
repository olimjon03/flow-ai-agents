"""Local Google Flow handoff and a network-free official Gemini preflight."""

import os
import tempfile
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .media import MediaError


class GoogleFlowFeasibilityProvider:
    def __init__(self, manual_video):
        self.manual_video = manual_video

    @property
    def enabled(self):
        return os.getenv("FLOW_GOOGLE_FLOW_MANUAL") == "1"

    def status(self, project):
        if not self.enabled or project["brief"]["aspect"] != "9:16":
            return "unsupported"
        if not project["finalAssetId"] or not any(scene["duration"] == 6 for scene in project["scenes"]):
            return "manual_required"
        return "ready_for_user_action"

    def require_scene(self, project, scene):
        if self.status(project) != "ready_for_user_action" or scene["duration"] != 6:
            raise MediaError("The Google Flow guide requires local opt-in and a six-second scene in a finished vertical export.")

    async def generate(self, source: Path, output: Path, duration: int, size: tuple[int, int]):
        result = await self.manual_video.generate(source, output, duration, size, strict_sample=True)
        with tempfile.TemporaryDirectory(prefix=".motion-", dir=output.parent) as directory:
            hashes = Path(directory) / "samples.txt"
            await self.manual_video.ffmpeg.run(
                "-xerror", "-i", output, "-an", "-vf", "fps=2", "-frames:v", "12", "-f", "framemd5", hashes,
            )
            samples = {line.rsplit(",", 1)[-1].strip() for line in hashes.read_text().splitlines()
                       if line and not line.startswith("#")}
            if len(samples) < 2:
                raise MediaError("No frame changes were detected. Choose a visibly moving six-second clip.")
        return {**result, "videoSource": "google_flow_manual"}


class OfficialGeminiVideoProvider:
    """Quote only. No SDK client or generation transport is available in this phase."""

    model = "gemini-omni-1.2-flash"
    video_estimate = Decimal("0.417024")  # 6s × 5,792 video tokens/s × $12/1M tokens.
    reservation = Decimal("1.00")  # Planning allowance for text, thinking and price variance.

    def preflight(self, *, consent=False):
        if os.getenv("FLOW_GEMINI_VIDEO_PREFLIGHT") != "1":
            return "disabled"
        if not os.getenv("GEMINI_API_KEY", "").strip():
            return "missing_credentials"
        if not consent:
            return "consent_required"
        try:
            budget = Decimal(os.getenv("FLOW_GEMINI_VIDEO_MAX_USD", "0"))
            if not budget.is_finite() or budget < self.reservation:
                return "budget_exceeded"
        except InvalidOperation:
            return "budget_exceeded"
        return "transport_unavailable"
