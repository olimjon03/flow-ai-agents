"""Opt-in local terminal tools for manual Chrome and completed Flow downloads."""

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
from collections import deque
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

import httpx

from .media import FFmpeg, MediaError
from .store import ID
from .video_import import MAX_MP4_BYTES, ManualVideoProvider, verify_mp4_signature

FLOW_URL = "https://flow.google.com/"
DIGEST = re.compile(r"[a-f0-9]{64}")
MAX_FOLDER_ENTRIES = 256


class LocalError(MediaError):
    def __init__(self, state, message):
        super().__init__(message)
        self.state = state


def require_opt_in():
    if os.getenv("FLOW_GOOGLE_FLOW_BROWSER_POC") != "1":
        raise LocalError("denied", "Set FLOW_GOOGLE_FLOW_BROWSER_POC=1 for this local command.")


def launch_chrome(confirmed):
    require_opt_in()
    if not confirmed:
        raise LocalError("denied", "Pass --confirm-open to open a manual Chrome window.")
    mac_chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    chrome = str(mac_chrome) if mac_chrome.is_file() else shutil.which("google-chrome")
    if not chrome:
        raise LocalError("chrome_missing", "Install Google Chrome or use the manual Flow website in your own browser.")
    profile = Path.home() / ".flow-ai-google-flow-browser"
    profile.mkdir(mode=0o700, exist_ok=True)
    profile_stat = profile.lstat()
    if (not stat.S_ISDIR(profile_stat.st_mode) or profile_stat.st_uid != os.getuid()
            or profile_stat.st_mode & 0o077):
        raise LocalError("denied", "The dedicated Chrome profile must be a private directory owned by you.")
    desktop_env = {
        key: value for key, value in os.environ.items()
        if key in {"HOME", "USER", "PATH", "TMPDIR", "LANG", "DISPLAY", "WAYLAND_DISPLAY",
                   "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY"} or key.startswith("LC_")
    }
    subprocess.Popen(
        [chrome, f"--user-data-dir={profile}", "--disable-sync", "--new-window", FLOW_URL],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, env=desktop_env,
    )
    return {"state": "login_required", "message": "Check your session or sign in manually in Chrome. Session status is unverified."}


