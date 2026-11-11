import { officeEndpoint } from "../../../../lib/office/upstream.ts";

export const dynamic = "force-dynamic";

const eventHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

function retryStream() {
  // A successful SSE handshake followed by EOF lets EventSource reconnect.
  return new Response("retry: 1500\n\n", { headers: eventHeaders });
}

export async function GET(request: Request) {
  const handshake = new AbortController();
  const timeout = setTimeout(() => handshake.abort(), 4000);
  try {
    const upstream = await fetch(officeEndpoint("events"), {
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, handshake.signal]),
    });

    if (!upstream.ok || !upstream.body
      || !upstream.headers.get("content-type")?.startsWith("text/event-stream")) {
      await upstream.body?.cancel();
      return retryStream();
    }

    return new Response(upstream.body, { headers: eventHeaders });
  } catch {
    return retryStream();
  } finally {
    clearTimeout(timeout);
  }
}
