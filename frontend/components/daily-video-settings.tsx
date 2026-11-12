"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Settings = { enabled: boolean; daily_limit: number; start_time: string; timezone: string };
type Snapshot = {
  settings: Settings; activated: boolean; paused: boolean; dry_run_complete: boolean;
  used_today: number; local_date: string;
  profiles: { id: string; name: string; userDataDirectory: string }[];
  jobs: { id: string; profile: string; source: string; state: string }[];
};

async function dailyVideo(payload?: object, signal?: AbortSignal): Promise<Snapshot> {
  const response = await fetch("/api/daily-video", payload ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal,
  } : { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || result.error || "Daily Video request failed.");
  return result;
}

export function DailyVideoSettings() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const requestId = useRef<string | null>(null);

  useEffect(() => {
    if (pending) return;
    const controller = new AbortController();
    async function refresh() {
      try {
        const next = await dailyVideo(undefined, controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(next);
        setDraft((current) => current ?? next.settings);
      } catch (failure) {
        if (!controller.signal.aborted) setError((failure as Error).message);
      }
    }
    void refresh();
    const timer = setInterval(refresh, 2500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [pending]);

  async function submit(action: string) {
    setPending(true);
    setError("");
    try {
      let extra = {};
      if (action === "save") extra = { settings: draft };
      if (action === "generate-now") {
        requestId.current ??= crypto.randomUUID().replaceAll("-", "");
        extra = { request_id: requestId.current };
      }
      const next = await dailyVideo({ action, ...extra });
      if (action === "save") setDraft(next.settings);
      if (action === "generate-now") requestId.current = null;
      setSnapshot(next);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }

  const dirty = !!draft && !!snapshot && (
    draft.enabled !== snapshot.settings.enabled || draft.daily_limit !== snapshot.settings.daily_limit
    || draft.start_time !== snapshot.settings.start_time || draft.timezone !== snapshot.settings.timezone
  );

  return (
    <section className="panel section-panel" aria-labelledby="daily-video-title">
      <h2 id="daily-video-title" className="section-title">Daily Video Settings</h2>
      {error && <p role="alert" className="error-text">{error}</p>}
      {snapshot && draft ? <>
        <p role="status" className="mt-2 text-sm">
          {!snapshot.settings.enabled ? "Schedule disabled" : !snapshot.activated ? "Mock schedule inactive"
            : snapshot.paused ? "Schedule paused" : "Mock schedule active"}
          {" · "}{snapshot.used_today}/{snapshot.settings.daily_limit} runs used on {snapshot.local_date}
        </p>
        <form className="studio-form mt-4" onSubmit={(event) => { event.preventDefault(); void submit("save"); }}>
          <label className="studio-check">
            <input type="checkbox" checked={draft.enabled} disabled={pending}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
            Enable scheduling
          </label>
          <label>Videos per day<select value={draft.daily_limit} disabled={pending}
            onChange={(event) => setDraft({ ...draft, daily_limit: Number(event.target.value) })}>
            <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
          </select></label>
          <label>Start time<input type="time" required value={draft.start_time} disabled={pending}
            onChange={(event) => setDraft({ ...draft, start_time: event.target.value })} /></label>
          <label>Timezone<input required maxLength={80} value={draft.timezone} disabled={pending}
            onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></label>
          <button disabled={pending || !dirty}>Save settings</button>
        </form>
        <div className="studio-actions mt-4">
          <button disabled={pending || dirty} onClick={() => void submit("dry-run")}>Run dry run</button>
          <button disabled={pending || dirty || !snapshot.dry_run_complete || !snapshot.settings.enabled || snapshot.activated}
            onClick={() => void submit("activate")}>Activate mock schedule</button>
          <button disabled={pending || !snapshot.activated} onClick={() => void submit(snapshot.paused ? "resume" : "pause")}>
            {snapshot.paused ? "Resume schedule" : "Pause schedule"}
          </button>
          <button disabled={pending || (snapshot.used_today >= snapshot.settings.daily_limit && !requestId.current)}
            onClick={() => void submit("generate-now")}>Generate Now</button>
        </div>
        {snapshot.dry_run_complete && <p className="mt-3 text-sm">Dry run complete. The schedule starts at {snapshot.settings.start_time} ({snapshot.settings.timezone}) and can use up to {snapshot.settings.daily_limit} mock slots per day.</p>}
        <details className="mt-4">
          <summary>Mock Chrome profiles</summary>
          <ul className="mt-2 text-sm">{snapshot.profiles.map((profile) =>
            <li key={profile.id}>{profile.name} · <code>{profile.userDataDirectory}</code></li>)}</ul>
        </details>
        {snapshot.jobs.length > 0 && <ul aria-label="Recent daily video jobs" className="mt-4 space-y-2 text-sm">
          {snapshot.jobs.map((job) => <li key={job.id}>
            {["running", "completed"].includes(job.state)
              ? <Link className="underline" href={`/media-studio?project=${job.id}`}>Daily video {job.id.slice(0, 8)}</Link>
              : <>Daily video {job.id.slice(0, 8)}</>}
            {" · "}{job.source} · {job.state} · {snapshot.profiles.find((profile) => profile.id === job.profile)?.name}
          </li>)}
        </ul>}
      </> : !error && <p role="status">Loading daily video settings…</p>}
    </section>
  );
}
