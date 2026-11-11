"""Local FastAPI service for the agent office."""

import os
from contextlib import AsyncExitStack, asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.sse import EventSourceResponse, ServerSentEvent
from pydantic import BaseModel, ConfigDict

from .agents import AgentTask, MockProvider, OpenAIProvider, budget_limit
from .orchestrator import DemoOrchestrator


class StartDemo(BaseModel):
    model_config = ConfigDict(extra="forbid")


def create_app(tick_seconds: float = 0.55, provider=None):
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with AsyncExitStack() as stack:
            selected = provider
            cap = budget_limit(os.getenv("FLOW_OFFICE_MAX_COST_USD", "0.05"))
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
                else:
                    raise ValueError("FLOW_OFFICE_PROVIDER must be mock or openai.")

            office = DemoOrchestrator(tick_seconds, selected, cap)
            app.state.office = office
            try:
                yield
            finally:
                await office.close()

    app = FastAPI(title="Flow AI Office API", lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.post("/api/office/tasks", status_code=202)
    async def start_task(request: Request, body: AgentTask | StartDemo):
        office = request.app.state.office
        if isinstance(body, AgentTask):
            if body.allowPaid != (office.provider.mode == "openai"):
                raise HTTPException(409, "Provider mode changed or paid execution was not confirmed.")
            run_id = office.start_agents(body)
        else:
            run_id = office.start()
        if run_id is None:
            raise HTTPException(409, "A task is already running.")
        return {"runId": run_id}

    @app.delete("/api/office/tasks/{run_id}", status_code=204)
    async def cancel_task(request: Request, run_id: str):
        if not request.app.state.office.cancel(run_id):
            raise HTTPException(409, "This run is no longer active.")

    @app.get("/api/office/events", response_class=EventSourceResponse)
    async def events(request: Request):
        office = request.app.state.office
        async with office.subscribe() as queue:
            while True:
                yield ServerSentEvent(event="office.snapshot", data=await queue.get(), retry=1500)

    return app


app = create_app()
