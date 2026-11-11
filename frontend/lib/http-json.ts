export function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function readJsonBody(request: Request, maxBodyBytes: number): Promise<unknown | Response> {
  if (Number(request.headers.get("content-length")) > maxBodyBytes) {
    return errorResponse("Request body is too large.", 413);
  }

  const reader = request.body?.getReader();
  if (!reader) return errorResponse("Expected a JSON request body.", 400);

  const bytes = new Uint8Array(maxBodyBytes);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > maxBodyBytes) {
        void reader.cancel().catch(() => {});
        return errorResponse("Request body is too large.", 413);
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch {
    return errorResponse("Invalid JSON request body.", 400);
  } finally {
    reader.releaseLock();
  }
}
