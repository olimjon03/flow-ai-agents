"use client";

import { Copy, FileText, LoaderCircle } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { isDraftResponse, MAX_BRIEF_LENGTH, validateDraftRequest, type DraftResponse } from "../lib/generation";

const formats = [
  { id: "post", label: "Social post" },
  { id: "video", label: "Short video script" },
] as const;

export function CreateContentForm() {
  const [result, setResult] = useState<DraftResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [validation, setValidation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    const form = new FormData(event.currentTarget);
    const input = validateDraftRequest({ brief: form.get("brief"), format: form.get("format") });
    setError("");
    setNotice("");
    if (typeof input === "string") {
      setValidation(input);
      return;
    }

    setValidation("");
    setLoading(true);
    inFlight.current = true;

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(35_000),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = payload as { error?: unknown } | null;
        throw new Error(typeof message?.error === "string" ? message.error : "Draft generation failed. Try again.");
      }
      if (!isDraftResponse(payload)) throw new Error("The backend returned an invalid draft.");
      setResult(payload);
      setNotice("Draft ready.");
    } catch (failure) {
      setError(failure instanceof Error && failure.name === "TimeoutError"
        ? "Draft generation timed out. Try again."
        : failure instanceof Error && failure.name === "Error"
          ? failure.message
          : "Draft generation failed. Try again.");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  async function copyDraft() {
    if (!result?.draft.trim()) return;

    try {
      await navigator.clipboard.writeText(result.draft);
      setNotice("Draft copied.");
    } catch {
      editor.current?.focus();
      editor.current?.select();
      setNotice("Draft selected. Press Ctrl+C or ⌘C to copy.");
    }
  }

  return (
    <div className="composer-grid">
      <form className="panel composer-panel" onSubmit={generate} noValidate onChange={() => setValidation("")}>
        <h2 className="section-title">Content brief</h2>
        <label htmlFor="brief" className="field-label">Brief</label>
        <textarea id="brief" name="brief" required maxLength={MAX_BRIEF_LENGTH}
          placeholder="Enter your brief here…" className="brief-input inset" />
        <fieldset className="format-fieldset" disabled={loading}>
          <legend className="field-label">Format</legend>
          {formats.map(({ id, label }) => (
            <label key={id} className="format-option">
              <input type="radio" name="format" value={id} required />
              {label}
            </label>
          ))}
        </fieldset>
        {validation && <p role="alert" className="error-text mb-3">{validation}</p>}
        <button type="submit" className="primary-button w-full" disabled={loading}>
          {loading && <LoaderCircle size={18} className="motion-safe:animate-spin" aria-hidden="true" />}
          {loading ? "Generating…" : "Generate draft"}
        </button>
        <p className="composer-note">OpenAI mode sends your brief to OpenAI.</p>
      </form>

      <section className="panel composer-panel draft-panel" aria-labelledby="draft-title">
        <div className="draft-header">
          <h2 id="draft-title" className="section-title">Draft</h2>
          {result && <span className={`mode mode-${result.mode}`}>{result.mode === "openai" ? "OpenAI generation" : "Sample template"}</span>}
          <button type="button" className="icon-button copy-button" onClick={copyDraft} disabled={loading || !result?.draft.trim()}>
            <Copy aria-hidden="true" size={19} /> Copy
          </button>
        </div>
        {result ? (
          <textarea
            ref={editor}
            aria-label="Edit draft"
            className="draft-editor inset"
            value={result.draft}
            readOnly={loading}
            onChange={(event) => {
              setResult({ ...result, draft: event.target.value });
              setNotice("");
            }}
          />
        ) : (
          <div className="draft-empty inset">
            {loading
              ? <LoaderCircle aria-hidden="true" size={52} strokeWidth={1.3} className="motion-safe:animate-spin" />
              : <FileText aria-hidden="true" size={58} strokeWidth={1.3} />}
            <p>{loading ? "Generating your draft…" : "Your draft will appear here."}</p>
          </div>
        )}
        {error && <p role="alert" className="error-text mt-3">{error}</p>}
        <p role="status" className="composer-note empty:hidden">{loading ? "Generating draft." : notice}</p>
      </section>
    </div>
  );
}
