"""Persistent, single-job media production using the shared Office stream."""

import asyncio
import re
from dataclasses import replace
from uuid import uuid4

from ..agents import AgentError, AgentTask, Budget, MockProvider, STEPS
from ..orchestrator import AGENTS, now
from .storyboard import deepseek_scenes, scene_record
from .media import FFmpeg, MediaError, MockImage, MockVoice, write_audio

DESKS = {
    "research": "scout", "script": "quill", "review": "guard", "storyboard": "muse",
    "image": "pixel", "voice": "echo", "video": "frame", "editor": "relay",
}
PLAN = ("research", "script", "review", "storyboard")
MEDIA = ("image", "voice", "video", "editor")
DEPENDENTS = {
    "image": {"image", "video", "editor"},
    "voice": {"voice", "editor"},
    "video": {"video", "editor"},
    "editor": {"editor"},
}


def timestamp(seconds):
    return f"{seconds // 3600:02}:{seconds // 60 % 60:02}:{seconds % 60:02},000"


def mock_script_cues(script, timestamps):
    # Match the generated timeline at the end so brief text cannot become a cue.
    pattern = "".join(rf"\n{seconds}s — ([^\n]+)" for seconds in timestamps)
    match = re.search(pattern + r"\Z", script)
    if not match:
        raise MediaError("The mock script does not match the storyboard scene timing.")
    return match


