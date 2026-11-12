"""Local mock video scheduling and its durable SQLite queue."""

import asyncio
import logging
from contextlib import closing, suppress
from datetime import datetime, time, timedelta, timezone
from typing import Annotated, Literal
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, RootModel, StrictBool, StringConstraints, field_validator

from .local_access import require_local_mutation
from .studio.media import MediaError
from .studio.routes import Brief, read_model

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/daily-video")

# These descriptors are inert. No browser profile is created or opened.
MOCK_PROFILES = tuple({
    "id": f"mock-chrome-{number}", "name": f"Mock Chrome profile {number}",
    "userDataDirectory": f"mock-profiles/chrome-{number}/data",
    "downloadDirectory": f"mock-profiles/chrome-{number}/downloads",
} for number in range(1, 5))


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool = True
    daily_limit: Annotated[int, Field(strict=True, ge=1, le=3)] = 1
    start_time: Annotated[str, StringConstraints(pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")] = "06:00"
    timezone: Annotated[str, StringConstraints(max_length=80)] = "Asia/Seoul"

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError):
            raise ValueError("Use an IANA timezone such as Asia/Seoul.") from None
        return value


class SaveSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["save"]
    settings: Settings


class Control(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["dry-run", "activate", "pause", "resume"]


class GenerateNow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["generate-now"]
    request_id: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]


Action = Annotated[SaveSettings | Control | GenerateNow, Field(discriminator="action")]


class DailyVideo:
    def __init__(self, studio, clock=None):
        self.studio = studio
        self.store = studio.store
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.task = None
        with closing(self.store.connect()) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS daily_video_settings (
                    id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL,
                    activated INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
                    dry_run INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS daily_video_timezone_change (
                    id INTEGER PRIMARY KEY CHECK(id=1), timezone TEXT NOT NULL, effective_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS daily_video_jobs (
                    sequence INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, request_id TEXT UNIQUE,
                    created_at TEXT NOT NULL, profile TEXT NOT NULL, source TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'queued'
                );
                CREATE INDEX IF NOT EXISTS daily_video_jobs_date ON daily_video_jobs(created_at);
            """)
            db.execute("INSERT OR IGNORE INTO daily_video_settings(id, settings) VALUES (1, ?)",
                       (Settings().model_dump_json(),))

    def config(self, db, now):
        pending = db.execute("SELECT timezone, effective_at FROM daily_video_timezone_change WHERE id=1").fetchone()
        raw, activated, paused, dry_run = db.execute(
            "SELECT settings, activated, paused, dry_run FROM daily_video_settings WHERE id=1"
        ).fetchone()
        settings = Settings.model_validate_json(raw)
        if pending and now.astimezone(timezone.utc).isoformat() >= pending[1]:
            settings = settings.model_copy(update={"timezone": pending[0]})
            db.execute("UPDATE daily_video_settings SET settings=?, activated=0, dry_run=0 WHERE id=1",
                       (settings.model_dump_json(),))
            db.execute("DELETE FROM daily_video_timezone_change WHERE id=1")
            return settings, False, bool(paused), False, None
        return settings, bool(activated), bool(paused), bool(dry_run), pending

    @staticmethod
    def day_bounds(settings, now):
        local = now.astimezone(ZoneInfo(settings.timezone))
        start = datetime.combine(local.date(), time.min, local.tzinfo)
        return local, (start.astimezone(timezone.utc).isoformat(),
                       (start + timedelta(days=1)).astimezone(timezone.utc).isoformat())

    def snapshot(self):
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            now = self.clock()
            settings, activated, paused, dry_run, pending = self.config(db, now)
            local, bounds = self.day_bounds(settings, now)
            used = self.used(db, bounds)
            jobs = db.execute(
                "SELECT id, profile, source, state FROM daily_video_jobs ORDER BY sequence DESC LIMIT 8"
            ).fetchall()
        return {
            "settings": settings.model_dump(), "activated": activated, "paused": paused,
            "dry_run_complete": dry_run, "mode": "mock", "used_today": used,
            "pending_timezone": {"timezone": pending[0], "effective_at": pending[1]} if pending else None,
            "local_date": local.date().isoformat(), "profiles": MOCK_PROFILES,
            "jobs": [{"id": job_id, "profile": profile, "source": source, "state": state}
                     for job_id, profile, source, state in jobs],
        }

    @staticmethod
    def used(db, bounds):
        return db.execute("SELECT count(*) FROM daily_video_jobs WHERE created_at >= ? AND created_at < ?", bounds).fetchone()[0]

    def configure(self, action):
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            now = self.clock()
            settings, _, _, dry_run, pending = self.config(db, now)
            if isinstance(action, SaveSettings):
                requested = action.settings
                if requested != settings or pending:
                    if requested.timezone == settings.timezone:
                        db.execute("DELETE FROM daily_video_timezone_change WHERE id=1")
                    else:
                        _, (_, boundary) = self.day_bounds(settings, now)
                        db.execute("INSERT INTO daily_video_timezone_change VALUES (1, ?, ?) "
                                   "ON CONFLICT(id) DO UPDATE SET timezone=excluded.timezone, effective_at=excluded.effective_at",
                                   (requested.timezone, boundary))
                    active = requested.model_copy(update={"timezone": settings.timezone})
                    db.execute("UPDATE daily_video_settings SET settings=?, activated=0, dry_run=0 WHERE id=1",
                               (active.model_dump_json(),))
            elif action.action == "dry-run":
                db.execute("UPDATE daily_video_settings SET dry_run=1 WHERE id=1")
            elif action.action == "activate":
                if pending:
                    raise MediaError("Wait for the timezone change before activating the schedule.")
                if not dry_run or not settings.enabled:
                    raise MediaError("Enable scheduling and complete a dry run first.")
                db.execute("UPDATE daily_video_settings SET activated=1, paused=0 WHERE id=1")
            else:
                db.execute("UPDATE daily_video_settings SET paused=? WHERE id=1", (int(action.action == "pause"),))

    def enqueue(self, request_id=None):
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            now = self.clock()
            if request_id is not None:
                existing = db.execute("SELECT id FROM daily_video_jobs WHERE request_id=?", (request_id,)).fetchone()
                if existing:
                    return existing[0]
            settings, activated, paused, _, _ = self.config(db, now)
            local, bounds = self.day_bounds(settings, now)
            if request_id is None and (not settings.enabled or not activated or paused
                                       or local.strftime("%H:%M") < settings.start_time):
                return None
            if self.used(db, bounds) >= settings.daily_limit:
                if request_id is not None:
                    raise MediaError("The daily mock video quota has been reached.")
                return None
            if request_id is None and db.execute(
                "SELECT 1 FROM daily_video_jobs WHERE state IN ('queued', 'running') LIMIT 1"
            ).fetchone():
                return None
            job_id = uuid4().hex
            count = db.execute("SELECT count(*) FROM daily_video_jobs").fetchone()[0]
            profile = MOCK_PROFILES[count % len(MOCK_PROFILES)]["id"]
            db.execute("INSERT INTO daily_video_jobs(id, request_id, created_at, profile, source) VALUES (?, ?, ?, ?, ?)",
                       (job_id, request_id, now.astimezone(timezone.utc).isoformat(), profile,
                        "manual" if request_id is not None else "scheduled"))
            return job_id

    def step(self):
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            now = self.clock()
            settings, activated, paused, _, _ = self.config(db, now)
            pending = db.execute(
                "SELECT id, profile, source, created_at FROM daily_video_jobs WHERE state IN ('queued', 'running') ORDER BY sequence"
            ).fetchall()
        if not pending:
            self.enqueue()
            return
        _, (day_start, day_end) = self.day_bounds(settings, now)
        for job_id, profile, source, created_at in pending:
            project = self.store.get(job_id)
            if project and project["status"] != "draft":
                status = project["status"]
                state = "running" if status == "working" else "completed" if project["finalAssetId"] else "failed"
                self.set_state(job_id, state)
                if state == "running":
                    return
                continue
            if not day_start <= created_at < day_end:
                self.set_state(job_id, "expired")
                continue
            if source == "scheduled" and (not settings.enabled or not activated or paused):
                continue
            if self.studio.busy():
                return
            if project is None:
                topic = f"Daily video · {job_id[:8]}"
                project = self.studio.create(Brief(topic=topic).model_dump(), project_id=job_id,
                                             daily_profile=profile)
            self.studio.launch_daily(project)
            self.set_state(job_id, "running")
            return

    def set_state(self, job_id, state):
        with closing(self.store.connect()) as db, db:
            db.execute("UPDATE daily_video_jobs SET state=? WHERE id=?", (state, job_id))

    async def run(self):
        while True:
            try:
                self.step()
            except Exception:
                logger.exception("Daily mock video scheduler could not advance.")
            await asyncio.sleep(1)

    def start(self):
        self.task = asyncio.create_task(self.run(), name="daily-video-scheduler")

    async def close(self):
        self.task.cancel()
        with suppress(asyncio.CancelledError):
            await self.task


@router.get("")
async def settings(request: Request):
    return request.app.state.daily_video.snapshot()




@router.post("")
async def update(request: Request):
    require_local_mutation(request)
    data = (await read_model(request, RootModel[Action])).root
    scheduler = request.app.state.daily_video
    try:
        if isinstance(data, GenerateNow):
            job_id = scheduler.enqueue(data.request_id)
            return {**scheduler.snapshot(), "job_id": job_id}
        scheduler.configure(data)
        return scheduler.snapshot()
    except MediaError as error:
        raise HTTPException(409, str(error)) from None
