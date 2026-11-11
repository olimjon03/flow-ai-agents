import type { Activity, Agent, AgentStatus, OfficeSnapshot, OfficeSource } from "./model.ts";

function sampleUsage(requests: number, inputTokens: number, outputTokens: number) {
  return {
    requests,
    inputTokens,
    outputTokens,
    // Illustrative USD rates per million tokens. No provider pricing or billing data.
    estimatedCostUsd: (inputTokens * 0.5 + outputTokens * 1.5) / 1_000_000,
  };
}

const agents: Agent[] = [
  { id: "scout", name: "Scout", role: "Trend researcher", stage: "research", task: "Scan content trends", status: "working", progress: 72, usage: sampleUsage(18, 22_000, 8_100) },
  { id: "atlas", name: "Atlas", role: "Audience analyst", stage: "research", task: "Map audience segments", status: "completed", progress: 100, usage: sampleUsage(12, 16_000, 4_300) },
  { id: "muse", name: "Muse", role: "Creative strategist", stage: "create", task: "Develop campaign angles", status: "completed", progress: 100, usage: sampleUsage(9, 9_400, 6_800) },
  { id: "quill", name: "Quill", role: "Copywriter", stage: "create", task: "Draft social copy", status: "working", progress: 58, usage: sampleUsage(24, 25_100, 17_000) },
  { id: "frame", name: "Frame", role: "Storyboard designer", stage: "create", task: "Outline video scenes", status: "queued", progress: 0, usage: sampleUsage(4, 5_200, 2_500) },
  { id: "pixel", name: "Pixel", role: "Visual designer", stage: "create", task: null, status: "idle", progress: 0, usage: sampleUsage(0, 0, 0) },
  { id: "echo", name: "Echo", role: "Brand editor", stage: "review", task: "Check brand voice", status: "queued", progress: 0, usage: sampleUsage(6, 5_900, 1_200) },
  { id: "guard", name: "Guard", role: "Quality reviewer", stage: "review", task: "Verify source references", status: "failed", progress: 40, usage: sampleUsage(7, 7_600, 1_200) },
  { id: "relay", name: "Relay", role: "Publishing planner", stage: "deliver", task: "Prepare release checklist", status: "queued", progress: 0, usage: sampleUsage(3, 2_200, 500) },
  { id: "lens", name: "Lens", role: "Performance analyst", stage: "deliver", task: null, status: "idle", progress: 0, usage: sampleUsage(0, 0, 0) },
  { id: "nova", name: "Nova", role: "Topic researcher", stage: "research", task: "Find supporting examples", status: "working", progress: 35, usage: sampleUsage(7, 6_000, 3_000) },
  { id: "sage", name: "Sage", role: "Accessibility reviewer", stage: "review", task: "Review captions", status: "queued", progress: 0, usage: sampleUsage(0, 0, 0) },
];

function activity(agentId: string, time: string, message: string, status: AgentStatus): Activity {
  return { id: `${agentId}-${time}`, agentId, at: `2026-11-12T${time}:00Z`, message, status };
}

const activities = [
  activity("scout", "10:42", "Shortlisted five content trends", "working"),
  activity("quill", "10:40", "Prepared the first draft outline", "working"),
  activity("guard", "10:38", "Source references were unavailable", "failed"),
  activity("atlas", "10:36", "Saved three audience segments", "completed"),
  activity("muse", "10:34", "Finalized campaign angles", "completed"),
  activity("frame", "10:30", "Added scene outline to the queue", "queued"),
  activity("echo", "10:28", "Queued the brand voice review", "queued"),
  activity("relay", "10:25", "Queued the release checklist", "queued"),
  activity("pixel", "10:20", "Marked available for a visual brief", "idle"),
  activity("lens", "10:18", "Waiting for campaign metrics", "idle"),
  activity("nova", "10:17", "Started collecting examples", "working"),
  activity("sage", "10:16", "Added caption review to the queue", "queued"),
  activity("scout", "10:15", "Started trend research", "working"),
];

export const demoSnapshot: OfficeSnapshot = {
  source: "demo",
  agents,
  activity: activities,
  usagePeriod: "Demo campaign",
};

export const demoSource: OfficeSource = {
  getSnapshot: () => demoSnapshot,
  subscribe: () => () => {},
};
