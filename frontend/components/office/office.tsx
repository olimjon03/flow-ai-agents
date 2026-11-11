"use client";

import { CheckCircle2, Search, Send, Sparkles } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { AgentTaskForm, type AgentTaskInput } from "./agent-task-form";
import { OfficeViewport } from "./office-viewport";
import { demoSnapshot } from "../../lib/office/demo";
import { latestFirst, stageProgress, totalUsage, workflow } from "../../lib/office/model";
import type { Activity, Agent, AgentStatus, OfficeSnapshot } from "../../lib/office/model";

import { createSseOfficeSource } from "../../lib/office/sse";

const officeSource = createSseOfficeSource("/api/office/events", demoSnapshot);
const stageIcons = { research: Search, create: Sparkles, review: CheckCircle2, deliver: Send };
const number = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 3, maximumFractionDigits: 4,
});
const time = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });

function Status({ status }: { status: AgentStatus }) {
  return <span className="office-status" data-status={status}>{status}</span>;
}

function Progress({ agent }: { agent: Agent }) {
  return (
    <span className="office-progress">
      <progress aria-label={`${agent.name} task progress`} max={100} value={agent.progress} />
      <span>{agent.progress}%</span>
    </span>
  );
}

function WorkstationImage() {
  // Decorative artwork shared by the workstation cards and their detail view.
  return <span className="office-desk-art" aria-hidden="true" />;
}

