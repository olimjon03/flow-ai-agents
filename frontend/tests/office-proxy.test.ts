import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/api/office/events/route.ts";
import { POST } from "../app/api/office/tasks/route.ts";

const events = "http://localhost:3000/api/office/events";
const tasks = "http://localhost:3000/api/office/tasks";

test("the SSE proxy forwards bytes without transforming or buffering events", async (t) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: office.snapshot\ndata: {"simulation":true}\n\n'));
    },
  });
  t.mock.method(globalThis, "fetch", async () =>
    new Response(body, { headers: { "Content-Type": "text/event-stream" } }));

  const response = await GET(new Request(events));
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  assert.match(response.headers.get("cache-control")!, /no-transform/);
  const reader = response.body!.getReader();
  try {
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /event: office.snapshot/);
  } finally {
    await reader.cancel();
  }
});

test("the offline SSE proxy leaves EventSource able to retry", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unavailable"); });
  const response = await GET(new Request(events));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "retry: 1500\n\n");
});

test("task proxy guards browser origin and preserves conflict status", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 409 }));
  const request = (headers: Record<string, string>) =>
    new Request(tasks, { method: "POST", headers, body: "{}" });
  assert.equal((await POST(request({ "Sec-Fetch-Site": "cross-site" }))).status, 403);
  assert.equal((await POST(request({ "Content-Type": "text/plain" }))).status, 415);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal((await POST(request({ "Content-Type": "application/json" }))).status, 409);
});
