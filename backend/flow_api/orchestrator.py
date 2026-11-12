"""Single-process demo workflow and bounded snapshot subscriptions."""

import asyncio
import logging
from collections import deque
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from uuid import uuid4

from .agents import AgentError, Budget, MockProvider, STEPS, budget_limit

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
    def __init__(self, tick_seconds: float = 0.55, provider=None, max_cost=None):
        self.tick_seconds = tick_seconds
        self.agents = {agent.id: agent for agent in AGENTS}
        self.activity = []
        self.run = None
        self.worker = None
        self.updated_at = now()
        self.subscribers = set()
        self.handoff_sequence = 0
        self.handoffs = deque(maxlen=32)
        self.provider = provider or MockProvider(tick_seconds * 2)
        self.max_cost = max_cost if max_cost is not None else budget_limit("0.01" if self.provider.mode == "deploy" else "0.05")
        self.budget = Budget(self.max_cost)

    def snapshot(self):
        return {
            "confirmedAt": self.updated_at,
            "handoffs": list(self.handoffs),
            "simulation": not self.run or self.run.get("mode") in (None, "mock"),
            "providerMode": self.provider.mode,
            "usagePeriod": "Current workflow",
            "run": dict(self.run) if self.run else None,
            "agents": [
                {**asdict(agent), "usage": self.budget.agents[agent.id].snapshot()
                 if agent.id in self.budget.agents else dict(ZERO_USAGE)}
                for agent in self.agents.values()
            ],
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

    def handoff(self, sender, receiver):
        """Record a real dependency transition without awaiting its animation."""
        if (not self.run or self.run["status"] != "running" or sender == receiver
                or self.agents[sender].status != "completed" or self.agents[receiver].status != "working"):
            return
        self.handoff_sequence += 1
        self.handoffs.append({
            "id": uuid4().hex, "sequence": self.handoff_sequence, "runId": self.run["id"],
            "fromAgentId": sender, "toAgentId": receiver, "at": now(),
        })

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
        self.budget = Budget(self.max_cost)
        for agent in AGENTS:
            self.agents[agent.id] = replace(agent, task=TASKS[agent.id])
            self.update_agent(agent.id, "queued", 0, f"Queued: {TASKS[agent.id]}")
        self.publish()
        self.worker = asyncio.create_task(self.execute(), name=f"office-demo-{run_id}")
        return run_id

    async def execute(self):
        try:
            predecessor = None
            for stage in STAGES:
                # Publish the queued state before starting the next stage.
                await asyncio.sleep(self.tick_seconds)
                members = [agent for agent in self.agents.values() if agent.stage == stage]
                for agent in members:
                    self.update_agent(agent.id, "working", 0, f"Started: {agent.task}")
                if predecessor:
                    self.handoff(predecessor, members[0].id)
                self.publish()
                predecessor = members[-1].id

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

    def start_agents(self, task):
        if self.run and self.run["status"] == "running":
            return None

        run_id = uuid4().hex
        self.run = {
            "id": run_id, "status": "running", "mode": self.provider.mode,
            "script": None, "review": None, "error": None,
        }
        self.activity.clear()
        self.budget = Budget(self.max_cost)
        self.agents = {agent.id: agent for agent in AGENTS}
        for step in STEPS:
            description = f"{step.label}: {task.topic}"
            self.agents[step.agent_id] = replace(self.agents[step.agent_id], task=description)
            self.update_agent(step.agent_id, "queued", 0, f"{step.label} queued")
        self.publish()
        self.worker = asyncio.create_task(self.execute_agents(task), name=f"office-agents-{run_id}")
        return run_id

    async def execute_agents(self, task):
        previous = {}
        for index, step in enumerate(STEPS):
            self.update_agent(step.agent_id, "working", 0, f"{step.label} started")
            if index:
                self.handoff(STEPS[index - 1].agent_id, step.agent_id)
            self.publish()

            def on_retry(message):
                self.update_agent(step.agent_id, "working", 0, f"{message} Retrying.")
                self.publish()

            try:
                output = await self.provider.generate(step, task, previous, self.budget, on_retry)
            except Exception as error:
                message = str(error) if isinstance(error, AgentError) else "Agent execution failed."
                self.run.update(status="failed", error=message)
                self.update_agent(step.agent_id, "failed", 0, message)
                for pending in STEPS[index + 1:]:
                    self.update_agent(pending.agent_id, "idle", 0, "Skipped after workflow failure.")
                self.publish()
                return

            previous[step.label] = output
            if step.agent_id == "quill":
                self.run["script"] = output
            if step.agent_id == "guard":
                self.run.update(status="completed", review=output)
            self.update_agent(step.agent_id, "completed", 100, f"{step.label} completed")
            self.publish()

    def cancel(self, run_id):
        if not self.run or self.run["id"] != run_id or self.run["status"] != "running":
            return False

        self.worker.cancel()
        self.run["status"] = "cancelled"
        for agent in self.agents.values():
            if agent.status in ("queued", "working"):
                self.update_agent(agent.id, "idle", agent.progress, "Run cancelled.")
        self.publish()
        return True

    async def close(self):
        if self.worker and not self.worker.done():
            self.worker.cancel()
            with suppress(asyncio.CancelledError):
                await self.worker
