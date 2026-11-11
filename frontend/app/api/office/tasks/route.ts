import { officeEndpoint } from "../../../../lib/office/upstream.ts";

function reply(payload: object, status: number) {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site" || (
    origin && fetchSite !== "same-origin" && origin !== new URL(request.url).origin
  )) {
    return reply({ error: "Cross-origin requests are not supported." }, 403);
  }

  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return reply({ error: "Expected a JSON request." }, 415);
  }

  try {
    const upstream = await fetch(officeEndpoint("tasks"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
    });
    if (upstream.status !== 202) {
      await upstream.body?.cancel();
      if (upstream.status === 409) return reply({ error: "A demo task is already running." }, 409);
      return reply({ error: "The office service could not start the demo." }, 502);
    }

    const result = await upstream.json();
    if (typeof result?.runId === "string" && result.runId) return reply({ runId: result.runId }, 202);
  } catch {
    // The browser receives an actionable message without upstream configuration.
  }
  return reply({ error: "Could not reach the office service. Check that FastAPI is running." }, 502);
}
