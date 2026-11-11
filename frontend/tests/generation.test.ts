import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/generate/route.ts";
import { isDraftResponse, validateDraftRequest } from "../lib/generation.ts";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("validates both formats and the Python-compatible UTF-16 length limit", () => {
  for (const format of ["post", "video"]) {
    assert.deepEqual(validateDraftRequest({ brief: "  Sinov  ", format }), { brief: "Sinov", format });
  }
  assert.equal(typeof validateDraftRequest({ brief: " ", format: "post" }), "string");
  assert.equal(typeof validateDraftRequest({ brief: "a", format: "other" }), "string");
  assert.equal(typeof validateDraftRequest({ brief: "😀".repeat(501), format: "post" }), "string");
  assert.equal(typeof validateDraftRequest({ brief: "😀".repeat(500), format: "post" }), "object");
});

test("accepts explicit modes and rejects unknown modes and empty drafts", () => {
  assert.ok(isDraftResponse({ draft: "Sample", mode: "sample" }));
  assert.ok(isDraftResponse({ draft: "AI", mode: "openai" }));
  assert.ok(!isDraftResponse({ draft: "AI" }));
  assert.ok(!isDraftResponse({ draft: " ", mode: "sample" }));
});

test("rejects invalid or cross-origin requests before contacting Python", async () => {
  assert.equal((await POST(request({ brief: "", format: "post" }))).status, 400);
  assert.equal((await POST(request({}, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await POST(request({}, { Origin: "https://example.com" }))).status, 403);
});

test("uses the configured endpoint and returns only the expected response fields", async (t) => {
  const old = process.env.FLOW_API_URL;
  process.env.FLOW_API_URL = "http://127.0.0.1:8999/api/generate";
  t.after(() => {
    if (old === undefined) delete process.env.FLOW_API_URL;
    else process.env.FLOW_API_URL = old;
  });

  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ draft: "Sinov", mode: "openai", extra: "ignored" }));

  // Next may normalize 127.0.0.1 to localhost in the server-side URL.
  const response = await POST(request(
    { brief: " Sinov ", format: "video", mode: "sample" },
    { Origin: "http://127.0.0.1:3000", "Sec-Fetch-Site": "same-origin" },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { draft: "Sinov", mode: "openai" });
  const [[url, init]] = fetchMock.mock.calls.map(({ arguments: args }) => args as unknown as [string, RequestInit]);
  assert.equal(url, process.env.FLOW_API_URL);
  assert.deepEqual(JSON.parse(String(init.body)), { brief: "Sinov", format: "video" });
});

test("maps unavailable, timed-out and malformed upstream responses to safe errors", async (t) => {
  const input = { brief: "Sinov", format: "post" };
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Private URL"); });
  const offline = await POST(request(input));
  assert.equal(offline.status, 502);
  assert.ok(!(await offline.text()).includes("Private URL"));

  fetchMock.mock.mockImplementation(async () => { throw new DOMException("Timed out", "TimeoutError"); });
  assert.equal((await POST(request(input))).status, 504);

  fetchMock.mock.mockImplementation(async () => Response.json({ draft: "Missing mode" }));
  assert.equal((await POST(request(input))).status, 502);
});

test("rejects oversized and malformed JSON before forwarding it to Python", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const input = { brief: "Sinov", format: "post" };
  assert.equal((await POST(request(input, { "Content-Length": "16385" }))).status, 413);

  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8192));
      controller.enqueue(new Uint8Array(8193));
      controller.close();
    },
  });
  const streamed = new Request("http://localhost:3000/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: chunks,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.equal((await POST(streamed)).status, 413);

  const invalid = new Request("http://localhost:3000/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal((await POST(invalid)).status, 400);
  assert.equal(upstream.mock.callCount(), 0);
});
