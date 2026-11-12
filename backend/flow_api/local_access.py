"""Mutation boundary for local single-user APIs."""

import re
from ipaddress import ip_address

from fastapi import HTTPException, Request

LOCAL_AUTHORITY = re.compile(r"(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?", re.IGNORECASE | re.ASCII)


def require_local_mutation(request: Request):
    try:
        peer = ip_address(request.client.host if request.client else "")
        peer = getattr(peer, "ipv4_mapped", None) or peer
        loopback = peer.is_loopback
    except ValueError:
        loopback = False
    hosts = request.headers.getlist("host")
    authority = LOCAL_AUTHORITY.fullmatch(hosts[0]) if len(hosts) == 1 else None
    if not loopback or not authority or (authority[1] and not 1 <= int(authority[1]) <= 65535):
        raise HTTPException(403, "This action is only available on localhost.")
    if any(header in request.headers for header in (
        "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
    )):
        raise HTTPException(403, "Forwarded local mutations are not supported.")
    origins = request.headers.getlist("origin")
    scheme = request.scope["scheme"]
    host = hosts[0].lower()
    default_port = "80" if scheme == "http" else "443"
    if authority[1] == default_port:
        host = host.removesuffix(f":{default_port}")
    expected = f"{scheme}://{host}"
    if origins and (len(origins) != 1 or origins[0].lower() != expected):
        raise HTTPException(403, "Cross-origin local mutations are not supported.")

