"""SQLite metadata and a project-scoped media directory."""

import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path

ID = re.compile(r"[a-f0-9]{32}")
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

    def connect(self):
        return sqlite3.connect(self.db, timeout=3)

    def save(self, project):
        with closing(self.connect()) as db, db:
            db.execute(
                "INSERT INTO projects VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                (project["id"], project["createdAt"], json.dumps(project, ensure_ascii=False)),
            )

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

    def path(self, project_id, asset_id, extension):
        if not ID.fullmatch(asset_id) or extension not in MEDIA_TYPES:
            raise ValueError("Invalid media asset.")
        candidate = self.directory(project_id) / (asset_id + extension)
        if candidate.resolve() != candidate:
            raise ValueError("Unsafe media path.")
        return candidate

    def asset(self, project, asset_id):
        metadata = next((asset for asset in project["assets"] if asset["id"] == asset_id), None)
        if not metadata:
            return None
        path = self.path(project["id"], asset_id, metadata["extension"])
        return (path, metadata) if path.is_file() else None
