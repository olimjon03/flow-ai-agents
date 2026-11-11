"use client";

import dynamic from "next/dynamic";
import { Hand, Minus, Plus, RotateCcw } from "lucide-react";
import { Component, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Agent } from "../../lib/office/model";
import type { CameraCommand } from "./office-scene";

const OfficeScene = dynamic(() => import("./office-scene"), {
  ssr: false,
  loading: () => <p className="office-scene-loading" role="status">Loading 3D office…</p>,
});

const compactQuery = "(max-width: 1060px)";
const motionQuery = "(prefers-reduced-motion: reduce)";

function observe(query: string, onChange: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

const subscribeCompact = (onChange: () => void) => observe(compactQuery, onChange);
const subscribeMotion = (onChange: () => void) => observe(motionQuery, onChange);
const getCompact = () => {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return window.matchMedia(compactQuery).matches || (memory !== undefined && memory <= 2);
};
const getMotion = () => window.matchMedia(motionQuery).matches;
const serverCompact = () => true;
const serverMotion = () => false;

class SceneBoundary extends Component<{ children: ReactNode; onUnavailable: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onUnavailable();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function ScenePanel({ agents, selectedId, onSelect, reducedMotion, onUnavailable }: {
  agents: readonly Agent[];
  selectedId?: string;
  onSelect: (id: string) => void;
  reducedMotion: boolean;
  onUnavailable: () => void;
}) {
  const [command, setCommand] = useState<CameraCommand | null>(null);
  const [visible, setVisible] = useState(true);
  const scene = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scene.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(scene.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="office-scene" ref={scene}>
      <div className="office-camera" role="group" aria-label="Office camera">
        <span className="office-pan-hint"><Hand size={15} aria-hidden="true" /> Drag or use arrow keys to pan</span>
        <button type="button" aria-label="Zoom out" onClick={() => setCommand({ action: "out" })}><Minus size={16} aria-hidden="true" /></button>
        <button type="button" aria-label="Zoom in" onClick={() => setCommand({ action: "in" })}><Plus size={16} aria-hidden="true" /></button>
        <button type="button" aria-label="Reset camera" onClick={() => setCommand({ action: "reset" })}><RotateCcw size={16} aria-hidden="true" /></button>
      </div>
      <SceneBoundary onUnavailable={onUnavailable}>
        <OfficeScene agents={agents} selectedId={selectedId} onSelect={onSelect}
          reducedMotion={reducedMotion} visible={visible} command={command} onUnavailable={onUnavailable} />
      </SceneBoundary>
    </div>
  );
}

export function OfficeViewport({ agents, selectedId, onSelect, fallback }: {
  agents: readonly Agent[];
  selectedId?: string;
  onSelect: (id: string) => void;
  fallback: ReactNode;
}) {
  const compact = useSyncExternalStore(subscribeCompact, getCompact, serverCompact);
  const reducedMotion = useSyncExternalStore(subscribeMotion, getMotion, serverMotion);
  const [useList, setUseList] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const onUnavailable = useCallback(() => setUnavailable(true), []);
  const showScene = !compact && !useList && !unavailable;

  return (
    <section className={`office-panel office-workstations${showScene ? " office-viewport" : ""}`}
      aria-labelledby="workstations-title">
      <header className="office-workstation-header">
        <h2 id="workstations-title">Workstations</h2>
        {!compact && !unavailable && (
          <button type="button" className="office-view-button" onClick={() => setUseList(!useList)}>
            {showScene ? "Switch to 2D" : "Switch to 3D"}
          </button>
        )}
      </header>
      {showScene ? (
        <ScenePanel agents={agents} selectedId={selectedId} onSelect={onSelect}
          reducedMotion={reducedMotion} onUnavailable={onUnavailable} />
      ) : (
        <>
          {unavailable && <p className="office-muted office-fallback-note">3D is unavailable on this device. Showing the 2D office.</p>}
          {fallback}
        </>
      )}
    </section>
  );
}
