import { isDraftResponse, validateDraftRequest } from "../../../lib/generation.ts";

const defaultApiUrl = "http://127.0.0.1:8000/api/generate";

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
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

  const payload = await request.json().catch(() => null);
  const input = validateDraftRequest(payload);
  if (typeof input === "string") return errorResponse(input, 400);

  try {
    const upstream = await fetch(process.env.FLOW_API_URL || defaultApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(32_000)]),
    });

    if (!upstream.ok) {
      if (upstream.status === 400) return errorResponse("The backend rejected the brief. Check the text and format.", 400);
      return errorResponse("Draft generation failed. Try again.", 502);
    }

    const result: unknown = await upstream.json();
    if (!isDraftResponse(result)) return errorResponse("The backend returned an invalid draft.", 502);

    return Response.json({ draft: result.draft, mode: result.mode }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return errorResponse("The backend took too long to respond. Try again.", 504);
    }
    return errorResponse("Could not reach the draft API. Check that the Python server is running and try again.", 502);
  }
}
