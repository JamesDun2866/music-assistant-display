import array
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sendspin_karaoke_source.meters import Meters


def pcm(left, right):
    samples = array.array("h", [left, right] * 1200)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples.tobytes()


class MeterTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.meter = Meters(clock=lambda: self.now)

    def feed(self, left=0, right=0, blocks=1):
        for _ in range(blocks):
            self.now += 0.025
            self.meter.offer(pcm(left, right), 0)
        return self.meter.snapshot()

    def test_passive_inactive_silence_and_stale(self):
        self.assertEqual(self.feed(32767)["state"], "inactive")
        self.meter.context(True)
        value = self.feed()
        self.assertEqual(value["state"], "active")
        self.assertEqual(value["left"]["rmsDbfs"], -60)
        self.now += 0.501
        value = self.meter.snapshot()
        self.assertEqual(value["state"], "stale")
        self.assertEqual(value["left"]["peakDbfs"], -60)
        self.meter.context(False)
        self.assertEqual(self.meter.snapshot()["state"], "inactive")

    def test_independent_stereo_and_rms_calibration(self):
        self.meter.context(True)
        value = self.feed(16384, 0, 160)
        self.assertAlmostEqual(value["left"]["rmsDbfs"], 20 * math.log10(0.5), places=3)
        self.assertEqual(value["right"]["rmsDbfs"], -60)
        self.assertFalse(value["left"]["possibleClipping"])
        self.assertLessEqual(value["sequence"], 1 + 4 * 15)
        self.assertGreaterEqual(value["sequence"], 4 * 15 - 1)

    def test_smoothed_attack_peak_interval_and_hold(self):
        self.meter.context(True)
        initial = self.feed(16384)
        self.assertLess(initial["left"]["rmsDbfs"], -12)
        self.feed(32767)
        self.feed()
        value = self.feed()
        self.assertGreater(value["left"]["peakDbfs"], -0.01)
        self.assertGreater(value["left"]["holdDbfs"], -0.01)
        value = self.feed(blocks=64)
        self.assertEqual(value["left"]["holdDbfs"], -60)

    def test_clipping_requires_two_blocks_and_clears(self):
        self.meter.context(True)
        self.assertFalse(self.feed(-32768)["left"]["possibleClipping"])
        self.feed(-32768)
        value = self.feed(blocks=2)
        self.assertTrue(value["left"]["possibleClipping"])
        self.assertFalse(value["right"]["possibleClipping"])
        self.assertFalse(self.feed(blocks=64)["left"]["possibleClipping"])
        self.feed(-32768, blocks=4)
        self.meter.context(False)
        self.assertFalse(self.meter.snapshot()["left"]["possibleClipping"])

    def test_clip_blocks_outside_window_and_single_fullscale_sample(self):
        self.meter.context(True)
        self.feed(32767)
        self.feed(blocks=11)
        self.feed(32767)
        self.assertFalse(self.feed(blocks=3)["left"]["possibleClipping"])
        block = bytearray(pcm(0, 0))
        block[:2] = b"\xff\x7f"
        for _ in range(4):
            self.now += 0.025
            self.meter.offer(bytes(block), 0)
        self.assertFalse(self.meter.snapshot()["left"]["possibleClipping"])

    def test_repeated_context_preserves_active_energy_and_stale_resets(self):
        self.meter.context(True)
        before = self.feed(16000, blocks=20)["left"]["rmsDbfs"]
        self.meter.context(True)
        self.assertEqual(self.meter.snapshot()["left"]["rmsDbfs"], before)
        self.now += 0.6
        self.assertEqual(self.feed()["left"]["rmsDbfs"], -60)
        self.assertLessEqual(self.meter.snapshot()["sampleAgeMs"], 86_400_000)


if __name__ == "__main__":
    unittest.main()
