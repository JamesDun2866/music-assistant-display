import asyncio
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from aiohttp import ClientConnectionError
from aiosendspin.noise.driver import HandshakeAbortedError

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

from aiosendspin.models.core import ServerCommandPayload
from aiosendspin.models.source import SourceCommandServerPayload
from aiosendspin.noise.trust_store import ClientPairingRecord, PskCategory

from sendspin_karaoke_source.audio import AudioInput, FRAMES, MAX_AGE_US, MAX_BLOCKS, check_device, discover
from sendspin_karaoke_source.bridge import SourceBridge
from sendspin_karaoke_source.cli import dispatch, main, make_client, pair, pairing_policy, run
from sendspin_karaoke_source.config import (
    CaptureError, Config, InputDevice, PairingRequired, SourceError, input_devices, parse_args, select_device,
)
from sendspin_karaoke_source.lifecycle import cleanup_async, error_classes, sdk_call
from sendspin_karaoke_source.state import load_identity, locked_state, open_store


def command(value):
    return ServerCommandPayload(source=SourceCommandServerPayload(command=value))


async def eventually(predicate, timeout=3):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.005)


class PrivateWorkspace:
    def create_workspace(self):
        self.path = SOURCE / "tests" / (".state-" + uuid.uuid4().hex)
        self.path.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree, self.path)
        return self.path


