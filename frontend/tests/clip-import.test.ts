import assert from "node:assert/strict";
import test from "node:test";
import { forwardClipImport } from "../lib/clip-import-proxy.ts";

const project = "a".repeat(32);
const scene = "b".repeat(32);
const exportId = "c".repeat(32);
const replaceAsset = "d".repeat(32);
const digest = "e".repeat(64);

test("clip import proxy streams bytes and binds the upload to the current export", async () => {
  const body = new Uint8Array([0, 1, 2, 3]);
  const incoming = new Request(`http://localhost/import?expected_export=${exportId}&replace_asset=${replaceAsset}`, {
    method: "POST", headers: { "Content-Type": "video/mp4", Origin: "http://localhost", "X-Flow-Clip-Sha256": digest }, body,
  });
  const result = await forwardClipImport(incoming, project, scene, async (url, options) => {
    const target = new URL(url as URL);
    assert.equal(target.pathname, `/api/studio/projects/${project}/scenes/${scene}/import`);
    assert.equal(target.searchParams.get("expected_export"), exportId);
    assert.equal(target.searchParams.get("replace_asset"), replaceAsset);
    assert.equal(new Headers(options?.headers).get("x-flow-clip-sha256"), digest);
    assert.deepEqual(new Uint8Array(await new Response(options?.body).arrayBuffer()), body);
    return Response.json({ status: "working" }, { status: 202 });
  });
  assert.equal(result.status, 202);
});

test("clip import proxy rejects hostile origin, oversized files, and traversal", async () => {
  for (const [headers, target, status] of [
    [{ Origin: "https://untrusted.example" }, project, 403],
    [{ "Content-Length": String(33 * 1024 * 1024) }, project, 413],
    [{}, "../../outside", 422],
  ] as const) {
    const request = new Request(`http://localhost/import?expected_export=${exportId}`, {
      method: "POST", headers: { "Content-Type": "video/mp4", ...headers }, body: new Uint8Array([1]),
    });
    const result = await forwardClipImport(request, target, scene, async () => {
      throw new Error("Rejected request reached the backend");
    });
    assert.equal(result.status, status);
  }
});
