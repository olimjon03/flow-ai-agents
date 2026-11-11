import { errorResponse, readJsonBody } from "../../../../lib/http-json.ts";
import { officeEndpoint } from "../../../../lib/office/upstream.ts";

async function forward(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site" || (
    origin && fetchSite !== "same-origin" && origin !== new URL(request.url).origin
  )) {
    return errorResponse("Cross-origin requests are not supported.", 403);
  }

  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return errorResponse("Expected a JSON request.", 415);
  }

  const payload = await readJsonBody(request, 4096);
  if (payload instanceof Response) return payload;
  const cancelling = request.method === "DELETE";
  const runId = (payload as { runId?: unknown } | null)?.runId;
  if (cancelling && (typeof runId !== "string" || !/^[a-f0-9]{32}$/.test(runId))) {
    return errorResponse("A valid run ID is required.", 400);
  }

  try {
    const upstream = await fetch(officeEndpoint(cancelling ? `tasks/${runId}` : "tasks"), {
      method: request.method,
      headers: { "Content-Type": "application/json" },
      body: cancelling ? undefined : JSON.stringify(payload),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
    });
    if (cancelling && upstream.status === 204) return new Response(null, { status: 204 });
    if (!cancelling && upstream.status === 202) {
      const result = await upstream.json();
      if (typeof result?.runId === "string" && result.runId) {
        return Response.json({ runId: result.runId }, { status: 202, headers: { "Cache-Control": "no-store" } });
      }
    } else {
      await upstream.body?.cancel();
      if (upstream.status === 409) {
        return errorResponse(cancelling ? "This run is no longer active." : "A run is active or the provider mode changed.", 409);
      }
      if (upstream.status === 422) return errorResponse("Check the task fields and duration.", 422);
    }
  } catch {
    // Upstream configuration and provider credentials stay on the server.
  }

  return errorResponse("Could not reach the office service. Check that FastAPI is running.", 502);
}

export const POST = forward;
export const DELETE = forward;
