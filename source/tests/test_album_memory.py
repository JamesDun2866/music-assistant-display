import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import sys
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiosendspin.noise.keys import Identity
from sendspin_karaoke_source.album_memory import AlbumMemory, NAME, validate
from sendspin_karaoke_source.album_retry import AlbumRetryServer, decode_retry, peer_allowed
from sendspin_karaoke_source.config import SourceError, parse_args
from sendspin_karaoke_source.control import decode
from sendspin_karaoke_source.recognition import Recognition
from sendspin_karaoke_source.audio import FRAMES, RATE
from test_source import PrivateWorkspace, eventually
from test_recognition import ALBUM, block


class AlbumMemoryTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.create_workspace()
        self.identity = Identity.generate()
        self.subjects = []
        self.timestamp = 1_000_000
        self.addAsyncCleanup(self.close_all)

    async def close_all(self):
        for subject in self.subjects:
            await subject.close()

    def subject(self, identity=None):
        result = Recognition(SimpleNamespace(consumers={"stream": 1}, observers=set()),
                             identity or self.identity, state_dir=self.path,
                             publish=Mock(), recognize=AsyncMock(return_value=ALBUM))
        self.subjects.append(result)
        return result

    async def enable(self, subject):
        with patch("importlib.util.find_spec", return_value=object()):
            await subject.enable()

    def feed(self, subject, seconds, level=1000):
        for _ in range(round(seconds * RATE / FRAMES)):
            subject.offer(block(level), self.timestamp)
            self.timestamp += FRAMES * 1_000_000 // RATE

    async def identify(self, subject):
        self.feed(subject, 12)
        await eventually(lambda: subject.state == "identified")
        await subject._write()

    async def test_album_survives_silence_no_match_failure_disable_and_reboot_with_new_live_identity(self):
        subject = self.subject()
        await subject.start()
        await self.enable(subject)
        await self.identify(subject)
        key = subject.album_key
        for result in (None, OSError("unavailable")):
            self.feed(subject, 5, 0)
            self.assertEqual(subject.album, ALBUM)
            subject.recognize = AsyncMock(side_effect=result) if result else AsyncMock(return_value=None)
            self.feed(subject, 12)
            await eventually(lambda: subject.state == "unavailable")
            await subject._write()
            self.assertEqual(subject.album_key, key)
            self.assertEqual(subject.album, ALBUM)
        await subject.disable()
        await subject.close()
        restored = self.subject()
        await restored.start()
        self.assertFalse(restored.enabled)
        self.assertEqual(restored.state, "disabled")
        self.assertEqual(restored.album, ALBUM)
        self.assertEqual(restored.album_key, key)
        self.assertNotEqual(restored.boot_id, subject.boot_id)
        self.assertEqual(restored.generation, 0)
        self.assertEqual(restored.buffer, b"")
        restored.recognize.assert_not_called()
        data = json.loads((self.path / NAME).read_text())
        self.assertEqual(set(data), {"version", "source_id", "key", "album", "success"})
        self.assertEqual(data["success"], subject.album_success)
        self.assertLess((self.path / NAME).stat().st_size, 4096)
        if os.name == "posix":
            self.assertEqual((self.path / NAME).stat().st_mode & 0o777, 0o600)

    async def test_new_success_replaces_only_album_and_another_source_cannot_restore_it(self):
        subject = self.subject()
        await self.enable(subject)
        await self.identify(subject)
        old_key = subject.album_key
        self.feed(subject, 5, 0)
        second = {**ALBUM, "title": "Different album"}
        subject.recognize.return_value = second
        await self.identify(subject)
        self.assertNotEqual(subject.album_key, old_key)
        await subject.close()
        foreign = self.subject(Identity.generate())
        with patch("importlib.util.find_spec", return_value=object()):
            await foreign.start()
        self.assertIsNone(foreign.album)
        self.assertIsNone(foreign.album_key)
        restored = self.subject()
        with patch("importlib.util.find_spec", return_value=object()):
            await restored.start()
        self.assertEqual(restored.album, second)

    async def test_cache_errors_are_visible_do_not_fake_durability_or_change_consent(self):
        subject = self.subject()
        await self.enable(subject)
        subject.album_memory.save_album = AsyncMock(side_effect=OSError("disk full"))
        await self.identify(subject)
        self.assertEqual(subject.status()["cache_error"], "save_failed")
        self.assertTrue(subject.enabled)
        self.assertEqual(subject.album, ALBUM)
        self.assertFalse((self.path / NAME).exists())
        (self.path / NAME).write_text('{"version": 99}')
        (self.path / NAME).chmod(0o600)
        restored = self.subject()
        with patch("importlib.util.find_spec", return_value=object()):
            await restored.start()
        self.assertEqual(restored.cache_error, "restore_failed")
        self.assertIsNone(restored.album)

    async def test_retry_is_fresh_passive_bounded_and_retains_cache_on_no_match(self):
        subject = self.subject()
        await self.enable(subject)
        await self.identify(subject)
        old_key = subject.album_key
        subject.recognize.return_value = None
        before = dict(subject.owner.consumers)
        binding = (subject.source_id, subject.boot_id, subject.generation)
        await subject.retry(binding)
        self.assertEqual(subject.buffer, b"")
        self.assertEqual(subject.owner.consumers, before)
        self.assertEqual(subject.album_key, old_key)
        with self.assertRaisesRegex(SourceError, "changed"):
            await subject.retry(binding)
        self.feed(subject, 11.975, 2345)
        self.assertEqual(subject.recognize.await_count, 1)
        with self.assertRaisesRegex(SourceError, "busy"):
            await subject.retry()
        self.feed(subject, .025, 2345)
        await eventually(lambda: subject.state == "unavailable")
        self.assertEqual(subject.recognize.call_args.args[0], block(2345) * 480)
        self.assertEqual(subject.recognize.await_count, 2)
        self.assertEqual(subject.album, ALBUM)
        with self.assertRaisesRegex(SourceError, "rate limited"):
            await subject.retry()
        self.feed(subject, 30)
        self.assertEqual(subject.recognize.await_count, 2)
        await subject.disable()
        with self.assertRaisesRegex(SourceError, "off"):
            await subject.retry()
        await self.enable(subject)
        subject.context(False)
        with self.assertRaisesRegex(SourceError, "active line-in"):
            await subject.retry()
        self.assertEqual(subject.album, ALBUM)

    async def test_retry_silence_cancels_sample_and_late_attempt_cannot_replace_cache(self):
        subject = self.subject()
        await self.enable(subject)
        await self.identify(subject)
        await subject.retry()
        self.feed(subject, 1)
        self.feed(subject, 5, 0)
        self.assertEqual(subject.state, "armed")
        self.assertEqual(subject.buffer, b"")
        finish = asyncio.Event()
        async def late(_pcm):
            try:
                await finish.wait()
            except asyncio.CancelledError:
                return {**ALBUM, "title": "Late album"}
        subject.recognize = late
        self.feed(subject, 12)
        await asyncio.sleep(0)
        await subject.disable()
        self.assertEqual(subject.album, ALBUM)

    async def test_explicit_retry_can_identify_after_no_match_without_automatic_retry(self):
        subject = self.subject()
        await self.enable(subject)
        subject.recognize.return_value = None
        self.feed(subject, 12)
        await eventually(lambda: subject.state == "unavailable")
        self.feed(subject, 20)
        self.assertEqual(subject.recognize.await_count, 1)
        await subject.retry()
        subject.recognize.return_value = ALBUM
        await self.identify(subject)
        self.assertEqual(subject.recognize.await_count, 2)
        self.assertEqual(subject.album, ALBUM)
        self.assertEqual(subject.owner.consumers, {"stream": 1})

    async def test_orphaned_pending_cache_is_bounded_and_recovered(self):
        from sendspin_karaoke_source.album_memory import PENDING
        pending = self.path / PENDING
        pending.write_bytes(b'{"interrupted":')
        pending.chmod(0o600)
        memory = AlbumMemory(self.path)
        self.assertIsNone(await memory.load())
        self.assertFalse(pending.exists())
        await memory.save_album("a" * 64, "b" * 32 + "-1", ALBUM)
        self.assertEqual([entry.name for entry in self.path.iterdir()], [NAME])

    async def test_corrupt_oversized_unsafe_and_unknown_cache_fields_are_rejected(self):
        memory = AlbumMemory(self.path)
        value = {"version": 1, "source_id": "a" * 64, "key": "b" * 32 + "-1", "album": ALBUM}
        for raw in (b"x" * 4097, b"{", json.dumps({**value, "audio": "forbidden"}).encode(),
                    json.dumps({**value, "album": {**ALBUM, "artwork": "http://localhost/a"}}).encode()):
            (self.path / NAME).write_bytes(raw)
            (self.path / NAME).chmod(0o600)
            with self.assertRaises(SourceError):
                await memory.load()
        if os.name == "posix":
            (self.path / NAME).unlink()
            target = self.path / "target"
            target.write_text("unchanged")
            (self.path / NAME).symlink_to(target)
            with self.assertRaises(SourceError):
                await memory.save_album(value["source_id"], value["key"], ALBUM)
            self.assertEqual(target.read_text(), "unchanged")


    async def test_success_order_survives_equal_clock_rollback_and_same_album_reidentification(self):
        subject = self.subject()
        subject.clock = lambda: 100
        await self.enable(subject)
        await self.identify(subject)
        first = dict(subject.album_success)
        key = subject.album_key
        self.feed(subject, 5, 0)
        await self.identify(subject)
        self.assertEqual(subject.album_key, key)
        self.assertEqual(subject.album_success["at_ms"], first["at_ms"] + 1)
        self.assertGreater(subject.album_success["generation"], first["generation"])
        subject.clock = lambda: 1
        self.feed(subject, 5, 0)
        await self.identify(subject)
        saved = dict(subject.album_success)
        self.assertEqual(saved["at_ms"], first["at_ms"] + 2)
        await subject.close()
        restored = self.subject()
        restored.clock = lambda: 0
        with patch("importlib.util.find_spec", return_value=object()):
            await restored.start()
        self.assertEqual(restored.album_success, saved)
        self.assertNotEqual(restored.boot_id, saved["boot_id"])
        await self.identify(restored)
        self.assertEqual(restored.album_key, key)
        self.assertEqual(restored.album_success["at_ms"], saved["at_ms"] + 1)
        self.assertEqual(restored.album_success["boot_id"], restored.boot_id)

    async def test_failed_source_save_restores_older_success_not_a_fresh_identification(self):
        subject = self.subject()
        await self.enable(subject)
        await self.identify(subject)
        old = dict(subject.album_success)
        self.feed(subject, 5, 0)
        subject.recognize.return_value = {**ALBUM, "title": "B"}
        with patch.object(subject.album_memory, "save_album", AsyncMock(side_effect=OSError("disk"))):
            await self.identify(subject)
        latest = dict(subject.album_success)
        self.assertGreater(latest["at_ms"], old["at_ms"])
        self.assertEqual(subject.cache_error, "save_failed")
        await subject.close()
        restored = self.subject()
        with patch("importlib.util.find_spec", return_value=object()):
            await restored.start()
        self.assertEqual(restored.album, ALBUM)
        self.assertEqual(restored.album_success, old)
        self.assertNotEqual(restored.status()["boot_id"], old["boot_id"])
        self.assertNotEqual(restored.state, "identified")
        self.assertGreater(restored.status()["updated_at_ms"], old["at_ms"])

    async def test_legacy_source_cache_migrates_with_unknown_order_and_malformed_success_is_rejected(self):
        value = {"version": 1, "source_id": "a" * 64, "key": "b" * 32 + "-1", "album": ALBUM}
        (self.path / NAME).write_text(json.dumps(value))
        (self.path / NAME).chmod(0o600)
        loaded = await AlbumMemory(self.path).load()
        self.assertEqual(loaded["version"], 2)
        self.assertIsNone(loaded["success"])
        for success in (
                {"boot_id": "b" * 32, "generation": True, "at_ms": 100},
                {"boot_id": "b" * 32, "generation": 1, "at_ms": -1},
                {"boot_id": "wrong", "generation": 1, "at_ms": 100},
                {"boot_id": "b" * 32, "generation": 1, "at_ms": 100, "extra": "bad"}):
            with self.assertRaises(SourceError):
                validate({**value, "version": 2, "success": success})


