import type { TaskHandoff } from "./handoff.ts";

export type AgentStatus = "idle" | "queued" | "working" | "completed" | "failed" | "cancelled";

export const workflow = [
  { id: "research", label: "Research" },
  { id: "create", label: "Create" },
  { id: "review", label: "Review" },
  { id: "deliver", label: "Deliver" },
] as const;

export type Stage = (typeof workflow)[number]["id"];

export type Usage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

export type Agent = {
  id: string;
  name: string;
  role: string;
  stage: Stage;
  task: string | null;
  status: AgentStatus;
  progress: number;
  usage: Usage;
};

export type Activity = {
  id: string;
  agentId: string;
  at: string;
  message: string;
  status: AgentStatus;
};

type OfficeData = {
  agents: readonly Agent[];
  activity: readonly Activity[];
  usagePeriod: string;
};

export const providerNames = { mock: "Mock", openai: "OpenAI", deploy: "Deploy DeepSeek" } as const;
export type ProviderMode = keyof typeof providerNames;
export function isProviderMode(value: unknown): value is ProviderMode {
  return typeof value === "string" && Object.hasOwn(providerNames, value);
}

export type OfficeRun = {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  mode?: ProviderMode | "studio";
  script?: string | null;
  review?: string | null;
  error?: string | null;
};

export type OfficeSnapshot = OfficeData & (
  | { source: "demo" }
  | {
    source: "backend";
    connection: "connected" | "disconnected";
    confirmedAt: string;
    simulation: boolean;
    providerMode: ProviderMode;
    run: OfficeRun | null;
    handoffs?: readonly TaskHandoff[];
  }
);

/**
 * A transport adapter publishes immutable snapshots and returns an unsubscribe
 * callback. A future SSE or WebSocket adapter can implement the same contract.
 */
export type OfficeSource = {
  getSnapshot: () => OfficeSnapshot;
  subscribe: (onChange: () => void) => () => void;
};

export function latestFirst(activity: readonly Activity[]) {
  return [...activity].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function stageProgress(agents: readonly Agent[], stage: Stage) {
  const members = agents.filter((agent) => agent.stage === stage);

  return {
    total: members.length,
    completed: members.filter((agent) => agent.status === "completed").length,
    failed: members.filter((agent) => agent.status === "failed").length,
  };
}

export function totalUsage(agents: readonly Agent[]): Usage {
  return agents.reduce((total, { usage }) => ({
    requests: total.requests + usage.requests,
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    estimatedCostUsd: total.estimatedCostUsd + usage.estimatedCostUsd,
  }), { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
}