class ConfigurationTests(unittest.TestCase):
    def test_explicit_run_config(self):
        config = parse_args([
            "run", "--server-url", "ws://ma.lan:8927/sendspin",
            "--device", "hw:CARD=CODEC,DEV=0", "--state-dir", str(SOURCE),
        ])
        self.assertEqual(config.name, "UCA222 Line In")
        self.assertEqual(config.device, "hw:CARD=CODEC,DEV=0")

    def test_reject_credentials_query_invalid_url_and_implicit_devices(self):
        with patch.dict(os.environ, {}, clear=True), contextlib.redirect_stderr(io.StringIO()):
            for url in (
                "", "http://ma:8095", "ws://user:secret@ma/sendspin",
                "ws://ma/sendspin?token=secret", "ws://ma:0/sendspin",
                "ws://ma:bad/sendspin", "ws://ma/other", "ws://ma/sendspin#secret",
            ):
                with self.subTest(url=url), self.assertRaises(SystemExit):
                    parse_args(["pair", "--server-url", url])
            for device in ("", "0", "default", "USB", "hw:1,0", "hw:CARD=1,DEV=0"):
                with self.subTest(device=device), self.assertRaises(SystemExit):
                    parse_args(["run", "--server-url", "ws://ma/sendspin", "--device", device])

    def test_environment_and_explicit_override(self):
        with patch.dict(os.environ, {
            "SOURCE_SERVER_URL": "ws://ma/sendspin", "SOURCE_DEVICE": "hw:CARD=CODEC,DEV=0",
            "SOURCE_NAME": "Record player",
        }):
            self.assertEqual(parse_args(["run", "--name", "Line In", "--state-dir", str(SOURCE)]).name, "Line In")

    def test_devices_needs_no_server_device_or_state(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(parse_args(["devices"]).command, "devices")

    def test_check_device_requires_exact_input_but_no_server_or_pairing(self):
        with patch.dict(os.environ, {}, clear=True):
            config = parse_args(["check-device", "--device", "hw:CARD=CODEC,DEV=0"])
            self.assertEqual(config.command, "check-device")
            self.assertEqual(config.server_url, "")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                parse_args(["check-device", "--device", "default"])

    def test_only_stereo_alsa_hardware_inputs_are_listed(self):
        devices = [
            {"name": "USB Audio (hw:3,0)", "max_input_channels": 2, "hostapi": 0},
            {"name": "HDMI (hw:0,0)", "max_input_channels": 0, "hostapi": 0},
            {"name": "Microphone (hw:1,0)", "max_input_channels": 1, "hostapi": 0},
            {"name": "default", "max_input_channels": 32, "hostapi": 0},
            {"name": "USB Audio (hw:3,0)", "max_input_channels": 2, "hostapi": 1},
        ]
        found = input_devices(devices, [{"name": "ALSA"}, {"name": "JACK"}], {3: "CODEC"})
        self.assertEqual(found, [InputDevice("hw:CARD=CODEC,DEV=0", 0, "USB Audio (hw:3,0)")])
        self.assertEqual(select_device("hw:CARD=CODEC,DEV=0", found).index, 0)
        with self.assertRaisesRegex(SourceError, "ambiguous"):
            select_device(found[0].selector, found + found)
        with self.assertRaisesRegex(SourceError, "not present"):
            select_device("USB", found)

    def test_card_id_survives_kernel_card_number_change(self):
        def find(number):
            return input_devices(
                [{"name": f"USB (hw:{number},0)", "max_input_channels": 2, "hostapi": 0}],
                [{"name": "ALSA"}], {number: "CODEC"},
            )[0].selector
        self.assertEqual(find(1), find(4))


class StateTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.create_workspace()

    async def test_identity_and_pairing_survive_reopen(self):
        with locked_state(self.path):
            identity = load_identity(self.path)
            store = await open_store(self.path)
            await store.store_record(ClientPairingRecord(
                psk_id="test-record", psk=b"x" * 32, server_id="test-server",
            ))
        with locked_state(self.path):
            self.assertEqual(load_identity(self.path).peer_id, identity.peer_id)
            reopened = await open_store(self.path)
            self.assertEqual((await reopened.record_by_server_id("test-server")).psk, b"x" * 32)
        if os.name == "posix":
            for name in ("identity.json", "pairing.json", "lock"):
                self.assertEqual((self.path / name).stat().st_mode & 0o777, 0o600)

    async def test_lock_prevents_pair_and_service_identity_races(self):
        with locked_state(self.path):
            with self.assertRaisesRegex(SourceError, "in use"):
                with locked_state(self.path):
                    pass

    async def test_corrupt_identity_is_never_silently_replaced(self):
        with locked_state(self.path):
            load_identity(self.path)
            original = b'{"private_key_b64u":"not-a-key"}'
            (self.path / "identity.json").write_bytes(original)
            with self.assertRaises(SourceError):
                load_identity(self.path)
            self.assertEqual((self.path / "identity.json").read_bytes(), original)

    async def test_missing_identity_with_pairing_is_not_regenerated(self):
        with locked_state(self.path):
            await open_store(self.path)
            with self.assertRaisesRegex(SourceError, "Identity is missing"):
                load_identity(self.path)

    @unittest.skipUnless(os.name == "posix", "POSIX permissions/symlinks")
    async def test_insecure_state_and_symlink_refused(self):
        self.path.chmod(0o755)
        with self.assertRaises(SourceError):
            with locked_state(self.path):
                pass
        self.path.chmod(0o700)
        (self.path / "pairing.json").symlink_to(self.path / "target")
        with self.assertRaises(SourceError):
            with locked_state(self.path):
                pass

    async def test_runtime_policy_disables_all_unpaired_and_pairing_paths(self):
        with locked_state(self.path):
            store = await open_store(self.path)
            await pairing_policy(store, True)
            await store.set_static_pin("12345678")
            await pairing_policy(store)
            policy = await store.get_pairing_config()
            self.assertFalse(policy.unpaired_access_enabled)
            self.assertFalse(policy.static_pin_enabled)
            self.assertFalse(policy.dynamic_pin_enabled)
            self.assertFalse(policy.pairing_psk_enabled)
            self.assertIsNone(await store.static_pin())

    async def test_pair_refuses_nonterminal_before_exposing_pin(self):
        with locked_state(self.path):
            identity = load_identity(self.path)
            store = await open_store(self.path)
            with patch("sys.stdout", new=io.StringIO()) as output:
                with self.assertRaisesRegex(SourceError, "terminal"):
                    await pair(None, identity, store)
                self.assertEqual(output.getvalue(), "")

    async def test_pair_failure_clears_pin_and_disables_pairing(self):
        with locked_state(self.path):
            identity = load_identity(self.path)
            store = await open_store(self.path)
            client = Mock(connect=AsyncMock(side_effect=TimeoutError), disconnect=AsyncMock())
            config = SimpleNamespace(server_url="ws://ma/sendspin")
            with patch("sys.stdout", new=Mock()), patch(
                "sendspin_karaoke_source.cli.make_client", return_value=client,
            ):
                with self.assertRaises(PairingRequired):
                    await pair(config, identity, store)
            self.assertIsNone(await store.static_pin())
            self.assertFalse((await store.get_pairing_config()).static_pin_enabled)
            client.disconnect.assert_awaited_once()


class AudioTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = 5_000_000
        self.audio = AudioInput(lambda: self.now)
        self.audio.clock_anchor = (100.0, self.now)
        self.data = b"\x01\x00\x02\x00" * FRAMES

    def produce(self, offset=-0.02, status=False):
        current = 95 + self.now / 1_000_000
        self.audio.callback(self.data, FRAMES, SimpleNamespace(
            inputBufferAdcTime=current + offset, currentTime=current,
        ), status)
        self.now += 25_000

    async def test_adc_timestamp_is_first_sample_not_send_time(self):
        self.produce()
        pcm, timestamp = await self.audio.read()
        self.assertEqual(pcm, self.data)
        self.assertEqual(timestamp, 4_980_000)

    async def test_callback_scheduling_jitter_does_not_insert_silence(self):
        from aiosendspin.audio.format import AudioFormat
        from aiosendspin.audio.source_bridge import SourceBridge as ReceiverBridge

        for block, scheduling_delay in enumerate((20_000, 20_000, 0)):
            self.now = 5_000_000 + block * 25_000 + scheduling_delay
            current = 100 + block * 0.025
            self.audio.callback(self.data, FRAMES, SimpleNamespace(
                inputBufferAdcTime=current - 0.02, currentTime=current,
            ), False)
        chunks = [await self.audio.read() for _ in range(3)]
        self.assertEqual([timestamp for _, timestamp in chunks], [
            4_980_000, 5_005_000, 5_030_000,
        ])

        audio_format = AudioFormat(sample_rate=48000, bit_depth=16, channels=2)
        receiver = ReceiverBridge(
            input_format=audio_format, output_format=audio_format, target_latency_ms=75,
        )
        for pcm, timestamp in chunks:
            receiver.feed(pcm, timestamp)
        self.assertEqual(receiver.read(FRAMES * 3), self.data * 3)

    async def test_clock_calibration_uses_shortest_bracket_not_first_callback_arrival(self):
        self.audio.stream = SimpleNamespace(time=100.0)
        self.audio.now_us = Mock(side_effect=[
            4_950_000, 5_000_000, 4_999_900, 5_000_100, 4_990_000, 5_010_000,
        ])
        self.audio._calibrate_clock()
        self.assertEqual(self.audio.clock_anchor, (100.0, 5_000_000))

    async def test_missing_or_delayed_clock_calibration_fails_explicitly(self):
        self.audio.clock_anchor = None
        self.produce()
        with self.assertRaisesRegex(CaptureError, "not calibrated"):
            await self.audio.read()
        self.audio.stream = SimpleNamespace(time=100.0)
        self.audio.now_us = Mock(side_effect=[0, 20_000, 30_000, 50_000, 60_000, 80_000])
        with self.assertRaisesRegex(CaptureError, "calibration delayed"):
            self.audio._calibrate_clock()

    async def test_bounded_queue_never_schedules_unbounded_callbacks(self):
        for _ in range(MAX_BLOCKS + 20):
            self.produce()
        self.assertEqual(self.audio.blocks.qsize(), MAX_BLOCKS)
        with self.assertRaisesRegex(SourceError, "queue overflow"):
            await self.audio.read()

    async def test_brief_consumer_stall_retains_current_audio(self):
        for _ in range(16):
            self.produce()
        chunks = [await self.audio.read() for _ in range(16)]
        self.assertEqual([timestamp for _, timestamp in chunks], [
            4_980_000 + block * 25_000 for block in range(16)
        ])
        self.assertTrue(self.audio.blocks.empty())

    async def test_real_adc_clock_reversal_is_not_hidden(self):
        self.produce()
        self.produce(offset=-0.1)
        with self.assertRaisesRegex(CaptureError, "clock moved backwards"):
            await self.audio.read()

    async def test_overflow_clock_and_block_shape_errors_surface(self):
        for offset, status in ((-2, False), (float("nan"), False), (0.5, False), (-0.02, True)):
            self.audio = AudioInput(lambda: self.now)
            self.produce(offset, status)
            with self.assertRaises(SourceError):
                await self.audio.read()
        self.audio = AudioInput(lambda: self.now)
        self.audio.callback(b"x", 1, SimpleNamespace(inputBufferAdcTime=1, currentTime=1), False)
        with self.assertRaises(SourceError):
            await self.audio.read()

    async def test_stop_and_disconnection_discard_buffers(self):
        self.produce()
        self.audio.mute()
        self.produce()
        self.assertEqual(self.audio.blocks.qsize(), 1)
        self.audio.close()
        self.assertTrue(self.audio.blocks.empty())
        self.audio.stream = SimpleNamespace(active=False)
        with self.assertRaisesRegex(SourceError, "disconnected"):
            await self.audio.read()

    async def test_stale_audio_is_not_sent(self):
        self.produce()
        self.now += MAX_AGE_US + 1
        with self.assertRaisesRegex(SourceError, "stale"):
            await self.audio.read()

    async def test_hardware_opens_input_only_with_fixed_pcm_shape(self):
        sd = Mock()
        sd.PortAudioError = OSError
        sd.RawInputStream.return_value.time = 100.0
        selected = InputDevice("hw:CARD=CODEC,DEV=0", 7, "USB")
        with patch.dict(sys.modules, {"sounddevice": sd}), patch(
            "sendspin_karaoke_source.audio.discover", return_value=[selected],
        ):
            self.audio.open(selected.selector)
        sd.check_input_settings.assert_called_once_with(
            device=7, channels=2, dtype="int16", samplerate=48000,
        )
        sd.RawInputStream.assert_called_once_with(
            device=7, channels=2, dtype="int16", samplerate=48000,
            blocksize=1200, latency="high", callback=self.audio.callback,
        )
        sd.RawOutputStream.assert_not_called()
        self.audio.close()
        sd.RawInputStream.return_value.abort.assert_called_once()

    async def test_device_busy_failure_is_actionable_and_closes_handle(self):
        sd = Mock()
        sd.PortAudioError = OSError
        sd.RawInputStream.return_value.time = 100.0
        sd.RawInputStream.return_value.start.side_effect = OSError("device busy")
        selected = InputDevice("hw:CARD=CODEC,DEV=0", 7, "USB")
        with patch.dict(sys.modules, {"sounddevice": sd}), patch(
            "sendspin_karaoke_source.audio.discover", return_value=[selected],
        ), self.assertRaisesRegex(SourceError, "PipeWire"):
            self.audio.open(selected.selector)
        sd.RawInputStream.return_value.close.assert_called_once()

    async def test_calibration_failure_closes_device_without_starting_capture(self):
        sd = Mock()
        sd.PortAudioError = OSError
        sd.RawInputStream.return_value.time = float("nan")
        with patch.dict(sys.modules, {"sounddevice": sd}), patch(
            "sendspin_karaoke_source.audio.discover",
            return_value=[InputDevice("hw:CARD=CODEC,DEV=0", 7, "USB")],
        ), self.assertRaisesRegex(CaptureError, "Invalid capture clock calibration"):
            self.audio.open("hw:CARD=CODEC,DEV=0")
        sd.RawInputStream.return_value.start.assert_not_called()
        sd.RawInputStream.return_value.close.assert_called_once()

    async def test_programming_error_in_device_open_is_not_relabelled(self):
        sd = Mock()
        sd.PortAudioError = OSError
        failure = TypeError("secret-device-internals")
        sd.check_input_settings.side_effect = failure
        with patch.dict(sys.modules, {"sounddevice": sd}), patch(
            "sendspin_karaoke_source.audio.discover",
            return_value=[InputDevice("hw:CARD=CODEC,DEV=0", 7, "USB")],
        ), self.assertRaises(TypeError) as raised:
            self.audio.open("hw:CARD=CODEC,DEV=0")
        self.assertIs(raised.exception, failure)

    async def test_discovery_refreshes_portaudio_after_usb_replug(self):
        sd = Mock()
        sd.PortAudioError = OSError
        sd.query_devices.return_value = [
            {"name": "USB (hw:4,0)", "max_input_channels": 2, "hostapi": 0},
        ]
        sd.query_hostapis.return_value = [{"name": "ALSA"}]
        with patch.dict(sys.modules, {"sounddevice": sd}), patch(
            "sendspin_karaoke_source.audio.alsa_cards", return_value={4: "CODEC"},
        ):
            self.assertEqual(discover()[0].selector, "hw:CARD=CODEC,DEV=0")
        sd._terminate.assert_called_once()
        sd._initialize.assert_called_once()


class FakeClient:
    def __init__(self, paired=True):
        self.connected = True
        self.noise_psk = SimpleNamespace(category=PskCategory.LONG_TERM if paired else PskCategory.SENTINEL)
        self.synchronized = True
        self.commands = []
        self.disconnects = []
        self.captures = []
        self.start_gate = None
        self.feed_gate = None

    def add_server_command_listener(self, callback):
        self.commands.append(callback)
        return lambda: self.commands.remove(callback)

    def add_disconnect_listener(self, callback):
        self.disconnects.append(callback)
        return lambda: self.disconnects.remove(callback)

    def is_time_synchronized(self):
        return self.synchronized

    def now_us(self):
        return 5_000_000

    def create_source_capture(self, fmt):
        async def start():
            if self.start_gate:
                await self.start_gate.wait()

        async def feed(*args, **kwargs):
            if self.feed_gate:
                await self.feed_gate.wait()

        capture = SimpleNamespace(
            start=AsyncMock(side_effect=start), feed=AsyncMock(side_effect=feed), stop=AsyncMock(),
        )
        self.captures.append(capture)
        return capture


class FakeAudio:
    def __init__(self, now_us):
        self.opened = False
        self.closed = False
        self.muted = False
        self.queue = asyncio.Queue()

    def open(self, selector):
        self.opened = True

    def mute(self):
        self.muted = True

    def close(self):
        self.closed = True

    async def read(self):
        return await self.queue.get()


class ProbeTests(unittest.IsolatedAsyncioTestCase):
    async def test_probe_reports_stereo_levels_and_closes_without_network_or_state(self):
        audio = FakeAudio(None)
        audio.read = AsyncMock(return_value=(b"\x00\x40\x00\x00" * FRAMES, 0))
        with contextlib.redirect_stdout(io.StringIO()) as output:
            await check_device("hw:CARD=CODEC,DEV=0", lambda now: audio)
        self.assertTrue(audio.closed)
        self.assertTrue(audio.muted)
        self.assertEqual(audio.read.await_count, 120)
        self.assertIn("Left: RMS -6.0 dBFS", output.getvalue())
        self.assertIn("Right: RMS -inf dBFS", output.getvalue())
        self.assertIn("no audio saved or transmitted", output.getvalue())

    async def test_probe_surfaces_overflow_and_closes_device(self):
        audio = FakeAudio(None)
        audio.read = AsyncMock(side_effect=SourceError("Capture overflow"))
        with contextlib.redirect_stdout(io.StringIO()) as output:
            with self.assertRaisesRegex(SourceError, "overflow"):
                await check_device("hw:CARD=CODEC,DEV=0", lambda now: audio)
        self.assertTrue(audio.closed)
        self.assertNotIn("no capture overflows", output.getvalue())

    async def test_probe_warns_for_silence_and_clipping(self):
        for pcm, expected in (
            (b"\x00\x00\x00\x00" * FRAMES, "Very low level/silence"),
            (b"\xff\x7f\x00\x80" * FRAMES, "Clipping detected"),
        ):
            audio = FakeAudio(None)
            audio.read = AsyncMock(return_value=(pcm, 0))
            with contextlib.redirect_stdout(io.StringIO()) as output:
                await check_device("hw:CARD=CODEC,DEV=0", lambda now: audio)
            self.assertIn(expected, output.getvalue())

    async def test_probe_dispatch_never_opens_identity_or_sendspin_client(self):
        config = SimpleNamespace(command="check-device", device="hw:CARD=CODEC,DEV=0")
        with patch("sendspin_karaoke_source.cli.check_device", new=AsyncMock()) as probe, patch(
            "sendspin_karaoke_source.cli.locked_state",
        ) as state, patch("sendspin_karaoke_source.cli.make_client") as client:
            await dispatch(config)
        probe.assert_awaited_once_with(config.device)
        state.assert_not_called()
        client.assert_not_called()


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = FakeClient()
        self.inputs = []

        def factory(now_us):
            audio = FakeAudio(now_us)
            self.inputs.append(audio)
            return audio

        self.bridge = SourceBridge(self.client, "hw:CARD=CODEC,DEV=0", factory)
        self.addAsyncCleanup(self.bridge.close)

    async def start(self):
        self.bridge.command(command("start"))
        await eventually(lambda: self.inputs and self.inputs[-1].opened and not self.inputs[-1].closed)

    async def test_idle_until_start_then_stop_and_fresh_restart(self):
        await asyncio.sleep(0.02)
        self.assertEqual(self.inputs, [])
        await self.start()
        first = self.inputs[-1]
        first.queue.put_nowait((b"pcm", 12345))
        await eventually(lambda: self.client.captures[0].feed.await_count == 1)
        self.client.captures[0].feed.assert_awaited_with(b"pcm", capture_timestamp_us=12345)
        self.bridge.command(command("stop"))
        self.assertTrue(first.muted)
        await eventually(lambda: first.closed)
        await self.start()
        self.assertEqual(len(self.inputs), 2)
        self.assertEqual(self.client.captures[1].feed.await_count, 0)

    async def test_unpaired_start_never_opens_hardware(self):
        self.client.noise_psk = SimpleNamespace(category=PskCategory.SENTINEL)
        self.bridge.command(command("start"))
        await self.bridge.failed.wait()
        self.assertIsInstance(self.bridge.failure, PairingRequired)
        self.assertFalse(self.inputs)

    async def test_start_stop_before_worker_runs_and_duplicate_start_are_safe(self):
        self.bridge.command(command("start"))
        self.bridge.command(command("stop"))
        await asyncio.sleep(0.02)
        self.assertFalse(self.inputs)
        await self.start()
        self.bridge.command(command("start"))
        await asyncio.sleep(0.02)
        self.assertEqual(len(self.inputs), 1)

    async def test_stop_while_waiting_for_sync_opens_nothing(self):
        self.client.synchronized = False
        self.bridge.command(command("start"))
        await asyncio.sleep(0.02)
        self.bridge.command(command("stop"))
        self.client.synchronized = True
        await eventually(lambda: self.bridge.active is None)
        self.assertFalse(self.inputs)

    async def test_stop_during_start_authorization_opens_nothing(self):
        self.client.start_gate = asyncio.Event()
        self.bridge.command(command("start"))
        await eventually(lambda: self.client.captures)
        self.bridge.command(command("stop"))
        self.client.start_gate.set()
        await eventually(lambda: self.bridge.active is None)
        self.assertFalse(self.inputs[0].opened)

    async def test_stop_start_race_serializes_cleanup_and_new_stream(self):
        await self.start()
        previous = self.inputs[-1]
        self.bridge.command(command("stop"))
        self.bridge.command(command("start"))
        await eventually(lambda: len(self.inputs) == 2 and self.inputs[-1].opened)
        self.assertTrue(previous.closed)

    async def test_disconnect_mutes_and_does_not_resume_without_new_start(self):
        await self.start()
        previous = self.inputs[-1]
        previous.queue.put_nowait((b"stale", 1))
        self.client.connected = False
        self.bridge.disconnected()
        await eventually(lambda: previous.closed)
        self.client.connected = True
        await asyncio.sleep(0.02)
        self.assertEqual(len(self.inputs), 1)
        self.assertFalse(self.bridge.requested)
        self.assertEqual(self.client.captures[0].feed.await_count, 0)

    async def test_stop_interrupts_blocked_network_feed(self):
        self.client.feed_gate = asyncio.Event()
        await self.start()
        self.inputs[-1].queue.put_nowait((b"data", 1))
        await eventually(lambda: self.client.captures[0].feed.await_count)
        self.bridge.command(command("stop"))
        await eventually(lambda: self.inputs[-1].closed)
        self.assertFalse(self.bridge.failed.is_set())

    async def test_brief_network_stall_does_not_reconnect(self):
        self.client.feed_gate = asyncio.Event()
        await self.start()
        self.inputs[-1].queue.put_nowait((b"first", 1))
        await eventually(lambda: self.client.captures[0].feed.await_count)
        try:
            await asyncio.sleep(0.35)
            self.assertFalse(self.bridge.failed.is_set(), self.bridge.failure)
            self.assertFalse(self.inputs[-1].closed)
        finally:
            self.client.feed_gate.set()
        self.inputs[-1].queue.put_nowait((b"second", 2))
        await eventually(lambda: self.client.captures[0].feed.await_count == 2)

    async def test_persistent_send_stall_has_actionable_error_and_closes_capture(self):
        self.client.feed_gate = asyncio.Event()
        with patch("sendspin_karaoke_source.bridge.SEND_TIMEOUT_SECONDS", 0.02):
            await self.start()
            self.inputs[-1].queue.put_nowait((b"data", 1))
            await eventually(self.bridge.failed.is_set)
        self.assertIsInstance(self.bridge.failure, CaptureError)
        self.assertIn("Audio send stalled", str(self.bridge.failure))
        self.assertTrue(self.inputs[-1].closed)

    async def test_stop_during_threaded_device_open_cleans_late_handle(self):
        opened = threading.Event()
        release = threading.Event()

        def factory(now_us):
            audio = FakeAudio(now_us)

            def delayed_open(selector):
                opened.set()
                release.wait(2)
                audio.opened = True

            audio.open = delayed_open
            self.inputs.append(audio)
            return audio

        self.bridge.audio_factory = factory
        self.bridge.command(command("start"))
        await eventually(opened.is_set)
        self.bridge.command(command("stop"))
        release.set()
        await eventually(lambda: self.inputs[0].closed)
        self.assertEqual(self.client.captures[0].feed.await_count, 0)

    async def test_capture_failure_is_exposed_to_reconnect_supervisor(self):
        await self.start()
        self.inputs[-1].read = AsyncMock(side_effect=SourceError("device disconnected"))
        self.inputs[-1].queue.put_nowait((b"last", 1))
        await self.bridge.failed.wait()
        self.assertIsInstance(self.bridge.failure, SourceError)
        self.assertTrue(self.inputs[-1].closed)


class PackagingTests(unittest.TestCase):
    def test_installer_is_opt_in_and_does_not_control_display_or_pair(self):
        installer = (SOURCE.parent / "scripts" / "install-source.sh").read_text()
        self.assertNotRegex(installer, r"systemctl (enable|start|restart|stop|disable)")
        self.assertNotIn("sendspin-karaoke.service", installer)
        self.assertNotIn("pip install --break-system-packages", installer)
        self.assertIn('"$release/venv/bin/python" -I -m pip install', installer)
        self.assertIn('[[ ! -e "$config/environment" ]]', installer)
        self.assertLess(installer.index('import sendspin_karaoke_source.cli'), installer.index('mv -Tf'))
        self.assertIn("trap rollback ERR", installer)
        self.assertIn("mv -Tf", installer)

    def test_private_service_identity_and_source_only_paths(self):
        unit = (SOURCE.parent / "deploy" / "sendspin-karaoke-source.service").read_text()
        for text in (
            "User=sendspin-karaoke-source", "SupplementaryGroups=audio", "StateDirectoryMode=0700",
            "UMask=0077", "RestartPreventExitStatus=2", "DeviceAllow=char-alsa rw",
            "EnvironmentFile=/etc/sendspin-karaoke-source/environment",
        ):
            self.assertIn(text, unit)
        self.assertNotIn("PrivateDevices=true", unit)

    def test_installer_uses_explicit_runtime_before_mutation_and_after_apt(self):
        installer = (SOURCE.parent / "scripts" / "install-source.sh").read_text()
        check = installer.index("check_source_runtime /usr/bin/python3")
        for mutation in ("exec 9>", "apt-get update", "groupadd ", "install -d "):
            self.assertLess(check, installer.index(mutation))
        self.assertEqual(installer.count("check_source_runtime /usr/bin/python3"), 2)
        self.assertIn("export PATH=/usr/sbin:/usr/bin:/sbin:/bin", installer)
        self.assertIn("/usr/bin/python3 -I -m venv", installer)
        unit = (SOURCE.parent / "deploy" / "sendspin-karaoke-source.service").read_text()
        self.assertIn("RestartPreventExitStatus=2 3", unit)
        self.assertIn("Environment=PATH=/usr/sbin:/usr/bin:/sbin:/bin", unit)

    def test_ci_covers_supported_python_protocol_and_installed_entrypoint(self):
        ci = (SOURCE.parent / ".github" / "workflows" / "ci.yml").read_text()
        self.assertIn("python: ['3.12', '3.13']", ci)
        self.assertIn("source/.venv/bin/python -m pip install './source[test]'", ci)
        self.assertIn("source/.venv/bin/sendspin-karaoke-source check-device --help", ci)
        self.assertIn("-m unittest discover -s source/tests -p 'test_*.py'", ci)
        self.assertIn("bash -n scripts/check-source-runtime.sh", ci)

    def test_new_code_and_deployment_files_are_ascii(self):
        files = [
            *SOURCE.glob("sendspin_karaoke_source/*.py"), *SOURCE.glob("tests/*.py"),
            SOURCE.parent / "scripts" / "install-source.sh",
            SOURCE.parent / "scripts" / "check-source-runtime.sh",
            SOURCE.parent / "scripts" / "source-cli.sh",
            SOURCE.parent / "deploy" / "sendspin-karaoke-source.service",
            SOURCE.parent / "deploy" / "source-environment.example",
        ]
        for path in files:
            with self.subTest(path=path.name):
                path.read_bytes().decode("ascii")


class RuntimePreflightTests(PrivateWorkspace, unittest.TestCase):
    def setUp(self):
        self.create_workspace()
        self.bash = shutil.which("bash")
        if not self.bash:
            self.skipTest("Bash is unavailable")
        self.python = self.path / "system-python"
        self.python.write_text(
            '#!/bin/bash\n'
            '[[ $1 == -I && $2 == -c ]] || exit 99\n'
            'exec "$TEST_REAL_PYTHON" -I -c "import sys; '
            "sys.version_info=tuple(map(int, '$TEST_VERSION'.split('.'))); $3\"\n",
            encoding="ascii", newline="\n",
        )
        self.python.chmod(0o700)

    def check(self, version, executable="./system-python"):
        env = dict(os.environ)
        env.update({
            "TEST_REAL_PYTHON": Path(sys.executable).as_posix(),
            "TEST_VERSION": version,
            "TEST_CHECKER": (SOURCE.parent / "scripts" / "check-source-runtime.sh").as_posix(),
        })
        return subprocess.run(
            [self.bash, "-c", 'source "$TEST_CHECKER"; check_source_runtime "$1"', "test", executable],
            cwd=self.path, env=env, capture_output=True, text=True, timeout=15,
        )

    def test_accepts_only_supported_runtime_range_using_isolated_interpreter(self):
        for version in ("3.12", "3.13", "3.14"):
            with self.subTest(version=version):
                result = self.check(version)
                self.assertEqual(result.returncode, 0, result.stderr)
        for version in ("3.11", "3.15"):
            with self.subTest(version=version):
                result = self.check(version)
                self.assertEqual(result.returncode, 1)
                self.assertIn("Python 3.12-3.14 is required", result.stderr)

    def test_missing_explicit_runtime_does_not_fall_back_to_user_path(self):
        result = self.check("3.13", "./not-a-python")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Missing system Python", result.stderr)


class ReconnectTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.create_workspace()
        self.identity = load_identity(self.path)
        self.store = await open_store(self.path)
        self.config = SimpleNamespace(server_url="ws://ma/sendspin", device="hw:CARD=CODEC,DEV=0")

    async def authorize(self):
        await self.store.store_record(ClientPairingRecord(
            psk_id="record", psk=b"x" * 32, server_id="server",
        ))

    async def test_unpaired_state_does_not_even_connect(self):
        factory = Mock()
        with self.assertRaises(PairingRequired):
            await run(self.config, self.identity, self.store, client_factory=factory)
        factory.assert_not_called()

    async def test_failed_connections_back_off_and_cleanup_without_logging_secrets(self):
        await self.authorize()
        clients = []
        bridges = []
        delays = []

        def client_factory(*args):
            client = FakeClient()
            client.connect = AsyncMock(side_effect=OSError("private-key-do-not-log"))
            client.disconnect = AsyncMock()
            clients.append(client)
            return client

        def bridge_factory(*args):
            bridge = SimpleNamespace(close=AsyncMock())
            bridges.append(bridge)
            return bridge

        async def sleep(delay):
            delays.append(delay)
            if len(delays) == 4:
                raise asyncio.CancelledError

        with self.assertLogs("sendspin_karaoke_source.cli", level="INFO") as logs:
            with self.assertRaises(asyncio.CancelledError):
                await run(
                    self.config, self.identity, self.store,
                    client_factory=client_factory, bridge_factory=bridge_factory, sleep=sleep,
                )
        self.assertEqual(delays, [1, 2, 4, 8])
        self.assertEqual(len(clients), 4)
        self.assertEqual(len({id(client) for client in clients}), 4)
        for client, bridge in zip(clients, bridges):
            client.disconnect.assert_awaited_once()
            bridge.close.assert_awaited_once()
        self.assertNotIn("private-key-do-not-log", "\n".join(logs.output))
        self.assertIn("re-pair", "\n".join(logs.output))

    async def test_expected_transport_classes_reconnect_but_programming_errors_do_not(self):
        await self.authorize()
        for error in (
            ClientConnectionError("secret"), TimeoutError("secret"),
            HandshakeAbortedError("secret"),
        ):
            client = FakeClient()
            client.connect = AsyncMock(side_effect=error)
            client.disconnect = AsyncMock()
            bridge = SimpleNamespace(close=AsyncMock())
            sleep = AsyncMock(side_effect=asyncio.CancelledError)
            with self.subTest(error=type(error).__name__), self.assertLogs(
                "sendspin_karaoke_source.cli", level="WARNING",
            ), self.assertRaises(asyncio.CancelledError):
                await run(
                    self.config, self.identity, self.store,
                    client_factory=lambda *args: client, bridge_factory=lambda *args: bridge,
                    sleep=sleep,
                )
            sleep.assert_awaited_once_with(1)
        for failure in (ValueError("secret"), TypeError("secret"), RuntimeError("unexpected bug")):
            client = FakeClient()
            client.connect = AsyncMock(side_effect=failure)
            client.disconnect = AsyncMock()
            bridge = SimpleNamespace(close=AsyncMock())
            sleep = AsyncMock()
            factory = Mock(return_value=client)
            with self.subTest(error=type(failure).__name__), self.assertRaises(type(failure)) as raised:
                await run(
                    self.config, self.identity, self.store,
                    client_factory=factory, bridge_factory=lambda *args: bridge, sleep=sleep,
                )
            self.assertIs(raised.exception, failure)
            factory.assert_called_once()
            sleep.assert_not_called()
            bridge.close.assert_awaited_once()
            client.disconnect.assert_awaited_once()

    async def test_server_unpaired_admission_is_explicit_fatal_and_never_captures(self):
        await self.authorize()
        client = FakeClient(paired=False)
        client.connect = AsyncMock()
        client.disconnect = AsyncMock()
        bridge = SimpleNamespace(close=AsyncMock())
        with self.assertRaisesRegex(PairingRequired, "did not admit"):
            await run(
                self.config, self.identity, self.store,
                client_factory=lambda *args: client, bridge_factory=lambda *args: bridge,
            )
        bridge.close.assert_awaited_once()
        client.disconnect.assert_awaited_once()

    async def test_programming_failure_survives_expected_disconnect_cleanup_error(self):
        await self.authorize()
        primary = ValueError("primary-secret")
        client = FakeClient()
        client.connect = AsyncMock(side_effect=primary)
        client.disconnect = AsyncMock(side_effect=OSError("disconnect-secret"))
        bridge = SimpleNamespace(close=AsyncMock())
        with self.assertLogs("sendspin_karaoke_source.lifecycle", level="WARNING") as logs, \
                self.assertRaises(ValueError) as raised:
            await run(
                self.config, self.identity, self.store,
                client_factory=lambda *args: client, bridge_factory=lambda *args: bridge,
            )
        self.assertIs(raised.exception, primary)
        self.assertNotIn("secret", "\n".join(logs.output))

    async def test_disconnection_replaces_client_and_bridge_and_cancellation_closes_both(self):
        await self.authorize()
        clients = []
        bridges = []
        delays = []

        def client_factory(*args):
            client = FakeClient()

            async def connect(url):
                if len(clients) == 1:
                    for callback in client.disconnects:
                        callback()

            client.connect = AsyncMock(side_effect=connect)
            client.disconnect = AsyncMock()
            clients.append(client)
            return client

        def bridge_factory(*args):
            bridge = SimpleNamespace(close=AsyncMock(), failed=asyncio.Event(), failure=None)
            bridges.append(bridge)
            return bridge

        async def sleep(delay):
            delays.append(delay)

        task = asyncio.create_task(run(
            self.config, self.identity, self.store,
            client_factory=client_factory, bridge_factory=bridge_factory, sleep=sleep,
        ))
        await eventually(lambda: len(clients) == 2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(delays, [1])
        for client, bridge in zip(clients, bridges):
            client.disconnect.assert_awaited_once()
            bridge.close.assert_awaited_once()


class ErrorBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_known_sdk_runtime_state_is_translated_but_unknown_runtime_error_is_not(self):
        with self.assertRaises(CaptureError):
            await sdk_call(AsyncMock(side_effect=RuntimeError("Source stream is not active")))
        failure = RuntimeError("programming bug")
        with self.assertRaises(RuntimeError) as raised:
            await sdk_call(AsyncMock(side_effect=failure))
        self.assertIs(raised.exception, failure)

    async def test_cleanup_preserves_original_and_logs_expected_failure_without_payload(self):
        primary = ValueError("primary-secret")
        later = AsyncMock()
        with self.assertLogs("sendspin_karaoke_source.lifecycle", level="WARNING") as logs:
            await cleanup_async([
                ("stream stop", AsyncMock(side_effect=CaptureError("cleanup-secret"))),
                ("client disconnect", later),
            ], primary=primary)
        later.assert_awaited_once()
        self.assertIn("stream stop", "\n".join(logs.output))
        self.assertIn("CaptureError", "\n".join(logs.output))
        self.assertNotIn("secret", "\n".join(logs.output))

    async def test_unexpected_cleanup_preserves_primary_in_group_and_runs_remaining_cleanup(self):
        primary = OSError("primary-secret")
        failure = TypeError("cleanup-secret")
        later = AsyncMock()
        with self.assertLogs("sendspin_karaoke_source.lifecycle", level="ERROR"), self.assertRaises(
            ExceptionGroup,
        ) as raised:
            await cleanup_async([
                ("device close", AsyncMock(side_effect=failure)),
                ("client disconnect", later),
            ], primary=primary)
        self.assertEqual(raised.exception.exceptions, (primary, failure))
        later.assert_awaited_once()
        self.assertEqual(error_classes(raised.exception), "ExceptionGroup[OSError,TypeError]")

    async def test_multiple_expected_cleanup_errors_remain_recoverable(self):
        first = CaptureError("device gone")
        with self.assertLogs("sendspin_karaoke_source.lifecycle", level="WARNING"), \
                self.assertRaises(CaptureError) as raised:
            await cleanup_async([
                ("device close", AsyncMock(side_effect=first)),
                ("client disconnect", AsyncMock(side_effect=OSError("socket gone"))),
            ])
        self.assertIs(raised.exception, first)

    def test_terminal_boundary_reports_context_and_class_without_exception_payload(self):
        with patch("sendspin_karaoke_source.cli.discover", side_effect=ValueError("private-key")), \
                contextlib.redirect_stderr(io.StringIO()) as output:
            result = main(["devices"])
        self.assertEqual(result, 3)
        self.assertIn("devices failure (ValueError), code 3", output.getvalue())
        self.assertNotIn("private-key", output.getvalue())


if __name__ == "__main__":
    unittest.main()
