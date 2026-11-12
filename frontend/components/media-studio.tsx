"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { importScenesInOrder, videoSourceLabel, type ImportStatus, type SceneImport } from "../lib/scene-import-queue";

type Brief = {
  topic: string; language: string; style: string; durationSeconds: number;
  aspect: string; gender: string; resolution: string; backgroundAudio: boolean;
};
type Asset = { id: string; extension: string; label: string; stage: string; sceneId: string | null; provider?: string;
  filename?: string | null; sourceDuration?: number; importedScenes?: number; sceneCount?: number;
};
type Scene = { id: string; index: number; start: number; duration: number; description: string; narration: string; prompt: string };
type ProjectSummary = { id: string; topic: string; status: string };
type Project = {
  id: string; brief: Brief; status: string; script: string | null; review: string | null;
  scenes: Scene[]; assets: Asset[]; finalAssetId: string | null; lastApprovedAssetId?: string | null; error: string | null;
  stages: Record<string, { status: string; progress: number }>;
  activity: { at: string; stage: string; message: string }[];
  approval: string; feedback: string | null; scriptApproved: boolean; deployStoryboardAvailable: boolean;
  imageQuote: { estimatedCostUsd: number; unitCostUsd: number; maxCostUsd: number; combinedMaxEstimateUsd: number | null; officeCapUsd: number } | null;
  estimatedImageSpendUsd: number;
  hiveUncertain?: boolean;
};

type Storage = { archiveBytes: number; archivedExports: number; freeBytes: number; floorBytes: number; renderPaused: boolean };
type SceneProgress = Record<string, { status: ImportStatus; message?: string }>;

const importLabels: Record<ImportStatus, string> = {
  uploading: "Uploading", rendering: "Normalizing and rendering", imported: "Imported", failed: "Import stopped",
};
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
const archiveSize = (bytes: number) => bytes >= 1024 ** 3 ? gib(bytes) : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
const projectsUrl = "/api/studio/projects";
const stageLabels: Record<string, string> = {
  research: "Research", script: "Script", review: "Review", storyboard: "Storyboard",
  image: "Image", voice: "Voice", video: "Video", editor: "Editor",
};
const displayStatus = (value: string) => value.replaceAll("_", " ");
const assetUrl = (projectId: string, assetId: string) => `${projectsUrl}/${projectId}/assets/${assetId}`;

