export type SceneImport = { sceneId: string; file: File; replaceAssetId: string | null };
export type ImportStatus = "uploading" | "rendering" | "imported" | "failed";
type ImportProject = {
  id: string;
  finalAssetId: string | null;
  scenes: { id: string }[];
  assets: { id: string; sceneId: string | null; stage: string; provider?: string }[];
};
export type ImportOperation = {
  id: string;
  projectId: string;
  sceneId: string;
  targetAssetId: string | null;
  status: "working" | "succeeded" | "failed" | "cancelled";
  resultAssetId: string | null;
  error: string | null;
};

function sceneAsset(project: ImportProject, sceneId: string) {
  return project.assets.find((asset) => asset.sceneId === sceneId && asset.stage === "video");
}

export async function importScenesInOrder<T extends ImportProject>(
  items: SceneImport[], initial: T, {
    upload, refresh, update, report, wait = () => new Promise<void>((resolve) => setTimeout(resolve, 650)),
  }: {
    upload: (item: SceneImport, expectedExport: string) => Promise<T & { importOperationId: string }>;
    refresh: (operationId: string) => Promise<{ operation: ImportOperation; project: T }>;
    update: (project: T) => void;
    report: (sceneId: string, status: ImportStatus, message?: string) => void;
    wait?: () => Promise<void>;
  },
) {
  let project = initial;
  for (const item of items) {
    try {
      const previous = project.finalAssetId;
      if (!previous) throw new Error("Create a vertical export before importing clips.");
      const target = sceneAsset(project, item.sceneId);
      if ((target?.provider === "manual" ? target.id : null) !== item.replaceAssetId) {
        throw new Error("The scene clip changed. Review it and confirm the replacement again.");
      }
      report(item.sceneId, "uploading");
      const accepted = await upload(item, previous);
      const operationId = accepted.importOperationId;
      if (!/^[a-f0-9]{32}$/.test(operationId) || accepted.id !== initial.id) {
        throw new Error("Could not verify the import operation. Refresh the project before retrying.");
      }
      update(accepted);
      report(item.sceneId, "rendering");
      const deadline = Date.now() + 7 * 60 * 1000;
      let completed = false;
      while (Date.now() < deadline) {
        await wait();
        const snapshot = await refresh(operationId);
        const { operation } = snapshot;
        if (operation.id !== operationId || operation.projectId !== initial.id || operation.sceneId !== item.sceneId
          || operation.targetAssetId !== (target?.id ?? null) || snapshot.project.id !== initial.id) {
          throw new Error("The response did not match this import. Refresh the project before retrying.");
        }
        project = snapshot.project;
        update(project);
        if (operation.status === "working") continue;
        if (operation.status !== "succeeded") {
          throw new Error(operation.error || (operation.status === "cancelled" ? "Import cancelled. Retry when ready." : "Import failed. Check the file and retry."));
        }
        const active = sceneAsset(project, item.sceneId);
        if (!operation.resultAssetId || active?.id !== operation.resultAssetId || active.provider !== "manual"
          || !project.scenes.some((scene) => scene.id === item.sceneId)) {
          throw new Error("The imported clip is no longer active. Review the current scene before retrying.");
        }
        completed = true;
        break;
      }
      if (!completed) throw new Error("Still processing. Check the project before retrying.");
      report(item.sceneId, "imported");
    } catch (failure) {
      report(item.sceneId, "failed", failure instanceof Error ? failure.message : "Import failed.");
      break;
    }
  }
}

export function videoSourceLabel(imported: number | undefined, total: number | undefined) {
  if (imported === undefined || !total) return "Video source not recorded for this export";
  if (imported === 0) return "Mock-only video · no imported clips";
  if (imported === total) return `All ${total} scenes use imported video`;
  return `Mixed video · ${imported} of ${total} scenes use imported clips`;
}
