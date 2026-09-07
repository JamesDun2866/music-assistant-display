"""One serialized, cancellable streaming subscription per server connection."""

import asyncio
import logging
import sys

from aiosendspin.models.player import SupportedAudioFormat
from aiosendspin.models.types import AudioCodec
from aiosendspin.noise.trust_store import PskCategory

from .audio import AudioInput, RATE, CHANNELS
from .config import CaptureError, PairingRequired
from .lifecycle import cleanup_async, finish_open, sdk_call, sdk_errors
from .shared import StreamInput

LOG = logging.getLogger(__name__)
SEND_TIMEOUT_SECONDS = 1.0


def paired(client):
    return (
        client.connected and client.noise_psk is not None
        and client.noise_psk.category is PskCategory.LONG_TERM
    )


class SourceBridge:
    def __init__(self, client, device, audio_factory=AudioInput, *, owner=None):
        self.client = client
        self.device = device
        self.audio_factory = audio_factory
        self.owner = owner
        self.requested = False
        self.closing = False
        self.changed = asyncio.Event()
        self.failed = asyncio.Event()
        self.failure = None
        self.active = None
        self.audio = None
        self.worker = asyncio.create_task(self._worker())
        self.unsubscribes = [
            client.add_server_command_listener(self.command),
            client.add_disconnect_listener(self.disconnected),
        ]

    def command(self, payload):
        if payload.source is None or self.closing:
            return
        if payload.source.command == "start":
            self.requested = True
            self.changed.set()
        elif payload.source.command == "stop":
            self.disconnected()

    def disconnected(self):
        self.requested = False
        if self.audio is not None:
            self.audio.mute()
        if self.active is not None and not self.active.cancelling():
            self.active.cancel()
        self.changed.set()

    async def _worker(self):
        while not self.closing:
            await self.changed.wait()
            self.changed.clear()
            if self.closing:
                break
            if not self.requested:
                continue
            self.active = asyncio.create_task(self._stream())
            try:
                await self.active
            except asyncio.CancelledError:
                pass
            except (Exception, BaseExceptionGroup) as error:
                # Transfer the original exception to run(); it decides retry vs fatal.
                self.failure = error
                self.failed.set()
                self.requested = False
            finally:
                self.active = None

    async def _stream(self):
        if not paired(self.client):
            raise PairingRequired("Source requires pairing; stop the service and run 'pair' with its state directory.")
        async with asyncio.timeout(20):
            while not self.client.is_time_synchronized():
                await asyncio.sleep(0.05)
        with sdk_errors():
            capture = self.client.create_source_capture(SupportedAudioFormat(
                codec=AudioCodec.PCM, sample_rate=RATE, channels=CHANNELS, bit_depth=16,
            ))
        audio = StreamInput(self.owner) if self.owner else self.audio_factory(self.client.now_us)
        self.audio = audio
        try:
            # SDK start verifies paired admission, active SOURCE role and synchronization
            # before this network stream subscribes to capture.
            async with asyncio.timeout(5):
                await sdk_call(capture.start)
            if self.owner:
                await self.owner.acquire(audio)
            else:
                opening = asyncio.create_task(asyncio.to_thread(audio.open, self.device))
                await finish_open(opening, audio)
            LOG.info("Streaming stereo line input at 48000 Hz / 16-bit; stable ADC clock.")
            while True:
                pcm, timestamp = await audio.read()
                if not self.requested or not paired(self.client):
                    return
                try:
                    async with asyncio.timeout(SEND_TIMEOUT_SECONDS):
                        await sdk_call(capture.feed, pcm, capture_timestamp_us=timestamp)
                except TimeoutError:
                    raise CaptureError(
                        "Audio send stalled for one second; reconnecting and discarding queued audio. "
                        "Check the Pi-to-MA network and MA server load; do not reset pairing for this timeout."
                    ) from None
        finally:
            audio.mute()

            async def stop_capture():
                async with asyncio.timeout(1):
                    await sdk_call(capture.stop)

            try:
                await cleanup_async([
                    ("capture device close", lambda: self.owner.release(audio)
                     if self.owner else asyncio.to_thread(audio.close)),
                    ("Sendspin stream stop", stop_capture),
                ], primary=sys.exception())
            finally:
                self.audio = None

    async def close(self):
        self.closing = True
        self.disconnected()
        await self.worker
        unsubscribes, self.unsubscribes = self.unsubscribes, []
        for unsubscribe in unsubscribes:
            unsubscribe()
