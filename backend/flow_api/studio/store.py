"""SQLite metadata and a project-scoped media directory."""

import fcntl
import json
import re
import sqlite3
import shutil
from contextlib import closing, contextmanager
from pathlib import Path
from time import time

ID = re.compile(r"[a-f0-9]{32}")
UPLOAD_DIRECTORY = re.compile(r"\.upload-[a-z0-9_]{8}")
MEDIA_TYPES = {
    ".png": "image/png",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".srt": "application/x-subrip",
    ".vtt": "text/vtt",
}


class ProjectStore:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = self.root / "projects.sqlite3"
        with closing(self.connect()) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, created TEXT, data TEXT)")

    @contextmanager
    def upload_slot(self):
        # The same root-wide lock protects uploads and startup cleanup across workers.
        with (self.root / ".upload.lock").open("ab") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
            else:
                yield True

    def recover_uploads(self, *, max_age=24 * 60 * 60):
        with self.upload_slot() as acquired:
            if not acquired:
                return
            cutoff = time() - max_age
            for project in self.root.iterdir():
                if not ID.fullmatch(project.name) or project.is_symlink() or not project.is_dir():
                    continue
                for directory in project.glob(".upload-*"):
                    if not UPLOAD_DIRECTORY.fullmatch(directory.name) or directory.is_symlink():
                        continue
                    try:
                        if directory.is_dir() and directory.stat().st_mtime < cutoff:
                            shutil.rmtree(directory)
                    except FileNotFoundError:
                        continue

    def connect(self):
        return sqlite3.connect(self.db, timeout=3)

    def save(self, project):
        with closing(self.connect()) as db, db:
            db.execute(
                "INSERT INTO projects VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                (project["id"], project["createdAt"], json.dumps(project, ensure_ascii=False)),
            )

    def save_review(self, project, asset_id, previous_updated_at):
        with closing(self.connect()) as db, db:
            cursor = db.execute(
                "UPDATE projects SET data=? WHERE id=? AND json_extract(data, '$.finalAssetId')=? "
                "AND json_extract(data, '$.replacementJob') IS NULL "
                "AND json_extract(data, '$.status') IN ('awaiting_approval', 'approved', 'rejected') "
                "AND json_extract(data, '$.updatedAt')=?",
                (json.dumps(project, ensure_ascii=False), project["id"], asset_id, previous_updated_at),
            )
            return cursor.rowcount == 1

    def claim_replacement(self, project, job_id):
        with closing(self.connect()) as db, db:
            cursor = db.execute(
                "UPDATE projects SET data=? WHERE id=? AND json_extract(data, '$.replacementJob') IS NULL "
                "AND json_extract(data, '$.status') != 'working' AND json_extract(data, '$.updatedAt')=?",
                (json.dumps({**project, "replacementJob": job_id, "replacementStages": project["stages"],
                             "status": "working"}, ensure_ascii=False), project["id"], project["updatedAt"]),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("The project already has an active job.")

    def save_replacement(self, project, job_id):
        with closing(self.connect()) as db, db:
            cursor = db.execute(
                "UPDATE projects SET data=? WHERE id=? AND json_extract(data, '$.replacementJob')=?",
                (json.dumps(project, ensure_ascii=False), project["id"], job_id),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("The replacement job is no longer current.")

    def batch_directory(self, project_id, batch):
        if not ID.fullmatch(batch):
            raise ValueError("Invalid replacement ID.")
        directory = self.directory(project_id) / (".replacement-" + batch)
        if directory.resolve() != directory:
            raise ValueError("Unsafe replacement directory.")
        return directory

    def stage(self, project_id, batch):
        directory = self.batch_directory(project_id, batch)
        directory.mkdir(mode=0o700)
        lock = (directory / ".lease").open("xb")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            lock.close()
            raise
        return lock

    def recover_batches(self, project):
        directory = self.directory(project["id"])
        referenced = {asset.get("batch") for asset in project["assets"]}
        for candidate in directory.glob(".replacement-*"):
            batch = candidate.name.removeprefix(".replacement-")
            if not ID.fullmatch(batch) or batch in referenced or candidate.is_symlink() or not candidate.is_dir():
                continue
            lease = candidate / ".lease"
            if lease.is_symlink() or not lease.is_file():
                continue
            try:
                lock_file = lease.open("rb")
            except FileNotFoundError:
                continue
            with lock_file as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    if batch == project.get("replacementJob"):
                        return False
                    continue
                current = self.get(project["id"])
                if current and not any(asset.get("batch") == batch for asset in current["assets"]):
                    shutil.rmtree(candidate)
        return True

    def get(self, project_id):
        if not ID.fullmatch(project_id):
            return None
        with closing(self.connect()) as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (project_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def list(self):
        with closing(self.connect()) as db:
            return [json.loads(row[0]) for row in db.execute("SELECT data FROM projects ORDER BY created DESC")]

    def directory(self, project_id):
        if not ID.fullmatch(project_id):
            raise ValueError("Invalid project ID.")
        directory = self.root / project_id
        if directory.resolve() != directory:
            raise ValueError("Unsafe project directory.")
        directory.mkdir(exist_ok=True)
        return directory

    def path(self, project_id, asset_id, extension, batch=None):
        if not ID.fullmatch(asset_id) or extension not in MEDIA_TYPES:
            raise ValueError("Invalid media asset.")
        directory = self.batch_directory(project_id, batch) if batch else self.directory(project_id)
        candidate = directory / (asset_id + extension)
        if candidate.resolve() != candidate:
            raise ValueError("Unsafe media path.")
        return candidate

    def asset(self, project, asset_id):
        metadata = next((asset for asset in project["assets"] if asset["id"] == asset_id), None)
        if not metadata:
            return None
        path = self.path(project["id"], asset_id, metadata["extension"], metadata.get("batch"))
        return (path, metadata) if path.is_file() else None
