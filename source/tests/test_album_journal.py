import asyncio
from contextlib import closing
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import threading
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiosendspin.noise.keys import Identity
from sendspin_karaoke_source.album_journal import (
    AlbumJournal, BACKLOG_ERROR, MAX_PENDING, MAX_PAYLOAD, RETENTION_MS,
)
from sendspin_karaoke_source.album_journal_ipc import AlbumJournalServer, decode_journal
from sendspin_karaoke_source.album_memory import AlbumMemory
from sendspin_karaoke_source.config import SourceError
from sendspin_karaoke_source.recognition import Recognition
from test_source import PrivateWorkspace

SOURCE_ID = "a" * 64
BOOT = "b" * 32
ALBUM = {"title": "Original album", "artist": "Original artist", "artwork": None, "catalog": None}


class JournalTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.create_workspace()
        self.now = RETENTION_MS + 10000
        self.journals = []
        self.addAsyncCleanup(self.close_all)
        self.journal = self.create()
        self.assertIsNone(await self.journal.start())

    def create(self, source_id=SOURCE_ID):
        journal = AlbumJournal(self.path, source_id, clock=lambda: self.now / 1000)
        self.journals.append(journal)
        return journal

    async def close_all(self):
        for journal in self.journals:
            await journal.close()

    def record(self, generation=1, boot=BOOT, observed=None, at_ms=None):
        observed = self.now if observed is None else observed
        return self.journal.record(
            BOOT + "-1", ALBUM, {"boot_id": boot, "generation": generation,
                                "at_ms": observed if at_ms is None else at_ms}, observed)

    async def head(self, journal=None):
        return await (journal or self.journal).request({"command": "journal-head", "source_id": SOURCE_ID})

    async def page(self, after=0, limit=100):
        head = await self.head()
        return await self.journal.request({"command": "journal-page", "source_id": SOURCE_ID,
                                           "epoch": head["epoch"], "after": after, "limit": limit})

    async def clear(self):
        head = await self.head()
        return await self.journal.request({"command": "journal-clear", "source_id": SOURCE_ID,
                                           "epoch": head["epoch"], "revision": head["revision"],
                                           "confirm": True})

    async def test_same_album_new_success_duplicate_and_restart(self):
        self.record()
        self.record()
        self.record(2)
        page = await self.page()
        self.assertEqual([e["sequence"] for e in page["events"]], [1, 2])
        self.assertEqual([e["album_key"] for e in page["events"]], [BOOT + "-1"] * 2)
        self.assertEqual(set(page), {"ok", "source_id", "epoch", "revision", "watermark",
                                    "high_water", "oldest_sequence", "healthy", "error", "events"})
        self.assertEqual(set(page["events"][0]), {"sequence", "source_id", "album_key",
                                                  "album_success", "observed_at_ms", "album"})
        await self.journal.close()
        restored = self.create()
        recovery = await restored.start()
        self.assertEqual(recovery["success"]["generation"], 2)
        head = await self.head(restored)
        self.assertEqual(head["epoch"], page["epoch"])
        self.assertEqual(head["high_water"], 2)
        self.assertTrue(head["healthy"])

    async def test_keyset_pages_and_payload_are_bounded(self):
        for generation in range(1, 112):
            self.record(generation)
            await self.journal.flush()
        first = await self.page(limit=100)
        second = await self.page(after=100)
        self.assertEqual(len(first["events"]), 100)
        self.assertEqual([e["sequence"] for e in second["events"]], list(range(101, 112)))
        self.assertLessEqual(len(json.dumps(first).encode()), MAX_PAYLOAD)

    async def test_clear_revision_watermark_recovery_and_replay(self):
        self.record()
        before = await self.head()
        cleared = await self.clear()
        self.assertEqual(cleared["revision"], 1)
        self.assertEqual(cleared["watermark"], 1)
        self.assertEqual(cleared["high_water"], 1)
        self.assertIsNone(cleared["oldest_sequence"])
        self.record()
        replayed = await self.page()
        self.assertEqual(replayed["events"], [])
        self.assertEqual(replayed["high_water"], 1)
        self.record(2, boot="c" * 32)
        self.record()
        self.assertEqual([e["sequence"] for e in (await self.page())["events"]], [2])
        with self.assertRaisesRegex(SourceError, "revision"):
            await self.journal.request({"command": "journal-clear", "source_id": SOURCE_ID,
                                        "epoch": before["epoch"], "revision": 0, "confirm": True})
        await self.journal.close()
        self.journal = self.create()
        recovery = await self.journal.start()
        self.assertEqual(recovery["success"]["boot_id"], "c" * 32)
        self.assertEqual((await self.head())["watermark"], 1)

    async def test_retention_boundary_and_expired_duplicate(self):
        self.record(observed=10001, at_ms=10001)
        self.assertEqual(len((await self.page())["events"]), 1)
        self.now += 1
        self.assertEqual((await self.page())["events"], [])
        self.record(observed=10001, at_ms=10001)
        self.assertEqual((await self.head())["high_water"], 1)

    async def test_epoch_zero_clock_keeps_a_new_success_for_its_retention_window(self):
        directory = self.path / "zero-clock"
        directory.mkdir(mode=0o700)
        self.now = 0
        journal = AlbumJournal(directory, SOURCE_ID, clock=lambda: self.now / 1000)
        self.journals.append(journal)
        await journal.start()
        self.assertTrue(journal.record(BOOT + "-1", ALBUM,
                                      {"boot_id": BOOT, "generation": 1, "at_ms": 0}, 0))
        self.assertEqual((await self.head(journal))["oldest_sequence"], 1)
        self.now = RETENTION_MS
        self.assertIsNone((await self.head(journal))["oldest_sequence"])

    async def test_allowed_unicode_metadata_is_not_rejected_by_ascii_wire_expansion(self):
        album = {**ALBUM, "title": "\u4e2d" * 256, "artist": "\u6587" * 256,
                 "artwork": "https://is1-ssl.mzstatic.com/image/thumb/" + "a" * 790 + "/400x400bb.jpg"}
        self.assertTrue(self.journal.record(
            BOOT + "-1", album, {"boot_id": BOOT, "generation": 1, "at_ms": self.now}, self.now))
        page = await self.page()
        self.assertEqual(page["events"][0]["album"], album)
        self.assertTrue(page["healthy"])

    async def test_slow_start_has_a_deadline_without_abandoning_the_worker(self):
        await self.journal.close()
        journal = self.create()
        entered, release = threading.Event(), threading.Event()
        original = journal._open
        def slow_open():
            entered.set()
            release.wait(5)
            return original()
        with (patch.object(journal, "_open", side_effect=slow_open),
              patch("sendspin_karaoke_source.album_journal.START_SECONDS", .02)):
            try:
                with self.assertRaises(TimeoutError):
                    await journal.start()
                self.assertTrue(entered.is_set())
                self.assertIsNotNone(journal.error)
                await asyncio.wait_for(asyncio.sleep(.001), .1)
            finally:
                release.set()
            await journal.close()

    async def test_new_success_survives_large_clock_rollback_and_restart(self):
        original_now = self.now
        self.record(at_ms=original_now)
        await self.head()
        self.now = 0
        self.record(2, observed=0, at_ms=original_now + 1)
        events = (await self.page())["events"]
        self.assertEqual(len(events), 2)
        self.assertEqual(events[1]["observed_at_ms"], 0)
        self.assertEqual(events[1]["album_success"]["at_ms"], original_now + 1)
        self.assertEqual((await self.head())["high_water"], 2)
        await self.journal.close()
        self.journal = self.create()
        recovered = await self.journal.start()
        self.assertEqual(recovered["success"]["at_ms"], original_now + 1)
        self.record(3, observed=0, at_ms=original_now + 2)
        self.assertEqual(len((await self.page())["events"]), 3)
        self.now = original_now + RETENTION_MS + 1
        self.assertEqual((await self.page())["events"], [])

    async def test_future_success_clamped_once_and_replay_after_expiry_cannot_refresh_age(self):
        original_now = self.now
        future = original_now + RETENTION_MS * 100
        self.record(observed=original_now, at_ms=future)
        event = (await self.page())["events"][0]
        self.assertEqual(event["album_success"]["at_ms"], future)
        self.now += RETENTION_MS + 1
        self.assertEqual((await self.page())["events"], [])
        self.record(observed=original_now, at_ms=future)
        replayed = await self.page()
        self.assertEqual(replayed["events"], [])
        self.assertEqual(replayed["high_water"], 1)
        await self.journal.close()
        self.journal = self.create()
        await self.journal.start()
        self.record(observed=original_now, at_ms=future)
        self.assertEqual((await self.page())["events"], [])
        self.assertEqual((await self.head())["high_water"], 1)

    async def test_wrong_source_epoch_cursor_and_future_schema_fail_explicitly(self):
        with self.assertRaisesRegex(SourceError, "source identity"):
            await self.journal.request({"command": "journal-head", "source_id": "c" * 64})
        head = await self.head()
        for epoch, after in [("c" * 32, 0), (head["epoch"], 1)]:
            with self.assertRaises(SourceError):
                await self.journal.request({"command": "journal-page", "source_id": SOURCE_ID,
                                            "epoch": epoch, "after": after, "limit": 1})
        await self.journal.close()
        foreign = self.create("c" * 64)
        with self.assertRaisesRegex(SourceError, "source identity"):
            await foreign.start()
        await foreign.close()
        with closing(sqlite3.connect(self.path / "album-journal" / "journal.sqlite3")) as db:
            with db:
                db.execute("UPDATE metadata SET version=99")
        future = self.create()
        with self.assertRaisesRegex(SourceError, "schema"):
            await future.start()

    async def test_slow_disk_bounded_backlog_does_not_block_loop_and_error_survives_restart(self):
        entered, release = threading.Event(), threading.Event()
        original = self.journal._record
        def slow(*args):
            entered.set()
            release.wait(5)
            return original(*args)
        with patch.object(self.journal, "_record", side_effect=slow):
            self.record()
            await asyncio.to_thread(entered.wait, 2)
            try:
                for generation in range(2, MAX_PENDING + 1):
                    self.assertTrue(self.record(generation))
                self.assertFalse(self.record(MAX_PENDING + 1))
                self.assertEqual(self.journal.error, BACKLOG_ERROR)
                await asyncio.wait_for(asyncio.sleep(.001), .1)
            finally:
                release.set()
            await self.journal.flush()
        self.assertFalse((await self.head())["healthy"])
        await self.journal.close()
        restored = self.create()
        await restored.start()
        self.assertEqual((await self.head(restored))["error"], BACKLOG_ERROR)

    async def test_failed_transaction_has_no_partial_event_or_recovery(self):
        with patch.object(self.journal, "_prune", side_effect=OSError("private album title disk error")):
            self.record()
            await self.journal.flush()
        head = await self.head()
        self.assertEqual(head["high_water"], 0)
        self.assertFalse(head["healthy"])
        self.assertNotIn("private", head["error"])
        with closing(sqlite3.connect(self.journal.path)) as db:
            self.assertIsNone(db.execute("SELECT recovery FROM metadata").fetchone()[0])

    async def test_cancelled_request_cannot_abandon_admitted_clear(self):
        self.record()
        head = await self.head()
        entered, release = threading.Event(), threading.Event()
        original = self.journal._request
        def slow(request):
            entered.set()
            release.wait(5)
            return original(request)
        with patch.object(self.journal, "_request", side_effect=slow):
            task = asyncio.create_task(self.journal.request(
                {"command": "journal-clear", "source_id": SOURCE_ID, "epoch": head["epoch"],
                 "revision": 0, "confirm": True}))
            await asyncio.to_thread(entered.wait, 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            release.set()
            await self.journal.flush()
        self.assertEqual((await self.head())["revision"], 1)

    async def test_reject_hardlinked_database_and_unsafe_sidecar(self):
        await self.journal.close()
        link = self.path / "linked.sqlite3"
        os.link(self.journal.path, link)
        rejected = self.create()
        with self.assertRaises(SourceError):
            await rejected.start()
        await rejected.close()
        link.unlink()
        sidecar = self.journal.path.with_name("journal.sqlite3-wal")
        sidecar.mkdir()
        rejected = self.create()
        with self.assertRaises(SourceError):
            await rejected.start()

    @unittest.skipUnless(os.name == "posix", "POSIX ownership/mode/symlink checks")
    async def test_private_modes_and_symlinks(self):
        self.assertEqual(self.journal.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.journal.path.stat().st_mode & 0o777, 0o600)
        self.journal.path.chmod(0o640)
        with self.assertRaises(SourceError):
            await self.head()
        self.journal.path.chmod(0o600)
        await self.journal.close()
        real = self.path / "real.sqlite3"
        self.journal.path.rename(real)
        self.journal.path.symlink_to(real)
        rejected = self.create()
        with self.assertRaises(SourceError):
            await rejected.start()


class ProducerTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def test_only_accepted_successes_record_and_crash_recovery_repairs_mirror(self):
        self.create_workspace()
        identity = Identity.generate()
        owner = SimpleNamespace(consumers={"stream": 1}, observers=set())
        subject = Recognition(owner, identity, state_dir=self.path, publish=Mock(),
                              recognize=AsyncMock(return_value=ALBUM))
        self.addAsyncCleanup(subject.close)
        await subject.start()
        with patch("importlib.util.find_spec", return_value=object()):
            await subject.enable()
        # Simulate a crash after commit but before the compatible mirror is written.
        subject.album_memory.save_album = AsyncMock(side_effect=OSError("disk"))
        await subject._attempt(b"", subject.generation)
        first = dict(subject.album_success)
        subject._reset("armed")
        await subject._attempt(b"", subject.generation)
        await subject.journal.flush()
        head_request = {"command": "journal-head", "source_id": subject.source_id}
        self.assertEqual((await subject.journal.request(head_request))["high_water"], 2)
        self.assertGreater(subject.album_success["generation"], first["generation"])
        subject.recognize.return_value = None
        subject._reset("armed")
        await subject._attempt(b"", subject.generation)
        subject.recognize.return_value = ALBUM
        await subject._attempt(b"", subject.generation - 1)
        for _ in range(3):
            subject.status()
            await subject._write()
        await subject.disable()
        await subject.close()
        restored = Recognition(owner, identity, state_dir=self.path, publish=Mock())
        self.addAsyncCleanup(restored.close)
        await restored.start()
        await restored._write()
        self.assertEqual(restored.album, ALBUM)
        self.assertEqual(restored.album_success, subject.album_success)
        self.assertEqual((await restored.journal.request(head_request))["high_water"], 2)
        saved = await AlbumMemory(self.path).load()
        self.assertEqual(saved["success"], subject.album_success)
        self.assertFalse(restored.enabled)

    async def test_legacy_cache_restore_never_backfills(self):
        self.create_workspace()
        identity = Identity.generate()
        subject = Recognition(SimpleNamespace(consumers={}, observers=set()), identity,
                              state_dir=self.path, publish=Mock())
        self.addAsyncCleanup(subject.close)
        await AlbumMemory(self.path).save_album(
            subject.source_id, BOOT + "-1", ALBUM,
            {"boot_id": BOOT, "generation": 1, "at_ms": 1000})
        await subject.start()
        self.assertEqual(subject.album, ALBUM)
        self.assertEqual((await subject.journal.request(
            {"command": "journal-head", "source_id": subject.source_id}))["high_water"], 0)


class WireTests(unittest.TestCase):
    def test_strict_commands_bounds_duplicate_keys_and_confirm(self):
        head = {"command": "journal-head", "source_id": SOURCE_ID}
        self.assertEqual(decode_journal(json.dumps(head).encode()), head)
        for value in [
            {**head, "command": "recognition-enable"},
            {**head, "path": "/private"},
            {**head, "command": "journal-page", "epoch": BOOT, "after": True, "limit": 1},
            {**head, "command": "journal-page", "epoch": BOOT, "after": 0, "limit": 101},
            {**head, "command": "journal-clear", "epoch": BOOT, "revision": 0, "confirm": 1},
            {**head, "command": "journal-clear", "epoch": BOOT, "confirm": True},
            {**head, "command": "journal-page", "epoch": BOOT.upper(), "after": 0, "limit": 1},
        ]:
            with self.subTest(value=value), self.assertRaises(SourceError):
                decode_journal(json.dumps(value).encode())
        for raw in [b"x" * 1025, b'{"command":"journal-head","command":"journal-clear"}', b"[]"]:
            with self.assertRaises(SourceError):
                decode_journal(raw)


class HandlerTests(unittest.IsolatedAsyncioTestCase):
    async def test_wire_errors_are_bounded_and_never_forward_controls(self):
        journal = SimpleNamespace(request=AsyncMock(return_value={"ok": True}), fail=Mock())
        server = AlbumJournalServer(SimpleNamespace(journal=journal))
        async def exchange(raw, allowed=True):
            reader = asyncio.StreamReader(limit=512)
            reader.feed_data(raw)
            reader.feed_eof()
            writer = SimpleNamespace(write=Mock(), drain=AsyncMock(), close=Mock(),
                                     wait_closed=AsyncMock(), get_extra_info=Mock())
            with (patch("sendspin_karaoke_source.album_journal_ipc.peer_allowed", return_value=allowed),
                  patch("os.geteuid", return_value=0, create=True)):
                await server._handle(reader, writer)
            response = writer.write.call_args.args[0]
            writer.close.assert_called_once()
            return response
        head = json.dumps({"command": "journal-head", "source_id": SOURCE_ID}).encode() + b"\n"
        self.assertTrue(json.loads(await exchange(head))["ok"])
        journal.request.assert_awaited_once()
        for raw, allowed in [
            (head, False), (b'{"command":"record-start"}\n', True),
            (b"x" * 2000 + b"\n", True), (head[:-1], True),
        ]:
            response = await exchange(raw, allowed)
            self.assertLessEqual(len(response), 1024)
            self.assertFalse(json.loads(response)["ok"])
        journal.request.assert_awaited_once()
        journal.request.side_effect = OSError("secret source identifier")
        response = await exchange(head)
        self.assertFalse(json.loads(response)["ok"])
        self.assertNotIn(b"secret", response)

    async def test_connection_admission_is_bounded(self):
        from sendspin_karaoke_source.album_journal_ipc import MAX_CLIENTS
        server = AlbumJournalServer(SimpleNamespace(journal=None))
        server.handlers = {object() for _ in range(MAX_CLIENTS)}
        writer = SimpleNamespace(write=Mock(), close=Mock())
        server._accept(None, writer)
        self.assertFalse(json.loads(writer.write.call_args.args[0])["ok"])
        writer.close.assert_called_once()
        self.assertEqual(len(server.handlers), MAX_CLIENTS)
        server.handlers.clear()


@unittest.skipUnless(os.name == "posix" and hasattr(socket, "SO_PEERCRED"), "Linux IPC")
class SocketTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def test_narrow_socket_binding_peers_and_lifecycle(self):
        self.create_workspace()
        journal = AlbumJournal(self.path, SOURCE_ID)
        await journal.start()
        self.addAsyncCleanup(journal.close)
        runtime = tempfile.TemporaryDirectory(prefix="ss-journal-", dir="/tmp")
        self.addCleanup(runtime.cleanup)
        run = Path(runtime.name)
        run.chmod(0o2750)
        server = AlbumJournalServer(SimpleNamespace(journal=journal), directory=run)
        await server.start()
        self.addAsyncCleanup(server.close)
        async def exchange(message):
            reader, writer = await asyncio.open_unix_connection(server.path)
            writer.write(json.dumps(message).encode() + b"\n")
            await writer.drain()
            response = json.loads(await reader.readline())
            writer.close()
            await writer.wait_closed()
            return response
        head = {"command": "journal-head", "source_id": SOURCE_ID}
        self.assertTrue((await exchange(head))["ok"])
        self.assertFalse((await exchange({**head, "command": "record-start"}))["ok"])
        with patch("sendspin_karaoke_source.album_journal_ipc.peer_allowed", return_value=False):
            self.assertFalse((await exchange(head))["ok"])
        await server.close()
        self.assertFalse(server.path.exists())
