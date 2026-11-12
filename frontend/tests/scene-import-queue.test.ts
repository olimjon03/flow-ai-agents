import assert from "node:assert/strict";
import test from "node:test";
import { importScenesInOrder, videoSourceLabel, type SceneImport } from "../lib/scene-import-queue.ts";

const items: SceneImport[] = Array.from({ length: 5 }, (_, index) => ({
  sceneId: String(index + 1), file: new File(["mp4"], `scene-${index + 1}.mp4`), replace: false,
}));
const ready = (finalAssetId: string) => ({ finalAssetId, status: "awaiting_approval", error: null as string | null });

test("uploads five scenes serially against the latest completed export", async () => {
  const history: string[] = [];
  let active = "";
  await importScenesInOrder(items, ready("0"), {
    upload: async ({ sceneId }, expected) => {
      assert.equal(active, "");
      active = sceneId;
      history.push(`upload ${sceneId} from ${expected}`);
      return { ...ready(expected), status: "working" };
    },
    refresh: async () => {
      const done = ready(active);
      active = "";
      return done;
    },
    update: () => {},
    report: (id, status) => { if (status === "imported") history.push(`complete ${id}`); },
    wait: async () => {},
  });
  assert.deepEqual(history, items.flatMap(({ sceneId }, index) => [
    `upload ${sceneId} from ${index}`, `complete ${sceneId}`,
  ]));
});

test("stops the queue after cancellation and preserves the scene-specific reason", async () => {
  const started: string[] = [];
  const errors: string[] = [];
  await importScenesInOrder(items, ready("0"), {
    upload: async ({ sceneId }, expected) => {
      started.push(sceneId);
      return sceneId === "1" ? ready("1") : { ...ready(expected), status: "cancelled", error: "Cancelled by user." };
    },
    refresh: async () => { throw new Error("Terminal state should not poll"); },
    update: () => {},
    report: (id, status, message) => { if (status === "failed") errors.push(`${id}: ${message}`); },
  });
  assert.deepEqual(started, ["1", "2"]);
  assert.deepEqual(errors, ["2: Cancelled by user."]);
  assert.match(videoSourceLabel(0, 5), /Mock-only/);
  assert.match(videoSourceLabel(2, 5), /Mixed video/);
  assert.equal(videoSourceLabel(5, 5), "All 5 scenes use imported video");
});
