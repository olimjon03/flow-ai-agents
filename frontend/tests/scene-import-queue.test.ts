import assert from "node:assert/strict";
import test from "node:test";
import { importScenesInOrder, videoSourceLabel, type ImportOperation, type SceneImport } from "../lib/scene-import-queue.ts";

const items: SceneImport[] = Array.from({ length: 5 }, (_, index) => ({
  sceneId: String(index + 1), file: new File(["mp4"], `scene-${index + 1}.mp4`), replaceAssetId: null,
}));
const ready = (count: number) => ({
  id: "project", finalAssetId: `export-${count}`, scenes: items.map(({ sceneId: id }) => ({ id })),
  assets: items.map(({ sceneId }, index) => ({
    sceneId, stage: "video", id: index < count ? `manual-${sceneId}` : `mock-${sceneId}`,
    provider: index < count ? "manual" : "mock",
  })),
});
const operation = (sceneId: string, status: ImportOperation["status"] = "succeeded"): ImportOperation => ({
  id: sceneId.repeat(32), projectId: "project", sceneId, targetAssetId: `mock-${sceneId}`, status,
  resultAssetId: status === "succeeded" ? `manual-${sceneId}` : null, error: null,
});

test("uploads five scenes serially after exact terminal operation and scene asset checks", async () => {
  const history: string[] = [];
  let active = "";
  let waiting = true;
  await importScenesInOrder(items, ready(0), {
    upload: async ({ sceneId }, expected) => {
      assert.equal(active, "");
      active = sceneId;
      waiting = true;
      history.push(`upload ${sceneId} from ${expected}`);
      return { ...ready(Number(sceneId) - 1), importOperationId: operation(sceneId).id };
    },
    refresh: async (id) => {
      assert.equal(id, operation(active).id);
      if (waiting) {
        waiting = false;
        return { operation: operation(active, "working"), project: ready(Number(active) - 1) };
      }
      const done = { operation: operation(active), project: ready(Number(active)) };
      active = "";
      return done;
    },
    update: () => {},
    report: (id, status) => { if (status === "imported") history.push(`complete ${id}`); },
    wait: async () => {},
  });
  assert.deepEqual(history, items.flatMap(({ sceneId }, index) => [
    `upload ${sceneId} from export-${index}`, `complete ${sceneId}`,
  ]));
});

test("never advances on unrelated, failed, cancelled or superseded operation snapshots", async () => {
  const failures = [
    { operation: operation("2"), project: ready(5), message: /did not match/ },
    { operation: { ...operation("1", "failed"), error: "Invalid media" }, project: ready(5), message: /Invalid media/ },
    { operation: operation("1", "cancelled"), project: ready(5), message: /cancelled/ },
    { operation: operation("1"), project: ready(0), message: /no longer active/ },
  ];
  for (const { operation: returned, project, message } of failures) {
    const started: string[] = [];
    const reports: string[] = [];
    await importScenesInOrder(items, ready(0), {
      upload: async ({ sceneId }) => {
        started.push(sceneId);
        return { ...ready(0), importOperationId: operation(sceneId).id };
      },
      refresh: async () => ({ operation: returned, project }),
      update: () => {},
      report: (id, status, detail) => reports.push(`${id}: ${status}: ${detail ?? ""}`),
      wait: async () => {},
    });
    assert.deepEqual(started, ["1"]);
    assert.match(reports.at(-1)!, message);
    assert.ok(reports.every((entry) => !entry.includes(": imported:")));
  }
});

test("stops when the clip confirmed earlier was replaced in another tab", async () => {
  const confirmed = { ...items[0], replaceAssetId: "older-clip" };
  const errors: string[] = [];
  await importScenesInOrder([confirmed], ready(1), {
    upload: async () => { throw new Error("Unexpected upload"); },
    refresh: async () => { throw new Error("Unexpected polling"); },
    update: () => {},
    report: (_id, status, message) => { if (status === "failed") errors.push(message!); },
  });
  assert.match(errors[0], /confirm the replacement again/);
  assert.match(videoSourceLabel(0, 5), /Mock-only/);
  assert.match(videoSourceLabel(2, 5), /Mixed video/);
  assert.equal(videoSourceLabel(5, 5), "All 5 scenes use imported video");
});