class RetryProtocolTests(unittest.TestCase):
    def test_retry_is_cli_command_but_narrow_socket_never_accepts_control_or_extra_fields(self):
        self.assertEqual(parse_args(["recognition-retry", "--state-dir", str(Path.cwd())]).command, "recognition-retry")
        self.assertEqual(decode(b'{"command":"recognition-retry"}')["command"], "recognition-retry")
        request = {"command": "recognition-retry", "source_id": "a" * 64, "boot_id": "b" * 32, "generation": 1}
        self.assertEqual(decode_retry(json.dumps(request).encode()), ("a" * 64, "b" * 32, 1))
        for value in ({**request, "command": "record-start"}, {**request, "command": "recognition-enable"},
                      {**request, "filename": "/private"}, {**request, "generation": True},
                      {**request, "source_id": "foreign"}, {**request, "generation": -1}):
            with self.assertRaises(SourceError):
                decode_retry(json.dumps(value).encode())
        with self.assertRaises(SourceError):
            decode_retry(b'{"command":"recognition-retry","command":"record-start"}')

    def test_peer_uid_not_group_membership_authorizes_retry(self):
        peer = Mock()
        with patch.object(socket, "SO_PEERCRED", 17, create=True):
            for uid, allowed in ((0, True), (100, True), (200, True), (300, False)):
                peer.getsockopt.return_value = struct.pack("3i", 123, uid, 999)
                self.assertEqual(peer_allowed(peer, 100, 200), allowed)


class RetryAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_newline_times_out_without_mutation(self):
        recognition = SimpleNamespace(retry=AsyncMock())
        server = AlbumRetryServer(recognition)
        reader = asyncio.StreamReader(limit=512)
        reader.feed_data(b'{"command":')
        writer = SimpleNamespace(write=Mock(), drain=AsyncMock(), close=Mock(),
                                 wait_closed=AsyncMock(), get_extra_info=Mock())
        with (patch("sendspin_karaoke_source.album_retry.peer_allowed", return_value=True),
              patch.object(os, "geteuid", return_value=100, create=True)):
            await asyncio.wait_for(server._handle(reader, writer), 4)
        recognition.retry.assert_not_awaited()
        self.assertFalse(json.loads(writer.write.call_args.args[0])["ok"])
        writer.close.assert_called_once()

    async def test_full_admission_does_not_create_another_handler(self):
        server = AlbumRetryServer(SimpleNamespace(retry=AsyncMock()))
        server.handlers = set(range(8))
        writer = SimpleNamespace(write=Mock(), close=Mock())
        server._accept(Mock(), writer)
        self.assertEqual(len(server.handlers), 8)
        writer.close.assert_called_once()
        self.assertFalse(json.loads(writer.write.call_args.args[0])["ok"])


@unittest.skipUnless(sys.platform == "linux", "Linux socket permissions and credentials")
class RetrySocketTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def test_socket_permissions_peer_gate_bound_retry_and_cleanup(self):
        self.path = Path.cwd() / (".retry-" + uuid.uuid4().hex[:8])
        self.path.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree, self.path)
        self.path.chmod(0o2750)
        recognition = SimpleNamespace(retry=AsyncMock(), status=Mock())
        server = AlbumRetryServer(recognition, self.path)
        await server.start()
        self.addAsyncCleanup(server.close)
        self.assertEqual(server.path.stat().st_mode & 0o777, 0o660)
        self.assertEqual(server.path.stat().st_gid, self.path.stat().st_gid)
        async def request(value):
            reader, writer = await asyncio.open_unix_connection(server.path)
            writer.write(json.dumps(value).encode() + b"\n")
            await writer.drain()
            response = json.loads(await reader.readline())
            writer.close()
            await writer.wait_closed()
            return response
        binding = {"source_id": "a" * 64, "boot_id": "b" * 32, "generation": 1}
        self.assertTrue((await request({"command": "recognition-retry", **binding}))["ok"])
        recognition.retry.assert_awaited_once_with(("a" * 64, "b" * 32, 1))
        self.assertFalse((await request({"command": "record-start", **binding}))["ok"])
        with patch("sendspin_karaoke_source.album_retry.peer_allowed", return_value=False):
            self.assertFalse((await request({"command": "recognition-retry", **binding}))["ok"])
        self.assertEqual(recognition.retry.await_count, 1)
        await server.close()
        self.assertFalse(server.path.exists())
