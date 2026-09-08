"""Cheap allowlisted snapshots; transport evidence is independent of SOURCE STOP."""

import asyncio
from collections import OrderedDict
import importlib.metadata
import logging
import platform
import re
import shutil
import time

LOG = logging.getLogger(__name__)

ERRORS = frozenset({
    "not-configured", "offline", "incompatible", "unsafe-socket", "invalid-request",
    "invalid-response", "busy", "timeout", "not-found", "revision-changed",
    "restart-needed", "context-changed", "unavailable", "forbidden",
})


def age_ms(now, then):
    return None if then is None else min(86_400_000, max(0, round((now - then) * 1000)))


def safe_version(value):
    return value if (
        type(value) is str and len(value) <= 64
        and re.fullmatch(r"\d+\.\d+(?:\.\d+)?(?:[-+.][A-Za-z0-9.-]+)?", value)
    ) else None


async def worker_call(function, *args, **kwargs):
    """Cancellation never closes a descriptor that its worker is still using."""
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not task.cancelled():
            task.exception()
        raise


class SourceHealth:
    def __init__(self, meters, owner, recorder, state_dir, *, clock=time.monotonic):
        self.meters, self.owner, self.recorder = meters, owner, recorder
        self.path, self.clock = state_dir, clock
        self.transport = "unknown"
        self.bridge = None
        self.errors = OrderedDict()
        self.disk = None
        self.disk_at = None
        self.versions = {"source": None, "toolsAbi": 1,
                         "python": safe_version(platform.python_version()),
                         "sendspin": None, "installedSource": None}
        self.task = None

    def error(self, category):
        if category not in ERRORS:
            category = "unavailable"
        previous = self.errors.pop(category, (0, 0))
        self.errors[category] = (min(previous[0] + 1, 2**53 - 1), self.clock())
        while len(self.errors) > 20:
            self.errors.popitem(last=False)

    def connecting(self, bridge=None):
        self.transport, self.bridge = "connecting", bridge

    def connected(self, bridge):
        self.transport, self.bridge = "connected", bridge

    def disconnected(self):
        self.transport, self.bridge = "disconnected", None

    async def start(self):
        def versions():
            result = {}
            for key, package in (("sendspin", "aiosendspin"), ("source", "sendspin-karaoke-source")):
                try:
                    result[key] = safe_version(importlib.metadata.version(package))
                except importlib.metadata.PackageNotFoundError:
                    result[key] = None
            return result
        try:
            self.versions.update(await worker_call(versions))
        except Exception:
            self.error("unavailable")
            LOG.error("Source version sampling unavailable; audio unaffected.")
        self.task = asyncio.create_task(self._sample())
        self.task.add_done_callback(self._sample_done)

    def _sample_done(self, task):
        if not task.cancelled() and task.exception() is not None:
            self.disk, self.disk_at = None, None
            self.error("unavailable")
            LOG.error("Source disk sampling stopped; audio unaffected.")

    async def _sample(self):
        while True:
            try:
                usage = await worker_call(shutil.disk_usage, self.path)
                self.disk = (usage.free, usage.total)
                self.disk_at = self.clock()
            except OSError:
                self.disk, self.disk_at = None, None
                self.error("unavailable")
            await asyncio.sleep(10)

    def snapshot(self):
        now = self.clock()
        telemetry = self.meters.snapshot()
        state = telemetry["state"]
        session = getattr(self.owner, "session", None)
        capture_error = (getattr(self.owner, "failure", None) is not None
                         or getattr(session, "error", None) is not None)
        attached = self.meters in self.owner.observers
        if capture_error or not attached:
            state = "unavailable"
        evidence = "capture-error" if capture_error else (
            "receiving" if state == "active" else "unknown"
        )
        recording = self.recorder.status()["state"]
        recording = {"idle": "idle", "starting": "finalizing", "recording": "recording",
                     "stopping": "finalizing", "completed": "idle", "failed": "error"}.get(recording, "unknown")
        bridge = self.bridge
        stream = getattr(bridge, "audio", None)
        streaming = bool(self.transport == "connected" and stream is not None
                         and getattr(bridge, "requested", False)
                         and getattr(stream, "accepting", False)
                         and not getattr(stream, "failure", None)
                         and any(stream is consumer for consumer in getattr(self.owner, "consumers", ())))
        return {
            "capture": {"state": state, "evidence": evidence,
                        "evidenceAgeMs": telemetry["sampleAgeMs"] if evidence == "receiving" else None},
            "sendspin": {"state": self.transport, "streaming": streaming},
            "recording": {"state": recording},
            "disk": {"state": "available" if self.disk is not None else "unavailable",
                     "freeBytes": self.disk[0] if self.disk is not None else None,
                     "totalBytes": self.disk[1] if self.disk is not None else None,
                     "sampleAgeMs": age_ms(now, self.disk_at)},
            "versions": dict(self.versions),
            "errors": [{"category": category, "count": count, "ageMs": age_ms(now, at)}
                       for category, (count, at) in self.errors.items()],
        }

    async def close(self):
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None
