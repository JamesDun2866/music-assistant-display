import array
import asyncio
import io
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiosendspin.noise.keys import Identity
from sendspin_karaoke_source.album_handoff import write_snapshot
from sendspin_karaoke_source.album_provider import (
    MAX_RESPONSE, SingleRequestClient, album_fields, recognize,
)
from sendspin_karaoke_source.audio import FRAMES, CHANNELS, RATE
from sendspin_karaoke_source.config import SourceError, parse_args
from sendspin_karaoke_source.control import decode
from sendspin_karaoke_source.recognition import Recognition, SAMPLE_BYTES, process_album
from sendspin_karaoke_source.recording import Recorder
from sendspin_karaoke_source.shared import SharedCapture, StreamInput
from test_source import FakeAudio, PrivateWorkspace, eventually

ALBUM = {"title": "An album", "artist": "An artist", "artwork": None, "catalog": None}
RAW = {"track": {
    "title": "Never display this song", "subtitle": "An artist",
    "sections": [
        {"type": "SONG", "metadata": [{"title": "Album", "text": "An album"}]},
        {"type": "LYRICS", "text": ["Never export these lyrics"]},
    ],
}}


def block(left=1000, right=0):
    return array.array("h", [left, right] * FRAMES).tobytes()


class RecognitionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.owner = SimpleNamespace(consumers={}, observers=set())
        self.provider = AsyncMock(return_value=ALBUM)
        self.publish = Mock()
        self.subject = Recognition(self.owner, Identity.generate(), recognize=self.provider, publish=self.publish)
        self.timestamp = 1_000_000

    async def asyncTearDown(self):
        await self.subject.close()

    async def enable(self):
        with patch("importlib.util.find_spec", return_value=object()):
            await self.subject.enable()

    def feed(self, seconds, left=1000, right=0):
        for _ in range(round(seconds * RATE / FRAMES)):
            self.subject.offer(block(left, right), self.timestamp)
            self.timestamp += FRAMES * 1_000_000 // RATE

    async def active(self):
        self.owner.consumers[object()] = 1
        await self.enable()

    async def test_default_off_and_enable_never_acquire_input(self):
        await self.subject.start()
        self.feed(15)
        self.assertEqual(self.subject.state, "disabled")
        await self.enable()
        self.feed(15)
        self.assertEqual(self.subject.state, "idle")
        self.assertEqual(self.subject.buffer, b"")
        self.assertEqual(self.owner.consumers, {})
        self.provider.assert_not_called()

    async def test_initial_silence_then_one_bounded_sample_album_no_retry(self):
        await self.active()
        self.feed(20, 0, 0)
        self.provider.assert_not_called()
        self.feed(11.975, 0, -2000)
        self.provider.assert_not_called()
        self.feed(.025, 0, -2000)
        await eventually(lambda: self.subject.state == "identified")
        self.assertEqual(len(self.provider.call_args.args[0]), SAMPLE_BYTES)
        self.assertEqual(self.subject.album, ALBUM)
        self.assertEqual(self.subject.buffer, b"")
        self.feed(40)
        self.provider.assert_awaited_once()

    async def test_five_continuous_seconds_of_silence_rearm(self):
        await self.active()
        self.feed(12)
        await eventually(lambda: self.subject.state == "identified")
        generation = self.subject.generation
        self.feed(4.975, 0)
        self.assertEqual(self.subject.album, ALBUM)
        self.feed(.025)
        self.feed(4.975, 0)
        self.assertEqual(self.subject.album, ALBUM)
        self.feed(.025, 0)
        self.assertEqual(self.subject.state, "armed")
        self.assertEqual(self.subject.album, ALBUM)
        self.assertGreater(self.subject.generation, generation)
        self.feed(12)
        await eventually(lambda: self.provider.await_count == 2)

    async def test_sampling_silence_discards_partial_sample(self):
        await self.active()
        self.feed(2)
        self.feed(5, 0)
        self.assertEqual(self.subject.state, "armed")
        self.assertEqual(self.subject.buffer, b"")
        self.provider.assert_not_called()

    async def test_late_provider_failure_does_not_restart_silence_timer(self):
        finish = asyncio.Event()
        async def failing(_pcm):
            await finish.wait()
            raise OSError("timeout")
        self.subject.recognize = failing
        await self.active()
        self.feed(12)
        await asyncio.sleep(0)
        self.feed(4.975, 0)
        finish.set()
        await eventually(lambda: self.subject.state == "unavailable")
        self.feed(.025, 0)
        self.assertEqual(self.subject.state, "armed")

    async def test_partial_silence_is_reset_by_either_audible_channel(self):
        await self.active()
        self.feed(12)
        await eventually(lambda: self.subject.state == "identified")
        self.feed(4.975, 0)
        self.feed(.025, 0, 1000)
        self.feed(4.975, 0)
        self.assertIsNotNone(self.subject.album)
        self.feed(.025, 0)
        self.assertEqual(self.subject.album, ALBUM)

    async def test_unmatched_and_failure_do_not_retry_until_silence(self):
        await self.active()
        for result in (None, OSError("network"), RuntimeError("provider bug")):
            self.provider.side_effect = result if isinstance(result, Exception) else None
            self.provider.return_value = None
            before = self.provider.await_count
            self.feed(12)
            await eventually(lambda: self.subject.state == "unavailable")
            self.feed(30)
            self.assertEqual(self.provider.await_count, before + 1)
            self.feed(5, 0)

    async def test_disable_clears_and_discards_late_generation(self):
        started = asyncio.Event()
        finish = asyncio.Event()
        async def late(_pcm):
            started.set()
            try:
                await finish.wait()
            except asyncio.CancelledError:
                return ALBUM
        self.subject.recognize = late
        await self.active()
        self.feed(12)
        await started.wait()
        await self.subject.disable()
        self.assertEqual(self.subject.state, "disabled")
        self.assertIsNone(self.subject.album)
        self.assertIsNone(self.subject.worker)
        self.assertEqual(self.publish.call_args.args[0]["state"], "disabled")

    async def test_context_end_preserves_album_without_starting_recording(self):
        await self.active()
        self.feed(12)
        await eventually(lambda: self.subject.state == "identified")
        self.owner.consumers.clear()
        self.subject.context(False)
        self.assertEqual(self.subject.state, "idle")
        self.assertEqual(self.subject.album, ALBUM)
        self.feed(15)
        self.provider.assert_awaited_once()
        self.subject.context(True)
        self.assertEqual(self.subject.state, "armed")

    async def test_invalid_blocks_and_capture_gaps_fail_closed(self):
        await self.active()
        self.feed(1)
        self.timestamp += 1_000_000
        self.feed(.025)
        self.assertEqual(self.subject.state, "unavailable")
        self.assertEqual(self.subject.buffer, b"")
        self.feed(15)
        self.provider.assert_not_called()
        self.feed(5, 0)
        self.subject.offer(b"x", self.timestamp)
        self.assertEqual(self.subject.state, "unavailable")

    async def test_threshold_and_missing_extra_are_explicit(self):
        for value in (0, True, "x", float("nan"), float("inf"), -(10**500)):
            with self.assertRaises(SourceError):
                await self.subject.enable(value)
        with patch("importlib.util.find_spec", return_value=None):
            with self.assertRaisesRegex(SourceError, "optional recognition"):
                await self.subject.enable()
        self.assertFalse(self.subject.enabled)

    async def test_disk_error_does_not_break_recognition_or_streaming(self):
        self.publish.side_effect = PermissionError("denied")
        await self.active()
        await self.subject.start()
        self.feed(12)
        await eventually(lambda: self.subject.state == "identified")
        await self.subject.disable()
        self.assertEqual(self.subject.state, "disabled")

    async def test_only_small_peak_scan_runs_in_capture_path(self):
        await self.active()
        self.feed(12)
        self.provider.assert_not_called()
        self.assertEqual(self.subject.state, "recognizing")
        await eventually(lambda: self.provider.await_count == 1)


