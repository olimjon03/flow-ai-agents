"""Serve the local Flow AI prototype and its draft API."""

import argparse
import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from openai_provider import DEFAULT_MODEL, GenerationError, generate_draft

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"
MAX_BODY_BYTES = 16_384
MAX_BRIEF_UNITS = 1_000


def sample_post(brief):
    return "\n\n".join((
        "E’tiborni tortadigan sarlavha yozing.",
        brief,
        "Mavzuni bitta aniq misol bilan ochib bering.",
        "Yakunida o‘quvchiga savol bering yoki keyingi qadamni taklif qiling.",
    ))


def sample_video(brief):
    return "\n\n".join((
        "0–3 soniya · Kirish\nTomoshabin e’tiborini tortadigan savol yoki jumla ayting.",
        f"3–20 soniya · Asosiy qism\n{brief}\nAsosiy fikrni bitta misol yoki kadr bilan ko‘rsating.",
        "20–30 soniya · Yakun\nBitta xulosa ayting va tomoshabinga keyingi qadamni taklif qiling.",
    ))


TEMPLATES = {"post": sample_post, "video": sample_video}


class FlowHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, generate, mode, **kwargs):
        self.generate = generate
        self.mode = mode
        super().__init__(*args, **kwargs)

    def send_head(self):
        # The frontend directory also contains the Next.js source and local config.
        if urlsplit(self.path).path not in {"/", "/index.html", "/app.js", "/styles.css"}:
            self.send_error(404)
            return None
        return super().send_head()

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urlsplit(self.path).path != "/api/generate":
            self.send_json(404, {"error": "Endpoint not found."})
            return

        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "Expected application/json."})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0

        if length > MAX_BODY_BYTES:
            self.send_json(413, {"error": "Request body is too large."})
            return
        if length <= 0:
            self.send_json(400, {"error": "Expected a JSON request body."})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, RecursionError):
            self.send_json(400, {"error": "Invalid JSON request body."})
            return

        if not isinstance(payload, dict):
            self.send_json(400, {"error": "Expected a JSON object."})
            return

        brief = payload.get("brief")
        format_name = payload.get("format")
        if not isinstance(brief, str) or not brief.strip():
            self.send_json(400, {"error": "Brief is required."})
            return

        try:
            brief_units = len(brief.encode("utf-16-le")) // 2
        except UnicodeEncodeError:
            self.send_json(400, {"error": "Brief contains invalid characters."})
            return
        if brief_units > MAX_BRIEF_UNITS:
            self.send_json(400, {"error": "Brief exceeds the length limit."})
            return

        if not isinstance(format_name, str) or format_name not in TEMPLATES:
            self.send_json(400, {"error": "Format must be post or video."})
            return

        try:
            draft = self.generate(brief.strip(), format_name)
        except GenerationError as exc:
            self.log_error("%s", exc)
            self.send_json(502, {"error": "Draft generation failed."})
            return

        self.send_json(200, {"draft": draft, "mode": self.mode})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--openai", action="store_true", help="Generate drafts with OpenAI.")
    args = parser.parse_args()

    def sample_draft(brief, format_name):
        return TEMPLATES[format_name](brief)

    generate = sample_draft
    mode = "sample"
    if args.openai:
        api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not api_key:
            parser.error("--openai requires OPENAI_API_KEY in the server environment.")
        model = os.environ.get("OPENAI_MODEL", "").strip() or DEFAULT_MODEL
        generate = partial(generate_draft, api_key=api_key, model=model)
        mode = "openai"

    handler = partial(FlowHandler, directory=FRONTEND, generate=generate, mode=mode)
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"Flow AI: http://localhost:{server.server_port} ({mode})", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
