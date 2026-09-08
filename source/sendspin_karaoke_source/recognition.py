"""Passive, bounded album recognition; never owns input or rearms recording."""

import array
import asyncio
import hashlib
import importlib.util
import json
import logging
import math
import os
import re
import sys
import time
import uuid

from .album_handoff import write_snapshot
from .audio import CHANNELS, FRAMES, RATE
from .config import SourceError
from .recognition_settings import RecognitionSettings

LOG = logging.getLogger(__name__)
SAMPLE_BYTES = 12 * RATE * CHANNELS * 2
SILENCE_FRAMES = 5 * RATE
WORKER_SECONDS = 35


async def process_album(pcm):
    spawning = asyncio.create_task(asyncio.create_subprocess_exec(
        sys.executable, "-I", "-B", "-m", "sendspin_karaoke_source.album_provider",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, limit=4096,
        env={**os.environ, "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1",
             "MKL_NUM_THREADS": "1", "RAYON_NUM_THREADS": "1", "TOKIO_WORKER_THREADS": "1"},
    ))
    process = None
    try:
        process = await asyncio.shield(spawning)
        async with asyncio.timeout(WORKER_SECONDS):
            process.stdin.write(pcm)
            await process.stdin.drain()
            process.stdin.close()
            raw = bytearray()
            while True:
                chunk = await process.stdout.read(4097 - len(raw))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > 4096:
                    raise SourceError("Recognition worker returned too much metadata.")
            code = await process.wait()
            if code != 0:
                try:
                    failure = json.loads(raw)
                except (ValueError, UnicodeError):
                    failure = {}
                kind = failure.get("error") if type(failure) is dict else None
                if type(kind) is str and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", kind):
                    raise SourceError(f"Recognition worker failed ({kind}); no retry this session.")
                raise SourceError("Recognition worker unavailable; no retry this session.")
            value = json.loads(raw)
            if type(value) is not dict or set(value) != {"album"}:
                raise ValueError("Invalid worker result")
            album = value["album"]
            if album is not None:
                from .album_provider import ARTWORK, text
                from .album_catalog import valid_reference
                if (type(album) is not dict or set(album) != {"title", "artist", "artwork", "catalog"}
                        or not text(album["title"]) or not text(album["artist"])
                        or not valid_reference(album["catalog"])
                        or (album["artwork"] is not None and (
                            type(album["artwork"]) is not str
                            or not ARTWORK.fullmatch(album["artwork"])
                            or ".." in album["artwork"]))):
                    raise ValueError("Invalid worker album")
            return album
    finally:
        # Cancellation while creating a process must not abandon the late child.
        while not spawning.done():
            try:
                await asyncio.shield(spawning)
            except asyncio.CancelledError:
                continue
        if process is None and not spawning.cancelled() and spawning.exception() is None:
            process = spawning.result()
        if process is not None:
            if process.returncode is None:
                process.kill()
            reaping = asyncio.create_task(process.wait())
            while not reaping.done():
                try:
                    await asyncio.shield(reaping)
                except asyncio.CancelledError:
                    continue


