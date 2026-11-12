"""Media Studio API. Only project-generated media is served."""

import asyncio
import errno
import hashlib
import re
import tempfile
import unicodedata
from pathlib import Path
from ipaddress import ip_address
from typing import Annotated, Literal
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints, ValidationError, model_validator

from ..agents import NANODOLLARS
from ..local_access import require_local_mutation
from .hive_image_provider import IMAGE_COST
from .media import MediaError, StorageFull
from .store import ID, MEDIA_TYPES
from .video_feasibility import OfficialGeminiVideoProvider
from .video_import import MAX_MP4_BYTES, verify_mp4_signature

router = APIRouter(prefix="/api/studio")


class Brief(BaseModel):
    model_config = ConfigDict(extra="forbid")
    topic: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200, pattern=r"^[^\r\n]+$")]
    language: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)] = "Uzbek"
    style: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)] = "Conversational"
    durationSeconds: Annotated[int, Field(strict=True, ge=15, le=120)] = 30
    aspect: Literal["9:16", "16:9"] = "9:16"
    gender: Literal["male", "female", "neutral"] = "male"
    resolution: Literal["test", "full"] = "test"
    backgroundAudio: StrictBool = False


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["start", "approve-script", "approve", "reject", "regenerate", "cancel"]
    stage: Literal["script", "image", "voice", "video", "editor"] | None = None
    allowPaid: StrictBool = False
    allowPaidImages: StrictBool = False
    acknowledgeUncertainHive: StrictBool = False
    confirmDiscardImported: StrictBool = False
    cancelImportOperationId: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")] | None = None
    reviewedAssetId: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")] | None = None
    feedback: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)] | None = None

    @model_validator(mode="after")
    def required_fields(self):
        if (self.action == "regenerate") != (self.stage is not None):
            raise ValueError("Regeneration requires a stage.")
        if (self.action == "reject") != (self.feedback is not None):
            raise ValueError("Rejection requires feedback.")
        if (self.action in {"approve", "reject"}) != (self.reviewedAssetId is not None):
            raise ValueError("Final review requires the reviewed asset ID.")
        if self.cancelImportOperationId and self.action != "cancel":
            raise ValueError("An import operation ID is only accepted for cancellation.")
        if self.confirmDiscardImported and self.action not in {"approve-script", "regenerate"}:
            raise ValueError("Imported clip confirmation requires a production action.")
        if self.allowPaid and self.action != "approve-script":
            raise ValueError("Paid consent is only available when approving a script.")
        if self.allowPaidImages and not (self.action == "approve-script"
                                         or self.action == "regenerate" and self.stage == "image"):
            raise ValueError("Paid image consent is only available when approving a script or regenerating images.")
        if self.acknowledgeUncertainHive and not self.allowPaidImages:
            raise ValueError("Acknowledgement requires paid image consent.")
        return self


async def read_model(request, model):
    if request.headers.get("content-type", "").split(";")[0].lower() != "application/json":
        raise HTTPException(415, "Expected a JSON request.")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > 4096:
            raise HTTPException(413, "Project request is too large.")
        data.extend(chunk)
    try:
        return model.model_validate_json(data)
    except ValidationError as error:
        fields = sorted({".".join(map(str, item["loc"])) for item in error.errors() if item["loc"]})
        detail = "Check " + ", ".join(fields) + "." if fields else "Check the requested project action."
        raise HTTPException(422, detail) from None


def project_response(request, project):
    studio = request.app.state.studio
    return {
        **{key: value for key, value in project.items() if key not in {"replacementJob", "replacementStages"}},
        "deployStoryboardAvailable": studio.office.provider.mode == "deploy" and project["brief"]["durationSeconds"] == 30,
        "imageQuote": studio.image_quote(project),
        "estimatedImageSpendUsd": project.get("imageAttempts", 0) * IMAGE_COST / NANODOLLARS,
    }


