import assert from "node:assert/strict";
import test from "node:test";
import { demoSnapshot, demoSource } from "../lib/office/demo.ts";
import { parseOfficeEvent } from "../lib/office/sse.ts";
import { latestFirst, stageProgress, totalUsage } from "../lib/office/model.ts";

test("demo source is stable and covers twelve desks and all statuses", () => {
  const { agents, activity, source } = demoSource.getSnapshot();
  assert.equal(source, "demo");
  assert.equal(demoSource.getSnapshot(), demoSnapshot);
  assert.equal(new Set(agents.map(({ id }) => id)).size, 12);
  assert.deepEqual([...new Set(agents.map(({ status }) => status))].sort(),
    ["completed", "failed", "idle", "queued", "working"]);
  for (const agent of agents) {
    assert.ok(agent.progress >= 0 && agent.progress <= 100);
    assert.ok(activity.some(({ agentId }) => agentId === agent.id));
  }
});

test("activity sorts newest first without mutating the source", () => {
  const [first, second] = demoSnapshot.activity;
  const input = [second, first];
  assert.deepEqual(latestFirst(input), [first, second]);
  assert.deepEqual(input, [second, first]);
});

test("workflow totals and cost derive from the same agent snapshot", () => {
  const { agents } = demoSnapshot;
  assert.deepEqual(stageProgress(agents, "review"), { total: 3, completed: 0, failed: 1 });
  assert.deepEqual(stageProgress(agents, "research"), { total: 3, completed: 1, failed: 0 });
  const usage = totalUsage(agents);
  assert.equal(usage.requests, 90);
  assert.equal(usage.inputTokens, 99_400);
  assert.equal(usage.outputTokens, 44_600);
  assert.ok(Math.abs(usage.estimatedCostUsd - 0.1166) < 1e-9);
});

test("SSE only accepts complete server snapshots with valid progress and references", () => {
  const event = {
    ...demoSnapshot,
    confirmedAt: "2026-11-12T11:00:00Z",
    simulation: true,
    run: null,
  };

  const confirmed = parseOfficeEvent(JSON.stringify(event));
  assert.equal(confirmed?.source, "backend");
  assert.equal(confirmed?.connection, "connected");
  assert.equal(confirmed?.agents.length, 12);
  assert.equal(confirmed?.simulation, true);
  assert.equal(parseOfficeEvent(JSON.stringify({ ...event, simulation: false })), null);
  assert.equal(parseOfficeEvent(JSON.stringify({ ...event, run: { id: "run", status: "unknown" } })), null);
  assert.equal(parseOfficeEvent("not JSON"), null);
  assert.equal(parseOfficeEvent(JSON.stringify({
    ...event, agents: [{ ...event.agents[0], progress: 101 }],
  })), null);
  assert.equal(parseOfficeEvent(JSON.stringify({
    ...event, activity: [{ ...event.activity[0], agentId: "missing" }],
  })), null);
});

test("SSE recognizes a Deploy run as live model execution and a Deploy server demo as simulated", () => {
  const event = {
    ...demoSnapshot,
    confirmedAt: "2026-11-12T11:00:00Z",
    providerMode: "deploy",
    simulation: false,
    run: { id: "run", status: "completed", mode: "deploy", script: "Script", review: "Review" },
  };
  const confirmed = parseOfficeEvent(JSON.stringify(event));
  assert.equal(confirmed?.providerMode, "deploy");
  assert.equal(confirmed?.run?.mode, "deploy");
  assert.equal(confirmed?.simulation, false);
  assert.equal(parseOfficeEvent(JSON.stringify({ ...event, simulation: true })), null);
  const demo = parseOfficeEvent(JSON.stringify({ ...event, simulation: true, run: { id: "demo", status: "running" } }));
  assert.equal(demo?.providerMode, "deploy");
  assert.equal(demo?.simulation, true);
});
