"use client";

import type { FormEvent } from "react";
import { providerNames, type ProviderMode } from "../../lib/office/model";

export type AgentTaskInput = {
  topic: string;
  language: string;
  style: string;
  durationSeconds: number;
  allowPaid: boolean;
  provider: ProviderMode;
};

export function AgentTaskForm({ provider, disabled, onStart }: {
  provider: ProviderMode;
  disabled: boolean;
  onStart: (input: AgentTaskInput) => void;
}) {
  const paid = provider !== "mock";
  const name = providerNames[provider];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const consent = event.currentTarget.elements.namedItem("allowPaid");
    if (consent instanceof HTMLInputElement) consent.checked = false;
    onStart({
      topic: String(data.get("topic") ?? "").trim(),
      language: String(data.get("language") ?? "").trim(),
      style: String(data.get("style") ?? "").trim(),
      durationSeconds: Number(data.get("durationSeconds")),
      allowPaid: paid && data.has("allowPaid"),
      provider,
    });
  }

  return (
    <details className="office-panel office-section office-agent-form">
      <summary>Agent workflow</summary>
      <form onSubmit={submit}>
        <label>Topic<input name="topic" required maxLength={200} /></label>
        <label>Language<input name="language" required maxLength={40} defaultValue="Uzbek" /></label>
        <label>Content style<input name="style" required maxLength={80} defaultValue="Clear and conversational" /></label>
        <label>Target duration (seconds)<input name="durationSeconds" type="number" required min={15} max={600} defaultValue={60} /></label>
        {paid && <label className="office-paid-consent">
          <input name="allowPaid" type="checkbox" required /> Allow paid {name} requests for this run
        </label>}
        <button type="submit" className="office-view-button" disabled={disabled}>
          {paid ? `Run with ${name}` : "Run in mock mode"}
        </button>
      </form>
    </details>
  );
}
