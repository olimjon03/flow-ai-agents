"""Single-process demo workflow and bounded snapshot subscriptions."""

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from uuid import uuid4

logger = logging.getLogger(__name__)

STAGES = ("research", "create", "review", "deliver")
MAX_ACTIVITY = 80


@dataclass(frozen=True)
class Agent:
    id: str
    name: str
    role: str
    stage: str
    task: str | None = None
    status: str = "idle"
    progress: int = 0


# Keep workstation order stable so a live update does not move desks in 3D.
AGENTS = (
    Agent("scout", "Scout", "Trend researcher", "research"),
    Agent("atlas", "Atlas", "Audience analyst", "research"),
    Agent("muse", "Muse", "Creative strategist", "create"),
    Agent("quill", "Quill", "Copywriter", "create"),
    Agent("frame", "Frame", "Storyboard designer", "create"),
    Agent("pixel", "Pixel", "Visual designer", "create"),
    Agent("echo", "Echo", "Brand editor", "review"),
    Agent("guard", "Guard", "Quality reviewer", "review"),
    Agent("relay", "Relay", "Publishing planner", "deliver"),
    Agent("lens", "Lens", "Performance analyst", "deliver"),
    Agent("nova", "Nova", "Topic researcher", "research"),
    Agent("sage", "Sage", "Accessibility reviewer", "review"),
)
TASKS = {
    "scout": "Scan content trends",
    "atlas": "Map audience segments",
    "muse": "Develop campaign angles",
    "quill": "Draft social copy",
    "frame": "Outline video scenes",
    "pixel": "Plan campaign visuals",
    "echo": "Check brand voice",
    "guard": "Verify source references",
    "relay": "Prepare release checklist",
    "lens": "Define campaign metrics",
    "nova": "Find supporting examples",
    "sage": "Review captions",
}
ZERO_USAGE = {"requests": 0, "inputTokens": 0, "outputTokens": 0, "estimatedCostUsd": 0}


def now():
    return datetime.now(timezone.utc).isoformat()


class DemoOrchestrator:
    def __init__(self, tick_seconds: float = 0.55):
        self.tick_seconds = tick_seconds
        self.agents = {agent.id: agent for agent in AGENTS}
        self.activity = []
        self.run = None
        self.worker = None
        self.updated_at = now()
        self.subscribers = set()

    def snapshot(self):
        return {
            "confirmedAt": self.updated_at,
            "simulation": True,
            "usagePeriod": "Local simulation",
            "run": dict(self.run) if self.run else None,
            "agents": [{**asdict(agent), "usage": dict(ZERO_USAGE)} for agent in self.agents.values()],
            "activity": list(self.activity),
        }

    @asynccontextmanager
    async def subscribe(self):
        queue = asyncio.Queue(maxsize=1)
        self.subscribers.add(queue)
        try:
            queue.put_nowait(self.snapshot())
            yield queue
        finally:
            self.subscribers.discard(queue)

    def publish(self):
        self.updated_at = now()
        snapshot = self.snapshot()
        for queue in self.subscribers:
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(snapshot)

    def update_agent(self, agent_id, status, progress, message):
        agent = replace(self.agents[agent_id], status=status, progress=progress)
        self.agents[agent_id] = agent
        self.activity.insert(0, {
            "id": uuid4().hex,
            "agentId": agent_id,
            "at": now(),
            "message": message,
            "status": status,
        })
        del self.activity[MAX_ACTIVITY:]

    def start(self):
        # The check, state changes and task creation all run on the same event loop.
        if self.run and self.run["status"] == "running":
            return None

        run_id = uuid4().hex
        self.run = {"id": run_id, "status": "running"}
        self.activity.clear()
        for agent in AGENTS:
            self.agents[agent.id] = replace(agent, task=TASKS[agent.id])
            self.update_agent(agent.id, "queued", 0, f"Queued: {TASKS[agent.id]}")
        self.publish()
        self.worker = asyncio.create_task(self.execute(), name=f"office-demo-{run_id}")
        return run_id

    async def execute(self):
        try:
            for stage in STAGES:
                # Publish the queued state before starting the next stage.
                await asyncio.sleep(self.tick_seconds)
                members = [agent for agent in self.agents.values() if agent.stage == stage]
                for agent in members:
                    self.update_agent(agent.id, "working", 0, f"Started: {agent.task}")
                self.publish()

                for progress in (25, 55, 80, 100):
                    await asyncio.sleep(self.tick_seconds)
                    completed = progress == 100
                    for agent in members:
                        message = f"Completed: {agent.task}" if completed else f"{agent.task} · {progress}%"
                        self.update_agent(agent.id, "completed" if completed else "working", progress, message)
                    self.publish()

            self.run["status"] = "completed"
        except Exception:
            logger.exception("Office simulation failed")
            self.run["status"] = "failed"
            for agent in self.agents.values():
                if agent.status in ("queued", "working"):
                    self.update_agent(agent.id, "failed", agent.progress, "Simulation interrupted.")
        self.publish()

    async def close(self):
        if self.worker and not self.worker.done():
            self.worker.cancel()
            with suppress(asyncio.CancelledError):
                await self.worker
