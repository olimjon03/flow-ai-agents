import assert from "node:assert/strict";
import test from "node:test";
import { forwardDailyVideo } from "../lib/daily-video-proxy.ts";

test("daily video proxy preserves idempotency keys and conflict responses", async () => {
  const payload = { action: "generate-now", request_id: "a".repeat(32) };
  const request = new Request("http://localhost/api/daily-video", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(payload),
  });
  const result = await forwardDailyVideo(request, async (url, init) => {
    assert.equal(new URL(url as URL).pathname, "/api/daily-video");
    assert.deepEqual(JSON.parse(String(init?.body)), payload);
    return Response.json({ detail: "Quota reached" }, { status: 409 });
  });
  assert.equal(result.status, 409);
  assert.equal(result.headers.get("cache-control"), "no-store");
});

test("daily video proxy rejects cross-origin writes before reaching FastAPI", async () => {
  const response = await forwardDailyVideo(new Request("http://localhost/api/daily-video", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://untrusted.example" },
    body: JSON.stringify({ action: "activate" }),
  }), async () => { throw new Error("Unexpected upstream request"); });
  assert.equal(response.status, 403);
});

test("daily video proxy rejects hostile authority and forged same-origin headers", async () => {
  for (const [url, headers] of [
    ["http://untrusted.example/api/daily-video", { origin: "http://untrusted.example" }],
    ["http://localhost/api/daily-video", { host: "untrusted.example", origin: "http://localhost" }],
    ["http://localhost/api/daily-video", { origin: "https://untrusted.example", "sec-fetch-site": "same-origin" }],
    ["http://localhost/api/daily-video", { "x-forwarded-for": "192.0.2.10" }],
  ] as const) {
    const response = await forwardDailyVideo(new Request(url, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ action: "activate" }),
    }), async () => { throw new Error("Unexpected upstream request"); });
    assert.equal(response.status, 403);
  }
});
