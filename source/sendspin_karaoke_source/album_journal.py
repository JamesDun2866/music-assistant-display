"""Private, bounded, serialized durable recognition-success feed."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import logging
import os
import re
import sqlite3
import stat
import time
import uuid

from .album_memory import validate
from .config import SourceError

LOG = logging.getLogger(__name__)
RETENTION_MS = 90 * 24 * 60 * 60 * 1000
MAX_PENDING = 32
MAX_PAYLOAD = 512 * 1024
MAX_RECORD_BYTES = 16 * 1024
START_SECONDS = 3
MAX_INT = 2**53 - 1
STORAGE_ERROR = "Journal storage unavailable."
BACKLOG_ERROR = "Journal backlog full; a recognition success may be missing."


def encode(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode()


def _private(path, directory=False):
    info = path.lstat()
    if (not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or (not directory and info.st_nlink != 1)
            or (os.name == "posix" and (
                info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600)))):
        raise SourceError(STORAGE_ERROR)
    return info.st_dev, info.st_ino


class AlbumJournal:
    def __init__(self, state_dir, source_id, *, clock=time.time):
        self.state_dir = state_dir
        self.directory = state_dir / "album-journal"
        self.path = self.directory / "journal.sqlite3"
        self.source_id = source_id
        self.clock = clock
        self.error = None
        self.executor = None
        self.pending = set()
        self.connection = None
        self.identities = None
        self.timer = None
        self.closing = False
        self.start_error = None

    def fail(self, reason=STORAGE_ERROR):
        if self.error is None:
            self.error = reason
            LOG.warning("%s", reason)

    def _submit(self, operation, *args):
        if self.closing or self.executor is None:
            raise SourceError(self.start_error or STORAGE_ERROR)
        if len(self.pending) >= MAX_PENDING:
            self.fail(BACKLOG_ERROR)
            raise SourceError(BACKLOG_ERROR)
        future = asyncio.wrap_future(self.executor.submit(self._execute, operation, *args))
        self.pending.add(future)
        future.add_done_callback(self._finished)
        return future

    def _finished(self, future):
        self.pending.discard(future)
        if not future.cancelled():
            future.exception()

    async def start(self):
        if self.executor is not None:
            raise SourceError(STORAGE_ERROR)
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="album-journal")
        try:
            async with asyncio.timeout(START_SECONDS):
                recovery = await asyncio.shield(self._submit("open"))
        except (SourceError, TimeoutError) as error:
            self.start_error = str(error) if isinstance(error, SourceError) else STORAGE_ERROR
            self.fail()
            raise
        self.timer = asyncio.create_task(self._prune_periodically())
        return recovery

    def record(self, album_key, album, success, observed_at_ms):
        """Admission never waits for disk; accepted work survives task cancellation."""
        try:
            value = {"version": 2, "source_id": self.source_id, "key": album_key,
                     "album": album, "success": success}
            raw = encode(value)
            if len(raw) > MAX_RECORD_BYTES:
                raise ValueError()
            self._submit("record", raw.decode(), observed_at_ms)
            return True
        except (SourceError, ValueError, TypeError, OverflowError):
            self.fail()
            return False

    async def request(self, request):
        return await asyncio.shield(self._submit("request", request))

    async def flush(self):
        if self.pending:
            await asyncio.shield(asyncio.gather(*tuple(self.pending), return_exceptions=True))

    async def _prune_periodically(self):
        while True:
            await asyncio.sleep(60)
            try:
                await asyncio.shield(self._submit("prune"))
            except SourceError:
                self.fail()

    async def close(self):
        if self.closing:
            return
        self.closing = True
        if self.timer is not None:
            self.timer.cancel()
            await asyncio.gather(self.timer, return_exceptions=True)
        if self.executor is not None:
            # Shutdown must observe all admitted commits, even after cancellation.
            closing = asyncio.wrap_future(self.executor.submit(self._close_connection))
            while not closing.done():
                try:
                    await asyncio.shield(closing)
                except asyncio.CancelledError:
                    continue
            closing.result()
            await self.flush()
            self.executor.shutdown(wait=False)
            self.executor = None

    def _close_connection(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def _check_paths(self):
        current = (_private(self.state_dir, True), _private(self.directory, True),
                   _private(self.path))
        if self.identities is not None and current != self.identities:
            raise SourceError(STORAGE_ERROR)
        for suffix in ("-journal", "-wal", "-shm"):
            path = self.path.with_name(self.path.name + suffix)
            if path.exists() or path.is_symlink():
                _private(path)
        return current

    def _execute(self, operation, *args):
        try:
            if operation == "open":
                return self._open()
            if self.start_error is not None:
                raise SourceError(self.start_error)
            if self.connection is None:
                raise SourceError(STORAGE_ERROR)
            self._check_paths()
            if self.error is not None:
                with self.connection:
                    self.connection.execute("UPDATE metadata SET error=COALESCE(error,?)", (self.error,))
            if operation == "record":
                return self._record(*args)
            if operation == "prune":
                with self.connection:
                    self._prune()
                return None
            return self._request(*args)
        except SourceError as error:
            if operation != "request" or str(error) == STORAGE_ERROR:
                self.fail()
            raise
        except Exception:
            self.fail()
            raise SourceError(STORAGE_ERROR) from None

    def _open(self):
        if not re.fullmatch(r"[a-f0-9]{64}", self.source_id):
            raise SourceError("Journal source identity mismatch.")
        _private(self.state_dir, True)
        self.directory.mkdir(mode=0o700, exist_ok=True)
        _private(self.directory, True)
        if not self.path.exists() and not self.path.is_symlink():
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                         | getattr(os, "O_NOFOLLOW", 0), 0o600)
            os.close(fd)
        self.identities = self._check_paths()
        self.connection = sqlite3.connect(self.path, timeout=0.25)
        db = self.connection
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("PRAGMA synchronous=FULL")
        with db:
            db.execute("""CREATE TABLE IF NOT EXISTS metadata (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
                source_id TEXT NOT NULL, epoch TEXT NOT NULL, revision INTEGER NOT NULL,
                watermark INTEGER NOT NULL, high_water INTEGER NOT NULL,
                cutoff INTEGER NOT NULL, recovery TEXT, error TEXT)""")
            db.execute("""CREATE TABLE IF NOT EXISTS events (
                sequence INTEGER PRIMARY KEY, source_id TEXT NOT NULL,
                boot_id TEXT NOT NULL, generation INTEGER NOT NULL,
                observed_at_ms INTEGER NOT NULL, retention_at_ms INTEGER NOT NULL,
                snapshot TEXT NOT NULL,
                UNIQUE(source_id, boot_id, generation))""")
            db.execute("CREATE INDEX IF NOT EXISTS events_age ON events(retention_at_ms)")
            db.execute("""CREATE TABLE IF NOT EXISTS accepted (
                boot_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)""")
            db.execute("INSERT OR IGNORE INTO metadata VALUES(1,1,?,?,0,0,0,?,NULL,NULL)",
                       (self.source_id, uuid.uuid4().hex, -RETENTION_MS))
            row = db.execute("SELECT version,source_id,epoch,revision,watermark,high_water,cutoff,error "
                             "FROM metadata").fetchone()
            if row[0] != 1:
                raise SourceError("Unsupported journal schema.")
            if row[1] != self.source_id:
                raise SourceError("Journal source identity mismatch.")
            if (type(row[2]) is not str or not re.fullmatch(r"[a-f0-9]{32}", row[2])
                    or any(type(value) is not int or not 0 <= value <= MAX_INT for value in row[3:6])
                    or type(row[6]) is not int or not -RETENTION_MS <= row[6] <= MAX_INT
                    or row[4] > row[5] or row[7] not in (None, STORAGE_ERROR, BACKLOG_ERROR)):
                raise SourceError(STORAGE_ERROR)
            self.error = self.error or row[7]
            self._prune()
        self._check_paths()
        raw = db.execute("SELECT recovery FROM metadata").fetchone()[0]
        recovery = validate(json.loads(raw)) if raw is not None else None
        if recovery is not None:
            if recovery["source_id"] != self.source_id:
                raise SourceError("Journal source identity mismatch.")
            if recovery["success"] is None:
                raise SourceError(STORAGE_ERROR)
        if os.name == "posix":
            for directory in (self.state_dir, self.directory):
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        return recovery

    def _prune(self):
        now = max(0, min(MAX_INT, int(self.clock() * 1000)))
        db = self.connection
        db.execute("UPDATE metadata SET cutoff=MAX(cutoff,?)", (now - RETENTION_MS,))
        db.execute("DELETE FROM events WHERE retention_at_ms <= (SELECT cutoff FROM metadata)")

    def _record(self, raw, observed_at_ms):
        value = validate(json.loads(raw))
        success = value["success"]
        if (success is None or value["source_id"] != self.source_id
                or type(observed_at_ms) is not int or not 0 <= observed_at_ms <= MAX_INT):
            raise SourceError(STORAGE_ERROR)
        db = self.connection
        with db:
            self._prune()
            if db.execute("SELECT 1 FROM events WHERE source_id=? AND boot_id=? AND generation=?",
                          (self.source_id, success["boot_id"], success["generation"])).fetchone():
                return
            # Small per-boot high-water tombstones prevent replay after clear/expiry.
            accepted = db.execute("SELECT generation FROM accepted WHERE boot_id=?",
                                  (success["boot_id"],)).fetchone()
            if accepted is not None and accepted[0] >= success["generation"]:
                return
            recovery, high_water = db.execute("SELECT recovery,high_water FROM metadata").fetchone()
            previous = json.loads(recovery)["success"] if recovery else None
            if previous and (previous["boot_id"] == success["boot_id"]
                             and previous["generation"] >= success["generation"]):
                return
            if high_water >= MAX_INT:
                raise SourceError(STORAGE_ERROR)
            sequence = high_water + 1
            cutoff = db.execute("SELECT cutoff FROM metadata").fetchone()[0]
            horizon = max(0, min(MAX_INT, int(self.clock() * 1000)), cutoff + RETENTION_MS)
            # Logical success time survives rollback, but cannot extend beyond the
            # persisted wall horizon. Raw observation and historical time stay intact.
            retention_at_ms = min(success["at_ms"], horizon)
            db.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?)",
                       (sequence, self.source_id, success["boot_id"], success["generation"],
                        observed_at_ms, retention_at_ms, raw))
            db.execute("UPDATE metadata SET high_water=?, recovery=?", (sequence, raw))
            db.execute("INSERT INTO accepted VALUES(?,?) ON CONFLICT(boot_id) DO UPDATE "
                       "SET generation=excluded.generation",
                       (success["boot_id"], success["generation"]))
            self._prune()
        self._check_paths()

    def _request(self, request):
        # The same validator protects direct callers and socket clients.
        from .album_journal_ipc import decode_journal
        request = decode_journal(encode(request))
        if request["source_id"] != self.source_id:
            raise SourceError("Journal source identity mismatch.")
        db = self.connection
        with db:
            self._prune()
            epoch, revision, watermark, high_water = db.execute(
                "SELECT epoch,revision,watermark,high_water FROM metadata").fetchone()
            command = request["command"]
            if command != "journal-head" and request["epoch"] != epoch:
                raise SourceError("Journal epoch mismatch.")
            if command == "journal-clear":
                if request["revision"] != revision:
                    raise SourceError("Journal revision changed.")
                if revision >= MAX_INT:
                    raise SourceError(STORAGE_ERROR)
                db.execute("DELETE FROM events")
                db.execute("UPDATE metadata SET revision=revision+1,watermark=high_water")
                revision += 1
                watermark = high_water
            oldest = db.execute("SELECT MIN(sequence) FROM events").fetchone()[0]
            response = {"ok": True, "source_id": self.source_id, "epoch": epoch,
                        "revision": revision, "watermark": watermark, "high_water": high_water,
                        "oldest_sequence": oldest, "healthy": self.error is None,
                        "error": self.error, "events": []}
            if command == "journal-page":
                if request["after"] > high_water:
                    raise SourceError("Journal cursor is ahead of source.")
                rows = db.execute(
                    "SELECT sequence,observed_at_ms,snapshot FROM events WHERE sequence>? "
                    "ORDER BY sequence LIMIT ?", (request["after"], request["limit"]))
                size = len(encode(response)) + 1
                for sequence, observed, raw in rows:
                    value = validate(json.loads(raw))
                    if value["source_id"] != self.source_id or value["success"] is None:
                        raise SourceError(STORAGE_ERROR)
                    event = {"sequence": sequence, "source_id": value["source_id"],
                             "album_key": value["key"], "album_success": value["success"],
                             "observed_at_ms": observed, "album": value["album"]}
                    size += len(encode(event)) + 1
                    if size > MAX_PAYLOAD:
                        break
                    response["events"].append(event)
            return response
