"""Single physical input, independently bounded recording and network consumers."""

import asyncio
import logging
import threading
import time

from aiosendspin.clock import RawMonotonicClock

from .audio import AudioInput, MAX_AGE_US, MAX_BLOCKS
from .config import CaptureError
from .lifecycle import EXPECTED_ERRORS, error_classes

LOG = logging.getLogger(__name__)
DEVICE_WAIT_SECONDS = 4.0


async def wait_thread_event(event, timeout):
    try:
        async with asyncio.timeout(timeout):
            while not event.is_set():
                await asyncio.sleep(0.005)
    except TimeoutError:
        if not event.is_set():
            raise


class DeviceSession:
    """The daemon owns even a late-opened handle; shutdown never abandons its close."""

    def __init__(self, audio, device):
        self.audio = audio
        self.device = device
        self.ready = threading.Event()
        self.stop = threading.Event()
        self.done = threading.Event()
        self.error = None
        self.close_requested_at = None
        self.thread = threading.Thread(target=self._run, name="source-device", daemon=True)
        self.thread.start()

    def _run(self):
        try:
            self.audio.open(self.device)
        except Exception as error:
            # Transfer to the event loop, which distinguishes operational errors/bugs.
            self.error = error
        finally:
            self.ready.set()
        try:
            if self.error is None:
                self.stop.wait()
            self.audio.close()
        except Exception as error:
            self.error = error if self.error is None else ExceptionGroup(
                "Device open and close failed", [self.error, error],
            )
        finally:
            self.done.set()

    def request_close(self):
        if self.close_requested_at is None:
            self.close_requested_at = time.monotonic()
        self.audio.mute()
        self.stop.set()


class StreamInput:
    def __init__(self, owner):
        self.owner = owner
        self.blocks = asyncio.Queue(maxsize=MAX_BLOCKS)
        self.accepting = True
        self.failure = None

    def offer(self, pcm, timestamp):
        if not self.accepting or self.failure:
            return
        try:
            self.blocks.put_nowait((pcm, timestamp))
        except asyncio.QueueFull:
            self.fail(CaptureError("Streaming queue overflow; discarding delayed audio and reconnecting."))

    def mute(self):
        self.accepting = False
        while not self.blocks.empty():
            self.blocks.get_nowait()

    def fail(self, error):
        self.failure = error
        self.mute()

    async def read(self):
        while True:
            if self.failure:
                raise self.failure
            try:
                pcm, timestamp = self.blocks.get_nowait()
            except asyncio.QueueEmpty:
                await asyncio.sleep(0.005)
                continue
            if not 0 <= self.owner.clock.now_us() - timestamp <= MAX_AGE_US:
                raise CaptureError("Discarded stale streaming audio; check CPU/network load.")
            return pcm, timestamp


class SharedCapture:
    def __init__(self, device, audio_factory=AudioInput, clock=None):
        self.device = device
        # The pinned SDK defaults to CLOCK_MONOTONIC_RAW, NOT monotonic on Linux.
        # Production clients receive this exact clock object, including reconnects.
        self.clock = clock or RawMonotonicClock()
        self.audio_factory = audio_factory
        self.lock = asyncio.Lock()
        self.consumers = {}
        self.session = None
        self.reader = None
        self.failed = asyncio.Event()
        self.failure = None

    async def acquire(self, consumer):
        since_us = self.clock.now_us()
        async with self.lock:
            if self.session is not None and self.session.stop.is_set():
                if self.consumers:
                    raise CaptureError("Capture is recovering; wait for existing consumers to stop.")
                await self._finish_close()
            if self.session is None:
                session = DeviceSession(self.audio_factory(self.clock.now_us), self.device)
                self.session = session
                try:
                    await wait_thread_event(session.ready, DEVICE_WAIT_SECONDS)
                    if session.error:
                        raise session.error
                except BaseException:
                    # Cancellation/timeout cannot free ownership while open is running.
                    session.request_close()
                    raise
            self.consumers[consumer] = since_us
            if self.reader is None:
                self.reader = asyncio.create_task(self._read())

    async def _read(self):
        try:
            while True:
                pcm, timestamp = await self.session.audio.read()
                for consumer, since_us in tuple(self.consumers.items()):
                    # A newly enabled consumer never receives a pre-subscription block,
                    # even if the event loop briefly stalled while capture stayed live.
                    if timestamp >= since_us:
                        consumer.offer(pcm, timestamp)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            for consumer in tuple(self.consumers):
                consumer.fail(error)
            if not isinstance(error, EXPECTED_ERRORS):
                self.failure = error
                self.failed.set()
            LOG.error("Shared capture failed (%s); recording will not rearm.", error_classes(error))
            self.session.request_close()

    async def _finish_close(self):
        session = self.session
        if session is None:
            return
        try:
            remaining = max(0, DEVICE_WAIT_SECONDS - (time.monotonic() - session.close_requested_at))
            await wait_thread_event(session.done, remaining)
        except TimeoutError:
            raise CaptureError(
                "Device close/open is still pending; input remains owned, retry later."
            ) from None
        self.session = None
        if session.error:
            raise session.error

    async def release(self, consumer):
        consumer.mute()
        async with self.lock:
            self.consumers.pop(consumer, None)
            if self.consumers:
                return
            if self.reader is not None:
                self.reader.cancel()
                await asyncio.gather(self.reader, return_exceptions=True)
                self.reader = None
            if self.session is not None:
                self.session.request_close()
                await self._finish_close()

    async def close(self):
        for consumer in tuple(self.consumers):
            consumer.fail(CaptureError("Source service is stopping."))
        self.consumers.clear()
        await self.release(StreamInput(self))
