"""Passive PCM16 sample meters; never owns or opens an input device."""

import array
import math
import sys
import time


def dbfs(amplitude):
    return max(-60.0, min(0.0, 20 * math.log10(amplitude))) if amplitude > 0 else -60.0


def quiet_channel():
    return {"rmsDbfs": -60.0, "peakDbfs": -60.0, "holdDbfs": -60.0, "possibleClipping": False}


class Meters:
    def __init__(self, *, clock=time.monotonic):
        self.clock = clock
        self.active = False
        self.sequence = 0
        self.last_sample = None
        self.next_publish = None
        self.energy = [0.0, 0.0]
        self.peaks = [0.0, 0.0]
        self.holds = [0.0, 0.0]
        self.hold_until = [0.0, 0.0]
        self.clip_block = [None, None]
        self.clip_until = [0.0, 0.0]
        self.published = [quiet_channel(), quiet_channel()]

    def _reset(self):
        self.energy = [0.0, 0.0]
        self.peaks = [0.0, 0.0]
        self.holds = [0.0, 0.0]
        self.hold_until = [0.0, 0.0]
        self.clip_block = [None, None]
        self.clip_until = [0.0, 0.0]
        self.published = [quiet_channel(), quiet_channel()]
        self.next_publish = None

    def context(self, active):
        if not active or not self.active:
            self._reset()
            self.last_sample = None
        self.active = bool(active)

    def offer(self, pcm, timestamp):
        if not self.active:
            return
        if len(pcm) != 4800:
            raise ValueError("Invalid meter PCM block.")
        now = self.clock()
        if self.last_sample is not None and now - self.last_sample > 0.5:
            self._reset()
        samples = array.array("h", pcm)
        if sys.byteorder != "little":
            samples.byteswap()
        sums, peaks, clips = [0, 0], [0, 0], [0, 0]
        for index, sample in enumerate(samples):
            channel = index & 1
            magnitude = abs(sample)
            sums[channel] += sample * sample
            peaks[channel] = max(peaks[channel], magnitude)
            clips[channel] += sample in (-32768, 32767)
        alpha = -math.expm1(-0.025 / 0.3)
        for channel in range(2):
            self.energy[channel] += alpha * (sums[channel] / (1200 * 32768**2) - self.energy[channel])
            peak = peaks[channel] / 32768
            self.peaks[channel] = max(self.peaks[channel], peak)
            if now >= self.hold_until[channel] or peak >= self.holds[channel]:
                self.holds[channel] = peak
                self.hold_until[channel] = now + 1.5
            if clips[channel] >= 3:
                previous = self.clip_block[channel]
                if previous is not None and now - previous <= 0.25:
                    self.clip_until[channel] = now + 1.5
                self.clip_block[channel] = now
        self.last_sample = now
        if self.next_publish is None or now >= self.next_publish:
            self.published = [
                {"rmsDbfs": dbfs(math.sqrt(self.energy[c])), "peakDbfs": dbfs(self.peaks[c]),
                 "holdDbfs": dbfs(self.holds[c]), "possibleClipping": now < self.clip_until[c]}
                for c in range(2)
            ]
            self.peaks = [0.0, 0.0]
            # Carry the fractional interval across 25 ms blocks rather than
            # rounding every publication up to three blocks (only 13.3 Hz).
            due = now if self.next_publish is None else max(self.next_publish, now - 1 / 15)
            self.next_publish = due + 1 / 15
            self.sequence += 1

    def snapshot(self):
        age = None if self.last_sample is None else max(0, (self.clock() - self.last_sample) * 1000)
        state = "inactive" if not self.active else (
            "stale" if age is None or age >= 500 else "active"
        )
        if state != "active":
            self._reset()
        channels = self.published if state == "active" else [quiet_channel(), quiet_channel()]
        return {
            "version": 1, "state": state, "sequence": self.sequence,
            "sampleAgeMs": None if age is None else min(round(age), 86_400_000),
            "staleAfterMs": 500, "sampleRate": 48000, "channels": 2,
            "left": dict(channels[0]), "right": dict(channels[1]),
        }
