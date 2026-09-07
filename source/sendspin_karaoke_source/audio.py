"""Bounded PortAudio capture with client-local first-sample ADC timestamps."""

import asyncio
import array
import math
import queue
import sys
import threading
import time

from .config import CaptureError, alsa_cards, input_devices, select_device
from .lifecycle import cleanup_async, cleanup_sync, finish_open

RATE = 48_000
CHANNELS = 2
# Match the pinned SDK's 25 ms PCM frames: STOP has no partial encoder tail.
FRAMES = 1200
# Allow a short scheduling/network stall, not an outage-length recording.
MAX_BLOCKS = 32
MAX_AGE_US = 1_000_000


def discover():
    import sounddevice as sd
    # PortAudio caches ALSA's device list at initialization. This private pair is
    # pinned to sounddevice 0.5.3 and is called only with no live source stream.
    try:
        sd._terminate()
        sd._initialize()
        return input_devices(sd.query_devices(), sd.query_hostapis(), alsa_cards())
    except (sd.PortAudioError, OSError):
        raise CaptureError("Cannot enumerate ALSA inputs; check USB and audio-group access.") from None


class AudioInput:
    def __init__(self, now_us):
        self.now_us = now_us
        self.blocks = queue.Queue(maxsize=MAX_BLOCKS)
        self.failure = None
        self.stream = None
        self.accepting = threading.Event()
        self.accepting.set()
        self.last_timestamp = None
        self.clock_anchor = None

    def callback(self, data, frames, timing, status):
        if not self.accepting.is_set() or self.failure is not None:
            return
        if status:
            self.failure = CaptureError("Capture overflow/device error; check USB, CPU load and competing audio apps.")
            return
        offset = timing.inputBufferAdcTime - timing.currentTime
        if not math.isfinite(offset) or offset > 0.01 or offset < -0.25:
            self.failure = CaptureError("Capture returned an invalid/stale ADC timestamp.")
            return
        if self.clock_anchor is None:
            self.failure = CaptureError("Capture clock was not calibrated before audio started.")
            return
        portaudio_time, client_time_us = self.clock_anchor
        timestamp = client_time_us + round(
            (timing.inputBufferAdcTime - portaudio_time) * 1_000_000
        )
        if self.last_timestamp is not None and timestamp <= self.last_timestamp:
            self.failure = CaptureError("Capture clock moved backwards; restarting the source connection.")
            return
        self.last_timestamp = timestamp
        pcm = bytes(data)
        if frames != FRAMES or len(pcm) != FRAMES * CHANNELS * 2:
            self.failure = CaptureError("Capture returned an unexpected PCM block size.")
            return
        try:
            self.blocks.put_nowait((pcm, timestamp))
        except queue.Full:
            self.failure = CaptureError("Capture queue overflow; refusing to send delayed audio.")

    def open(self, selector):
        import sounddevice as sd
        selected = select_device(selector, discover())
        try:
            sd.check_input_settings(device=selected.index, channels=CHANNELS, dtype="int16", samplerate=RATE)
            self.stream = sd.RawInputStream(
                device=selected.index, channels=CHANNELS, dtype="int16", samplerate=RATE,
                blocksize=FRAMES, latency="high", callback=self.callback,
            )
            self._calibrate_clock()
            if self.accepting.is_set():
                self.stream.start()
        except CaptureError as error:
            cleanup_sync([("device clock calibration", self.close)], primary=error)
            raise
        except (sd.PortAudioError, OSError) as error:
            cleanup_sync([("device open", self.close)], primary=error)
            raise CaptureError(
                "Cannot open 48000 Hz / 16-bit / stereo capture. Check USB and audio-group access; "
                "close apps using this input or release only this card in PipeWire (do not disable "
                "desktop audio globally). Run 'devices' as the service user."
            ) from None

    def _calibrate_clock(self):
        # PortAudio stream.time uses the callback's clock and is valid before START.
        # Use the shortest bracket; callback/GIL delays must never move this mapping.
        samples = []
        for _ in range(3):
            before = self.now_us()
            portaudio_time = self.stream.time
            after = self.now_us()
            if not math.isfinite(portaudio_time) or after < before:
                raise CaptureError("Invalid capture clock calibration; check the audio device.")
            samples.append((after - before, portaudio_time, (before + after) // 2))
        elapsed, portaudio_time, client_time_us = min(samples, key=lambda sample: sample[0])
        if elapsed > 10_000:
            raise CaptureError("Capture clock calibration delayed; check Pi CPU load.")
        self.clock_anchor = (portaudio_time, client_time_us)

    def mute(self):
        self.accepting.clear()

    def close(self):
        self.mute()
        if self.stream is not None:
            stream, self.stream = self.stream, None
            try:
                cleanup_sync([
                    ("PortAudio abort", lambda: self._portaudio_call(stream.abort)),
                    ("PortAudio close", lambda: self._portaudio_call(stream.close)),
                ])
            finally:
                while not self.blocks.empty():
                    self.blocks.get_nowait()
        while not self.blocks.empty():
            self.blocks.get_nowait()

    @staticmethod
    def _portaudio_call(operation):
        import sounddevice as sd
        try:
            return operation()
        except (sd.PortAudioError, OSError):
            raise CaptureError("PortAudio device operation failed; check USB and audio ownership.") from None

    async def read(self):
        deadline = time.monotonic() + 2
        while True:
            if self.failure:
                raise self.failure
            if self.stream is not None and not self._portaudio_call(lambda: self.stream.active):
                raise CaptureError("Capture device stopped/disconnected; check USB and audio ownership.")
            try:
                pcm, timestamp = self.blocks.get_nowait()
            except queue.Empty:
                if time.monotonic() >= deadline:
                    raise CaptureError("No capture samples for two seconds; check USB/device connection.")
                await asyncio.sleep(0.005)
                continue
            if not 0 <= self.now_us() - timestamp <= MAX_AGE_US:
                raise CaptureError("Discarded stale capture audio; check CPU/network load.")
            return pcm, timestamp


async def check_device(device, audio_factory=AudioInput):
    """Measure three seconds locally; never create a network client or audio file."""
    audio = audio_factory(lambda: time.monotonic_ns() // 1000)
    sums = [0, 0]
    peaks = [0, 0]
    clipped = [0, 0]
    count = 0
    opening = asyncio.create_task(asyncio.to_thread(audio.open, device))
    try:
        await finish_open(opening, audio)
        async with asyncio.timeout(5):
            for _ in range(RATE * 3 // FRAMES):
                pcm, _ = await audio.read()
                samples = array.array("h", pcm)
                if sys.byteorder != "little":
                    samples.byteswap()
                for channel in range(CHANNELS):
                    values = samples[channel::CHANNELS]
                    sums[channel] += sum(value * value for value in values)
                    peaks[channel] = max(peaks[channel], max(abs(value) for value in values))
                    clipped[channel] += sum(abs(value) >= 32767 for value in values)
                count += len(samples) // CHANNELS
    finally:
        audio.mute()
        await cleanup_async(
            [("local probe device close", lambda: asyncio.to_thread(audio.close))],
            primary=sys.exception(),
        )

    def dbfs(value):
        return f"{20 * math.log10(value / 32768):.1f}" if value else "-inf"

    print("Captured 3 seconds: 48000 Hz / 16-bit / stereo; no capture overflows.")
    for channel, label in enumerate(("Left", "Right")):
        rms = math.sqrt(sums[channel] / count)
        print(f"{label}: RMS {dbfs(rms)} dBFS; peak {dbfs(peaks[channel])} dBFS; clipped samples {clipped[channel]}.")
    if max(peaks) < 64:
        print("Very low level/silence: check line-level source playback, volume and RCA connections.")
    if any(clipped):
        print("Clipping detected: lower the source's line-output level.")
    print("Local probe only: no audio saved or transmitted; capture is now closed.")
