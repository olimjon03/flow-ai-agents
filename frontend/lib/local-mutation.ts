import { errorResponse } from "./http-json.ts";

export function localMutationError(request: Request) {
  const url = new URL(request.url);
  const localAuthority = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i;
  const host = request.headers.get("host");
  const forwarded = request.headers.get("x-forwarded-for");
  if (!localAuthority.test(url.host) || (host && !localAuthority.test(host))
    || (forwarded && !forwarded.split(",").every((peer) =>
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer.trim())))) {
    return errorResponse("This action is only available on localhost.", 403);
  }
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  // Next may normalize its internal URL to localhost; the validated Host is the browser authority.
  const browserOrigin = new URL(`${url.protocol}//${host ?? url.host}`).origin;
  if (fetchSite === "cross-site" || (origin && origin !== browserOrigin)) {
    return errorResponse("Cross-origin requests are not supported.", 403);
  }
  return null;
}
