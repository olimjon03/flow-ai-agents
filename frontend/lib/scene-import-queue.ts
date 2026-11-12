export type SceneImport = { sceneId: string; file: File; replace: boolean };
export type ImportStatus = "uploading" | "rendering" | "imported" | "failed";
type ImportProject = { status: string; finalAssetId: string | null; error: string | null };

export async function importScenesInOrder<T extends ImportProject>(
  items: SceneImport[], initial: T, {
    upload, refresh, update, report, wait = () => new Promise<void>((resolve) => setTimeout(resolve, 650)),
  }: {
    upload: (item: SceneImport, expectedExport: string) => Promise<T>;
    refresh: () => Promise<T>;
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
      report(item.sceneId, "uploading");
      project = await upload(item, previous);
      update(project);
      report(item.sceneId, "rendering");
      const deadline = Date.now() + 7 * 60 * 1000;
      while (project.status === "working" && Date.now() < deadline) {
        await wait();
        project = await refresh();
        update(project);
      }
      if (project.status === "working") throw new Error("Still processing. Check the project before retrying.");
      if (project.status !== "awaiting_approval" || !project.finalAssetId || project.finalAssetId === previous) {
        throw new Error(project.error || "The import did not produce a replacement export.");
      }
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