class Recognition:
    def __init__(self, owner, identity, *, recognize=process_album, publish=write_snapshot,
                 clock=time.time, state_dir=None):
        self.owner = owner
        self.source_id = hashlib.sha256(identity.public_bytes).hexdigest()
        self.boot_id = uuid.uuid4().hex
        self.recognize = recognize
        self.publish = publish
        self.clock = clock
        self.enabled = False
        self.active = False
        self.state = "disabled"
        self.generation = 0
        self.album = None
        self.threshold_dbfs = -45.0
        self.threshold = 32768 * 10 ** (-45 / 20)
        self.buffer = bytearray()
        self.silent_frames = 0
        self.last_timestamp = None
        self.last_audio = None
        self.worker = None
        self.publisher = None
        self.changed = asyncio.Event()
        self.handoff_error = False
        self.publish_lock = asyncio.Lock()
        self.publish_broken = False
        self.settings = RecognitionSettings(state_dir) if state_dir is not None else None
        self.remembered_enabled = False
        self.settings_error = None
        self.operation_lock = asyncio.Lock()

    async def start(self):
        async with self.operation_lock:
            if self.settings is not None:
                try:
                    saved = await self.settings.load()
                    if saved is not None:
                        self.remembered_enabled = saved["enabled"]
                        self.threshold_dbfs = saved["silence_dbfs"]
                        if saved["enabled"]:
                            self._activate(saved["silence_dbfs"])
                except (SourceError, OSError, TimeoutError) as error:
                    self.settings_error = "restore_failed"
                    LOG.warning("Remembered recognition could not be restored (%s); core service continues off.",
                                str(error) if isinstance(error, SourceError) else type(error).__name__)
        self.owner.observers.add(self)
        self.publisher = asyncio.create_task(self._publish())
        self.changed.set()

    def status(self):
        now = int(self.clock() * 1000)
        return {
            "version": 2, "source_id": self.source_id, "boot_id": self.boot_id,
            "generation": self.generation, "updated_at_ms": now, "expires_at_ms": now + 4000,
            "state": self.state, "enabled": self.enabled, "active": self.active,
            "silence_dbfs": self.threshold_dbfs, "album": self.album,
            "remembered_enabled": self.remembered_enabled, "settings_error": self.settings_error,
        }

    async def enable(self, silence_dbfs=-45.0):
        async with self.operation_lock:
            self._check_enable(silence_dbfs)
            await self._remember(True, silence_dbfs)
            self._activate(silence_dbfs)
            return self.status()

    def _check_enable(self, silence_dbfs):
        try:
            valid = type(silence_dbfs) in (int, float) and math.isfinite(silence_dbfs) and silence_dbfs < 0
        except OverflowError:
            valid = False
        if not valid:
            raise SourceError("Recognition silence threshold must be finite and negative.")
        if self.publish_broken:
            raise SourceError("Album handoff failed unexpectedly; fix the service before enabling recognition.")
        if self.enabled and silence_dbfs != self.threshold_dbfs:
            raise SourceError("Disable recognition before changing its silence threshold.")
        if any(importlib.util.find_spec(name) is None for name in (
            "shazamio", "shazamio_core", "pydub", "pydantic", "aiofiles",
            "aiohttp_retry", "dataclass_factory", "anyio", "numpy", "audioop",
        )):
            raise SourceError("Install the optional recognition extra before enabling recognition.")

    def _activate(self, silence_dbfs):
        self._check_enable(silence_dbfs)
        if not self.enabled:
            self.threshold_dbfs = silence_dbfs
            self.threshold = 32768 * 10 ** (silence_dbfs / 20)
            self.enabled = True
            self.active = bool(self.owner.consumers)
            self._reset("armed" if self.active else "idle")

    async def disable(self):
        async with self.operation_lock:
            self._deactivate()
            await self._retire()
            await self._write()
            await self._remember(False, self.threshold_dbfs)
            return self.status()

    def _deactivate(self):
        self.enabled = False
        self.active = False
        self._reset("disabled")

    async def _remember(self, enabled, threshold):
        try:
            if self.settings is not None:
                await self.settings.save(enabled, threshold)
        except (SourceError, OSError, TimeoutError, asyncio.CancelledError) as error:
            self.settings_error = "save_failed"
            self._deactivate()
            if isinstance(error, asyncio.CancelledError):
                raise
            raise SourceError(
                "Recognition is off, but its choice could not be saved. "
                "Inspect recognition-status and storage; a previous or requested opt-in may remain on disk."
            ) from None
        self.remembered_enabled = enabled
        self.settings_error = None
        self.changed.set()

    def _reset(self, state):
        self.generation += 1
        self.state = state
        self.album = None
        self.buffer.clear()
        self.silent_frames = 0
        self.last_timestamp = None
        self.last_audio = None
        if self.worker is not None:
            self.worker.cancel()
        self.changed.set()

    def context(self, active):
        active = active and self.enabled
        if active != self.active:
            self.active = active
            self._reset("armed" if active else "idle" if self.enabled else "disabled")

    def offer(self, pcm, timestamp):
        if not self.enabled or not self.active:
            return
        if len(pcm) != FRAMES * CHANNELS * 2:
            self.fail(ValueError("Invalid recognition PCM block"))
            return
        # Fixed 25ms blocks: small peak scan only; codecs/fingerprinting are elsewhere.
        if self.last_timestamp is not None and not 0 < timestamp - self.last_timestamp <= 2 * FRAMES * 1_000_000 / RATE:
            self.fail(SourceError("Recognition audio gap"))
        self.last_timestamp = timestamp
        self.last_audio = time.monotonic()
        samples = array.array("h", pcm)
        if sys.byteorder != "little":
            samples.byteswap()
        silent = max(abs(value) for value in samples) <= self.threshold
        self.silent_frames = self.silent_frames + FRAMES if silent else 0
        if self.silent_frames >= SILENCE_FRAMES:
            if self.state != "armed":
                self._reset("armed")
            return
        if self.state == "armed" and not silent:
            self.state = "sampling"
            self.changed.set()
        if self.state == "sampling":
            self.buffer.extend(pcm[:SAMPLE_BYTES - len(self.buffer)])
            if len(self.buffer) == SAMPLE_BYTES:
                self.state = "recognizing"
                self.changed.set()
                if self.worker is not None and not self.worker.done():
                    self.fail(SourceError("Previous recognition process still retiring"))
                    return
                pcm = bytes(self.buffer)
                self.buffer.clear()
                self.worker = asyncio.create_task(self._attempt(pcm, self.generation))

    def fail(self, error, *, reset_session=True):
        if self.state == "unavailable":
            if reset_session:
                self.silent_frames = 0
                self.last_timestamp = None
                self.last_audio = None
            return
        if reset_session:
            self._reset("unavailable")
        else:
            self.state = "unavailable"
            self.album = None
            self.buffer.clear()
            self.changed.set()
        if not isinstance(error, (SourceError, OSError, TimeoutError)):
            LOG.error("Unexpected recognition failure (%s); streaming unaffected.", type(error).__name__)
        else:
            LOG.warning("%s", str(error) if isinstance(error, SourceError)
                        else f"Recognition unavailable ({type(error).__name__}); no retry this session.")

    async def _attempt(self, pcm, generation):
        try:
            album = await self.recognize(pcm)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if generation == self.generation:
                self.fail(error, reset_session=False)
        else:
            if generation == self.generation and self.enabled and self.active:
                self.album = album
                self.state = "identified" if album else "unavailable"
                self.changed.set()

    async def _retire(self):
        if self.worker is not None:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
            self.worker = None

    async def _publish(self):
        while True:
            self.changed.clear()
            if self.last_audio is not None and time.monotonic() - self.last_audio > 1:
                self.fail(SourceError("Recognition input stopped delivering audio"))
            await self._write()
            try:
                await asyncio.wait_for(self.changed.wait(), timeout=1)
            except TimeoutError:
                pass

    async def _write(self):
        async with self.publish_lock:
            if self.publish_broken:
                return
            try:
                await asyncio.to_thread(self.publish, self.status())
                self.handoff_error = False
            except OSError as error:
                if not self.handoff_error:
                    LOG.warning("Album handoff unavailable (%s); streaming unaffected.", type(error).__name__)
                self.handoff_error = True
            except Exception as error:
                LOG.error("Unexpected album handoff failure (%s); recognition disabled.", type(error).__name__)
                self.enabled = False
                self.active = False
                self._reset("disabled")
                self.publish_broken = True

    async def close(self):
        self.owner.observers.discard(self)
        async with self.operation_lock:
            self._deactivate()
            await self._retire()
            await self._write()
        if self.publisher is not None:
            self.publisher.cancel()
            await asyncio.gather(self.publisher, return_exceptions=True)