async function request<T>(url: string, signal?: AbortSignal, payload?: object): Promise<T> {
  const upload = payload instanceof File;
  const response = await fetch(url, payload ? {
    method: "POST",
    headers: upload ? {
      "Content-Type": "video/mp4",
      "X-Flow-Clip-Name": encodeURIComponent(Array.from(payload.name).slice(0, 150).join("")),
    } : { "Content-Type": "application/json" },
    body: upload ? payload : JSON.stringify(payload), signal,
  } : { signal, cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || result.error || "Studio request failed.");
  return result;
}

function ProjectForm({ disabled, onCreate }: { disabled: boolean; onCreate: (brief: Brief) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onCreate({
      topic: String(data.get("topic") ?? "").trim(), language: String(data.get("language") ?? "").trim(),
      style: String(data.get("style") ?? "").trim(), durationSeconds: Number(data.get("duration")),
      aspect: String(data.get("aspect")), gender: String(data.get("gender")),
      resolution: String(data.get("resolution")), backgroundAudio: data.has("background"),
    });
  }

  return (
    <details className="panel studio-panel" open>
      <summary>New project</summary>
      <form className="studio-form" onSubmit={submit}>
        <label>Topic<input name="topic" required maxLength={200} /></label>
        <label>Language<input name="language" defaultValue="Uzbek" required maxLength={40} /></label>
        <label>Content style<input name="style" defaultValue="Conversational" required maxLength={80} /></label>
        <label>Duration (seconds)<input name="duration" type="number" min={15} max={120} defaultValue={30} required /></label>
        <label>Aspect ratio<select name="aspect"><option>9:16</option><option>16:9</option></select></label>
        <label>Voice preference<select name="gender"><option value="male">Male</option><option value="female">Female</option><option value="neutral">Neutral</option></select></label>
        <label>Export resolution<select name="resolution"><option value="test">360p test</option><option value="full">1080p full</option></select></label>
        <label className="studio-check"><input name="background" type="checkbox" /> Add background tone</label>
        <button type="submit" disabled={disabled}>Create project</button>
      </form>
    </details>
  );
}

function PaidImageConsent({ checked, onChange, disabled, estimate, cap }: {
  checked: boolean; onChange: (value: boolean) => void; disabled: boolean; estimate: number; cap: number;
}) {
  return <label className="studio-check">
    <input type="checkbox" checked={checked} disabled={disabled}
      onChange={(event) => onChange(event.target.checked)} />
    Allow paid Hive images · estimated up to ${estimate.toFixed(3)} · run limit ${cap.toFixed(3)}
  </label>;
}

function ProjectView({ project, pending, renderPaused, importProgress, onAction, onImport, onCancelImport }: {
  project: Project; pending: boolean; renderPaused: boolean; onAction: (action: string, extra?: object) => void;
  importProgress: SceneProgress;
  onImport: (items: SceneImport[], onImported: (sceneId: string) => void) => void;
  onCancelImport: () => void;
}) {
  const [acknowledgedHive, setAcknowledgedHive] = useState(false);
  const [paidImages, setPaidImages] = useState(false);
  const [paidRegeneration, setPaidRegeneration] = useState(false);
  const [paidStoryboard, setPaidStoryboard] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [regenerate, setRegenerate] = useState("script");
  const [discardImported, setDiscardImported] = useState(false);
  const [selectedClips, setSelectedClips] = useState<Record<string, File>>({});
  const imports = project.scenes.flatMap((scene) => {
    const file = selectedClips[scene.id];
    const replace = project.assets.some((asset) => asset.sceneId === scene.id && asset.provider === "manual");
    return file ? [{ sceneId: scene.id, file, replace }] : [];
  });
  function submitImports(items: SceneImport[]) {
    const replacements = items.filter((item) => item.replace);
    if (replacements.length && !window.confirm(`Replace ${replacements.length} existing imported clip(s)?`)) return;
    onImport(items, (sceneId) => setSelectedClips((previous) => {
      const remaining = { ...previous };
      delete remaining[sceneId];
      return remaining;
    }));
  }
  const hasImported = project.assets.some((asset) => asset.provider === "manual");
  const working = project.status === "working";
  const canReviewFinal = ["awaiting_approval", "approved", "rejected"].includes(project.status);
  const canApproveScript = ["awaiting_script_approval", "failed", "cancelled"].includes(project.status)
    && !!project.script && project.scenes.length > 0 && !project.scriptApproved;
  const combined = project.imageQuote?.combinedMaxEstimateUsd ?? null;
  const combinedOverBudget = paidStoryboard && paidImages && combined !== null
    && combined > (project.imageQuote?.officeCapUsd ?? 0);
  const requiresHiveAcknowledgement = !!project.hiveUncertain && (paidImages || paidRegeneration);
  const activeImport = Object.values(importProgress).some(({ status }) => status === "rendering");
  const finalAsset = project.assets.find((asset) => asset.id === project.finalAssetId);
  const captions = project.assets.find((asset) => asset.extension === ".vtt");
  const final = project.finalAssetId ? assetUrl(project.id, project.finalAssetId) : null;
  const lastApproved = project.lastApprovedAssetId && project.lastApprovedAssetId !== project.finalAssetId
    ? assetUrl(project.id, project.lastApprovedAssetId) : null;

  return (
    <div className="studio-content">
      <section className="panel studio-panel">
        <div className="studio-title"><h2>{project.brief.topic}</h2><span role="status">{displayStatus(project.status)}</span></div>
        {project.error && <p role="alert" className="error-text">{project.error}</p>}
        {project.hiveUncertain && !working && <p role="status">A previous Hive image request may have been billed. Check your Hive account before retrying.</p>}
        {requiresHiveAcknowledgement && <label className="studio-check">
          <input type="checkbox" checked={acknowledgedHive} disabled={pending}
            onChange={(event) => setAcknowledgedHive(event.target.checked)} />
          I acknowledge that resubmitting may incur another Hive charge
        </label>}
        {project.estimatedImageSpendUsd > 0 && <p>Estimated Hive image spend · ${project.estimatedImageSpendUsd.toFixed(3)}</p>}
        <ul className="studio-stages">
          {Object.entries(stageLabels).map(([stage, label]) => (
            <li key={stage}><strong>{label}</strong><span>{project.stages[stage].status}</span>
              <progress aria-label={`${label} progress`} max={100} value={project.stages[stage].progress} />
            </li>
          ))}
        </ul>
        <div className="studio-actions">
          {project.status === "draft" && <button disabled={pending} onClick={() => onAction("start")}>Start mock workflow</button>}
          {canApproveScript && <>
            {project.deployStoryboardAvailable && <label className="studio-check">
              <input type="checkbox" checked={paidStoryboard} disabled={pending}
                onChange={(event) => setPaidStoryboard(event.target.checked)} />
              Allow a paid Deploy DeepSeek storyboard for this script
            </label>}
            {project.imageQuote && <PaidImageConsent checked={paidImages} onChange={setPaidImages} disabled={pending}
              estimate={paidStoryboard ? 5 * project.imageQuote.unitCostUsd : project.imageQuote.estimatedCostUsd}
              cap={project.imageQuote.maxCostUsd} />}
            {paidStoryboard && paidImages && combined !== null && <p>
              Combined reservation up to ${combined.toFixed(4)}. Office run limit ${project.imageQuote?.officeCapUsd.toFixed(4)}.
              {combinedOverBudget && " Increase the Office run budget or select one paid option."}
            </p>}
            <button disabled={pending || renderPaused || combinedOverBudget || (paidImages && requiresHiveAcknowledgement && !acknowledgedHive)} onClick={() => {
              if (hasImported && !window.confirm("Starting a new storyboard will discard imported clips. Continue?")) return;
              const allowPaid = project.deployStoryboardAvailable && paidStoryboard;
              setPaidStoryboard(false);
              setPaidImages(false);
              setAcknowledgedHive(false);
              onAction("approve-script", { confirmDiscardImported: hasImported, allowPaid, allowPaidImages: !!project.imageQuote && paidImages,
                acknowledgeUncertainHive: paidImages && requiresHiveAcknowledgement && acknowledgedHive });
            }}>{project.deployStoryboardAvailable && paidStoryboard ? "Approve script and generate DeepSeek storyboard" : "Approve script and storyboard"}</button>
          </>}
          {working && <button disabled={pending && !activeImport} onClick={() => pending ? onCancelImport() : onAction("cancel")}>Cancel production</button>}
          {!working && project.status !== "draft" && (
            <form className="studio-actions" onSubmit={(event) => {
              event.preventDefault();
              const confirmDiscardImported = hasImported && (regenerate === "script" || discardImported);
              if (confirmDiscardImported && !window.confirm("This regeneration can discard imported clips. Continue?")) return;
              setDiscardImported(false);
              setPaidStoryboard(false);
              setPaidImages(false);
              setPaidRegeneration(false);
              setAcknowledgedHive(false);
              onAction("regenerate", {
                stage: regenerate, confirmDiscardImported, allowPaidImages: regenerate === "image" && !!project.imageQuote && paidRegeneration,
                acknowledgeUncertainHive: paidRegeneration && requiresHiveAcknowledgement && acknowledgedHive,
              });
            }}>
              <label>Regenerate stage<select value={regenerate} onChange={(event) => { setRegenerate(event.target.value); setDiscardImported(false); setPaidRegeneration(false); setAcknowledgedHive(false); }}>
                {["script", "image", "voice", "video", "editor"].filter((stage) => stage === "script" || project.scriptApproved)
                  .map((stage) => <option key={stage} value={stage}>{stageLabels[stage]}</option>)}
              </select></label>
              {hasImported && ["image", "video"].includes(regenerate) && <label className="studio-check">
                <input type="checkbox" checked={discardImported} disabled={pending}
                  onChange={(event) => setDiscardImported(event.target.checked)} />
                Replace imported clips with generated clips
              </label>}
              {regenerate === "image" && project.scriptApproved && project.imageQuote &&
                <PaidImageConsent checked={paidRegeneration} onChange={setPaidRegeneration} disabled={pending}
                  estimate={project.imageQuote.estimatedCostUsd} cap={project.imageQuote.maxCostUsd} />}
              <button disabled={pending || (renderPaused && regenerate !== "script") || (!project.scriptApproved && regenerate !== "script")
                || (paidRegeneration && requiresHiveAcknowledgement && !acknowledgedHive)}>Regenerate</button>
            </form>
          )}
          <Link href="/ai-office">Open AI Office</Link>
        </div>
      </section>

      {project.scenes.length > 0 && <section className="panel studio-panel">
        <h2>Storyboard and editing timeline</h2>
        {project.brief.aspect === "9:16" && project.finalAssetId && <>
          <h3>{project.scenes.length === 5 ? "Five-scene MP4 import" : "Scene MP4 import"}</h3>
          <p>Select a file for each scene, then import them in scene order. Each successful scene is saved before the next upload.</p>
          <button disabled={pending || working || renderPaused || !imports.length} onClick={() => submitImports(imports)}>Import selected clips in scene order</button>
        </>}
        {project.script && <details><summary>Script and review</summary><p className="studio-script">{project.script}</p><p className="studio-script">{project.review}</p></details>}
        <div className="studio-scenes">
          {project.scenes.map((scene) => {
            const image = project.assets.find((asset) => asset.sceneId === scene.id && asset.extension === ".png");
            const video = project.assets.find((asset) => asset.sceneId === scene.id && asset.extension === ".mp4");
            const progress = importProgress[scene.id];
            const selection = imports.find((item) => item.sceneId === scene.id);
            const sourceDuration = video?.sourceDuration;
            return <article key={scene.id}>
              <h3>Scene {scene.index + 1} · {scene.start}–{scene.start + scene.duration}s</h3>
              <p>Target duration · {scene.duration}s</p>
              <p>Voiceover · {scene.narration}</p><p>Visual prompt · {scene.prompt}</p>
              {image && <img src={assetUrl(project.id, image.id)} alt={`${image.provider === "hive" ? "Hive" : "Mock"} image for scene ${scene.index + 1}`} />}
              {video && <video key={video.id} controls preload="none" aria-label={`Scene ${scene.index + 1} video`} src={assetUrl(project.id, video.id)} />}
              {video?.provider === "manual" ? <>
                <p>Imported MP4</p>
                {video.filename && <p>{video.filename}</p>}
                {sourceDuration !== undefined && Math.abs(sourceDuration - scene.duration) > 1 / 24 && <p>
                  Source {sourceDuration.toFixed(2)}s → target {scene.duration}s · {sourceDuration > scene.duration ? "trimmed" : "last frame held"}
                </p>}
              </> : <p>{video ? "Mock video placeholder" : "No scene clip yet"}</p>}
              {project.finalAssetId && project.brief.aspect === "9:16" && <>
                <label>Import MP4 for scene {scene.index + 1}
                  <input type="file" accept="video/mp4,.mp4" disabled={pending || working} onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) setSelectedClips((previous) => ({ ...previous, [scene.id]: file }));
                  }} />
                </label>
                {selection && <p>Selected · {selection.file.name}</p>}
                <button disabled={pending || working || renderPaused || !selection} onClick={() => selection && submitImports([selection])}>
                  Import scene {scene.index + 1}
                </button>
              </>}
              {progress && <p role={progress.status === "failed" ? "alert" : "status"}>
                {importLabels[progress.status]}{progress.message && ` · ${progress.message}`}
              </p>}
            </article>;
          })}
        </div>
        {project.assets.filter((asset) => asset.extension === ".wav").map((asset) => (
          <div key={asset.id} className="studio-audio"><p>{asset.label}</p><audio controls preload="none" aria-label={asset.label} src={assetUrl(project.id, asset.id)} /></div>
        ))}
      </section>}

      <section className="panel studio-panel">
        <h2>Final export</h2>
        {lastApproved && <a href={`${lastApproved}?download=true`}>Download last approved MP4</a>}
        {final ? <>
          <p>{videoSourceLabel(finalAsset?.importedScenes, finalAsset?.sceneCount)}</p>
          <p>Audio · {project.brief.language} script and subtitles with the existing Studio mock voiceover tone</p>
          <video key={final} controls preload="metadata" className="studio-final" aria-label="Final MP4" src={final}>
            {captions && <track kind="subtitles" label={project.brief.language} src={assetUrl(project.id, captions.id)} default />}
          </video>
          <div className="studio-actions">
            <a href={`${final}?download=true`}>Download MP4</a>
            <button disabled={pending || !canReviewFinal} onClick={() => onAction("approve", { reviewedAssetId: project.finalAssetId })}>Approve final video</button>
          </div>
          <form className="studio-actions" onSubmit={(event) => {
            event.preventDefault();
            onAction("reject", { feedback: feedback.trim(), reviewedAssetId: project.finalAssetId });
          }}>
            <label>Rejection feedback<input required maxLength={1000} value={feedback} onChange={(event) => setFeedback(event.target.value)} /></label>
            <button disabled={pending || !canReviewFinal || !feedback.trim()}>Reject final video</button>
          </form>
          {project.feedback && <p>Feedback · {project.feedback}</p>}
        </> : <p>{working ? "Production in progress" : "No final MP4 yet"}</p>}
      </section>

      <section className="panel studio-panel">
        <h2>Agent activity</h2>
        <ul className="studio-activity">{project.activity.map((event, index) => (
          <li key={`${event.at}-${index}`}><strong>{stageLabels[event.stage]}</strong> · {event.message}</li>
        ))}</ul>
        {!project.activity.length && <p>No activity yet.</p>}
      </section>
    </div>
  );
}

