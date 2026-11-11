"""Local FastAPI service for the simulated agent office."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.sse import EventSourceResponse, ServerSentEvent
from pydantic import BaseModel, ConfigDict

from .orchestrator import DemoOrchestrator


class StartDemo(BaseModel):
    model_config = ConfigDict(extra="forbid")


def create_app(tick_seconds: float = 0.55):
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.office = DemoOrchestrator(tick_seconds)
        try:
            yield
        finally:
            await app.state.office.close()

    app = FastAPI(title="Flow AI Office API", lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.post("/api/office/tasks", status_code=202)
    async def start_demo(request: Request, body: StartDemo):
        run_id = request.app.state.office.start()
        if run_id is None:
            raise HTTPException(409, "A demo task is already running.")
        return {"runId": run_id}

    @app.get("/api/office/events", response_class=EventSourceResponse)
    async def events(request: Request):
        office = request.app.state.office
        async with office.subscribe() as queue:
            while True:
                yield ServerSentEvent(event="office.snapshot", data=await queue.get(), retry=1500)

    return app


app = create_app()
