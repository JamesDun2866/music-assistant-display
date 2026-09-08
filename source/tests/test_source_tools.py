import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import uuid

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
from sendspin_karaoke_source.meters import Meters
from sendspin_karaoke_source.recording_library import LibraryError
from sendspin_karaoke_source.source_health import SourceHealth, safe_version, worker_call
from sendspin_karaoke_source.tools import ToolsServer, decode_request, peer_allowed


class DecodeTests(unittest.TestCase):
    def request(self, **changes):
        return {"version": 1, "source_id": "a" * 64, "command": "telemetry", **changes}

    def test_strict_request(self):
        self.assertEqual(decode_request(json.dumps(self.request()).encode() + b"\n"), self.request())
        requests = [
            self.request(version=True), self.request(version=2), self.request(command=[]),
            self.request(command="record-start"), self.request(extra="not allowed"),
            self.request(source_id="b"), self.request(command="recordings-list", limit=True),
            self.request(command="recording-download", id="b" * 64, revision="c" * 64),
            self.request(command="recordings-list", cursor="../escape"),
            self.request(command="recording-label", boot_id="b" * 32, id="c" * 64,
                         revision="d" * 64, label="x\nsecret"),
        ]
        for value in requests:
            with self.subTest(value=value), self.assertRaises(LibraryError):
                decode_request(json.dumps(value).encode() + b"\n")
        for raw in (b"{}\n", b"[]\n", b"{}\n{}\n", b"x" * 8193,
                    b'{"version":1,"version":1,"source_id":"' + b"a" * 64 + b'","command":"telemetry"}\n',
                    b'{"version":NaN}\n', b'{"x":"\xff"}\n'):
            with self.assertRaises(LibraryError):
                decode_request(raw)

    def test_peer_requires_exact_uid_and_primary_gid(self):
        fake = Mock()
        fake.getsockopt.return_value = struct.pack("3i", 123, 1001, 1002)
        with patch.object(socket, "SO_PEERCRED", 17, create=True):
            self.assertTrue(peer_allowed(fake, 1001, 1002))
            self.assertFalse(peer_allowed(fake, 1001, 9999))
            self.assertFalse(peer_allowed(fake, 0, 1002))
            fake.getsockopt.return_value = struct.pack("iII", 123, 0xfffffffe, 0xfffffffd)
            self.assertTrue(peer_allowed(fake, 0xfffffffe, 0xfffffffd))

    def test_versions_allow_only_bounded_version_identifiers(self):
        for value in ("0.6.0", "3.14.0", "9.1.1", "1.2.3-rc.1", "1.2.3+build.4"):
            self.assertEqual(safe_version(value), value)
        for value in ("private-hostname", "secret_token", "1.2.3\n", "1.2." + "3" * 65, None):
            self.assertIsNone(safe_version(value))


class HealthTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = 0.0
        self.meter = Meters(clock=lambda: self.now)
        self.owner = SimpleNamespace(observers={self.meter}, session=None, failure=None)
        self.recorder = SimpleNamespace(status=lambda: {"state": "idle", "path": "SECRET", "error": "SECRET"})
        self.health = SourceHealth(self.meter, self.owner, self.recorder, SOURCE, clock=lambda: self.now)

    async def test_idle_is_not_device_evidence_and_stop_is_not_disconnect(self):
        value = self.health.snapshot()
        self.assertEqual(value["capture"], {"state": "inactive", "evidence": "unknown", "evidenceAgeMs": None})
        self.assertEqual(value["disk"]["state"], "unavailable")
        bridge = SimpleNamespace(audio=SimpleNamespace(accepting=True, failure=None), requested=True)
        self.owner.consumers = [bridge.audio]
        self.health.connecting()
        self.assertEqual(self.health.snapshot()["sendspin"]["state"], "connecting")
        self.health.connected(bridge)
        self.assertTrue(self.health.snapshot()["sendspin"]["streaming"])
        self.owner.consumers = []
        self.assertFalse(self.health.snapshot()["sendspin"]["streaming"])
        self.owner.consumers = [bridge.audio]
        bridge.requested = False
        self.assertEqual(self.health.snapshot()["sendspin"], {"state": "connected", "streaming": False})
        self.health.disconnected()
        self.assertEqual(self.health.snapshot()["sendspin"]["state"], "disconnected")
        self.assertNotIn("SECRET", json.dumps(self.health.snapshot()))

    async def test_observer_removed_and_error_categories_are_safe(self):
        self.owner.observers.clear()
        self.health.error("SECRET /home/private token")
        self.health.error("unavailable")
        self.now = 1
        value = self.health.snapshot()
        self.assertEqual(value["capture"]["state"], "unavailable")
        self.assertEqual(value["errors"], [{"category": "unavailable", "count": 2, "ageMs": 1000}])
        self.assertNotIn("SECRET", json.dumps(value))

    async def test_cancellation_waits_for_running_worker(self):
        started, finish = threading.Event(), threading.Event()
        def worker():
            started.set()
            finish.wait(3)
            return 7
        task = asyncio.create_task(worker_call(worker))
        while not started.is_set():
            await asyncio.sleep(0.005)
        task.cancel()
        await asyncio.sleep(0.02)
        self.assertFalse(task.done())
        finish.set()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_disk_refresh_is_not_triggered_by_snapshots(self):
        with patch("sendspin_karaoke_source.source_health.shutil.disk_usage",
                   return_value=SimpleNamespace(free=10, total=100)) as usage:
            await self.health.start()
            try:
                for _ in range(100):
                    if usage.call_count:
                        break
                    await asyncio.sleep(0.005)
                for _ in range(20):
                    self.health.snapshot()
                self.assertEqual(usage.call_count, 1)
            finally:
                await self.health.close()

    async def test_full_unicode_page_fits_bounded_utf8_response(self):
        server = ToolsServer(SOURCE, SimpleNamespace(public_bytes=b"fixture"), self.meter, self.health)
        writer = SimpleNamespace(write=Mock(), drain=AsyncMock())
        record = {"id": "a" * 64, "revision": "b" * 64, "label": "\U0001f3b5" * 120,
                  "format": "wav", "bytes": 100, "completedAt": "2026-09-08T12:00:00.000Z",
                  "album": {"title": "\U0001f3b5" * 256, "artist": "\U0001f3b5" * 256}}
        await server._send(writer, data={"version": 1, "items": [record] * 50, "nextCursor": None})
        raw = writer.write.call_args.args[0]
        self.assertLessEqual(len(raw), 262144)
        self.assertEqual(json.loads(raw)["data"]["items"][0], record)
        self.assertNotIn(b"\\ud83c", raw)

    async def test_permission_failure_during_start_cleanup_is_isolated(self):
        server = ToolsServer(SOURCE, SimpleNamespace(public_bytes=b"fixture"), self.meter, self.health)
        close = Mock()
        filesystem = SimpleNamespace(
            stat=Mock(side_effect=[FileNotFoundError(), PermissionError()]), close=close,
        )
        with patch.object(socket, "SO_PEERCRED", 17, create=True), \
                patch.object(server, "_credentials"), patch.object(server, "_configured_identity"), \
                patch("sendspin_karaoke_source.tools.runtime_directory", return_value=42), \
                patch("sendspin_karaoke_source.tools.os", filesystem), \
                patch("sendspin_karaoke_source.tools.asyncio.start_unix_server",
                      new=AsyncMock(side_effect=PermissionError()), create=True):
            self.assertFalse(await server.start())
            close.assert_called_once_with(42)
        self.assertIsNone(server.directory_fd)

    async def test_download_holds_last_block_until_final_validation(self):
        for ending in (b"", LibraryError("conflict")):
            with self.subTest(ending=ending):
                server = ToolsServer(SOURCE, SimpleNamespace(public_bytes=b"fixture"), self.meter, self.health)
                transfer = SimpleNamespace(
                    record={"bytes": 3, "format": "wav", "label": "Fixture"},
                    read=Mock(side_effect=[b"abc", ending]), close=Mock(),
                )
                server.library.download = Mock(return_value=transfer)
                server._check_socket = Mock()
                output = []
                writer = SimpleNamespace(
                    write=output.append, drain=AsyncMock(), close=Mock(),
                    wait_closed=AsyncMock(), get_extra_info=Mock(),
                )
                reader = asyncio.StreamReader()
                reader.feed_data(json.dumps({
                    "version": 1, "source_id": server.source_id, "boot_id": server.boot_id,
                    "command": "recording-download", "id": "a" * 64, "revision": "b" * 64,
                }).encode() + b"\n")
                with patch("sendspin_karaoke_source.tools.peer_allowed", return_value=True):
                    await server._handle(reader, writer)
                header, body = b"".join(output).split(b"\n", 1)
                self.assertTrue(json.loads(header)["ok"])
                self.assertEqual(body, b"" if isinstance(ending, LibraryError) else b"abc")
                transfer.close.assert_called_once()
                self.assertEqual(server.downloads, 0)

    async def test_run_uses_real_connection_events_not_source_stop(self):
        from sendspin_karaoke_source.cli import run
        from test_source import FakeClient
        connect_gate = asyncio.Event()
        client = FakeClient()
        async def connect(*_):
            await connect_gate.wait()
        client.connect = connect
        client.disconnect = AsyncMock()
        bridge = SimpleNamespace(close=AsyncMock(), failed=asyncio.Event(), failure=None,
                                 requested=True, audio=SimpleNamespace(accepting=True, failure=None))
        store = SimpleNamespace(list_records=AsyncMock(return_value=[SimpleNamespace(server_id="paired")]))
        config = SimpleNamespace(device="synthetic", server_url="ws://fixture/sendspin")
        with patch("sendspin_karaoke_source.cli.pairing_policy", new=AsyncMock()):
            task = asyncio.create_task(run(
                config, None, store, client_factory=lambda *_: client, bridge_factory=lambda *_: bridge,
                health=self.health, sleep=AsyncMock(side_effect=asyncio.CancelledError),
            ))
            try:
                async with asyncio.timeout(3):
                    while self.health.transport != "connecting":
                        await asyncio.sleep(0.005)
                    connect_gate.set()
                    while self.health.transport != "connected":
                        await asyncio.sleep(0.005)
                bridge.requested = False
                self.assertEqual(self.health.snapshot()["sendspin"], {"state": "connected", "streaming": False})
                for callback in tuple(client.disconnects):
                    callback()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertEqual(self.health.transport, "disconnected")
                client.disconnect.assert_awaited_once()
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)


