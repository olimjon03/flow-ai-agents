import { errorResponse, readJsonBody } from "../../../../lib/http-json.ts";

type Context = { params: Promise<{ path: string[] }> };
const id = /^[a-f0-9]{32}$/;

async function forward(request: Request, context: Context) {
  const { path } = await context.params;
  const [group, project, resource, asset] = path;
  const reading = request.method === "GET";
  const list = group === "projects" && path.length === 1;
  const detail = group === "projects" && path.length === 2 && id.test(project);
  const media = group === "projects" && path.length === 4 && id.test(project) && resource === "assets" && id.test(asset);
  const action = group === "projects" && path.length === 3 && id.test(project) && resource === "actions";
  if (!(list || (reading ? detail || media : action))) return errorResponse("Studio route not found.", 404);

  const url = new URL(request.url);
  const headers = new Headers();
  let body: string | undefined;
  if (reading) {
    const range = request.headers.get("range");
    if (media && range) headers.set("Range", range);
  } else {
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (site === "cross-site" || (origin && site !== "same-origin" && origin !== url.origin)) {
      return errorResponse("Cross-origin requests are not supported.", 403);
    }
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return errorResponse("Expected JSON.", 415);
    }
    const input = await readJsonBody(request, 4096);
    if (input instanceof Response) return input;
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(input);
  }

  try {
    const upstream = new URL(`/api/studio/${path.join("/")}`, process.env.FLOW_OFFICE_API_URL || "http://127.0.0.1:8001");
    if (media && url.searchParams.get("download") === "true") upstream.searchParams.set("download", "true");
    const response = await fetch(upstream, {
      method: request.method, headers, body, redirect: "error", cache: "no-store",
      signal: media ? request.signal : AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
    });
    const resultHeaders = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    for (const key of ["content-type", "content-disposition", "content-range", "accept-ranges", ...(media ? ["content-length"] : [])]) {
      const value = response.headers.get(key);
      if (value) resultHeaders.set(key, value);
    }
    return new Response(response.body, { status: response.status, headers: resultHeaders });
  } catch {
    return errorResponse("Studio backend is unavailable. Start the FastAPI service.", 502);
  }
}

export const GET = forward;
export const POST = forward;