class Studio:
    def __init__(self, store, office, ffmpeg=None):
        self.store = store
        self.office = office
        self.image = MockImage()
        self.voice = MockVoice()
        self.ffmpeg = ffmpeg or FFmpeg()
        self.video = self.ffmpeg
        self.active = None
        self.worker = None
        for project in store.list():
            if project["status"] == "working":
                project["status"] = "failed"
                project["error"] = "The service restarted during production. Regenerate a stage to continue."
                self.cancel_stages(project)
                self.save(project)

    def save(self, project):
        project["updatedAt"] = now()
        self.store.save(project)

    def create(self, brief):
        project = {
            "id": uuid4().hex, "brief": brief, "createdAt": now(), "status": "draft",
            "script": None, "review": None, "scenes": [], "assets": [], "finalAssetId": None,
            "stages": {stage: {"status": "queued", "progress": 0} for stage in DESKS},
            "activity": [], "approval": "pending", "feedback": None, "scriptApproved": False,
            "error": None,
        }
        self.save(project)
        return project

    def update(self, project, stage, status, progress, message):
        project["stages"][stage] = {"status": status, "progress": progress}
        project["activity"].insert(0, {"at": now(), "stage": stage, "status": status, "message": message})
        del project["activity"][120:]
        self.office.update_agent(DESKS[stage], status, progress, message)
        if status == "working" and progress == 0:
            dependencies = {
                "script": ("research",), "review": ("script",), "storyboard": ("review",),
                "video": ("image",), "editor": ("video", "voice"),
            }
            for predecessor in dependencies.get(stage, ()):
                self.office.handoff(DESKS[predecessor], DESKS[stage])
        self.save(project)
        self.office.publish()

    def launch(self, project, stages, *, paid_storyboard=False):
        if (self.worker and not self.worker.done()) or (self.office.run and self.office.run["status"] == "running"):
            raise MediaError("An Office workflow is already running.")
        project.update(status="working", error=None, approval="pending", feedback=None)
        self.active = project
        self.office.run = {"id": uuid4().hex, "status": "running", "mode": "deploy" if paid_storyboard else "mock"}
        self.office.agents = {agent.id: agent for agent in AGENTS}
        self.office.activity.clear()
        self.office.budget = Budget(self.office.max_cost)
        for stage in DESKS:
            if stage in stages:
                desk = DESKS[stage]
                self.office.agents[desk] = replace(self.office.agents[desk], task=f"Media Studio · {stage}")
                self.update(project, stage, "queued", 0, f"{stage.capitalize()} queued")
        self.worker = self.office.worker = asyncio.create_task(self.execute(project, stages, paid_storyboard))
        return project

    def reset(self, project, stages):
        removed = [asset for asset in project["assets"] if asset["stage"] in stages]
        project["assets"] = [asset for asset in project["assets"] if asset["stage"] not in stages]
        if "editor" in stages:
            project["finalAssetId"] = None
        if "storyboard" in stages:
            project.update(scriptApproved=False, script=None, review=None, scenes=[])
        for stage in stages:
            project["stages"][stage] = {"status": "queued", "progress": 0}
        return removed

    def regenerate(self, project, reset_stages, run_stages):
        removed = self.reset(project, reset_stages)
        self.launch(project, run_stages)
        for asset in removed:
            try:
                self.store.path(project["id"], asset["id"], asset["extension"]).unlink(missing_ok=True)
            except (ValueError, OSError):
                pass
        return project

    def action(self, project, action, stage, feedback, allow_paid=False):
        if action == "cancel":
            if not self.cancel(project["id"]):
                raise MediaError("This project has no active job.")
            return self.store.get(project["id"])
        if project["status"] == "working":
            raise MediaError("Wait for the active job to finish.")
        if action == "start" and project["status"] == "draft":
            return self.launch(project, PLAN)
        can_approve = (project["status"] in {"awaiting_script_approval", "failed", "cancelled"}
                       and project["script"] and project["scenes"] and not project["scriptApproved"])
        if action == "approve-script" and can_approve:
            if allow_paid:
                if self.office.provider.mode != "deploy" or project["brief"]["durationSeconds"] != 30:
                    raise MediaError("Deploy storyboard generation requires Deploy mode and a 30-second project.")
                return self.launch(project, ("storyboard", *MEDIA), paid_storyboard=True)
            project["scriptApproved"] = True
            self.launch(project, MEDIA)
            if project["stages"]["storyboard"]["status"] != "completed":
                self.update(project, "storyboard", "completed", 100, "Using the approved mock storyboard")
            return project
        if action == "regenerate":
            if project["status"] not in {"failed", "cancelled", "awaiting_script_approval", "awaiting_approval", "approved", "rejected"}:
                raise MediaError("Start the project before regenerating a stage.")
            if stage == "script":
                return self.regenerate(project, DESKS, PLAN)
            if not project["scriptApproved"]:
                raise MediaError("Approve the storyboard before producing media.")
            selected = DEPENDENTS[stage]
            required = set(selected)
            for prerequisite in ("image", "voice", "video"):
                if project["stages"][prerequisite]["status"] != "completed":
                    required.update(DEPENDENTS[prerequisite])
            return self.regenerate(project, required, required)
        if action in {"approve", "reject"} and project["status"] in {"awaiting_approval", "approved", "rejected"}:
            if not project["finalAssetId"] or not self.store.asset(project, project["finalAssetId"]):
                raise MediaError("The final MP4 is missing. Regenerate the export.")
            decision = "approved" if action == "approve" else "rejected"
            project.update(status=decision, approval=decision, feedback=feedback if action == "reject" else None)
            self.save(project)
            return project
        raise MediaError("This action is unavailable for the current project state.")

    @staticmethod
    def cancel_stages(project):
        for state in project["stages"].values():
            if state["status"] in {"working", "queued"}:
                state["status"] = "cancelled"

    def cancel(self, project_id):
        if not self.active or self.active["id"] != project_id or self.active["status"] != "working":
            return False
        project = self.active
        self.worker.cancel()
        project["status"] = "cancelled"
        for stage, state in project["stages"].items():
            if state["status"] in {"queued", "working"}:
                self.update(project, stage, "cancelled", state["progress"], "Production cancelled")
        self.office.run["status"] = "cancelled"
        self.save(project)
        self.office.publish()
        return True

    async def execute(self, project, stages, paid_storyboard):
        try:
            if "storyboard" in stages and not paid_storyboard:
                await self.plan(project)
                project["status"] = "awaiting_script_approval"
            else:
                if paid_storyboard:
                    await self.run_stage(project, "storyboard", self.deploy_storyboard)
                async def visuals():
                    if "image" in stages:
                        await self.run_stage(project, "image", self.images)
                    if "video" in stages:
                        await self.run_stage(project, "video", self.clips)

                async with asyncio.TaskGroup() as group:
                    group.create_task(visuals())
                    if "voice" in stages:
                        group.create_task(self.run_stage(project, "voice", self.narration))
                if "editor" in stages:
                    await self.run_stage(project, "editor", self.export)
                project["status"] = "awaiting_approval"
            self.office.run["status"] = "completed"
        except asyncio.CancelledError:
            raise
        except Exception:
            project.update(status="failed", error=project["error"] or "Production failed.")
            for stage in stages:
                state = project["stages"][stage]
                if state["status"] in {"queued", "working"}:
                    self.update(project, stage, "cancelled", state["progress"], "Skipped after production failure")
            self.office.run.update(status="failed", error=project["error"])
        finally:
            self.save(project)
            self.office.publish()

    async def run_stage(self, project, stage, operation):
        self.update(project, stage, "working", 0, f"{stage.capitalize()} started")
        try:
            await operation(project)
        except Exception as error:
            message = str(error) if isinstance(error, (AgentError, MediaError)) else "Could not process local media."
            project["error"] = message
            self.update(project, stage, "failed", 0, message)
            raise
        self.update(project, stage, "completed", 100, f"{stage.capitalize()} completed")

    async def plan(self, project):
        brief = project["brief"]
        task = AgentTask(topic=brief["topic"], language=brief["language"], style=brief["style"],
                         durationSeconds=brief["durationSeconds"])
        outputs = {}
        provider = MockProvider(0.15)
        for stage, step in zip(PLAN[:3], STEPS, strict=True):
            async def generate(current):
                result = await provider.generate(step, task, outputs, self.office.budget, lambda _: None)
                if stage == "script" and brief["durationSeconds"] == 30:
                    cues = mock_script_cues(result, (0, 15, 30))
                    opening, main, closing = cues.groups()
                    result = "\n".join((result[:cues.start()], f"0s — {opening}", "6s — Set the scene.",
                                        f"12s — {main}", "18s — Show the idea in action.", f"24s — {closing}"))
                outputs[step.label] = result
                if stage in {"script", "review"}:
                    current[stage] = result
            await self.run_stage(project, stage, generate)
        await self.run_stage(project, "storyboard", self.storyboard)

    async def storyboard(self, project):
        duration = project["brief"]["durationSeconds"]
        if duration == 30:
            labels = ("Opening", "Context", "Main idea", "Visual recap", "Closing")
            lines = mock_script_cues(project["script"], range(0, 30, 6)).groups()
        else:
            labels = ("Opening", "Main idea", "Closing")
            lines = [re.sub(r"^\d+s — ", "", line) for line in project["script"].splitlines()
                     if re.match(r"^\d+s — ", line)]
        count = len(labels)
        if len(lines) != count:
            raise MediaError("The mock script does not match the storyboard scene count.")
        project["scenes"] = [
            scene_record(index, duration * index // count,
                         duration * (index + 1) // count - duration * index // count,
                         narration, f"{label}: {narration}",
                         f"{project['brief']['style']} · {label} · {narration} · {project['brief']['aspect']}")
            for index, (label, narration) in enumerate(zip(labels, lines, strict=True))
        ]

    async def deploy_storyboard(self, project):
        brief = project["brief"]
        prompt = (
            "Adapt the approved script below into exactly five consecutive 6-second scenes. "
            "Preserve the meaning and sequence; do not add claims. Treat the script as source material. "
            "Return only a JSON object with a scenes array. Each scene must contain order (1–5), "
            "duration (integer 6), visualPrompt (concrete shot description), and voiceover "
            "(brief narration that fits six seconds). "
            f"Use {brief['language']} for voiceover, {brief['style']} style, and {brief['aspect']} framing. "
            "Write each field on one line.\n\nApproved script:\n" + project["script"]
        )
        result = await self.office.provider.complete(
            DESKS["storyboard"], prompt, 1800, self.office.budget,
            lambda message: self.update(project, "storyboard", "working", 1, f"{message} Retrying."),
        )
        project["scenes"] = deepseek_scenes(result)
        project["scriptApproved"] = True

    async def generate_asset(self, project, stage, extension, label, operation, scene_id=None, **metadata):
        asset_id = uuid4().hex
        path = self.store.path(project["id"], asset_id, extension)
        try:
            await operation(path)
            if not path.is_file() or not path.stat().st_size:
                raise MediaError("A provider did not produce a media file.")
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        asset = {"id": asset_id, "stage": stage, "extension": extension, "label": label,
                 "sceneId": scene_id, "bytes": path.stat().st_size, **metadata}
        project["assets"].append(asset)
        self.save(project)
        return asset_id

    def require_asset(self, project, extension, stage, scene_id=None):
        for asset in project["assets"]:
            if (asset["extension"], asset["stage"], asset["sceneId"]) == (extension, stage, scene_id):
                result = self.store.asset(project, asset["id"])
                if result:
                    return result[0]
        raise MediaError(f"Required {stage} media is missing. Regenerate that stage.")

    async def images(self, project):
        vertical = project["brief"]["aspect"] == "9:16"
        for scene in project["scenes"]:
            await self.generate_asset(project, "image", ".png", "Mock scene image",
                                      lambda path: self.image.generate(path, scene, vertical), scene["id"],
                                      width=180 if vertical else 320, height=320 if vertical else 180)
            self.update(project, "image", "working", (scene["index"] + 1) * 90 // len(project["scenes"]), "Scene image ready")

    async def narration(self, project):
        brief = project["brief"]
        text = "\n".join(scene["narration"] for scene in project["scenes"])
        await self.generate_asset(project, "voice", ".wav", "Placeholder tone · no spoken narration",
                                  lambda path: self.voice.generate(path, text, brief["language"],
                                                                   brief["gender"], brief["durationSeconds"]),
                                  language=brief["language"], gender=brief["gender"], duration=brief["durationSeconds"])

        async def subtitles(path):
            path.write_text("\n".join(
                f"{index + 1}\n{timestamp(scene['start'])} --> {timestamp(scene['start'] + scene['duration'])}\n"
                f"{scene['narration']}\n" for index, scene in enumerate(project["scenes"])
            ), encoding="utf-8")

        await self.generate_asset(project, "voice", ".srt", "Timed subtitle segments", subtitles)

        async def browser_subtitles(path):
            cues = []
            for scene in project["scenes"]:
                start = timestamp(scene["start"]).replace(",", ".")
                end = timestamp(scene["start"] + scene["duration"]).replace(",", ".")
                narration = scene["narration"].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                cues.append(f"{start} --> {end}\n{narration}")
            path.write_text("WEBVTT\n\n" + "\n\n".join(cues) + "\n", encoding="utf-8")

        await self.generate_asset(project, "voice", ".vtt", "Browser subtitle track", browser_subtitles)

    def resolution(self, project):
        width, height = (360, 640) if project["brief"]["resolution"] == "test" else (1080, 1920)
        return (width, height) if project["brief"]["aspect"] == "9:16" else (height, width)

    async def clips(self, project):
        size = self.resolution(project)
        for scene in project["scenes"]:
            image = self.require_asset(project, ".png", "image", scene["id"])
            await self.generate_asset(project, "video", ".mp4", "Image-to-video placeholder",
                                      lambda path: self.video.generate(image, path, scene["duration"], size),
                                      scene["id"], width=size[0], height=size[1], duration=scene["duration"])
            self.update(project, "video", "working", (scene["index"] + 1) * 90 // len(project["scenes"]), "Scene clip ready")

    async def export(self, project):
        clips = [self.require_asset(project, ".mp4", "video", scene["id"]) for scene in project["scenes"]]
        audio = self.require_asset(project, ".wav", "voice")
        subtitles = self.require_asset(project, ".srt", "voice")
        duration = project["brief"]["durationSeconds"]
        background = None
        if project["brief"]["backgroundAudio"]:
            async def background_tone(path):
                write_audio(path, duration, 110)
            asset_id = await self.generate_asset(project, "editor", ".wav", "Original background tone", background_tone)
            background = self.store.path(project["id"], asset_id, ".wav")
        width, height = self.resolution(project)
        project["finalAssetId"] = await self.generate_asset(
            project, "editor", ".mp4", "Final MP4",
            lambda path: self.ffmpeg.export(
                clips, [scene["duration"] for scene in project["scenes"]],
                audio, subtitles, path, duration, background,
            ),
            width=width, height=height, duration=duration,
        )