def file_version(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


@contextmanager
def snapshot_mp4(path, version=None):
    if path.suffix.lower() != ".mp4":
        raise LocalError("incomplete", "Choose a completed .mp4 file.")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        raise LocalError("missing_file", "The selected download no longer exists.") from None
    except OSError:
        raise LocalError("denied", "Could not open the download as a local regular file.") from None
    with os.fdopen(fd, "rb") as source, tempfile.TemporaryDirectory(prefix="flow-download-") as directory:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_MP4_BYTES:
            raise LocalError("invalid", "Choose a regular MP4 up to 32 MiB.")
        identity = file_version(info)
        if version is not None and version != identity:
            raise LocalError("incomplete", "The download changed. Wait for it to finish.")
        copy = Path(directory) / "clip.mp4"
        digest = hashlib.sha256()
        remaining = info.st_size
        with copy.open("xb") as destination:
            while remaining:
                chunk = source.read(min(remaining, 256 * 1024))
                if not chunk:
                    raise LocalError("incomplete", "The download changed while reading it.")
                digest.update(chunk)
                destination.write(chunk)
                remaining -= len(chunk)
        try:
            current = file_version(path.lstat())
        except FileNotFoundError:
            raise LocalError("missing_file", "The download was moved while reading it.") from None
        if current != identity or file_version(os.fstat(source.fileno())) != identity:
            raise LocalError("incomplete", "The download changed while reading it.")
        yield copy, digest.hexdigest()


class DownloadsWatcher:
    def __init__(self, directory, probe):
        self.directory = directory
        self.probe = probe
        self.previous = {}
        self.reported = {}
        self.digests = deque(maxlen=1024)

    async def scan(self):
        try:
            if not stat.S_ISDIR(self.directory.lstat().st_mode):
                raise LocalError("denied", "Choose a real, dedicated Downloads subdirectory.")
            with os.scandir(self.directory) as entries:
                names = {}
                for entry in entries:
                    if len(names) >= MAX_FOLDER_ENTRIES:
                        raise LocalError("denied", "Use a dedicated download folder with at most 256 entries.")
                    try:
                        names[entry.name] = entry.stat(follow_symlinks=False)
                    except FileNotFoundError:
                        continue
        except FileNotFoundError:
            raise LocalError("missing_file", "Create or select the dedicated Downloads folder first.") from None
        except PermissionError:
            raise LocalError("denied", "Access to the selected Downloads folder was denied.") from None

        current = {}
        reports = []
        for name, info in sorted(names.items()):
            if (Path(name).suffix.lower() != ".mp4" or name + ".crdownload" in names
                    or not stat.S_ISREG(info.st_mode) or not info.st_size):
                continue
            version = file_version(info)
            current[name] = version
            if self.previous.get(name) != version or self.reported.get(name) == version:
                continue
            try:
                with snapshot_mp4(self.directory / name, version) as (source, digest):
                    if digest in self.digests:
                        result = {"state": "duplicate_download", "file": name}
                    else:
                        verify_mp4_signature(source)
                        duration = await self.probe.probe(source, sample_duration=6)
                        self.digests.append(digest)
                        result = {"state": "ready", "file": name, "sha256": digest, "duration": duration}
            except LocalError as error:
                result = {"state": error.state, "file": name, "message": str(error)}
            except MediaError as error:
                result = {"state": "invalid", "file": name, "message": str(error)}
            if result["state"] not in {"incomplete", "missing_file"}:
                self.reported[name] = version
            reports.append(result)
        self.previous = current
        self.reported = {name: version for name, version in self.reported.items() if name in current}
        return reports


def response_json(response):
    if response.is_error or response.is_redirect:
        try:
            message = response.json().get("detail")
        except ValueError:
            message = None
        raise LocalError("denied", message if isinstance(message, str) else f"Studio returned HTTP {response.status_code}.")
    return response.json()


async def import_download(client, args, report=None):
    if (not all(ID.fullmatch(value) for value in (args.project, args.scene, args.export))
            or not DIGEST.fullmatch(args.sha256)
            or (args.replace_asset and not ID.fullmatch(args.replace_asset))):
        raise LocalError("denied", "Use exact Studio project, scene and export IDs and the detected file SHA-256.")
    project_path = f"/api/studio/projects/{args.project}"
    project = response_json(await client.get(project_path))
    scene = next((item for item in project["scenes"] if item["id"] == args.scene), None)
    if (project["id"] != args.project or not scene or scene["duration"] != 6
            or scene["index"] + 1 != args.confirm_scene):
        raise LocalError("wrong_scene", "The confirmed scene number must match the six-second target scene ID.")
    if project["finalAssetId"] != args.export:
        raise LocalError("denied", "The current export changed. Review the scene and confirm its latest export ID.")
    target = next((a for a in project["assets"] if a["sceneId"] == args.scene and a["stage"] == "video"), None)
    replacement = target["id"] if target and target.get("provider") == "manual" else None
    if replacement != args.replace_asset:
        raise LocalError("denied", "Confirm replacement with the exact current imported clip ID.")
    params = {"expected_export": args.export, "source": "google_flow"}
    headers = {"Content-Type": "video/mp4", "X-Flow-Clip-Name": quote(args.file.name[:150], safe="")}
    if replacement:
        params["replace_asset"] = replacement
        headers["X-Flow-Clip-Sha256"] = args.sha256

    operation_id = None
    try:
        with snapshot_mp4(args.file) as (source, digest):
            if digest != args.sha256:
                raise LocalError("denied", "The file changed since detection. Review the new file before importing.")
            verify_mp4_signature(source)
            accepted = response_json(await client.post(
                f"{project_path}/scenes/{args.scene}/import", params=params, headers=headers, content=source.read_bytes(),
            ))
        operation_id = accepted.get("importOperationId", "")
        if not ID.fullmatch(operation_id):
            raise LocalError("failed", "Studio did not return a valid import ID. Check the project before retrying.")
        if report:
            report({"state": "importing", "operationId": operation_id})
        async with asyncio.timeout(420):
            while True:
                snapshot = response_json(await client.get(f"{project_path}/imports/{operation_id}"))
                operation = snapshot["operation"]
                current = snapshot["project"]
                if (operation["id"], operation["projectId"], operation["sceneId"], operation["targetAssetId"], current["id"]) != (
                    operation_id, args.project, args.scene, target["id"] if target else None, args.project,
                ):
                    raise LocalError("failed", "Studio returned a different operation. Check the project before retrying.")
                if operation["status"] != "working":
                    break
                await asyncio.sleep(0.65)
        active = next((a for a in current["assets"] if a["sceneId"] == args.scene and a["stage"] == "video"), None)
        if operation["status"] != "succeeded":
            raise LocalError(operation["status"], operation["error"] or "Import did not complete.")
        if (not active or active["id"] != operation["resultAssetId"] or active.get("videoSource") != "google_flow_manual"
                or not any(item["id"] == args.scene for item in current["scenes"])):
            raise LocalError("failed", "The exact imported clip is no longer active. Review the project.")
        return {"state": "completed", "operationId": operation_id, "assetId": active["id"]}
    except asyncio.CancelledError:
        if operation_id and ID.fullmatch(operation_id):
            try:
                response_json(await client.post(f"{project_path}/actions", json={
                    "action": "cancel", "cancelImportOperationId": operation_id,
                }, timeout=5))
            except (httpx.HTTPError, LocalError):
                raise LocalError("failed", "Cancellation could not be confirmed. Check the exact operation in Studio.") from None
        else:
            raise LocalError("cancelled", "Local wait cancelled. Check Studio in case upload was accepted.") from None
        raise
    except TimeoutError:
        raise LocalError("failed", "Import polling timed out. Check the exact operation in Studio before retrying.") from None


async def run_local(args):
    require_opt_in()
    if args.command == "watch":
        watcher = DownloadsWatcher(args.directory, ManualVideoProvider(FFmpeg()))
        emit({"state": "watching", "message": "Waiting for stable six-second portrait MP4 downloads."})
        while True:
            for result in await watcher.scan():
                emit(result)
            await asyncio.sleep(2)
    if not 1 <= args.port <= 65535:
        raise LocalError("denied", "Use a valid local Studio port.")
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{args.port}", trust_env=False, timeout=65) as client:
        return await import_download(client, args, report=emit)


def emit(result):
    print(json.dumps(result, ensure_ascii=True), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    launch = commands.add_parser("launch", help="Open a dedicated Chrome window for manual login.")
    launch.add_argument("--confirm-open", action="store_true")
    watch = commands.add_parser("watch", help="Report completed portrait MP4s from a dedicated local folder.")
    watch.add_argument("directory", type=Path)
    importer = commands.add_parser("import", help="Import one explicitly confirmed local file through Studio.")
    importer.add_argument("file", type=Path)
    for option in ("project", "scene", "export", "sha256"):
        importer.add_argument(f"--{option}", required=True)
    importer.add_argument("--confirm-scene", type=int, required=True)
    importer.add_argument("--replace-asset")
    importer.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    try:
        emit(launch_chrome(args.confirm_open) if args.command == "launch" else asyncio.run(run_local(args)))
    except KeyboardInterrupt:
        emit({"state": "cancelled", "message": "Local command stopped. Check Studio for the final import status."})
        return 130
    except LocalError as error:
        emit({"state": error.state, "message": str(error)})
        return 1
    except MediaError as error:
        emit({"state": "invalid", "message": str(error)})
        return 1
    except (httpx.HTTPError, OSError):
        emit({"state": "failed", "message": "Could not complete the local action. Check Studio before retrying."})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