def project_for(request, project_id):
    project = request.app.state.studio.store.get(project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    return project


@router.get("/storage")
async def storage(request: Request):
    require_local_mutation(request)
    return request.app.state.studio.store.storage_status()


@router.get("/projects")
async def projects(request: Request):
    return [{"id": p["id"], "topic": p["brief"]["topic"], "status": p["status"], "createdAt": p["createdAt"]}
            for p in request.app.state.studio.store.list()]


@router.post("/projects", status_code=201)
async def create(request: Request):
    brief = await read_model(request, Brief)
    return project_response(request, request.app.state.studio.create(brief.model_dump()))


@router.get("/projects/{project_id}")
async def project(request: Request, project_id: str):
    return project_response(request, project_for(request, project_id))


@router.post("/projects/{project_id}/actions")
async def action(request: Request, project_id: str):
    data = await read_model(request, Action)
    if data.allowPaidImages:
        try:
            local_client = bool(request.client and ip_address(request.client.host).is_loopback)
        except ValueError:
            local_client = False
        if not local_client or request.url.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise HTTPException(403, "Paid Hive images are only available on localhost.")
    try:
        updated = request.app.state.studio.action(
            project_for(request, project_id), data.action, data.stage, data.feedback, data.allowPaid, data.allowPaidImages, data.acknowledgeUncertainHive, reviewed_asset_id=data.reviewedAssetId, confirm_discard=data.confirmDiscardImported, cancel_import_id=data.cancelImportOperationId,
        )
        return project_response(request, request.app.state.studio.store.get(updated["id"]))
    except StorageFull as error:
        raise HTTPException(507, str(error)) from None
    except MediaError as error:
        raise HTTPException(409, str(error)) from None


@router.get("/projects/{project_id}/video-feasibility")
async def video_feasibility(request: Request, project_id: str):
    require_local_mutation(request)
    project = project_for(request, project_id)
    fallback = OfficialGeminiVideoProvider()
    return {
        "googleFlow": request.app.state.studio.google_flow.status(project),
        "gemini": {
            "status": fallback.preflight(), "model": fallback.model,
            "estimatedVideoUsd": str(fallback.video_estimate), "planningReservationUsd": str(fallback.reservation),
        },
    }


@router.get("/projects/{project_id}/imports/{operation_id}")
async def clip_import_status(request: Request, project_id: str, operation_id: str):
    require_local_mutation(request)
    result = request.app.state.studio.store.clip_import(project_id, operation_id)
    if not result:
        raise HTTPException(404, "Scene import operation not found.")
    operation, project = result
    return {"operation": operation, "project": project_response(request, project)}


@router.post("/projects/{project_id}/scenes/{scene_id}/import", status_code=202)
async def import_clip(request: Request, project_id: str, scene_id: str, expected_export: str,
                      replace_asset: str | None = None, source: Literal["google_flow"] | None = None):
    require_local_mutation(request)
    if not ID.fullmatch(scene_id) or not ID.fullmatch(expected_export):
        raise HTTPException(422, "Invalid scene or export ID.")
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "video/mp4":
        raise HTTPException(415, "Upload a video/mp4 file.")
    if request.headers.get("content-encoding", "identity").lower() != "identity":
        raise HTTPException(415, "Compressed request bodies are not supported.")
    length = request.headers.get("content-length")
    if length and (not length.isascii() or not length.isdigit() or len(length) > 9 or int(length) > MAX_MP4_BYTES):
        raise HTTPException(413, "The MP4 exceeds the 32 MiB limit.")
    expected_digest = request.headers.get("x-flow-clip-sha256")
    if (replace_asset is not None or expected_digest is not None) and (
        not replace_asset or not ID.fullmatch(replace_asset)
        or not expected_digest or not re.fullmatch(r"[a-f0-9]{64}", expected_digest)
    ):
        raise HTTPException(422, "Replacement requires the current clip ID and confirmed file digest.")
    encoded_name = request.headers.get("x-flow-clip-name", "")
    if len(encoded_name) > 2048:
        raise HTTPException(422, "The clip filename is too long.")
    try:
        name = unquote(encoded_name, errors="strict").replace("\\", "/").rsplit("/", 1)[-1]
    except UnicodeDecodeError:
        raise HTTPException(422, "The clip filename is invalid.") from None
    filename = "".join(character for character in name if not unicodedata.category(character).startswith("C")).strip()[:150]
    studio = request.app.state.studio
    google_flow = source == "google_flow"
    try:
        studio.check_clip_import(project_for(request, project_id), scene_id, expected_export, replace_asset, google_flow=google_flow)
        studio.require_render_space(int(length) if length else MAX_MP4_BYTES)
        with studio.store.upload_slot() as acquired:
            if not acquired:
                raise HTTPException(429, "Another MP4 upload is in progress. Try again shortly.")
            with tempfile.TemporaryDirectory(prefix=".upload-", dir=studio.store.directory(project_id)) as directory:
                upload_path = Path(directory) / "upload.mp4"
                size = 0
                digest = hashlib.sha256()
                async with asyncio.timeout(60):
                    with upload_path.open("xb") as file:
                        async for chunk in request.stream():
                            size += len(chunk)
                            if size > MAX_MP4_BYTES:
                                raise HTTPException(413, "The MP4 exceeds the 32 MiB limit.")
                            digest.update(chunk)
                            file.write(chunk)
                source_sha256 = digest.hexdigest()
                if expected_digest and source_sha256 != expected_digest:
                    raise MediaError("The selected file changed after confirmation. Confirm the replacement again.")
                verify_mp4_signature(upload_path)
                operation_id = studio.launch_clip_import(
                    project_for(request, project_id), scene_id, expected_export, upload_path, replace_asset, source_sha256, filename or None,
                    google_flow=google_flow,
                )
    except TimeoutError:
        raise HTTPException(408, "The MP4 upload timed out.") from None
    except OSError as error:
        if error.errno in {errno.ENOSPC, errno.EDQUOT}:
            raise HTTPException(507, "There is insufficient disk space for the MP4 upload.") from None
        raise HTTPException(500, "Could not write the local MP4 upload.") from None
    except StorageFull as error:
        raise HTTPException(507, str(error)) from None
    except MediaError as error:
        raise HTTPException(409, str(error)) from None
    return {**project_response(request, project_for(request, project_id)), "importOperationId": operation_id}


@router.get("/projects/{project_id}/assets/{asset_id}")
async def asset(request: Request, project_id: str, asset_id: str, download: bool = False):
    project = project_for(request, project_id)
    try:
        result = request.app.state.studio.store.asset(project, asset_id)
    except ValueError:
        result = None
    if not result:
        raise HTTPException(404, "Media asset not found.")
    path, metadata = result
    return FileResponse(
        path, media_type=MEDIA_TYPES[metadata["extension"]],
        filename="flow-ai-" + asset_id + metadata["extension"] if download else None,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )
