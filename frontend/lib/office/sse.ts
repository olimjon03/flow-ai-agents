import { parseHandoff } from "./handoff.ts";
import { workflow } from "./model.ts";
import type { Agent, AgentStatus, Activity, OfficeRun, OfficeSnapshot, OfficeSource, Usage } from "./model.ts";

const statuses = new Set<AgentStatus>(["idle", "queued", "working", "completed", "failed", "cancelled"]);
const stages = new Set<string>(workflow.map(({ id }) => id));

type ConfirmedSnapshot = Extract<OfficeSnapshot, { source: "backend" }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isStatus(value: unknown): value is AgentStatus {
  return statuses.has(value as AgentStatus);
}

function isUsage(value: unknown): value is Usage {
  return isObject(value) && isCount(value.requests) && isCount(value.inputTokens)
    && isCount(value.outputTokens) && typeof value.estimatedCostUsd === "number"
    && Number.isFinite(value.estimatedCostUsd) && value.estimatedCostUsd >= 0;
}

function isAgent(value: unknown): value is Agent {
  return isObject(value) && typeof value.id === "string" && !!value.id
    && typeof value.name === "string" && !!value.name && typeof value.role === "string"
    && typeof value.stage === "string" && stages.has(value.stage)
    && (value.task === null || typeof value.task === "string")
    && isStatus(value.status) && isCount(value.progress) && value.progress <= 100
    && isUsage(value.usage);
}

function isActivity(value: unknown): value is Activity {
  return isObject(value) && typeof value.id === "string" && typeof value.agentId === "string"
    && typeof value.message === "string" && isTime(value.at) && isStatus(value.status);
}

function isRun(value: unknown): value is OfficeRun {
  return isObject(value) && typeof value.id === "string" && !!value.id
    && (value.status === "running" || value.status === "completed" || value.status === "failed" || value.status === "cancelled")
    && (value.mode === undefined || value.mode === "mock" || value.mode === "openai")
    && [value.script, value.review, value.error].every((field) =>
      field === undefined || field === null || typeof field === "string");
}

/** The named SSE event office.snapshot carries a complete server snapshot. */
export function parseOfficeEvent(data: string): ConfirmedSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }

  if (!isObject(value) || typeof value.simulation !== "boolean" || (value.run !== null && !isRun(value.run))
    || !isTime(value.confirmedAt) || typeof value.usagePeriod !== "string"
    || !Array.isArray(value.agents) || value.agents.length !== 12 || !value.agents.every(isAgent)
    || !Array.isArray(value.activity) || !value.activity.every(isActivity)) return null;

  const providerMode = value.providerMode ?? "mock";
  if (providerMode !== "mock" && providerMode !== "openai") return null;
  if (value.simulation !== (value.run?.mode !== "openai")) return null;

  const agentIds = new Set(value.agents.map(({ id }) => id));
  if (agentIds.size !== value.agents.length
    || new Set(value.activity.map(({ id }) => id)).size !== value.activity.length
    || value.activity.some(({ agentId }) => !agentIds.has(agentId))) return null;

  return {
    source: "backend",
    connection: "connected",
    confirmedAt: value.confirmedAt,
    simulation: value.simulation,
    providerMode,
    run: value.run,
    agents: value.agents,
    activity: value.activity,
    usagePeriod: value.usagePeriod,
  };
}

/** Show offline demo data until the same-origin SSE route confirms a snapshot. */
export function createSseOfficeSource(url: string, initial: OfficeSnapshot): OfficeSource {
  let snapshot = initial;
  let connection: EventSource | null = null;
  const listeners = new Set<() => void>();

  function publish(next: OfficeSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function markDisconnected() {
    if (snapshot.source === "backend" && snapshot.connection !== "disconnected") {
      publish({ ...snapshot, connection: "disconnected", handoffs: [] });
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (!connection) {
        connection = new EventSource(url);
        connection.addEventListener("office.snapshot", (event: MessageEvent<string>) => {
          if (event.target !== connection) return;
          const next = parseOfficeEvent(event.data);
          if (next && (snapshot.source === "demo"
            || Date.parse(next.confirmedAt) >= Date.parse(snapshot.confirmedAt))) {
            const handoffs = snapshot.source === "backend" && snapshot.connection === "connected"
              && snapshot.run?.id === next.run?.id
              && (next.run?.status === "running" || next.run?.status === "completed")
              ? snapshot.handoffs : [];
            publish({ ...next, handoffs });
          }
        });
        let lastSequence = 0;
        connection.addEventListener("open", () => { lastSequence = 0; });
        connection.addEventListener("task.handoff", (event: MessageEvent<string>) => {
          if (event.target !== connection || snapshot.source !== "backend" || snapshot.connection !== "connected") return;
          const handoff = parseHandoff(event.data);
          if (!handoff || handoff.sequence <= lastSequence || snapshot.run?.id !== handoff.runId
            || (snapshot.run.status !== "running" && snapshot.run.status !== "completed")) return;
          const ids = new Set(snapshot.agents.map(({ id }) => id));
          if (!ids.has(handoff.fromAgentId) || !ids.has(handoff.toAgentId)) return;
          lastSequence = handoff.sequence;
          publish({ ...snapshot, handoffs: [...(snapshot.handoffs ?? []).slice(-3), handoff] });
        });
        connection.addEventListener("error", (event) => {
          if (event.target === connection) markDisconnected();
        });
      }

      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          connection?.close();
          connection = null;
          markDisconnected();
        }
      };
    },
  };
}
