"""Opt-in lossless recording with a bounded, dedicated disk/encoding worker."""

import array
import asyncio
from datetime import datetime, timezone
import logging
import math
import os
import queue
import threading
import uuid

import soundfile as sf

from .audio import CHANNELS, FRAMES, RATE
from .config import CaptureError, SourceError
from .lifecycle import EXPECTED_ERRORS, cleanup_async, error_classes
from .shared import wait_thread_event
from .state import check_private

LOG = logging.getLogger(__name__)
SILENCE_FRAMES = 5 * RATE
WRITER_BLOCKS = 80  # Two seconds; independent of the smaller streaming queue.
# Leave header headroom below classic RIFF's 4 GiB boundary, for either format.
MAX_RECORDING_FRAMES = ((2**32 - 4096) // (CHANNELS * 2) // FRAMES) * FRAMES
WRITER_WAIT_SECONDS = 3.0


def validate_options(format, silence_dbfs):
    if type(format) is not str or format not in ("flac", "wav"):
        raise SourceError("Recording format must be flac or wav.")
    try:
        valid = type(silence_dbfs) in (int, float) and math.isfinite(silence_dbfs) and silence_dbfs < 0
    except OverflowError:
        valid = False
    if not valid:
        raise SourceError("Recording silence threshold must be a finite negative dBFS number.")


def write_pcm(codec, pcm):
    before = codec.frames
    try:
        codec.buffer_write(pcm, dtype="int16")
    except AssertionError as error:
        # soundfile 0.13.1 asserts on short writes even when libsndfile supplies
        # no error code. Translate ONLY that pinned assertion, never arbitrary bugs.
        trace = error.__traceback__
        while trace.tb_next is not None:
            trace = trace.tb_next
        frame = trace.tb_frame
        if (
            frame.f_code is sf.SoundFile.buffer_write.__code__
            and frame.f_locals["written"] < frame.f_locals["frames"]
        ):
            raise SourceError("Incomplete recording disk write; check free space and storage.") from None
        raise
    if codec.frames != before + len(pcm) // (CHANNELS * 2):
        raise SourceError("Incomplete recording disk write; check free space and storage.")


class RecordingWriter:
    def __init__(self, state_dir, format, silence_dbfs, *, codec_factory=sf.SoundFile):
        validate_options(format, silence_dbfs)
        self.directory = state_dir / "recordings"
        self.format = format
        self.silence_dbfs = silence_dbfs
        self.threshold = 32768 * 10 ** (silence_dbfs / 20)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        self.name = f"{stamp}-{uuid.uuid4().hex}.{format}"
        self.path = self.directory / (self.name + ".partial")
        self.codec_factory = codec_factory
        self.blocks = queue.Queue(maxsize=WRITER_BLOCKS)
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.done = threading.Event()
        self.stopping = threading.Event()
        self.accepting = False
        self.state = "starting"
        self.reason = None
        self.error = None
        self.unexpected = None
        self.frames = 0
        self.silent_frames = 0
        self.thread = threading.Thread(target=self._run, name="source-recording", daemon=True)

    def status(self):
        with self.lock:
            return {
                "state": self.state, "active": self.accepting,
                "format": self.format, "silence_dbfs": self.silence_dbfs,
                "frames": self.frames, "sample_rate": RATE, "channels": CHANNELS,
                "max_frames": MAX_RECORDING_FRAMES,
                "path": str(self.path), "reason": self.reason, "error": self.error,
                "worker_pending": not self.done.is_set(),
            }

    def offer(self, pcm, timestamp):
        if len(pcm) != FRAMES * CHANNELS * 2:
            raise ValueError("Recording received an invalid PCM block.")
        with self.lock:
            if not self.accepting:
                return
            try:
                self.blocks.put_nowait(pcm)
            except queue.Full:
                self._fail_locked("Recording queue overflow; recording stopped, streaming unaffected.")

    def _fail_locked(self, message):
        if self.error is None:
            self.error = message
        if self.reason is None:
            self.reason = "error"
        self.state = "failed"
        self.accepting = False
        self.stopping.set()

    def fail(self, error):
        with self.lock:
            if not isinstance(error, (*EXPECTED_ERRORS, SourceError, sf.LibsndfileError)):
                self.unexpected = error
            detail = str(error) if isinstance(error, SourceError) else f"Recording failed ({error_classes(error)})."
            self._fail_locked(f"{detail} Partial file preserved if created.")

    def mute(self):
        self.stop("manual")

    def stop(self, reason):
        with self.lock:
            self.accepting = False
            if self.reason is None:
                self.reason = reason
            if self.state not in ("failed", "completed") and not self.done.is_set():
                self.state = "stopping"
            self.stopping.set()

    def timeout(self):
        with self.lock:
            self._fail_locked("Recording worker timed out; partial file retained; wait for worker before retrying.")

    def _run(self):
        codec = None
        fd = None
        directory_fd = None
        partial = self.name + ".partial"
        try:
            check_private(self.directory.parent, directory=True)
            self.directory.mkdir(mode=0o700, exist_ok=True)
            check_private(self.directory, directory=True)
            if os.name == "posix":
                directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            fd = os.open(
                partial if directory_fd is not None else self.path,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o600, dir_fd=directory_fd,
            )
            codec = self.codec_factory(
                fd, mode="w", samplerate=RATE, channels=CHANNELS,
                format=self.format.upper(), subtype="PCM_16", closefd=False,
            )
            with self.lock:
                if not self.stopping.is_set():
                    self.state = "recording"
                    self.accepting = True
            self.ready.set()
            while True:
                if self.error is not None:
                    break
                try:
                    pcm = self.blocks.get(timeout=0.025)
                except queue.Empty:
                    if self.stopping.is_set():
                        break
                    continue
                samples = array.array("h", pcm)
                silent = max(abs(value) for value in samples) <= self.threshold
                count = len(samples) // CHANNELS
                remaining = MAX_RECORDING_FRAMES - self.frames
                if silent:
                    remaining = min(remaining, SILENCE_FRAMES - self.silent_frames)
                count = min(count, remaining)
                write_pcm(codec, pcm[:count * CHANNELS * 2])
                with self.lock:
                    self.frames += count
                    self.silent_frames = self.silent_frames + count if silent else 0
                if self.silent_frames >= SILENCE_FRAMES:
                    self.stop("silence")
                    break
                if self.frames >= MAX_RECORDING_FRAMES:
                    self.stop("size-limit")
                    break
        except Exception as error:
            # Thread boundary: unexpected exceptions are re-raised by the supervisor.
            self.fail(error)
        finally:
            if self.format == "flac" and self.frames == 0 and self.error is None:
                self.fail(SourceError("No PCM samples captured; empty FLAC cannot be finalized."))
            for resource, close in (
                (codec, lambda: codec.close()),
                (fd, lambda: os.fsync(fd)),
                (fd, lambda: os.close(fd)),
            ):
                if resource is not None:
                    try:
                        close()
                    except Exception as error:
                        self.fail(error)
            try:
                if self.error is None and fd is not None:
                    # link is exclusive, unlike rename/replace on Unix; never overwrite.
                    if directory_fd is not None:
                        os.link(partial, self.name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd,
                                follow_symlinks=False)
                        os.fsync(directory_fd)
                    else:
                        os.link(self.path, self.directory / self.name)
                    if self.error is None:
                        if directory_fd is not None:
                            os.unlink(partial, dir_fd=directory_fd)
                        else:
                            self.path.unlink()
                        with self.lock:
                            self.path = self.directory / self.name
                            if self.error is None:
                                self.state = "completed"
                    else:
                        os.unlink(
                            self.name if directory_fd is not None else self.directory / self.name,
                            dir_fd=directory_fd,
                        )
            except Exception as error:
                self.fail(error)
            finally:
                if directory_fd is not None:
                    try:
                        os.close(directory_fd)
                    except OSError as error:
                        self.fail(error)
                with self.lock:
                    self.accepting = False
                self.ready.set()
                self.done.set()


class Recorder:
    def __init__(self, owner, state_dir, writer_factory=RecordingWriter):
        self.owner = owner
        self.state_dir = state_dir
        self.writer_factory = writer_factory
        self.writer = None
        self.monitor = None
        self.lock = asyncio.Lock()
        self.failed = asyncio.Event()
        self.failure = None

    def status(self):
        return self.writer.status() if self.writer else {
            "state": "off", "active": False, "path": None,
            "max_frames": MAX_RECORDING_FRAMES, "sample_rate": RATE, "channels": CHANNELS,
        }

    async def start(self, format="flac", silence_dbfs=-45.0):
        validate_options(format, silence_dbfs)
        if self.lock.locked():
            raise SourceError("Recording control is busy; retry after the pending operation.")
        async with self.lock:
            if self.writer is not None and (
                not self.writer.done.is_set() or (self.monitor is not None and not self.monitor.done())
            ):
                raise SourceError("Recording is already active or finalizing; stop/wait before starting again.")
            writer = self.writer_factory(self.state_dir, format, silence_dbfs)
            self.writer = writer
            writer.thread.start()
            self.monitor = asyncio.create_task(self._monitor(writer))
            try:
                await wait_thread_event(writer.ready, WRITER_WAIT_SECONDS)
                if writer.error:
                    raise SourceError(writer.error)
                await self.owner.acquire(writer)
            except BaseException as error:
                if isinstance(error, (asyncio.CancelledError, TimeoutError)):
                    writer.timeout()
                else:
                    writer.fail(error)
                raise
            LOG.info("Recording started: %s; %.1f dBFS silence, five seconds; limit %s frames.",
                     writer.path, silence_dbfs, MAX_RECORDING_FRAMES)
            return writer.status()

    async def _monitor(self, writer):
        try:
            await wait_thread_event(writer.stopping, MAX_RECORDING_FRAMES / RATE + 60)
            # start owns this lock until its hardware subscription is fully installed.
            async with self.lock:
                await self.owner.release(writer)
            try:
                await wait_thread_event(writer.done, WRITER_WAIT_SECONDS)
            except TimeoutError:
                writer.timeout()
                LOG.error("Recording finalization timed out: %s; partial retained.", writer.path)
                # Keep watching a late worker for unexpected bugs, but never hold
                # hardware or make control/shutdown wait for a blocked disk.
                await wait_thread_event(writer.done, MAX_RECORDING_FRAMES / RATE + 60)
            status = writer.status()
            LOG.log(logging.ERROR if status["error"] else logging.INFO,
                    "Recording %s (%s): %s%s", status["state"], status["reason"],
                    status["path"], f"; {status['error']}" if status["error"] else "")
            if writer.unexpected is not None:
                raise writer.unexpected
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if isinstance(error, EXPECTED_ERRORS):
                writer.fail(error)
                LOG.error("Recording cleanup failed (%s); inspect record-status.", error_classes(error))
            if writer.unexpected is not None or not isinstance(error, EXPECTED_ERRORS):
                self.failure = writer.unexpected or error
                self.failed.set()

    async def stop(self, reason="manual"):
        if self.lock.locked():
            raise SourceError("Recording control is busy; retry after the pending operation.")
        async with self.lock:
            writer = self.writer
            if writer is None or writer.done.is_set():
                raise SourceError("Recording is not active; inspect record-status for the last result.")
            writer.stop(reason)
            # Release hardware immediately, independently of disk draining.
            await self.owner.release(writer)
            try:
                await wait_thread_event(writer.done, WRITER_WAIT_SECONDS)
            except TimeoutError:
                writer.timeout()
                raise SourceError(writer.status()["error"]) from None
            if writer.error:
                raise SourceError(writer.error + f" File: {writer.path}")
            return writer.status()

    async def close(self):
        if self.writer is None:
            return
        writer = self.writer
        writer.stop("service-stop")

        async def finish_writer():
            try:
                await wait_thread_event(writer.done, WRITER_WAIT_SECONDS)
            except TimeoutError:
                writer.timeout()
                LOG.error("%s File: %s", writer.status()["error"], writer.path)
            if self.monitor is not None:
                self.monitor.cancel()
                await asyncio.gather(self.monitor, return_exceptions=True)
            status = writer.status()
            LOG.log(logging.ERROR if status["error"] else logging.INFO,
                    "Recording shutdown %s: %s%s", status["state"], status["path"],
                    f"; {status['error']}" if status["error"] else "")
            if writer.unexpected:
                raise writer.unexpected

        await cleanup_async([
            ("recording unsubscribe", lambda: self.owner.release(writer)),
            ("recording finalize", finish_writer),
        ])
