import array
import asyncio
import dataclasses
import json
import math
import os
from pathlib import Path
import shutil
import stat
import sys
import threading
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import soundfile as sf
from aiosendspin.clock import RawMonotonicClock

from sendspin_karaoke_source.audio import CHANNELS, FRAMES, RATE, MAX_BLOCKS, MAX_AGE_US
from sendspin_karaoke_source.bridge import SourceBridge
from sendspin_karaoke_source.cli import dispatch, make_client, service
from sendspin_karaoke_source.config import CaptureError, Config, PairingRequired, SourceError, parse_args
from sendspin_karaoke_source.control import ControlServer, MAX_MESSAGE, SOCKET_NAME, decode, request
from sendspin_karaoke_source.recording import (
    MAX_RECORDING_FRAMES, Recorder, RecordingWriter, SILENCE_FRAMES, WRITER_BLOCKS, validate_options,
)
from sendspin_karaoke_source.shared import SharedCapture, StreamInput, wait_thread_event
from sendspin_karaoke_source.state import load_identity, locked_state, open_store
from test_source import FakeAudio, FakeClient, PrivateWorkspace, command, eventually


def pcm(left=0, right=0):
    return array.array("h", [left, right] * FRAMES).tobytes()


class RecordingOptionsTests(unittest.TestCase):
    def test_defaults_and_explicit_cli(self):
        for command_name in ("record-start", "record-stop", "record-status"):
            with self.subTest(command=command_name):
                config = parse_args([command_name, "--state-dir", str(SOURCE)])
                self.assertEqual(config.command, command_name)
                self.assertEqual(config.format, "flac")
                self.assertEqual(config.silence_dbfs, -45)
        config = parse_args([
            "record-start", "--format", "wav", "--silence-dbfs", "-60", "--state-dir", str(SOURCE),
        ])
        self.assertEqual((config.format, config.silence_dbfs), ("wav", -60))

    def test_finite_negative_threshold_only(self):
        for value in (0, 1, float("inf"), float("-inf"), float("nan"), True, "-45", None, -(10**500)):
            with self.subTest(value=value), self.assertRaises(SourceError):
                validate_options("flac", value)
        for value in (-0.001, -45, -10000):
            validate_options("flac", value)

    def test_strict_control_schema(self):
        good = decode(b'{"command":"record-start","format":"wav","silence_dbfs":-50}\n')
        self.assertEqual(good["format"], "wav")
        for data in (
            b"[]", b"null", b"{}", b'{"command":true}',
            b'{"command":"record-start","path":"/etc/test"}',
            b'{"command":"record-start","filename":"../x"}',
            b'{"command":"record-start","format":"mp3"}',
            b'{"command":"record-start","silence_dbfs":NaN}',
            b'{"command":"record-start","silence_dbfs":true}',
            b'{"command":"record-start","silence_dbfs":-Infinity}',
            b'{"command":"record-status","format":"wav"}',
            b'{"command":"record-status","command":"record-stop"}',
            b'{"command":"unknown"}', b"\xff", b"x" * (MAX_MESSAGE + 1),
            b'{"command":"record-start","silence_dbfs":-' + b"9" * 600 + b"}",
        ):
            with self.subTest(data=data[:120]), self.assertRaises(SourceError):
                decode(data)


class ControlHandlerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.recorder = SimpleNamespace(
            start=AsyncMock(return_value={"state": "recording"}),
            stop=AsyncMock(return_value={"state": "completed"}),
            status=Mock(return_value={"state": "off"}),
        )
        self.server = ControlServer(SOURCE, self.recorder)

    async def handle(self, data):
        reader = asyncio.StreamReader(limit=MAX_MESSAGE)
        reader.feed_data(data)
        reader.feed_eof()
        writer = SimpleNamespace(
            write=Mock(), drain=AsyncMock(), close=Mock(), wait_closed=AsyncMock(),
        )
        await self.server._handle(reader, writer)
        writer.close.assert_called_once()
        writer.wait_closed.assert_awaited_once()
        return json.loads(writer.write.call_args.args[0]) if writer.write.called else None

    async def test_successful_defaults_and_explicit_options(self):
        self.assertTrue((await self.handle(b'{"command":"record-start"}\n'))["ok"])
        self.recorder.start.assert_awaited_once_with("flac", -45)
        await self.handle(b'{"command":"record-start","format":"wav","silence_dbfs":-50}\n')
        self.recorder.start.assert_awaited_with("wav", -50)
        self.assertEqual(
            (await self.handle(b'{"command":"record-stop"}\n'))["recording"]["state"], "completed",
        )

    async def test_recognition_controls_never_start_or_stop_recording(self):
        self.server.recognition = SimpleNamespace(
            enable=AsyncMock(return_value={"state": "armed"}),
            disable=AsyncMock(return_value={"state": "disabled"}),
            status=Mock(return_value={"state": "idle"}),
        )
        enabled = await self.handle(b'{"command":"recognition-enable","silence_dbfs":-55}\n')
        self.assertEqual(enabled, {"ok": True, "recognition": {"state": "armed"}})
        self.server.recognition.enable.assert_awaited_once_with(-55)
        self.assertEqual((await self.handle(b'{"command":"recognition-status"}\n'))["recognition"]["state"], "idle")
        self.assertEqual((await self.handle(b'{"command":"recognition-disable"}\n'))["recognition"]["state"], "disabled")
        self.recorder.start.assert_not_awaited()
        self.recorder.stop.assert_not_awaited()
        self.server.recognition.enable.side_effect = SourceError("optional dependency missing")
        failed = await self.handle(b'{"command":"recognition-enable"}\n')
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["recognition"]["state"], "idle")
        self.assertNotIn("recording", failed)

    async def test_busy_bad_schema_size_and_truncated_requests_are_explicit_errors(self):
        self.recorder.start.side_effect = SourceError("busy")
        response = await self.handle(b'{"command":"record-start"}\n')
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"], "busy")
        for raw in (
            b"x" * (MAX_MESSAGE + 1) + b"\n",
            b'{"command":"record-start","path":"../../bad"}\n',
            b'{"command":"record-status"}', b"\xff\n",
        ):
            with self.subTest(raw=raw[:100]):
                self.assertFalse((await self.handle(raw))["ok"])

    async def test_unexpected_backend_error_is_exposed_to_service_not_hidden(self):
        bug = TypeError("bug")
        self.recorder.start.side_effect = bug
        self.assertIsNone(await self.handle(b'{"command":"record-start"}\n'))
        self.assertTrue(self.server.failed.is_set())
        self.assertIs(self.server.failure, bug)

    async def test_control_dispatch_does_not_touch_identity_pairing_or_service_lock(self):
        config = Config("record-status", "", "", "", SOURCE)
        with patch("sendspin_karaoke_source.cli.request", AsyncMock(return_value={"state": "off"})) as call, \
             patch("sendspin_karaoke_source.cli.locked_state", side_effect=AssertionError("must not lock")), \
             patch("sendspin_karaoke_source.cli.load_identity", side_effect=AssertionError("must not load")), \
             patch("sendspin_karaoke_source.cli.open_store", side_effect=AssertionError("must not load")), \
             patch("builtins.print") as output:
            await dispatch(config)
        call.assert_awaited_once_with(config)
        self.assertEqual(json.loads(output.call_args.args[0]), {"state": "off"})


class WriterTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.create_workspace()
        self.writers = []
        self.addAsyncCleanup(self.finish_writers)

    async def finish_writers(self):
        for writer in self.writers:
            writer.stop("test-cleanup")
            await wait_thread_event(writer.done, 4)

    async def writer(self, format="flac", threshold=-45, codec_factory=sf.SoundFile):
        writer = RecordingWriter(self.path, format, threshold, codec_factory=codec_factory)
        self.writers.append(writer)
        writer.thread.start()
        await wait_thread_event(writer.ready, 3)
        return writer

    async def feed(self, writer, block, count):
        start = writer.frames
        for index in range(count):
            writer.offer(block, 0)
            if index % 20 == 19:
                target = start + (index + 1) * FRAMES
                await eventually(lambda: writer.frames >= target or writer.done.is_set())
        await eventually(lambda: writer.frames >= start + count * FRAMES or writer.done.is_set())

    def read(self, writer):
        with sf.SoundFile(writer.path) as handle:
            self.assertEqual(handle.samplerate, RATE)
            self.assertEqual(handle.channels, 2)
            self.assertEqual(handle.subtype, "PCM_16")
            self.assertEqual(handle.format, writer.format.upper())
            return handle.buffer_read(handle.frames, dtype="int16")

    async def test_real_lossless_flac_and_wav_metadata_and_exact_pcm(self):
        for format in ("flac", "wav"):
            with self.subTest(format=format):
                writer = await self.writer(format)
                self.assertTrue(writer.path.name.endswith(".partial"))
                block = pcm(-32768, 32767)
                await self.feed(writer, block, 4)
                writer.stop("manual")
                await wait_thread_event(writer.done, 3)
                self.assertEqual(writer.state, "completed")
                self.assertEqual(writer.reason, "manual")
                self.assertEqual(bytes(self.read(writer)), block * 4)
                self.assertFalse(writer.path.name.endswith(".partial"))
                self.assertEqual(writer.frames, FRAMES * 4)

    async def test_exact_five_seconds_nonzero_noise_kept_and_no_rearm(self):
        writer = await self.writer()
        noise = pcm(80, -120)  # Nonzero but below -45 dBFS in both channels.
        await self.feed(writer, noise, SILENCE_FRAMES // FRAMES - 1)
        self.assertFalse(writer.done.is_set())
        self.assertEqual(writer.frames, SILENCE_FRAMES - FRAMES)
        writer.offer(noise, 0)
        await wait_thread_event(writer.done, 3)
        self.assertEqual((writer.reason, writer.frames), ("silence", SILENCE_FRAMES))
        writer.offer(pcm(30000, 0), 1)
        self.assertFalse(writer.accepting)
        self.assertEqual(writer.frames, SILENCE_FRAMES)
        self.assertEqual(bytes(self.read(writer)), noise * (SILENCE_FRAMES // FRAMES))

    async def test_either_channel_activity_resets_consecutive_silence(self):
        for left, right in ((400, 0), (0, -400)):
            with self.subTest(channels=(left, right)):
                writer = await self.writer()
                await self.feed(writer, pcm(1, -1), 199)
                await self.feed(writer, pcm(left, right), 1)
                await eventually(lambda: writer.silent_frames == 0)
                await self.feed(writer, pcm(), 199)
                self.assertFalse(writer.done.is_set())
                writer.offer(pcm(), 0)
                await wait_thread_event(writer.done, 3)
                self.assertEqual(writer.frames, 400 * FRAMES)

    async def test_threshold_boundary_is_silent_above_boundary_resets(self):
        writer = await self.writer(threshold=20 * math.log10(16384 / 32768))
        await self.feed(writer, pcm(16384, -16384), 199)
        self.assertEqual(writer.silent_frames, 199 * FRAMES)
        await self.feed(writer, pcm(16385, 0), 1)
        await eventually(lambda: writer.silent_frames == 0)
        await self.feed(writer, pcm(16384, 0), 200)
        await wait_thread_event(writer.done, 3)
        self.assertEqual(writer.reason, "silence")
        self.assertEqual(writer.frames, 400 * FRAMES)

    async def test_queue_overflow_is_bounded_and_preserves_readable_partial(self):
        entered, release = threading.Event(), threading.Event()

        def codec_factory(*args, **kwargs):
            codec = sf.SoundFile(*args, **kwargs)
            write = codec.buffer_write

            def blocked(*args, **kwargs):
                entered.set()
                release.wait(3)
                return write(*args, **kwargs)

            codec.buffer_write = blocked
            return codec

        writer = await self.writer(codec_factory=codec_factory)
        try:
            writer.offer(pcm(1000), 0)
            await eventually(entered.is_set)
            for _ in range(WRITER_BLOCKS + 1):
                writer.offer(pcm(1000), 0)
            self.assertEqual(writer.blocks.qsize(), WRITER_BLOCKS)
            self.assertEqual(writer.state, "failed")
            self.assertIn("overflow", writer.error)
        finally:
            release.set()
        await wait_thread_event(writer.done, 3)
        self.assertTrue(writer.path.name.endswith(".partial"))
        self.assertEqual(len(self.read(writer)), FRAMES * 4)

    async def test_disk_write_failure_closes_and_reports_partial(self):
        def broken(*args, **kwargs):
            codec = sf.SoundFile(*args, **kwargs)
            write = codec.buffer_write
            calls = 0

            def fail_after_one(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls > 1:
                    raise OSError("disk full")
                return write(*args, **kwargs)

            codec.buffer_write = fail_after_one
            return codec

        writer = await self.writer(codec_factory=broken)
        writer.offer(pcm(500), 0)
        await eventually(lambda: writer.frames == FRAMES)
        writer.offer(pcm(500), 0)
        await wait_thread_event(writer.done, 3)
        self.assertEqual(writer.state, "failed")
        self.assertIn("OSError", writer.error)
        self.assertIsNone(writer.unexpected)
        self.assertTrue(writer.path.exists())
        self.assertTrue(writer.path.name.endswith(".partial"))
        self.assertEqual(len(self.read(writer)), FRAMES * 4)

    async def test_codec_open_and_close_failures_are_visible(self):
        def broken_close(*args, **kwargs):
            codec = sf.SoundFile(*args, **kwargs)
            close = codec.close

            def fail_close():
                codec.close = close
                close()
                raise OSError("close failed")

            codec.close = fail_close
            return codec

        for factory in (Mock(side_effect=sf.LibsndfileError(1)), broken_close):
            with self.subTest(factory=factory):
                writer = await self.writer(codec_factory=factory)
                writer.stop("manual")
                await wait_thread_event(writer.done, 3)
                self.assertEqual(writer.state, "failed")
                self.assertTrue(writer.path.name.endswith(".partial"))
                self.assertTrue(writer.path.exists())
                self.assertIsNone(writer.unexpected)

    async def test_unexpected_writer_bug_is_not_classified_as_disk_failure(self):
        writer = await self.writer(codec_factory=Mock(side_effect=TypeError("bug")))
        await wait_thread_event(writer.done, 3)
        self.assertIsInstance(writer.unexpected, TypeError)
        self.assertEqual(writer.state, "failed")

    async def test_pinned_soundfile_short_write_is_a_recording_error_not_a_service_bug(self):
        def short_write(*args, **kwargs):
            codec = sf.SoundFile(*args, **kwargs)
            codec._cdata_io = Mock(return_value=0)
            return codec

        writer = await self.writer("wav", codec_factory=short_write)
        writer.offer(pcm(500), 0)
        await wait_thread_event(writer.done, 3)
        self.assertEqual(writer.state, "failed")
        self.assertIn("Incomplete recording disk write", writer.error)
        self.assertIsNone(writer.unexpected)
        self.assertTrue(writer.path.name.endswith(".partial"))

    async def test_unrelated_writer_assertion_remains_an_unexpected_bug(self):
        def bug(*args, **kwargs):
            codec = sf.SoundFile(*args, **kwargs)
            codec.buffer_write = Mock(side_effect=AssertionError("bug"))
            return codec

        writer = await self.writer("wav", codec_factory=bug)
        writer.offer(pcm(500), 0)
        await wait_thread_event(writer.done, 3)
        self.assertIsInstance(writer.unexpected, AssertionError)

    async def test_empty_flac_is_not_falsely_reported_as_a_valid_completed_file(self):
        writer = await self.writer()
        writer.stop("manual")
        await wait_thread_event(writer.done, 3)
        self.assertEqual(writer.state, "failed")
        self.assertIn("empty FLAC", writer.error)
        self.assertTrue(writer.path.name.endswith(".partial"))

    async def test_cap_is_explicit_and_finalizes_without_rearm(self):
        self.assertGreater(MAX_RECORDING_FRAMES / RATE, 6 * 60 * 60)
        self.assertLess(MAX_RECORDING_FRAMES * 4, 2**32 - 1000)
        with patch("sendspin_karaoke_source.recording.MAX_RECORDING_FRAMES", FRAMES * 3):
            writer = await self.writer("wav")
            await self.feed(writer, pcm(900), 5)
            await wait_thread_event(writer.done, 3)
            self.assertEqual((writer.reason, writer.frames), ("size-limit", FRAMES * 3))
            self.assertFalse(writer.accepting)
            self.assertEqual(len(self.read(writer)), FRAMES * 3 * 4)

    async def test_exclusive_partial_and_final_names_never_overwrite(self):
        first = await self.writer("wav")
        first.stop("manual")
        await wait_thread_event(first.done, 3)
        original = first.path.read_bytes()
        second = RecordingWriter(self.path, "wav", -45)
        second.name = first.name
        second.path = self.path / "recordings" / (first.name + ".partial")
        self.writers.append(second)
        second.thread.start()
        await wait_thread_event(second.ready, 3)
        second.stop("manual")
        await wait_thread_event(second.done, 3)
        self.assertEqual(second.state, "failed")
        self.assertEqual(first.path.read_bytes(), original)
        self.assertTrue(second.path.exists())

    @unittest.skipUnless(os.name == "posix", "Unix filesystem permissions")
    async def test_private_files_and_symlink_rejection(self):
        writer = await self.writer()
        writer.stop("manual")
        await wait_thread_event(writer.done, 3)
        self.assertEqual(stat.S_IMODE(writer.directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(writer.path.stat().st_mode), 0o600)
        writer.path.unlink()
        writer.directory.rmdir()
        target = self.path / "elsewhere"
        target.mkdir(mode=0o700)
        writer.directory.symlink_to(target, target_is_directory=True)
        bad = await self.writer()
        await wait_thread_event(bad.done, 3)
        self.assertEqual(bad.state, "failed")
        self.assertIsNone(bad.unexpected)
        self.assertEqual(list(target.iterdir()), [])


class SharedRecordingTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.create_workspace()
        self.inputs = []

        def factory(now_us):
            audio = FakeAudio(now_us)
            self.inputs.append(audio)
            return audio

        self.owner = SharedCapture("hw:CARD=CODEC,DEV=0", factory)
        self.recorder = Recorder(self.owner, self.path)
        self.client = FakeClient()
        self.client.now_us = self.owner.clock.now_us
        self.bridge = SourceBridge(self.client, self.owner.device, owner=self.owner)
        self.addAsyncCleanup(self.owner.close)
        self.addAsyncCleanup(self.recorder.close)
        self.addAsyncCleanup(self.bridge.close)

    async def feed(self, block=pcm(1000), count=1):
        for index in range(count):
            self.inputs[-1].queue.put_nowait((block, self.owner.clock.now_us()))
            if index % 10 == 9:
                await asyncio.sleep(0.005)
        await asyncio.sleep(0.01)

    async def stream(self):
        self.bridge.command(command("start"))
        await eventually(lambda: self.owner.consumers and self.client.captures)

    async def test_disabled_default_and_immediate_recording_without_ma_start(self):
        await asyncio.sleep(0.02)
        self.assertEqual(self.recorder.status()["state"], "off")
        self.assertEqual(self.inputs, [])
        self.client.connected = False
        status = await self.recorder.start()
        self.assertTrue(status["active"])
        self.assertEqual(len(self.inputs), 1)
        self.assertEqual(len(self.client.captures), 0)
        await self.feed()
        await self.recorder.stop()
        self.assertTrue(self.inputs[0].closed)
        self.assertEqual(self.recorder.writer.frames, FRAMES)

    async def test_one_input_simultaneous_stream_then_record_and_stop_isolation(self):
        await self.stream()
        await self.recorder.start("wav")
        self.assertEqual(len(self.inputs), 1)
        await self.feed()
        await eventually(lambda: self.client.captures[0].feed.await_count == 1)
        self.bridge.command(command("stop"))
        await eventually(lambda: self.bridge.active is None)
        self.assertFalse(self.inputs[0].muted)
        await self.feed(count=2)
        self.assertTrue(self.recorder.status()["active"])
        await self.recorder.stop()
        self.assertEqual(self.recorder.writer.frames, FRAMES * 3)
        self.assertTrue(self.inputs[0].closed)

    async def test_record_then_stream_and_record_stop_leaves_streaming_live(self):
        await self.recorder.start()
        await self.stream()
        await self.feed()
        await self.recorder.stop()
        self.assertFalse(self.inputs[0].closed)
        await self.feed()
        await eventually(lambda: self.client.captures[0].feed.await_count == 2)
        self.assertEqual(len(self.inputs), 1)

    async def test_disconnect_reconnect_keeps_capture_and_calibration_and_discards_backlog(self):
        await self.recorder.start()
        await self.stream()
        await self.feed()
        self.client.connected = False
        self.bridge.disconnected()
        await self.bridge.close()
        await self.feed(count=3)
        self.assertTrue(self.recorder.status()["active"])
        self.assertFalse(self.inputs[0].closed)
        other = FakeClient()
        other.now_us = self.owner.clock.now_us
        self.bridge = SourceBridge(other, self.owner.device, owner=self.owner)
        self.addAsyncCleanup(self.bridge.close)
        self.bridge.command(command("start"))
        await eventually(lambda: other.captures and len(self.owner.consumers) == 2)
        self.assertEqual(other.captures[0].feed.await_count, 0)
        await self.feed()
        await eventually(lambda: other.captures[0].feed.await_count == 1)
        self.assertEqual(len(self.inputs), 1)

    async def test_network_send_timeout_does_not_stop_recording(self):
        await self.recorder.start()
        self.client.feed_gate = asyncio.Event()
        with patch("sendspin_karaoke_source.bridge.SEND_TIMEOUT_SECONDS", 0.025):
            await self.stream()
            await self.feed()
            await eventually(self.bridge.failed.is_set)
        self.assertIsInstance(self.bridge.failure, CaptureError)
        self.assertFalse(self.inputs[0].closed)
        await self.feed(count=3)
        self.assertEqual(self.recorder.writer.frames, FRAMES * 4)
        self.assertTrue(self.recorder.status()["active"])

    async def test_five_seconds_silence_closes_idle_input_and_requires_explicit_restart(self):
        await self.recorder.start()
        await self.feed(pcm(20, -20), 200)
        await eventually(lambda: self.recorder.monitor.done())
        self.assertEqual(self.recorder.status()["reason"], "silence")
        self.assertTrue(self.inputs[0].closed)
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.inputs), 1)
        self.assertFalse(self.recorder.status()["active"])
        await self.recorder.start()
        self.assertEqual(len(self.inputs), 2)

    async def test_silence_completion_while_streaming_keeps_input_open(self):
        await self.recorder.start()
        await self.stream()
        await self.feed(pcm(), 200)
        await eventually(lambda: self.recorder.monitor.done())
        self.assertFalse(self.inputs[0].closed)
        await self.feed()
        await eventually(lambda: self.client.captures[0].feed.await_count == 201)

    async def test_recording_disk_failure_does_not_interrupt_stream(self):
        def factory(*args):
            def codec(*args, **kwargs):
                output = sf.SoundFile(*args, **kwargs)
                output.buffer_write = Mock(side_effect=OSError("full"))
                return output
            return RecordingWriter(*args, codec_factory=codec)

        self.recorder.writer_factory = factory
        await self.stream()
        await self.recorder.start()
        await self.feed()
        await eventually(lambda: self.recorder.monitor.done())
        self.assertEqual(self.recorder.status()["state"], "failed")
        self.assertFalse(self.inputs[0].closed)
        await self.feed()
        await eventually(lambda: self.client.captures[0].feed.await_count == 2)
        self.assertFalse(self.bridge.failed.is_set())

    async def test_recording_queue_overflow_does_not_interrupt_stream(self):
        entered, release = threading.Event(), threading.Event()

        def factory(*args):
            def codec_factory(*args, **kwargs):
                codec = sf.SoundFile(*args, **kwargs)
                write = codec.buffer_write

                def blocked(*args, **kwargs):
                    entered.set()
                    release.wait(3)
                    return write(*args, **kwargs)

                codec.buffer_write = blocked
                return codec
            return RecordingWriter(*args, codec_factory=codec_factory)

        self.recorder.writer_factory = factory
        await self.stream()
        await self.recorder.start()
        try:
            await self.feed()
            await eventually(entered.is_set)
            await self.feed(count=WRITER_BLOCKS + 1)
            await eventually(lambda: self.recorder.status()["state"] == "failed")
            self.assertIn("overflow", self.recorder.status()["error"])
            self.assertFalse(self.bridge.failed.is_set())
        finally:
            release.set()
        await eventually(lambda: self.recorder.monitor.done())
        self.assertFalse(self.inputs[0].closed)
        previous = self.client.captures[0].feed.await_count
        await self.feed()
        await eventually(lambda: self.client.captures[0].feed.await_count == previous + 1)

    async def test_failed_blocked_writer_releases_idle_hardware_before_disk_returns(self):
        entered, release = threading.Event(), threading.Event()

        def factory(*args):
            def codec_factory(*args, **kwargs):
                codec = sf.SoundFile(*args, **kwargs)
                write = codec.buffer_write

                def blocked(*args, **kwargs):
                    entered.set()
                    release.wait(3)
                    return write(*args, **kwargs)

                codec.buffer_write = blocked
                return codec
            return RecordingWriter(*args, codec_factory=codec_factory)

        self.recorder.writer_factory = factory
        await self.recorder.start()
        try:
            await self.feed()
            await eventually(entered.is_set)
            await self.feed(count=WRITER_BLOCKS + 1)
            await eventually(lambda: self.inputs[0].closed)
            self.assertEqual(self.recorder.status()["state"], "failed")
            self.assertFalse(self.recorder.writer.done.is_set())
            self.assertEqual(len(self.inputs), 1)
        finally:
            release.set()
        await eventually(lambda: self.recorder.monitor.done())

    async def test_stop_start_stream_race_while_recording_never_reopens_device(self):
        await self.recorder.start()
        await self.stream()
        await self.feed()
        self.bridge.command(command("stop"))
        self.bridge.command(command("start"))
        await eventually(lambda: len(self.client.captures) == 2 and len(self.owner.consumers) == 2)
        self.assertEqual(len(self.inputs), 1)
        self.assertFalse(self.inputs[0].muted)
        self.assertEqual(self.client.captures[1].feed.await_count, 0)
        await self.feed()
        await eventually(lambda: self.client.captures[1].feed.await_count == 1)
        self.assertTrue(self.recorder.status()["active"])

    async def test_writer_open_timeout_cannot_later_start_or_publish_recording(self):
        entered, release = threading.Event(), threading.Event()

        def factory(*args):
            def blocked(*args, **kwargs):
                entered.set()
                release.wait(3)
                return sf.SoundFile(*args, **kwargs)
            return RecordingWriter(*args, codec_factory=blocked)

        self.recorder.writer_factory = factory
        await self.stream()
        try:
            with patch("sendspin_karaoke_source.recording.WRITER_WAIT_SECONDS", 0.025):
                with self.assertRaises(TimeoutError):
                    await self.recorder.start()
            self.assertTrue(entered.is_set())
            self.assertEqual(self.recorder.status()["state"], "failed")
            with self.assertRaises(SourceError):
                await self.recorder.start()
        finally:
            release.set()
        await eventually(lambda: self.recorder.monitor.done())
        self.assertTrue(self.recorder.writer.path.name.endswith(".partial"))
        self.assertFalse(self.inputs[0].closed)
        await self.feed()
        await eventually(lambda: self.client.captures[0].feed.await_count == 1)

    async def test_writer_close_timeout_keeps_partial_and_stream_remains_responsive(self):
        entered, release = threading.Event(), threading.Event()

        def factory(*args):
            def codec_factory(*args, **kwargs):
                codec = sf.SoundFile(*args, **kwargs)
                close = codec.close

                def blocked():
                    entered.set()
                    release.wait(3)
                    return close()

                codec.close = blocked
                return codec
            return RecordingWriter(*args, codec_factory=codec_factory)

        self.recorder.writer_factory = factory
        await self.stream()
        await self.recorder.start()
        await self.feed()
        try:
            with patch("sendspin_karaoke_source.recording.WRITER_WAIT_SECONDS", 0.04):
                with self.assertRaisesRegex(SourceError, "timed out"):
                    await self.recorder.stop()
            self.assertTrue(entered.is_set())
            self.assertEqual(self.recorder.status()["state"], "failed")
            self.assertTrue(self.recorder.status()["worker_pending"])
            self.assertFalse(self.inputs[0].closed)
            with self.assertRaises(SourceError):
                await self.recorder.start()
            await self.feed()
            await eventually(lambda: self.client.captures[0].feed.await_count == 2)
        finally:
            release.set()
        await eventually(lambda: self.recorder.monitor.done())
        self.assertTrue(self.recorder.writer.path.name.endswith(".partial"))
        with sf.SoundFile(self.recorder.writer.path) as handle:
            self.assertEqual(handle.frames, FRAMES)

    async def test_unexpected_writer_bug_reaches_fatal_supervisor(self):
        error = TypeError("programming bug")
        self.recorder.writer_factory = lambda *args: RecordingWriter(
            *args, codec_factory=Mock(side_effect=error),
        )
        with self.assertRaises(SourceError):
            await self.recorder.start()
        await eventually(self.recorder.failed.is_set)
        self.assertIs(self.recorder.failure, error)
        # Verify the cleanup boundary too, then avoid deliberately re-raising twice.
        with self.assertRaises(TypeError):
            await self.recorder.close()
        self.recorder.writer.unexpected = None

    async def test_device_failure_stops_recording_and_does_not_rearm(self):
        await self.recorder.start()
        self.inputs[0].read = AsyncMock(side_effect=CaptureError("USB lost"))
        await self.feed()
        await eventually(lambda: self.recorder.monitor.done())
        self.assertEqual(self.recorder.status()["state"], "failed")
        self.assertTrue(self.recorder.writer.path.name.endswith(".partial"))
        self.assertTrue(self.inputs[0].closed)
        self.assertEqual(len(self.inputs), 1)

    async def test_stream_queue_is_separate_bounded_and_never_replays_old_audio(self):
        await self.recorder.start()
        consumer = StreamInput(self.owner)
        await self.owner.acquire(consumer)
        for _ in range(MAX_BLOCKS + 1):
            consumer.offer(pcm(), self.owner.clock.now_us())
        self.assertIsInstance(consumer.failure, CaptureError)
        self.assertEqual(consumer.blocks.qsize(), 0)
        await self.owner.release(consumer)
        self.assertTrue(self.recorder.status()["active"])
        stale = StreamInput(self.owner)
        stale.offer(pcm(), self.owner.clock.now_us() - MAX_AGE_US - 1)
        with self.assertRaises(CaptureError):
            await stale.read()

    async def test_new_stream_subscription_skips_pre_start_capture_backlog(self):
        await self.recorder.start()
        await self.feed()
        await asyncio.sleep(0.02)
        previous_timestamp = self.owner.clock.now_us()
        consumer = StreamInput(self.owner)
        await self.owner.acquire(consumer)
        self.inputs[0].queue.put_nowait((pcm(2000), previous_timestamp - 1))
        current = pcm(3000)
        self.inputs[0].queue.put_nowait((current, self.owner.clock.now_us()))
        try:
            async with asyncio.timeout(2):
                block, _ = await consumer.read()
            self.assertEqual(block, current)
            await eventually(lambda: self.recorder.writer.frames == FRAMES * 3)
        finally:
            await self.owner.release(consumer)

    async def test_record_start_busy_and_stop_when_off_are_errors(self):
        with self.assertRaises(SourceError):
            await self.recorder.stop()
        await self.recorder.start()
        with self.assertRaises(SourceError):
            await self.recorder.start()

    async def test_cancelled_device_open_closes_late_handle_without_second_open(self):
        entered, release = threading.Event(), threading.Event()
        original = self.owner.audio_factory

        def factory(now_us):
            audio = original(now_us)
            open = audio.open

            def blocked(selector):
                entered.set()
                release.wait(3)
                open(selector)

            audio.open = blocked
            return audio

        self.owner.audio_factory = factory
        starting = asyncio.create_task(self.recorder.start())
        try:
            await eventually(entered.is_set)
            starting.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await starting
            self.assertTrue(self.inputs[0].muted)
            with self.assertRaises(SourceError):
                await self.recorder.start()
        finally:
            release.set()
        await eventually(lambda: self.recorder.monitor.done())
        self.assertTrue(self.inputs[0].closed)
        self.assertEqual(len(self.inputs), 1)
        self.assertEqual(self.recorder.status()["state"], "failed")

    async def test_shutdown_finalizes_manual_recording_and_does_not_resume(self):
        await self.recorder.start("wav")
        await self.feed(count=3)
        await self.recorder.close()
        self.assertEqual(self.recorder.status()["state"], "completed")
        self.assertEqual(self.recorder.status()["reason"], "service-stop")
        with sf.SoundFile(self.recorder.writer.path) as handle:
            self.assertEqual(handle.frames, FRAMES * 3)
        fresh = Recorder(self.owner, self.path)
        self.assertEqual(fresh.status()["state"], "off")

    async def test_cancelled_stop_still_finalizes_and_releases_capture(self):
        await self.recorder.start("wav")
        await self.feed()
        operation = asyncio.create_task(self.recorder.stop())
        await eventually(lambda: self.recorder.writer.stopping.is_set())
        operation.cancel()
        try:
            await operation
        except asyncio.CancelledError:
            pass
        await eventually(lambda: self.recorder.monitor.done())
        self.assertEqual(self.recorder.status()["state"], "completed")
        self.assertTrue(self.inputs[0].closed)

    async def test_client_uses_exact_shared_raw_clock(self):
        identity = load_identity(self.path)
        store = await open_store(self.path)
        config = Config("run", "ws://ma:8927/sendspin", self.owner.device, "test", self.path)
        client = make_client(config, identity, store, clock=self.owner.clock)
        self.assertIs(client.clock, self.owner.clock)
        self.assertIsInstance(client.clock, RawMonotonicClock)
        before = self.owner.clock.now_us()
        self.assertGreaterEqual(client.now_us(), before)


@unittest.skipUnless(os.name == "posix", "asyncio Unix socket control is Linux-only")
class ControlTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # AF_UNIX paths are limited to ~108 bytes, including the CI checkout path.
        self.path = SOURCE.parent / (".control-" + uuid.uuid4().hex[:8])
        self.path.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree, self.path)
        self.recorder = SimpleNamespace(
            start=AsyncMock(return_value={"state": "recording"}),
            stop=AsyncMock(return_value={"state": "completed"}),
            status=Mock(return_value={"state": "off"}),
        )
        self.server = ControlServer(self.path, self.recorder)
        self.addAsyncCleanup(self.server.close)
        await self.server.start()
        self.config = Config("record-status", "", "", "", self.path)

    async def test_private_socket_and_commands_without_pairing_lock(self):
        path = self.path / SOCKET_NAME
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        with locked_state(self.path):
            result = await request(self.config)
        self.assertEqual(result["state"], "off")
        await request(dataclasses.replace(self.config, command="record-start", format="wav", silence_dbfs=-50))
        self.recorder.start.assert_awaited_once_with("wav", -50)
        await request(dataclasses.replace(self.config, command="record-stop"))
        self.recorder.stop.assert_awaited_once()

    async def test_errors_are_explicit_and_socket_is_removed(self):
        self.recorder.start.side_effect = SourceError("busy")
        with self.assertRaisesRegex(SourceError, "busy"):
            await request(dataclasses.replace(self.config, command="record-start"))
        await self.server.close()
        self.assertFalse((self.path / SOCKET_NAME).exists())
        with self.assertRaisesRegex(SourceError, "unavailable"):
            await request(self.config)

    async def test_oversized_bad_schema_and_missing_newline_are_rejected(self):
        for data in (
            b"x" * (MAX_MESSAGE + 2),
            b'{"command":"record-start","filename":"../../bad"}\n',
            b"[]\n",
        ):
            reader, writer = await asyncio.open_unix_connection(self.path / SOCKET_NAME)
            writer.write(data)
            await writer.drain()
            async with asyncio.timeout(3):
                result = json.loads(await reader.readline())
            self.assertFalse(result["ok"])
            writer.close()
            await writer.wait_closed()
        self.recorder.start.assert_not_awaited()

    async def test_socket_permissions_and_symlinks_are_rejected(self):
        await self.server.close()
        path = self.path / SOCKET_NAME
        target = self.path / "target"
        target.write_text("untouched")
        path.symlink_to(target)
        with self.assertRaises(SourceError):
            await self.server.start()
        with self.assertRaises(SourceError):
            await request(self.config)
        self.assertEqual(target.read_text(), "untouched")
        path.unlink()
        await self.server.start()
        path.chmod(0o666)
        with self.assertRaises(SourceError):
            await request(self.config)

    async def test_stale_private_socket_is_replaced_under_state_lock(self):
        await self.server.close()
        import socket
        with socket.socket(socket.AF_UNIX) as stale:
            stale.bind(str(self.path / SOCKET_NAME))
        (self.path / SOCKET_NAME).chmod(0o600)
        with locked_state(self.path):
            await self.server.start()
        self.assertEqual((await request(self.config))["state"], "off")


class ServiceTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.create_workspace()

    async def test_control_remains_available_during_unreachable_ma_and_shutdown_finalizes(self):
        inputs = []
        controls = []
        clients = []

        def audio_factory(now_us):
            audio = FakeAudio(now_us)
            inputs.append(audio)
            return audio

        owner = SharedCapture("hw:CARD=CODEC,DEV=0", audio_factory)
        config = Config("run", "ws://unreachable:8927/sendspin", owner.device, "test", self.path)
        store = SimpleNamespace(list_records=AsyncMock(return_value=[SimpleNamespace(server_id="ma")]))

        def control_factory(path, recorder):
            control = SimpleNamespace(
                start=AsyncMock(), close=AsyncMock(), recorder=recorder,
                failed=asyncio.Event(), failure=None,
            )
            controls.append(control)
            return control

        def client_factory(*args, **kwargs):
            client = FakeClient()
            client.connected = False
            client.connect = AsyncMock(side_effect=OSError("unreachable"))
            client.disconnect = AsyncMock()
            self.assertIs(kwargs["clock"], owner.clock)
            clients.append(client)
            return client

        with patch("sendspin_karaoke_source.cli.pairing_policy", AsyncMock()), \
             patch("sendspin_karaoke_source.cli.make_client", client_factory):
            task = asyncio.create_task(service(
                config, load_identity(self.path), store, owner=owner, control_factory=control_factory,
            ))
            try:
                await eventually(lambda: clients and clients[0].disconnect.await_count)
                self.assertEqual(inputs, [])
                recorder = controls[0].recorder
                await recorder.start("wav")
                self.assertEqual(len(inputs), 1)
                inputs[0].queue.put_nowait((pcm(1000), owner.clock.now_us()))
                await eventually(lambda: recorder.writer.frames == FRAMES)
                self.assertFalse(task.done())
                self.assertTrue(recorder.status()["active"])
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertEqual(recorder.status()["state"], "completed")
            self.assertEqual(recorder.status()["reason"], "service-stop")
            self.assertTrue(inputs[0].closed)
            controls[0].close.assert_awaited_once()

    async def test_no_pairing_is_still_fatal_without_opening_input(self):
        config = Config("run", "ws://ma:8927/sendspin", "hw:CARD=CODEC,DEV=0", "test", self.path)
        factory = Mock()
        owner = SharedCapture(config.device, factory)
        store = SimpleNamespace(list_records=AsyncMock(return_value=[]))
        control = SimpleNamespace(
            start=AsyncMock(), close=AsyncMock(), failed=asyncio.Event(), failure=None,
        )
        with patch("sendspin_karaoke_source.cli.pairing_policy", AsyncMock()):
            with self.assertRaises(PairingRequired):
                await service(config, load_identity(self.path), store, owner=owner, control_factory=lambda *args: control)
        factory.assert_not_called()
        control.close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
