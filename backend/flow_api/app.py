"""Local FastAPI service for the agent office."""

import os
from pathlib import Path
from contextlib import AsyncExitStack, asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.sse import EventSourceResponse, ServerSentEvent
from pydantic import BaseModel, ConfigDict

from .daily_video import DailyVideo, router as daily_video_router
from .agents import AgentTask, MockProvider, OpenAIProvider, budget_limit
from .deploy_provider import DEFAULT_BASE_URL, MODEL as DEPLOY_MODEL, DeployProvider, validate_base_url, validate_model
from .orchestrator import DemoOrchestrator
from .studio.hive_image_provider import HiveImageProvider
from .studio.routes import router as studio_router
from .studio.store import ProjectStore
from .studio.workflow import Studio


class StartDemo(BaseModel):
    model_config = ConfigDict(extra="forbid")


def create_app(tick_seconds: float = 0.55, provider=None, media_root=None):
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with AsyncExitStack() as stack:
            selected = provider
            if selected is None:
                mode = os.getenv("FLOW_OFFICE_PROVIDER", "mock")
                if mode == "mock":
                    selected = MockProvider(tick_seconds * 2)
                elif mode == "openai":
                    key = os.getenv("OPENAI_API_KEY", "").strip()
                    if not key:
                        raise ValueError("OpenAI office mode requires OPENAI_API_KEY.")
                    client = await stack.enter_async_context(httpx.AsyncClient(
                        base_url="https://api.openai.com", headers={"Authorization": f"Bearer {key}"},
                        trust_env=False, timeout=None,
                    ))
                    selected = OpenAIProvider(client)
                elif mode == "deploy":
                    key = os.getenv("DEPLOY_API_KEY", "").strip()
                    if not key or not key.isascii() or any(not (33 <= ord(char) <= 126) for char in key):
                        raise ValueError("Deploy office mode requires a valid DEPLOY_API_KEY Secret Key.")
                    base_url = validate_base_url(os.getenv("DEPLOY_BASE_URL", DEFAULT_BASE_URL).strip())
                    model = validate_model(os.getenv("DEPLOY_MODEL", DEPLOY_MODEL).strip())
                    client = await stack.enter_async_context(httpx.AsyncClient(
                        base_url=base_url, headers={"Authorization": f"Bearer {key}"},
                        trust_env=False, follow_redirects=False, timeout=None,
                    ))
                    selected = DeployProvider(client, model)
                else:
                    raise ValueError("FLOW_OFFICE_PROVIDER must be mock, openai or deploy.")

            default_cap = "0.01" if selected.mode == "deploy" else "0.05"
            cap = budget_limit(os.getenv("FLOW_OFFICE_MAX_COST_USD", default_cap))

            office = DemoOrchestrator(tick_seconds, selected, cap)
            app.state.office = office
            root = media_root or os.getenv("FLOW_MEDIA_ROOT") or Path(__file__).resolve().parents[2] / ".flow-media"
            image = None
            image_cap = 0
            image_mode = os.getenv("FLOW_STUDIO_IMAGE_PROVIDER", "mock")
            if image_mode == "hive":
                key = os.getenv("HIVE_API_KEY", "").strip()
                if not key or any(not (33 <= ord(char) <= 126) for char in key):
                    raise ValueError("Hive image mode requires a valid HIVE_API_KEY.")
                image_cap = budget_limit(os.getenv("FLOW_STUDIO_IMAGE_MAX_COST_USD", "0.03"))
                image_client = await stack.enter_async_context(httpx.AsyncClient(
                    trust_env=False, follow_redirects=False, timeout=None,
                ))
                image = HiveImageProvider(image_client, key)
            elif image_mode != "mock":
                raise ValueError("FLOW_STUDIO_IMAGE_PROVIDER must be mock or hive.")
            app.state.studio = Studio(ProjectStore(Path(root)), office, hive_image=image, image_cap=image_cap)
            daily_video = app.state.daily_video = DailyVideo(app.state.studio)
            daily_video.start()
            try:
                yield
            finally:
                await daily_video.close()
                await office.close()

    app = FastAPI(title="Flow AI Office API", lifespan=lifespan)

    app.include_router(studio_router)
    app.include_router(daily_video_router)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.post("/api/office/tasks", status_code=202)
    async def start_task(request: Request, body: AgentTask | StartDemo):
        office = request.app.state.office
        if isinstance(body, AgentTask):
            mode = office.provider.mode
            if (body.allowPaid != (mode != "mock")
                or (body.provider is not None and body.provider != mode)
                or (mode == "deploy" and body.provider != "deploy")):
                raise HTTPException(409, "Provider mode changed or paid execution was not confirmed.")
            run_id = office.start_agents(body)
        else:
            run_id = office.start()
        if run_id is None:
            raise HTTPException(409, "A task is already running.")
        return {"runId": run_id}

    @app.delete("/api/office/tasks/{run_id}", status_code=204)
    async def cancel_task(request: Request, run_id: str):
        office = request.app.state.office
        studio = request.app.state.studio
        if studio.active and studio.worker is office.worker and office.run and office.run["id"] == run_id:
            cancelled = studio.cancel(studio.active["id"])
        else:
            cancelled = office.cancel(run_id)
        if not cancelled:
            raise HTTPException(409, "This run is no longer active.")

    @app.get("/api/office/events", response_class=EventSourceResponse)
    async def events(request: Request):
        office = request.app.state.office
        cursor = office.handoff_sequence
        async with office.subscribe() as queue:
            while True:
                snapshot = await queue.get()
                pending = snapshot["handoffs"]
                yield ServerSentEvent(
                    event="office.snapshot", data={key: value for key, value in snapshot.items() if key != "handoffs"},
                    retry=1500,
                )
                run = snapshot["run"]
                for handoff in pending:
                    if handoff["sequence"] <= cursor:
                        continue
                    cursor = handoff["sequence"]
                    if run and run["id"] == handoff["runId"] and run["status"] in {"running", "completed"}:
                        yield ServerSentEvent(event="task.handoff", data=handoff)

    return app


app = create_app()
