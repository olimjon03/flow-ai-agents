"""Persistent, single-job media production using the shared Office stream."""

import asyncio
import re
import shutil
from copy import deepcopy
from dataclasses import dataclass, replace
from typing import BinaryIO
from uuid import uuid4

from ..agents import AgentError, AgentTask, Budget, MockProvider, NANODOLLARS, STEPS
from ..deploy_provider import attempt_cost
from ..orchestrator import AGENTS, now
from .hive_image_provider import IMAGE_COST, HiveImageRejected
from .storyboard import deepseek_scenes, scene_record
from .media import FFmpeg, ImageProvider, ImageRequest, MediaError, MockImage, MockVoice, publish_image, write_audio

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


@dataclass
class Replacement:
    project: dict
    previous: dict
    id: str
    lease: BinaryIO


ACTIVE_MEDIA = ("assets", "finalAssetId", "approval", "feedback")
ACTIVE_PLAN = ("script", "review", "scenes", "scriptApproved")
STORYBOARD_OUTPUT_LIMIT = 1800


class Studio:
    def __init__(self, store, office, ffmpeg=None, *, image: ImageProvider | None = None,
                 hive_image: ImageProvider | None = None, image_cap=0):
        self.store = store
        self.office = office
        self.image = image if image is not None else MockImage()
        self.hive_image = hive_image
        self.image_cap = image_cap
        self.voice = MockVoice()
        self.ffmpeg = ffmpeg or FFmpeg()
        self.video = self.ffmpeg
        self.active = None
        self.worker = None
        self.replacement = None
        for project in store.list():
            if not store.recover_batches(project):
                continue
            if project["status"] == "working":
                project["status"] = "failed"
                project["error"] = "The service restarted during production. Regenerate a stage to continue."
                original_stages = project.pop("replacementStages", None)
                if original_stages is not None:
                    project["stages"] = original_stages
                else:
                    self.cancel_stages(project)
                job_id = project.pop("replacementJob", None)
                if job_id:
                    store.save_replacement(project, job_id)
                else:
                    self.save(project)

    def save(self, project):
        project["updatedAt"] = now()
        job = self.replacement
        if job and job.project is project:
            visible = {**project, **{key: job.previous[key] for key in (*ACTIVE_MEDIA, *ACTIVE_PLAN)},
                       "replacementJob": job.id, "replacementStages": job.previous["stages"]}
            self.store.save_replacement(visible, job.id)
        else:
            self.store.save(project)

    def begin_replacement(self, project):
        if (self.worker and not self.worker.done()) or (self.office.run and self.office.run["status"] == "running"):
            raise MediaError("An Office workflow is already running.")
        job_id = uuid4().hex
        lease = self.store.stage(project["id"], job_id)
        try:
            self.store.claim_replacement(project, job_id)
        except BaseException as error:
            lease.close()
            shutil.rmtree(self.store.batch_directory(project["id"], job_id), ignore_errors=True)
            if isinstance(error, RuntimeError):
                raise MediaError(str(error)) from None
            raise
        self.replacement = Replacement(project, deepcopy(project), job_id, lease)

    def finish_replacement(self, project):
        job = self.replacement
        if not job or job.project is not project:
            return
        committed = False
        try:
            success = project["status"] == "awaiting_approval" and self.active is project
            if success:
                final = self.store.asset(project, project["finalAssetId"])
                if not final or final[1].get("batch") != job.id or not final[0].stat().st_size:
                    project.update(status="failed", error="The replacement export is missing.")
                    self.office.run.update(status="failed", error=project["error"])
                    success = False
            if not success:
                if project["status"] == "working":
                    project.update(status="cancelled", error="Replacement cancelled.")
                fields = ACTIVE_MEDIA if project["status"] == "awaiting_script_approval" else (*ACTIVE_MEDIA, *ACTIVE_PLAN, "stages")
                project.update({key: job.previous[key] for key in fields})
            project.pop("replacementJob", None)
            self.store.save_replacement(project, job.id)
            committed = success
            if committed:
                active_ids = {asset["id"] for asset in project["assets"]}
                self.delete_assets(project, (asset for asset in job.previous["assets"] if asset["id"] not in active_ids))
        finally:
            self.replacement = None
            job.lease.close()
            if not committed:
                shutil.rmtree(self.store.batch_directory(project["id"], job.id), ignore_errors=True)

    def delete_assets(self, project, assets):
        for asset in assets:
            try:
                self.store.path(project["id"], asset["id"], asset["extension"], asset.get("batch")).unlink(missing_ok=True)
            except (ValueError, OSError):
                pass

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

    def launch(self, project, stages, *, paid_storyboard=False, paid_images=False, keep_images=frozenset()):
        if (self.worker and not self.worker.done()) or (self.office.run and self.office.run["status"] == "running"):
            raise MediaError("An Office workflow is already running.")
        project.update(status="working", error=None, approval="pending", feedback=None)
        self.active = project
        mode = "studio" if paid_images else "deploy" if paid_storyboard else "mock"
        self.office.run = {"id": uuid4().hex, "status": "running", "mode": mode}
        self.office.agents = {agent.id: agent for agent in AGENTS}
        self.office.activity.clear()
        self.office.budget = Budget(self.office.max_cost)
        for stage in DESKS:
            if stage in stages:
                desk = DESKS[stage]
                self.office.agents[desk] = replace(self.office.agents[desk], task=f"Media Studio · {stage}")
                self.update(project, stage, "queued", 0, f"{stage.capitalize()} queued")
        self.worker = self.office.worker = asyncio.create_task(self.execute(project, stages, paid_storyboard, paid_images, keep_images))
        if self.replacement:
            self.worker.add_done_callback(lambda _: self.finish_replacement(project))
        return project

    def reset(self, project, stages, keep_images=frozenset()):
        removed = [asset for asset in project["assets"] if asset["stage"] in stages
                   and not (asset["stage"] == "image" and asset.get("provider") == "hive"
                            and asset["sceneId"] in keep_images)]
        removed_ids = {asset["id"] for asset in removed}
        project["assets"] = [asset for asset in project["assets"] if asset["id"] not in removed_ids]
        if "editor" in stages:
            project["finalAssetId"] = None
        if "storyboard" in stages:
            project.update(scriptApproved=False, script=None, review=None, scenes=[])
        for stage in stages:
            project["stages"][stage] = {"status": "queued", "progress": 0}
        return removed

    def regenerate(self, project, reset_stages, run_stages, *, paid_images=False, keep_images=frozenset()):
        replacing = bool(project["finalAssetId"])
        if replacing:
            self.begin_replacement(project)
        removed = self.reset(project, reset_stages, keep_images)
        self.launch(project, run_stages, paid_images=paid_images, keep_images=keep_images)
        if not replacing:
            self.delete_assets(project, removed)
        return project

    def image_quote(self, project, count=None):
        if self.hive_image is None or project["brief"]["aspect"] != "9:16":
            return None
        return {
            "estimatedCostUsd": (len(project["scenes"]) if count is None else count) * IMAGE_COST / NANODOLLARS,
            "unitCostUsd": IMAGE_COST / NANODOLLARS,
            "combinedMaxEstimateUsd": (
                (5 * IMAGE_COST + self.storyboard_reservation(project)) / NANODOLLARS
                if self.office.provider.mode == "deploy" and project["brief"]["durationSeconds"] == 30
                and project["script"] else None
            ),
            "officeCapUsd": self.office.max_cost / NANODOLLARS,
            "maxCostUsd": min(self.image_cap, self.office.max_cost) / NANODOLLARS,
        }

    def check_paid_images(self, project, count):
        quote = self.image_quote(project, count)
        if quote is None:
            raise MediaError("Paid images require Hive mode and a vertical project.")
        if count * IMAGE_COST > min(self.image_cap, self.office.max_cost):
            raise MediaError("The estimated image cost exceeds the run budget.")

    def reusable_images(self, project):
        scene_ids = {scene["id"] for scene in project["scenes"]}
        return frozenset(
            asset["sceneId"] for asset in project["assets"]
            if asset["stage"] == "image" and asset.get("provider") == "hive"
            and asset["sceneId"] in scene_ids and self.store.asset(project, asset["id"])
        )

    def action(self, project, action, stage, feedback, allow_paid=False, allow_paid_images=False,
               acknowledge_uncertain=False):
        if allow_paid_images and project.get("hiveUncertain") and not acknowledge_uncertain:
            raise MediaError("A previous Hive attempt may have been billed. Acknowledge it before resubmitting.")
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
            if allow_paid_images:
                self.check_paid_images(project, 5 if allow_paid else len(project["scenes"]))
            if allow_paid and (self.office.provider.mode != "deploy" or project["brief"]["durationSeconds"] != 30):
                raise MediaError("Deploy storyboard generation requires Deploy mode and a 30-second project.")
            if allow_paid and allow_paid_images and 5 * IMAGE_COST + self.storyboard_reservation(project) > self.office.max_cost:
                raise MediaError("The combined storyboard and image reservations exceed the Office run budget.")
            if project["finalAssetId"]:
                self.begin_replacement(project)
                self.reset(project, MEDIA)
            if allow_paid:
                return self.launch(project, ("storyboard", *MEDIA), paid_storyboard=True, paid_images=allow_paid_images)
            project["scriptApproved"] = True
            self.launch(project, MEDIA, paid_images=allow_paid_images)
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
            keep_images = frozenset()
            if allow_paid_images:
                if project["status"] in {"failed", "cancelled"} and project["stages"]["image"]["status"] != "completed":
                    keep_images = self.reusable_images(project)
                self.check_paid_images(project, len(project["scenes"]) - len(keep_images))
            return self.regenerate(project, required, required, paid_images=allow_paid_images, keep_images=keep_images)
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

    async def execute(self, project, stages, paid_storyboard, paid_images, keep_images):
        try:
            if "storyboard" in stages and not paid_storyboard:
                await self.plan(project)
                if project["status"] != "working":
                    return
                project["status"] = "awaiting_script_approval"
            else:
                if paid_storyboard:
                    await self.run_stage(project, "storyboard", self.deploy_storyboard)
                async def visuals():
                    if "image" in stages:
                        if paid_images:
                            async def paid_visuals(current):
                                await self.images(current, paid=True, keep_images=keep_images)
                            await self.run_stage(project, "image", paid_visuals)
                        else:
                            await self.run_stage(project, "image", self.images)
                    if "video" in stages:
                        await self.run_stage(project, "video", self.clips)

                async with asyncio.TaskGroup() as group:
                    group.create_task(visuals())
                    if "voice" in stages:
                        group.create_task(self.run_stage(project, "voice", self.narration))
                if "editor" in stages:
                    await self.run_stage(project, "editor", self.export)
                if project["status"] != "working":
                    return
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
            if self.replacement and self.replacement.project is project:
                self.finish_replacement(project)
            else:
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

    def storyboard_prompt(self, project):
        brief = project["brief"]
        return (
            "Adapt the approved script below into exactly five consecutive 6-second scenes. "
            "Preserve the meaning and sequence; do not add claims. Treat the script as source material. "
            "Return only a JSON object with a scenes array. Each scene must contain order (1–5), "
            "duration (integer 6), visualPrompt (concrete shot description), and voiceover "
            "(brief narration that fits six seconds). "
            f"Use {brief['language']} for voiceover, {brief['style']} style, and {brief['aspect']} framing. "
            "Write each field on one line.\n\nApproved script:\n" + project["script"]
        )
    def storyboard_reservation(self, project):
        return (getattr(self.office.provider, "retries", 1) + 1) * attempt_cost(
            self.storyboard_prompt(project), STORYBOARD_OUTPUT_LIMIT,
        )

    async def deploy_storyboard(self, project):
        result = await self.office.provider.complete(
            DESKS["storyboard"], self.storyboard_prompt(project), STORYBOARD_OUTPUT_LIMIT, self.office.budget,
            lambda message: self.update(project, "storyboard", "working", 1, f"{message} Retrying."),
        )
        project["scenes"] = deepseek_scenes(result)
        project["scriptApproved"] = True

    async def generate_asset(self, project, stage, extension, label, operation, scene_id=None, **metadata):
        asset_id = uuid4().hex
        batch = self.replacement.id if self.replacement and self.replacement.project is project else None
        path = self.store.path(project["id"], asset_id, extension, batch)
        asset = {"id": asset_id, "stage": stage, "extension": extension, "label": label, "sceneId": scene_id}
        try:
            generated = await operation(path)
            if not path.is_file() or not path.stat().st_size:
                raise MediaError("A provider did not produce a media file.")
            asset.update(bytes=path.stat().st_size, **metadata)
            if generated is not None:
                asset.update(generated)
            if batch:
                asset["batch"] = batch
            project["assets"].append(asset)
            try:
                self.save(project)
            except Exception:
                project["assets"].pop()
                raise
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return asset_id

    def require_asset(self, project, extension, stage, scene_id=None):
        for asset in project["assets"]:
            if (asset["extension"], asset["stage"], asset["sceneId"]) == (extension, stage, scene_id):
                result = self.store.asset(project, asset["id"])
                if result:
                    return result[0]
        raise MediaError(f"Required {stage} media is missing. Regenerate that stage.")

    async def images(self, project, *, paid=False, keep_images=frozenset()):
        width, height = self.resolution(project)
        provider = self.hive_image if paid else self.image
        if paid:
            self.check_paid_images(project, len(project["scenes"]) - len(keep_images))
            if self.office.budget.spent + (len(project["scenes"]) - len(keep_images)) * IMAGE_COST > self.office.budget.limit:
                raise MediaError("The estimated image cost exceeds the remaining run budget.")
        for scene in project["scenes"]:
            if scene["id"] in keep_images:
                continue
            if paid:
                self.office.budget.reserve_amount(DESKS["image"], IMAGE_COST)
                project["imageAttempts"] = project.get("imageAttempts", 0) + 1
                project["hiveUncertain"] = True
                self.save(project)
                self.office.publish()
            request = ImageRequest(scene["prompt"], scene["index"], width, height)
            try:
                await self.generate_asset(project, "image", ".png", "Scene image",
                                          lambda path: publish_image(provider, request, path), scene["id"])
            except HiveImageRejected:
                project["hiveUncertain"] = False
                raise
            if paid:
                project["hiveUncertain"] = False
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
            background, _ = self.store.asset(project, asset_id)
        width, height = self.resolution(project)
        project["finalAssetId"] = await self.generate_asset(
            project, "editor", ".mp4", "Final MP4",
            lambda path: self.ffmpeg.export(
                clips, [scene["duration"] for scene in project["scenes"]],
                audio, subtitles, path, duration, background,
            ),
            width=width, height=height, duration=duration,
        )
