"""Media Studio API. Only project-generated media is served."""

from ipaddress import ip_address
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints, ValidationError, model_validator

from ..agents import NANODOLLARS
from .hive_image_provider import IMAGE_COST
from .media import MediaError
from .store import MEDIA_TYPES

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
            project_for(request, project_id), data.action, data.stage, data.feedback, data.allowPaid, data.allowPaidImages, data.acknowledgeUncertainHive, reviewed_asset_id=data.reviewedAssetId,
        )
        return project_response(request, request.app.state.studio.store.get(updated["id"]))
    except MediaError as error:
        raise HTTPException(409, str(error)) from None


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
