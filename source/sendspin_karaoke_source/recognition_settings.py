"""Private consent persistence, separate from recognition's shutdown lifecycle."""

import asyncio
import json
import logging
import math
import os
from pathlib import Path
import stat
import threading
import uuid

from .config import SourceError
from .state import check_private

NAME = "recognition-settings.json"
MAX_BYTES = 512
IO_SECONDS = 3
LOG = logging.getLogger(__name__)


def validate(value):
    if (type(value) is not dict or set(value) != {"version", "enabled", "silence_dbfs"}
            or type(value["version"]) is not int or value["version"] != 1
            or type(value["enabled"]) is not bool):
        raise SourceError("Invalid recognition settings; recognition remains off.")
    try:
        valid = (type(value["silence_dbfs"]) in (int, float)
                 and math.isfinite(value["silence_dbfs"]) and value["silence_dbfs"] < 0)
    except OverflowError:
        valid = False
    if not valid:
        raise SourceError("Invalid recognition settings threshold; recognition remains off.")
    return value


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate settings key")
        result[key] = value
    return result


def read_settings(directory):
    check_private(directory, directory=True)
    path = directory / NAME
    check_private(path)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES or info.st_nlink != 1:
            raise SourceError("Unsafe recognition settings file; recognition remains off.")
        if os.name == "posix" and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
            raise SourceError("Recognition settings must be private to the source user.")
        raw = os.read(fd, MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise SourceError("Recognition settings exceed the size limit.")
        try:
            value = json.loads(raw, object_pairs_hook=object_pairs)
        except (ValueError, UnicodeError, RecursionError):
            raise SourceError("Corrupt recognition settings; recognition remains off.") from None
        return validate(value)
    finally:
        os.close(fd)


def write_settings(directory, value, cancelled):
    validate(value)
    check_private(directory, directory=True)
    path = directory / NAME
    check_private(path)
    pending = directory / f".recognition-settings-{uuid.uuid4().hex}"
    fd = None
    try:
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", closefd=False) as output:
            json.dump(value, output, allow_nan=False)
            output.flush()
            os.fsync(fd)
        os.close(fd)
        fd = None
        check_private(directory, directory=True)
        check_private(path)
        if cancelled.is_set():
            raise SourceError("Recognition settings write cancelled before commit.")
        os.replace(pending, path)
        if os.name == "posix":
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if fd is not None:
            os.close(fd)
        pending.unlink(missing_ok=True)


class RecognitionSettings:
    def __init__(self, directory: Path):
        self.directory = directory
        self.pending = None
        self.cancelled = None

    async def _run(self, function, *args):
        if self.pending is not None and not self.pending.done():
            raise SourceError("Recognition settings I/O is still retiring; inspect status before retrying.")
        self.cancelled = threading.Event()
        loop = asyncio.get_running_loop()
        task = loop.create_future()
        cancelled = self.cancelled
        def finish(result, error):
            if task.done():
                return
            if error is None:
                task.set_result(result)
            else:
                task.set_exception(error)
        def work():
            result = error = None
            try:
                result = function(*args, cancelled)
            except Exception as failure:
                error = failure
                if not isinstance(failure, (SourceError, OSError, TimeoutError)):
                    LOG.error("Unexpected recognition settings failure (%s).", type(failure).__name__)
            try:
                loop.call_soon_threadsafe(finish, result, error)
            except RuntimeError:
                # The service has shut down; no late write is permitted after cancellation.
                cancelled.set()
        self.pending = task
        threading.Thread(target=work, name="recognition-settings", daemon=True).start()
        # A cancelled caller cannot abandon a disk worker's eventual failure.
        task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
        try:
            return await asyncio.wait_for(asyncio.shield(task), IO_SECONDS)
        except (TimeoutError, asyncio.CancelledError):
            cancelled.set()
            raise

    async def load(self):
        return await self._run(lambda directory, _cancelled: read_settings(directory), self.directory)

    async def save(self, enabled, threshold):
        await self._run(write_settings, self.directory,
                        {"version": 1, "enabled": enabled, "silence_dbfs": threshold})
