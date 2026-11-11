"use client";

import { CheckCircle2, Search, Send, Sparkles } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { OfficeViewport } from "./office-viewport";
import { demoSnapshot, demoSource } from "../../lib/office/demo";
import { latestFirst, stageProgress, totalUsage, workflow } from "../../lib/office/model";
import type { Activity, Agent, AgentStatus, OfficeSnapshot } from "../../lib/office/model";

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

  return (
    <section className="office-panel office-section" aria-labelledby="usage-title">
      <h2 id="usage-title">API usage</h2>
      <p className="office-muted">{snapshot.usagePeriod}</p>
      <dl className="office-usage">
        <div><dt>Requests</dt><dd>{number.format(usage.requests)}</dd></div>
        <div><dt>Tokens</dt><dd>{number.format(usage.inputTokens + usage.outputTokens)}</dd></div>
        <div><dt>Estimated cost</dt><dd>{dollars.format(usage.estimatedCostUsd)}</dd></div>
      </dl>
      {snapshot.source === "demo" && (
        <p className="office-muted office-usage-note">
          Demo rates per 1M tokens · $0.50 input / $1.50 output
        </p>
      )}
    </section>
  );
}

export function Office() {
  const snapshot = useSyncExternalStore(demoSource.subscribe, demoSource.getSnapshot, () => demoSnapshot);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useRef<HTMLElement>(null);

  const selected = snapshot.agents.find((agent) => agent.id === selectedId) ?? snapshot.agents[0];
  const ordered = latestFirst(snapshot.activity);
  const latestByAgent = new Map<string, Activity>();
  for (const event of ordered) {
    if (!latestByAgent.has(event.agentId)) latestByAgent.set(event.agentId, event);
  }
  const names = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]));
  const demo = snapshot.source === "demo";

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
          {demo ? (
            <div className="office-source">
              <span className="office-demo">Demo data</span>
              <span>Simulated activity · No live connection</span>
            </div>
          ) : (
            <p className="office-source">
              {snapshot.connection === "connected" ? "Backend confirmed" : "Disconnected · Last known status"}
              {" · "}<time dateTime={snapshot.confirmedAt}>{time.format(new Date(snapshot.confirmedAt))} UTC</time>
            </p>
          )}
        </div>
        <p>Explore agent workstations, workflows, and API usage.</p>
      </header>

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
        <Workflow agents={snapshot.agents} />
        <div className="office-monitoring-grid">
          <UsagePanel snapshot={snapshot} />
          <section className="office-panel office-section" aria-labelledby="timeline-title">
            <h2 id="timeline-title">Activity timeline</h2>
            <ActivityList activity={ordered.slice(0, 4)} names={names} />
          </section>
        </div>
      </div>
    </div>
  );
}