class SharedRecognitionTests(unittest.IsolatedAsyncioTestCase):
    async def test_observer_does_not_own_input_and_last_release_clears(self):
        audio = FakeAudio(lambda: 1)
        owner = SharedCapture("test", lambda _clock: audio)
        observer = Mock()
        owner.observers.add(observer)
        stream = StreamInput(owner)
        await owner.acquire(stream)
        observer.context.assert_called_with(True)
        self.assertEqual(list(owner.consumers), [stream])
        await owner.release(stream)
        observer.context.assert_called_with(False)
        self.assertTrue(audio.closed)


class RecordingCoexistenceTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def test_recording_silence_stop_does_not_remove_stream_recognition_or_restart_recording(self):
        self.create_workspace()
        inputs = []
        def factory(clock):
            audio = FakeAudio(clock)
            inputs.append(audio)
            return audio
        owner = SharedCapture("test", factory)
        stream = Mock()
        recorder = Recorder(owner, self.path)
        recognition = Recognition(owner, Identity.generate(), recognize=AsyncMock(return_value=ALBUM),
                                  publish=Mock())
        await recognition.start()
        try:
            await owner.acquire(stream)
            await recorder.start("wav")
            with patch("importlib.util.find_spec", return_value=object()):
                await recognition.enable()
            # Initial recording silence ends it; the independent streaming owner remains.
            timestamp = owner.clock.now_us()
            for _ in range(5 * RATE // FRAMES):
                inputs[0].queue.put_nowait((block(0), timestamp))
                timestamp += FRAMES * 1_000_000 // RATE
                await asyncio.sleep(.001)
            await eventually(lambda: not recorder.status()["active"])
            await eventually(lambda: len(owner.consumers) == 1)
            self.assertEqual(recorder.status()["reason"], "silence")
            self.assertEqual(recognition.state, "armed")
            self.assertTrue(recognition.active)
            self.assertEqual(len(inputs), 1)
            self.assertFalse(inputs[0].closed)
            self.assertIsNone(recognition.album)
            recognition.offer(block(), timestamp)
            self.assertEqual(recognition.state, "sampling")
            self.assertFalse(recorder.status()["active"])
        finally:
            await recognition.close()
            await recorder.close()
            await owner.release(stream)
            await owner.close()


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(importlib.util.find_spec("shazamio_core"), "Optional native extra not installed")
    async def test_released_shazamio_native_wav_and_single_request_offline(self):
        async def chunks(_size):
            yield json.dumps(RAW).encode()
        context = AsyncMock()
        for status in (200, 500):
            context.__aenter__.return_value = SimpleNamespace(status=status, content=SimpleNamespace(iter_chunked=chunks))
            # This runs the real optional ShazamIO/core code on synthetic PCM only.
            with patch("aiohttp.ClientSession.post", Mock(return_value=context)) as post:
                if status == 200:
                    self.assertEqual(await recognize(block() * (12 * RATE // FRAMES)), ALBUM)
                else:
                    with self.assertRaises(ValueError):
                        await recognize(block() * (12 * RATE // FRAMES))
            post.assert_called_once()
            self.assertFalse(post.call_args.kwargs["allow_redirects"])
            self.assertTrue(post.call_args.args[0].startswith("https://amp.shazam.com/discovery/"))
            self.assertIn("signature", post.call_args.kwargs["json"])

    def test_minimal_album_only_no_song_fallback_or_lyrics(self):
        self.assertEqual(album_fields(RAW), ALBUM)
        self.assertIsNone(album_fields({"track": {"title": "Song", "subtitle": "Artist"}}))
        self.assertIsNone(album_fields({"track": {"sections": "bad"}}))
        for title in ("x" * 257, "", "album\ninjected"):
            data = {"track": {**RAW["track"], "sections": [
                {"type": "SONG", "metadata": [{"title": "Album", "text": title}]},
            ]}}
            self.assertIsNone(album_fields(data))

    async def test_exactly_one_http_attempt_on_500_timeout_and_success(self):
        for status in (200, 429, 500, 302):
            async def chunks(_size):
                yield json.dumps(RAW).encode()
            response = SimpleNamespace(status=status, content=SimpleNamespace(iter_chunked=chunks))
            context = AsyncMock()
            context.__aenter__.return_value = response
            session = SimpleNamespace(post=Mock(return_value=context))
            transport = SingleRequestClient(session)
            url = "https://amp.shazam.com/discovery/v5/en-US/GB/web/-/tag/a/b"
            if status == 200:
                self.assertEqual(await transport.request("POST", url), RAW)
            else:
                with self.assertRaises(ValueError):
                    await transport.request("POST", url)
            with self.assertRaises(ValueError):
                await transport.request("POST", url)
            session.post.assert_called_once_with(url, allow_redirects=False)
        context.__aenter__.side_effect = TimeoutError()
        transport = SingleRequestClient(session)
        before = session.post.call_count
        with self.assertRaises(TimeoutError):
            await transport.request("POST", url)
        self.assertEqual(session.post.call_count, before + 1)

    async def test_provider_response_and_endpoint_limits(self):
        async def chunks(_size):
            yield b"x" * (MAX_RESPONSE + 1)
        context = AsyncMock()
        context.__aenter__.return_value = SimpleNamespace(status=200, content=SimpleNamespace(iter_chunked=chunks))
        session = SimpleNamespace(post=Mock(return_value=context))
        for url in ("http://amp.shazam.com/discovery/a", "https://localhost/discovery/a",
                    "https://amp.shazam.com:443/discovery/a", "https://x@amp.shazam.com/discovery/a"):
            with self.assertRaises(ValueError):
                await SingleRequestClient(session).request("POST", url)
        session.post.assert_not_called()
        with self.assertRaisesRegex(ValueError, "too large"):
            await SingleRequestClient(session).request("POST", "https://amp.shazam.com/discovery/a")

    async def test_wav_memory_contract_and_custom_transport_no_default_retry(self):
        provider = SimpleNamespace(recognize=AsyncMock(return_value=RAW))
        factory = Mock(return_value=provider)
        with patch.dict(sys.modules, {"shazamio": SimpleNamespace(Shazam=factory)}):
            self.assertEqual(await recognize(block() * (12 * RATE // FRAMES)), ALBUM)
        self.assertIsInstance(factory.call_args.kwargs["http_client"], SingleRequestClient)
        self.assertEqual(factory.call_args.kwargs["segment_duration_seconds"], 12)
        with wave.open(io.BytesIO(provider.recognize.call_args.args[0]), "rb") as wav:
            self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth(), wav.getnframes()),
                             (48000, 2, 2, 576000))

    async def test_process_deadline_and_cancel_kill_then_reap(self):
        process = SimpleNamespace(
            stdin=SimpleNamespace(write=Mock(), drain=AsyncMock(), close=Mock()),
            stdout=SimpleNamespace(read=AsyncMock(side_effect=lambda _size: asyncio.sleep(10))),
            returncode=None, kill=Mock(), wait=AsyncMock(return_value=0),
        )
        async def read(_size):
            await asyncio.sleep(10)
        process.stdout.read = read
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)), \
                patch("sendspin_karaoke_source.recognition.WORKER_SECONDS", .01):
            with self.assertRaises(TimeoutError):
                await process_album(b"sample")
        process.kill.assert_called_once()
        process.wait.assert_awaited_once()

    async def test_spawn_failure_propagates(self):
        with patch("asyncio.create_subprocess_exec", AsyncMock(side_effect=OSError("missing"))):
            with self.assertRaises(OSError):
                await process_album(b"sample")

    async def test_cancel_during_process_creation_still_reaps_late_child(self):
        ready = asyncio.Event()
        process = SimpleNamespace(returncode=None, kill=Mock(), wait=AsyncMock(return_value=0))
        async def spawn(*args, **kwargs):
            await ready.wait()
            return process
        with patch("asyncio.create_subprocess_exec", spawn):
            task = asyncio.create_task(process_album(b"sample"))
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            ready.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        process.kill.assert_called_once()
        process.wait.assert_awaited_once()


class OptionsTests(unittest.TestCase):
    def test_cli_and_strict_control_contract(self):
        for command in ("recognition-enable", "recognition-disable", "recognition-status"):
            self.assertEqual(parse_args([command, "--state-dir", str(Path.cwd())]).command, command)
            self.assertEqual(decode(json.dumps({"command": command}).encode()), {"command": command})
        for extra in ('"path":"/private"', '"format":"wav"', '"silence_dbfs":true'):
            with self.assertRaises(SourceError):
                decode(('{"command":"recognition-enable",' + extra + '}').encode())


@unittest.skipUnless(os.name == "posix", "POSIX ownership/modes required")
class HandoffTests(PrivateWorkspace, unittest.TestCase):
    def setUp(self):
        self.create_workspace()
        self.path.chmod(0o2750)

    def test_atomic_bounded_metadata_and_modes(self):
        write_snapshot({"version": 1, "album": ALBUM}, self.path)
        target = self.path / "album.json"
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640)
        self.assertEqual(target.stat().st_gid, self.path.stat().st_gid)
        write_snapshot({"version": 1, "album": None}, self.path)
        self.assertIsNone(json.loads(target.read_bytes())["album"])
        self.assertEqual([p.name for p in self.path.iterdir()], ["album.json"])
        with self.assertRaises(ValueError):
            write_snapshot({"extra": "x" * 5000}, self.path)
        self.path.chmod(0o2770)
        with self.assertRaises(PermissionError):
            write_snapshot({}, self.path)

    def test_symlink_directory_and_world_readable_modes_rejected(self):
        link = self.path / "link"
        link.symlink_to(self.path, target_is_directory=True)
        with self.assertRaises(PermissionError):
            write_snapshot({}, link)
        self.path.chmod(0o2755)
        with self.assertRaises(PermissionError):
            write_snapshot({}, self.path)


if __name__ == "__main__":
    unittest.main()
