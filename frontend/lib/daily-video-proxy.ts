import { errorResponse, readJsonBody } from "./http-json.ts";

export async function forwardDailyVideo(request: Request, fetcher = fetch) {
  const write = request.method === "POST";
  let body: string | undefined;
  if (write) {
    const url = new URL(request.url);
    const localAuthority = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i;
    const host = request.headers.get("host");
    const forwarded = request.headers.get("x-forwarded-for");
    if (!localAuthority.test(url.host) || (host && !localAuthority.test(host))
      || (forwarded && !forwarded.split(",").every((peer) =>
        ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer.trim())))) {
      return errorResponse("Daily Video settings may only be changed on localhost.", 403);
    }
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    // Next may normalize its internal URL to localhost; the validated Host is the browser authority.
    const browserOrigin = new URL(`${url.protocol}//${host ?? url.host}`).origin;
    if (fetchSite === "cross-site" || (origin && origin !== browserOrigin)) {
      return errorResponse("Cross-origin requests are not supported.", 403);
    }
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return errorResponse("Expected JSON.", 415);
    }
    const payload = await readJsonBody(request, 4096);
    if (payload instanceof Response) return payload;
    body = JSON.stringify(payload);
  }
  try {
    const url = new URL("/api/daily-video", process.env.FLOW_OFFICE_API_URL || "http://127.0.0.1:8001");
    const response = await fetcher(url, {
      method: request.method, headers: write ? { "Content-Type": "application/json" } : undefined,
      body, redirect: "error", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
    });
    return new Response(response.body, {
      status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse("Daily Video backend is unavailable. Start the FastAPI service.", 502);
  }
}