export function Studio() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [storage, setStorage] = useState<Storage | null>(null);
  const [importProgress, setImportProgress] = useState<SceneProgress>({});

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => void request<Storage>("/api/studio/storage", controller.signal).then((value) => {
      if (!controller.signal.aborted) setStorage(value);
    }).catch(() => { if (!controller.signal.aborted) setStorage(null); });
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [pending, project?.status]);

  useEffect(() => {
    const controller = new AbortController();
    request<ProjectSummary[]>(projectsUrl, controller.signal).then((list) => {
      setProjects(list);
      const requested = new URLSearchParams(window.location.search).get("project");
      const initial = list.find((item) => item.id === requested) ?? list[0];
      setId((selected) => selected ?? initial?.id ?? null);
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!id || pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const updated = await request<Project>(`${projectsUrl}/${id}`, controller.signal);
        if (controller.signal.aborted) return;
        setProject(updated);
        setProjects((list) => list.map((item) => item.id === id ? { ...item, status: updated.status } : item));
        if (updated.status === "working") timer = setTimeout(refresh, 650);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : "Could not refresh the project.");
          timer = setTimeout(refresh, 1500);
        }
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, pending]);

  async function mutate(url: string, payload: object, creating = false) {
    setPending(true);
    setError("");
    try {
      const next = await request<Project>(url, undefined, payload);
      if (creating) setProjects((list) => [{ id: next.id, topic: next.brief.topic, status: next.status }, ...list]);
      setId(next.id);
      setProject(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Studio request failed.");
    } finally {
      setPending(false);
    }
  }

  async function importClips(project: Project, items: SceneImport[], onImported: (sceneId: string) => void) {
    setPending(true);
    setImportProgress({});
    setError("");
    try {
      await importScenesInOrder(items, project, {
        upload: ({ sceneId, file, replace }, expectedExport) => {
          if (!file.size || file.size > 32 * 1024 * 1024) {
            throw new Error("Choose a nonempty MP4 file up to 32 MiB.");
          }
          return request<Project>(`${projectsUrl}/${project.id}/scenes/${sceneId}/import?expected_export=${expectedExport}${replace ? "&confirm_replace=yes" : ""}`, undefined, file);
        },
        refresh: () => request<Project>(`${projectsUrl}/${project.id}`),
        update: setProject,
        report: (sceneId, status, message) => {
          setImportProgress((previous) => ({ ...previous, [sceneId]: { status, message } }));
          if (status === "imported") onImported(sceneId);
        },
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page-frame studio">
      <div className="breadcrumb">Workspace / <span>Media Studio</span></div>
      <header className="page-heading"><h1>Media Studio</h1><p>Produce and review a local video. Mock media is the default.</p></header>
      {error && <p role="alert" className="error-text">{error}</p>}
      <section className="panel studio-panel" aria-label="Studio storage">
        <h2>Studio storage</h2>
        {storage ? <>
          <p>Archived exports · {storage.archivedExports} · {archiveSize(storage.archiveBytes)}</p>
          <p>Free disk space · {gib(storage.freeBytes)} · safety floor {gib(storage.floorBytes)}</p>
          {storage.renderPaused && <p role="alert">Rendering paused. Free disk space before starting another export.</p>}
        </> : <p>Storage status unavailable</p>}
      </section>
      <ProjectForm disabled={pending} onCreate={(brief) => void mutate(projectsUrl, brief, true)} />
      <div className="studio-layout">
        <aside className="panel studio-panel"><h2>Projects</h2>
          <ul className="studio-projects">{projects.map((item) => (
            <li key={item.id}><button type="button" aria-pressed={id === item.id} disabled={pending}
              onClick={() => { setError(""); setId(item.id); }}>
              {item.topic}<small>{displayStatus(item.status)}</small>
            </button></li>
          ))}</ul>
        </aside>
        {project && project.id === id && <ProjectView key={project.id} project={project} pending={pending} renderPaused={!!storage?.renderPaused}
          onAction={(action, extra) => void mutate(`${projectsUrl}/${project.id}/actions`, { action, ...extra })}
          importProgress={importProgress}
          onImport={(items, onImported) => void importClips(project, items, onImported)}
          onCancelImport={() => void request<Project>(`${projectsUrl}/${project.id}/actions`, undefined, { action: "cancel" })
            .catch((failure) => setError(failure.message))} />}
      </div>
    </div>
  );
}