function Workflow({ agents }: { agents: readonly Agent[] }) {
  return (
    <section className="office-panel office-workflow" aria-labelledby="workflow-title">
      <h2 id="workflow-title">Workflow</h2>
      <ol>
        {workflow.map(({ id, label }) => {
          const Icon = stageIcons[id];
          const { completed, total, failed } = stageProgress(agents, id);

          return (
            <li key={id} data-stage={id}>
              <div className="office-stage">
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
                <span className="office-stage-count" aria-label={`${completed} of ${total} completed`}>
                  {completed}/{total}
                </span>
              </div>
              {failed > 0 && <span className="office-stage-failure">{failed} failed</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ActivityList({ activity, names }: {
  activity: readonly Activity[];
  names?: ReadonlyMap<string, string>;
}) {
  if (!activity.length) return <p className="office-muted">No activity recorded.</p>;

  return (
    <ol className="office-timeline">
      {activity.map((event) => (
        <li key={event.id} data-status={event.status}>
          <p>{event.message}</p>
          <span>
            {names && `${names.get(event.agentId) ?? "Unknown agent"} · `}
            <time dateTime={event.at}>{time.format(new Date(event.at))} UTC</time>
          </span>
        </li>
      ))}
    </ol>
  );
}

function UsagePanel({ snapshot }: { snapshot: OfficeSnapshot }) {
  const usage = totalUsage(snapshot.agents);
  const actual = snapshot.source === "backend" && !snapshot.simulation;

  return (
    <section className="office-panel office-section" aria-labelledby="usage-title">
      <h2 id="usage-title">API usage</h2>
      <p className="office-muted">{snapshot.usagePeriod}</p>
      <dl className="office-usage">
        <div><dt>Requests</dt><dd>{number.format(usage.requests)}</dd></div>
        <div><dt>Tokens</dt><dd>{number.format(usage.inputTokens + usage.outputTokens)}</dd></div>
        <div><dt>{actual ? "Estimated OpenAI cost" : "Demo estimated cost"}</dt><dd>{dollars.format(usage.estimatedCostUsd)}</dd></div>
      </dl>
      <p className="office-muted office-usage-note">
        {snapshot.source === "demo"
          ? "Demo rates per 1M tokens · $0.50 input / $1.50 output"
          : actual ? "Includes estimates for attempts with unconfirmed usage."
            : "The local simulation makes no model API calls."}
      </p>
    </section>
  );
}

export function Office() {
  const snapshot = useSyncExternalStore(officeSource.subscribe, officeSource.getSnapshot, () => demoSnapshot);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const detail = useRef<HTMLElement>(null);

  const selected = snapshot.agents.find((agent) => agent.id === selectedId) ?? snapshot.agents[0];
  const ordered = latestFirst(snapshot.activity);
  const latestByAgent = new Map<string, Activity>();
  for (const event of ordered) {
    if (!latestByAgent.has(event.agentId)) latestByAgent.set(event.agentId, event);
  }
  const names = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]));
  const offline = snapshot.source === "demo";
  const connected = !offline && snapshot.connection === "connected";
  const run = offline ? null : snapshot.run;
  const running = run?.status === "running";
  const paid = !offline && snapshot.providerMode === "openai";
  const simulated = offline || snapshot.simulation;
  const runLabel = run?.mode === "openai" ? "OpenAI workflow" : run?.mode === "mock" ? "Mock workflow" : "Demo workflow";

  async function changeRun(input?: AgentTaskInput, cancelId?: string) {
    if (!connected || starting || (!cancelId && running)) return;
    setStarting(true);
    setStartError("");
    try {
      const response = await fetch("/api/office/tasks", {
        method: cancelId ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cancelId ? { runId: cancelId } : input ?? {}),
        signal: AbortSignal.timeout(6500),
      });
      if (!response.ok) {
        const result = await response.json();
        setStartError(result.error || "Could not update the workflow.");
      }
    } catch {
      setStartError("Could not update the workflow. Try again.");
    } finally {
      setStarting(false);
    }
  }

  function selectAgent(id: string) {
    setSelectedId(id);
    if (window.matchMedia("(max-width: 1060px)").matches) detail.current?.focus();
  }

  return (
    <div className="page-frame office-page">
      <div className="breadcrumb">
        Workspace <span aria-hidden="true">/</span> <span>AI Office</span>
      </div>
      <header className="office-heading">
        <div className="office-heading-line">
          <h1>AI Office</h1>
          <div className="office-source">
            <span className="office-demo">{offline ? "Demo data" : simulated ? "Demo simulation" : "OpenAI execution"}</span>
            <span role="status">
              {offline ? "Simulated activity · No live connection"
                : connected ? simulated ? "Live backend · Simulated agents" : "Live backend · OpenAI agents"
                  : "Disconnected · Last confirmed state"}
            </span>
          </div>
        </div>
        <p>Explore agent workstations, workflows, and API usage.</p>
        <div className="office-run-controls">
          <button type="button" className="office-view-button" onClick={() => changeRun()}
            disabled={!connected || starting || running}>
            {starting ? "Starting…" : "Start demo task"}
          </button>
          {running && run && (
            <button type="button" className="office-view-button" disabled={!connected || starting}
              onClick={() => changeRun(undefined, run.id)}>Cancel run</button>
          )}
          <span role="status" className="office-muted">
            {!connected ? "Connect the local office backend to start a run."
              : run ? `${runLabel} ${run.status}` : "Ready to start"}
          </span>
          {(startError || run?.error) && <span role="alert" className="error-text">{startError || run?.error}</span>}
        </div>
      </header>

      <AgentTaskForm paid={paid} disabled={!connected || starting || running} onStart={changeRun} />

      <div className="office-grid">
        <OfficeViewport agents={snapshot.agents} selectedId={selected?.id} onSelect={selectAgent} fallback={<>
          {snapshot.agents.length === 0 && <p className="office-muted">No workstations available.</p>}
          <div className="office-desks">
            {snapshot.agents.map((agent) => (
              <button key={agent.id} id={`desk-${agent.id}`} type="button" className="office-desk"
                aria-pressed={agent.id === selected?.id}
                aria-label={`${agent.name} workstation`}
                aria-describedby={`desk-summary-${agent.id}`}
                aria-controls="agent-details" onClick={() => selectAgent(agent.id)}>
                <WorkstationImage />
                <span className="office-desk-content" id={`desk-summary-${agent.id}`}>
                  <span className="office-agent-line">
                    <strong>{agent.name}</strong>
                    <Status status={agent.status} />
                  </span>
                  <span className="office-task">{agent.task ?? "No task assigned"}</span>
                  <Progress agent={agent} />
                  <span className="office-recent">Last activity · {latestByAgent.get(agent.id)?.message ?? "None recorded"}</span>
                </span>
              </button>
            ))}
          </div>
        </>} />

        <aside className="office-inspector" aria-label="Office monitoring">
          <section id="agent-details" ref={detail} tabIndex={-1}
            className="office-panel office-section" aria-labelledby="details-title">
            <h2 id="details-title">Agent details</h2>
            {simulated && <p className="office-muted">Simulated status and activity</p>}
            {selected ? (
              <>
                <div className="office-agent-detail" aria-live="polite">
                  <WorkstationImage />
                  <div>
                    <div className="office-agent-line">
                      <h3>{selected.name}</h3>
                      <Status status={selected.status} />
                    </div>
                    <p className="office-muted">{selected.role}</p>
                    <p className="office-detail-task">{selected.task ?? "No task assigned"}</p>
                    <Progress agent={selected} />
                  </div>
                </div>
                <h3 className="office-subtitle">Recent activity</h3>
                <ActivityList activity={ordered.filter(({ agentId }) => agentId === selected.id).slice(0, 2)} />
                <a className="office-back" href={`#desk-${selected.id}`}>Back to {selected.name} workstation</a>
              </>
            ) : (
              <p className="office-muted">Select a workstation to view its details.</p>
            )}
          </section>

        </aside>
      </div>

      <div className="office-monitoring">
        {(run?.script || run?.review) && (
          <section className="office-panel office-section office-results" aria-labelledby="agent-results-title">
            <h2 id="agent-results-title">{run.mode === "mock" ? "Mock results" : "Agent results"}</h2>
            {run.script && <><h3>Script</h3><p>{run.script}</p></>}
            {run.review && <><h3>Review</h3><p>{run.review}</p></>}
          </section>
        )}
        <Workflow agents={snapshot.agents} />
        <div className="office-monitoring-grid">
          <UsagePanel snapshot={snapshot} />
          <section className="office-panel office-section" aria-labelledby="timeline-title">
            <h2 id="timeline-title">Activity timeline</h2>
            {simulated && <p className="office-muted">Simulated activity log</p>}
            <ActivityList activity={ordered.slice(0, 4)} names={names} />
          </section>
        </div>
      </div>
    </div>
  );
}