@unittest.skipUnless(os.name == "posix" and hasattr(socket, "SO_PEERCRED"), "Linux Unix peer/path integration")
class ToolsIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.path = SOURCE / "tests" / (".tools-" + uuid.uuid4().hex)
        self.path.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree, self.path)
        self.runtime = self.path / "runtime"
        self.runtime.mkdir(mode=0o2750)
        self.runtime.chmod(0o2750)
        self.meter = Meters()
        self.owner = SimpleNamespace(observers={self.meter}, session=None, failure=None)
        self.health = SourceHealth(self.meter, self.owner, SimpleNamespace(status=lambda: {"state": "idle"}), self.path)
        self.server = ToolsServer(self.path, SimpleNamespace(public_bytes=b"synthetic"), self.meter, self.health,
                                  directory=self.runtime, peer_uid=os.getuid(), peer_gid=os.getgid(),
                                  group_gid=os.getgid())
        self.assertTrue(await self.server.start())
        self.addAsyncCleanup(self.server.close)

    async def exchange(self, command="telemetry", *, send_request=True, **kwargs):
        reader, writer = await asyncio.open_unix_connection(f"/proc/self/fd/{self.server.directory_fd}/tools.sock")
        request = {"version": 1, "source_id": self.server.source_id, "command": command, **kwargs}
        if send_request:
            writer.write(json.dumps(request).encode() + b"\n")
            await writer.drain()
        response = json.loads(await reader.readline())
        body = await reader.read()
        writer.close()
        await writer.wait_closed()
        return response, body

    async def test_telemetry_health_and_identity_binding(self):
        result, body = await self.exchange()
        self.assertTrue(result["ok"])
        self.assertEqual(result["boot_id"], self.server.boot_id)
        self.assertEqual(result["data"]["state"], "inactive")
        self.assertEqual(body, b"")
        result, _ = await self.exchange("health")
        self.assertEqual(result["data"]["capture"]["evidence"], "unknown")
        result, _ = await self.exchange(source_id="f" * 64)
        self.assertEqual(result["error"], "forbidden")

    async def test_wrong_primary_group_rejected(self):
        self.server.peer_gid = os.getgid() + 1
        # Rejection precedes request parsing. Unread unauthorized input can
        # cause Linux to reset the connection instead of sending graceful EOF.
        result, _ = await self.exchange(send_request=False)
        self.assertEqual(result["error"], "forbidden")

    async def test_safe_exact_download_and_boot_guard(self):
        directory = self.path / "recordings"
        directory.mkdir(mode=0o700)
        path = directory / ("20260908T120000.000000Z-" + uuid.uuid4().hex + ".wav")
        audio = b"synthetic" * 20000
        path.write_bytes(audio)
        path.chmod(0o600)
        page, _ = await self.exchange("recordings-list")
        item = page["data"]["items"][0]
        binding = {"id": item["id"], "revision": item["revision"], "boot_id": "f" * 32}
        result, _ = await self.exchange("recording-download", **binding)
        self.assertEqual(result["error"], "revision-changed")
        binding["boot_id"] = self.server.boot_id
        result, body = await self.exchange("recording-download", **binding)
        self.assertEqual(result["data"]["bytes"], len(audio))
        self.assertEqual(body, audio)
        self.assertEqual(self.server.downloads, 0)

    async def test_socket_swap_and_symlink_runtime_rejected(self):
        await self.server.close()
        original = self.runtime
        original.rename(self.path / "old-runtime")
        original.symlink_to(self.path / "old-runtime", target_is_directory=True)
        self.assertFalse(await self.server.start())

    async def test_bounded_download_admission_does_not_block_telemetry(self):
        self.server.downloads = 2
        result, _ = await self.exchange("recording-download", id="a" * 64,
                                        revision="b" * 64, boot_id=self.server.boot_id)
        self.assertEqual(result["error"], "busy")
        result, _ = await self.exchange()
        self.assertTrue(result["ok"])
        self.server.downloads = 0

    async def test_disconnect_cancels_transfer_and_shutdown_retires_idle_clients(self):
        directory = self.path / "recordings"
        directory.mkdir(mode=0o700)
        path = directory / ("20260908T120000.000000Z-" + uuid.uuid4().hex + ".wav")
        path.write_bytes(b"x" * (4 * 1024 * 1024))
        path.chmod(0o600)
        page, _ = await self.exchange("recordings-list")
        item = page["data"]["items"][0]
        reader, writer = await asyncio.open_unix_connection(f"/proc/self/fd/{self.server.directory_fd}/tools.sock")
        writer.write(json.dumps({
            "version": 1, "source_id": self.server.source_id, "command": "recording-download",
            "boot_id": self.server.boot_id, "id": item["id"], "revision": item["revision"],
        }).encode() + b"\n")
        await writer.drain()
        self.assertTrue(json.loads(await reader.readline())["ok"])
        writer.close()
        await writer.wait_closed()
        async with asyncio.timeout(3):
            while self.server.downloads:
                await asyncio.sleep(0.01)
        _, idle = await asyncio.open_unix_connection(f"/proc/self/fd/{self.server.directory_fd}/tools.sock")
        await asyncio.sleep(0.01)
        async with asyncio.timeout(3):
            await self.server.close()
        idle.close()
        await idle.wait_closed()
        self.assertEqual(self.server.tasks, set())


if __name__ == "__main__":
    unittest.main()
