import { errorResponse } from "./http-json.ts";
import { localMutationError } from "./local-mutation.ts";

const maxBytes = 32 * 1024 * 1024;

export async function forwardClipImport(request: Request, projectId: string, sceneId: string, fetcher = fetch) {
  const denied = localMutationError(request);
  if (denied) return denied;
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "video/mp4") {
    return errorResponse("Upload a video/mp4 file.", 415);
  }
  if ((request.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity") {
    return errorResponse("Compressed request bodies are not supported.", 415);
  }
  const length = request.headers.get("content-length");
  if (length && (!/^\d{1,9}$/.test(length) || Number(length) > maxBytes)) {
    return errorResponse("The MP4 exceeds the 32 MiB limit.", 413);
  }
  if (!request.body) return errorResponse("An MP4 file is required.", 400);
  const params = new URL(request.url).searchParams;
  const expectedExport = params.get("expected_export");
  const replaceAsset = params.get("replace_asset");
  const digest = request.headers.get("x-flow-clip-sha256");
  if ((replaceAsset !== null || digest !== null) &&
    (!replaceAsset || !/^[a-f0-9]{32}$/.test(replaceAsset) || !digest || !/^[a-f0-9]{64}$/.test(digest))) {
    return errorResponse("Replacement requires the current clip ID and confirmed file digest.", 422);
  }
  if (![projectId, sceneId, expectedExport].every((value) => value !== null && /^[a-f0-9]{32}$/.test(value))) {
    return errorResponse("Invalid project, scene or export ID.", 422);
  }

  try {
    const upstream = new URL(`/api/studio/projects/${projectId}/scenes/${sceneId}/import`,
      process.env.FLOW_OFFICE_API_URL || "http://127.0.0.1:8001");
    upstream.searchParams.set("expected_export", expectedExport!);
    if (replaceAsset) upstream.searchParams.set("replace_asset", replaceAsset);
    const headers = new Headers({ "Content-Type": "video/mp4" });
    const filename = request.headers.get("x-flow-clip-name");
    if (filename) headers.set("X-Flow-Clip-Name", filename);
    if (digest) headers.set("X-Flow-Clip-Sha256", digest);
    const options: RequestInit & { duplex: "half" } = {
      method: "POST", headers, body: request.body, duplex: "half",
      cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(65_000)]),
    };
    const response = await fetcher(upstream, options);
    return new Response(response.body, {
      status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse("Could not upload the MP4 to the local Studio service.", 502);
  }
}
