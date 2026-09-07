"""Real pinned SDK/Noise/WebSocket/PCM interoperability; only hardware is faked."""

import asyncio
import contextlib
import io
import sys
import unittest
import soundfile as sf
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_source import PrivateWorkspace, FakeAudio, eventually

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer
from aiosendspin.client import SendspinClient
from aiosendspin.models.source import ClientHelloSourceSupport
from aiosendspin.models.types import PairMethod, Roles
from aiosendspin.noise.keys import Identity
from aiosendspin.noise.pairing import PairingAttempt
from aiosendspin.noise.trust_store import InMemoryServerPairingStore
from aiosendspin.server import SendspinServer
from aiosendspin.server.roles.source import SourceStreamStartedEvent

from sendspin_karaoke_source.bridge import SourceBridge, paired
from sendspin_karaoke_source.cli import make_client, pair, pairing_policy, run
from sendspin_karaoke_source.config import CaptureError, Config
from sendspin_karaoke_source.lifecycle import DisconnectCleanupError, disconnect_client
from sendspin_karaoke_source.state import load_identity, locked_state, open_store
from sendspin_karaoke_source.recording import Recorder
from sendspin_karaoke_source.shared import SharedCapture


class Terminal(io.StringIO):
    def isatty(self):
        return True


class ProtocolTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.create_workspace()
        self.lock = locked_state(self.path)
        self.lock.__enter__()
        self.addCleanup(self.lock.__exit__, None, None, None)
        self.identity = load_identity(self.path)
        self.store = await open_store(self.path)
        self.server_store = InMemoryServerPairingStore()
        self.server = SendspinServer(
            loop=asyncio.get_running_loop(), identity=Identity.generate(),
            server_name="Local test MA protocol peer", pairing_store=self.server_store,
            allow_unencrypted=False, allow_noncompliant_clients=False,
        )
        self.addAsyncCleanup(self.server.close)
        app = web.Application()
        app.router.add_get(SendspinServer.API_PATH, self.server.on_client_connect)
        self.http = TestServer(app, host="127.0.0.1")
        await self.http.start_server()
        self.addAsyncCleanup(self.http.close)
        self.config = Config(
            "pair", f"ws://127.0.0.1:{self.http.port}{SendspinServer.API_PATH}",
            "hw:CARD=CODEC,DEV=0", "UCA222 test", self.path,
        )

    async def pair_source(self):
        with patch("sys.stdout", new=Terminal()):
            task = asyncio.create_task(pair(self.config, self.identity, self.store))
            try:
                await eventually(lambda: any(
                    connection._client_id == self.identity.peer_id and connection._client is not None
                    for connection in self.server._pending_connections
                ))
                connection = next(
                    connection for connection in self.server._pending_connections
                    if connection._client_id == self.identity.peer_id
                )

                async def provide_pin():
                    return await self.store.static_pin()

                async with asyncio.timeout(10):
                    await connection.initiate_pairing(PairingAttempt(
                        method=PairMethod.STATIC_PIN, pin_provider=provide_pin,
                    ))
                    await task
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    def network_resources(self, client):
        connection = client._admitted_connection
        return (
            connection, connection._ws, client._session,
            (connection._reader_task, connection._time_task),
        )

    def assert_network_closed(self, client, resources):
        connection, socket, session, tasks = resources
        self.assertTrue(socket.closed)
        self.assertTrue(session.closed)
        self.assertTrue(all(task.done() for task in tasks))
        self.assertTrue(connection._closed.is_set())
        self.assertIsNone(client._admitted_connection)
        self.assertFalse(client.connected)

    async def test_stalled_sdk_goodbye_forces_real_transport_cleanup_without_stopping_recording(self):
        await self.pair_source()
        inputs = []

        def audio_factory(now_us):
            audio = FakeAudio(now_us)
            inputs.append(audio)
            return audio

        owner = SharedCapture(self.config.device, audio_factory)
        recorder = Recorder(owner, self.path)
        self.addAsyncCleanup(owner.close)
        self.addAsyncCleanup(recorder.close)
        await recorder.start("wav")
        client = make_client(self.config, self.identity, self.store, clock=owner.clock)
        self.addAsyncCleanup(disconnect_client, client)
        await client.connect(self.config.server_url)
        resources = self.network_resources(client)
        connection = resources[0]
        await connection._send_lock.acquire()
        try:
            with patch("sendspin_karaoke_source.lifecycle.GOODBYE_SECONDS", 0.025):
                async with asyncio.timeout(1):
                    await disconnect_client(client)
            self.assert_network_closed(client, resources)
            self.assertTrue(recorder.status()["active"])
            self.assertFalse(inputs[0].closed)
            inputs[0].queue.put_nowait((b"\xe8\x03\xd0\x07" * 1200, owner.clock.now_us()))
            await eventually(lambda: recorder.writer.frames == 1200)
            await recorder.stop()
        finally:
            connection._send_lock.release()

    async def test_cancellation_during_stalled_goodbye_waits_for_actual_sdk_resource_cleanup(self):
        await self.pair_source()
        client = make_client(self.config, self.identity, self.store)
        self.addAsyncCleanup(disconnect_client, client)
        await client.connect(self.config.server_url)
        resources = self.network_resources(client)
        connection = resources[0]
        await connection._send_lock.acquire()
        try:
            with patch("sendspin_karaoke_source.lifecycle.GOODBYE_SECONDS", 5):
                stopping = asyncio.create_task(disconnect_client(client))
                await asyncio.sleep(0.025)
                self.assertFalse(stopping.done())
                stopping.cancel()
                async with asyncio.timeout(1):
                    with self.assertRaises(asyncio.CancelledError):
                        await stopping
            self.assert_network_closed(client, resources)
        finally:
            connection._send_lock.release()

    async def test_expected_force_cleanup_error_does_not_swallow_external_cancellation(self):
        await self.pair_source()
        client = make_client(self.config, self.identity, self.store)
        self.addAsyncCleanup(disconnect_client, client)
        await client.connect(self.config.server_url)
        resources = self.network_resources(client)
        connection = resources[0]
        disconnect = client.disconnect

        async def cancelled_goodbye_error():
            try:
                await disconnect()
            except asyncio.CancelledError:
                raise OSError("cancelled send failed") from None

        client.disconnect = cancelled_goodbye_error
        await connection._send_lock.acquire()
        try:
            stopping = asyncio.create_task(disconnect_client(client))
            await asyncio.sleep(0.025)
            stopping.cancel()
            async with asyncio.timeout(1):
                with self.assertRaises(asyncio.CancelledError):
                    await stopping
            self.assert_network_closed(client, resources)
        finally:
            connection._send_lock.release()

    async def test_public_injected_session_keeps_caller_ownership_but_retires_sdk_tasks(self):
        await self.pair_source()
        session = ClientSession()
        self.addAsyncCleanup(session.close)
        client = SendspinClient(
            self.identity, self.config.name, [Roles.SOURCE], pairing_store=self.store,
            source_support=ClientHelloSourceSupport(), session=session,
        )
        self.addAsyncCleanup(disconnect_client, client)
        await client.connect(self.config.server_url)
        connection, socket, _, tasks = self.network_resources(client)
        await connection._send_lock.acquire()
        try:
            with patch("sendspin_karaoke_source.lifecycle.GOODBYE_SECONDS", 0.025):
                await disconnect_client(client)
            self.assertTrue(socket.closed)
            self.assertTrue(all(task.done() for task in tasks))
            self.assertTrue(connection._closed.is_set())
            self.assertIsNone(client._admitted_connection)
            self.assertFalse(session.closed)
        finally:
            connection._send_lock.release()

    async def test_cancellation_after_sdk_connected_flag_clears_still_joins_tasks_and_closes_socket(self):
        await self.pair_source()
        client = make_client(self.config, self.identity, self.store)
        self.addAsyncCleanup(disconnect_client, client)
        await client.connect(self.config.server_url)
        resources = self.network_resources(client)
        connection = resources[0]
        original_time = connection._time_task
        unwinding = asyncio.Event()
        release = asyncio.Event()

        async def delayed_time_cleanup():
            try:
                await original_time
            finally:
                unwinding.set()
                await release.wait()

        delayed = asyncio.create_task(delayed_time_cleanup())
        connection._time_task = delayed
        try:
            with patch("sendspin_karaoke_source.lifecycle.GOODBYE_SECONDS", 5):
                stopping = asyncio.create_task(disconnect_client(client))
                await unwinding.wait()
                self.assertFalse(connection._connected)
                self.assertFalse(resources[1].closed)
                stopping.cancel()
                async with asyncio.timeout(1):
                    with self.assertRaises(asyncio.CancelledError):
                        await stopping
            self.assert_network_closed(client, resources)
            self.assertTrue(delayed.done())
        finally:
            release.set()
            await asyncio.gather(delayed, return_exceptions=True)

    async def test_retry_boundary_waits_for_stalled_real_sdk_goodbye_cleanup(self):
        await self.pair_source()
        client = make_client(self.config, self.identity, self.store)
        self.addAsyncCleanup(disconnect_client, client)
        connect = client.connect
        resources = None

        async def connect_and_stall(url):
            nonlocal resources
            await connect(url)
            resources = self.network_resources(client)
            await resources[0]._send_lock.acquire()

        async def retry(delay):
            self.assertEqual(delay, 1)
            self.assert_network_closed(client, resources)
            raise asyncio.CancelledError

        client.connect = connect_and_stall
        bridge = SimpleNamespace(
            close=AsyncMock(), failed=asyncio.Event(), failure=CaptureError("retry test"),
        )
        bridge.failed.set()
        try:
            with patch("sendspin_karaoke_source.lifecycle.GOODBYE_SECONDS", 0.025):
                with self.assertRaises(asyncio.CancelledError):
                    await run(
                        self.config, self.identity, self.store, client_factory=lambda *args: client,
                        bridge_factory=lambda *args: bridge, sleep=retry,
                    )
            bridge.close.assert_awaited_once()
        finally:
            if resources is not None:
                resources[0]._send_lock.release()

    async def test_service_cancellation_during_bridge_cleanup_cannot_skip_sdk_teardown(self):
        await self.pair_source()
        client = make_client(self.config, self.identity, self.store)
        self.addAsyncCleanup(disconnect_client, client)
        closing_bridge = asyncio.Event()

        async def close_bridge():
            closing_bridge.set()
            await asyncio.Event().wait()

        bridge = SimpleNamespace(
            close=close_bridge, failed=asyncio.Event(), failure=CaptureError("retry test"),
        )
        retry = AsyncMock()
        running = asyncio.create_task(run(
            self.config, self.identity, self.store, client_factory=lambda *args: client,
            bridge_factory=lambda *args: bridge, sleep=retry,
        ))
        await eventually(lambda: client.connected and client._admitted_connection._time_task is not None)
        resources = self.network_resources(client)
        await resources[0]._send_lock.acquire()
        try:
            bridge.failed.set()
            await closing_bridge.wait()
            with patch("sendspin_karaoke_source.lifecycle.GOODBYE_SECONDS", 0.025):
                running.cancel()
                async with asyncio.timeout(1):
                    with self.assertRaises(asyncio.CancelledError):
                        await running
            self.assert_network_closed(client, resources)
            retry.assert_not_awaited()
        finally:
            resources[0]._send_lock.release()
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)

    async def test_unfinished_sdk_task_is_fatal_and_never_enters_retry(self):
        await self.pair_source()
        client = make_client(self.config, self.identity, self.store)
        self.addAsyncCleanup(disconnect_client, client)
        await client.connect(self.config.server_url)
        connection = client._admitted_connection
        connection._time_task.cancel()
        await asyncio.gather(connection._time_task, return_exceptions=True)
        release = asyncio.Event()

        async def uncooperative_task():
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    pass

        stubborn = asyncio.create_task(uncooperative_task())
        connection._time_task = stubborn
        await asyncio.sleep(0)
        await connection._send_lock.acquire()
        client.connect = AsyncMock()
        bridge = SimpleNamespace(
            close=AsyncMock(), failed=asyncio.Event(), failure=CaptureError("retry test"),
        )
        bridge.failed.set()
        retry = AsyncMock()
        try:
            with patch("sendspin_karaoke_source.lifecycle.GOODBYE_SECONDS", 0.025), \
                 patch("sendspin_karaoke_source.lifecycle.TRANSPORT_CLOSE_SECONDS", 0.025):
                with self.assertRaises(ExceptionGroup) as failure:
                    await run(
                        self.config, self.identity, self.store, client_factory=lambda *args: client,
                        bridge_factory=lambda *args: bridge, sleep=retry,
                    )
            self.assertTrue(any(isinstance(item, DisconnectCleanupError) for item in failure.exception.exceptions))
            retry.assert_not_awaited()
        finally:
            release.set()
            connection._send_lock.release()
            await stubborn

    async def test_static_pin_pair_persist_reconnect_start_pcm_stop_and_fresh_connection(self):
        await self.pair_source()
        reopened = await open_store(self.path)
        client_record = await reopened.record_by_server_id(self.server.id)
        server_record = await self.server_store.record_by_client_id(self.identity.peer_id)
        self.assertIsNotNone(client_record)
        self.assertEqual(client_record.psk, server_record.psk)
        self.assertIsNone(await reopened.static_pin())
        self.assertFalse((await reopened.get_pairing_config()).unpaired_access_enabled)

        inputs = []
        streams = asyncio.Queue()

        def audio_factory(now_us):
            audio = FakeAudio(now_us)
            inputs.append(audio)
            return audio

        for attempt in range(2):
            client = make_client(self.config, load_identity(self.path), reopened)
            bridge = SourceBridge(client, self.config.device, audio_factory)
            try:
                await client.connect(self.config.server_url)
                self.assertTrue(paired(client))
                await eventually(client.is_time_synchronized, timeout=15)
                peer = self.server.get_client(self.identity.peer_id)
                role = peer.role("source@v1")
                self.assertIsNotNone(role)

                def on_event(_client, event):
                    if isinstance(event, SourceStreamStartedEvent):
                        streams.put_nowait(event.handle)

                unsubscribe = peer.add_event_listener(on_event)
                await asyncio.sleep(0.03)
                self.assertEqual(len(inputs), attempt)
                role.request_start()
                async with asyncio.timeout(5):
                    stream = await streams.get()
                await eventually(lambda: len(inputs) == attempt + 1 and inputs[-1].opened)
                pcm = b"\x01\x00\x02\x00" * 1200
                captured_at = client.now_us() - 20_000
                expected = client.compute_server_time(captured_at)
                inputs[-1].queue.put_nowait((pcm, captured_at))
                async with asyncio.timeout(5):
                    decoded, timestamp = await anext(stream)
                self.assertEqual(decoded, pcm)
                self.assertLess(abs(timestamp - expected), 5000)
                self.assertEqual(stream.audio_format.sample_rate, 48000)
                self.assertEqual(stream.audio_format.channels, 2)
                role.request_stop()
                await eventually(lambda: inputs[-1].closed)
                await eventually(lambda: not role.stream_active)
                self.assertFalse(bridge.failed.is_set(), bridge.failure)
                unsubscribe()
            finally:
                await bridge.close()
                await client.disconnect()
        self.assertEqual(len(inputs), 2)

    async def test_unpaired_wire_connection_cannot_open_source(self):
        client = make_client(self.config, self.identity, self.store, pairing=True)
        await pairing_policy(self.store, True)
        inputs = []
        bridge = SourceBridge(client, self.config.device, lambda now: inputs.append(now))
        try:
            await client.connect(self.config.server_url)
            self.assertFalse(paired(client))
            self.assertFalse(inputs)
            peer = self.server.get_client(self.identity.peer_id)
            self.assertTrue(peer is None or peer.role("source@v1") is None)
        finally:
            await bridge.close()
            await client.disconnect()

    async def test_recording_survives_real_paired_stop_and_reconnect_with_shared_clock(self):
        await self.pair_source()
        inputs = []

        def audio_factory(now_us):
            audio = FakeAudio(now_us)
            inputs.append(audio)
            return audio

        owner = SharedCapture(self.config.device, audio_factory)
        recorder = Recorder(owner, self.path)
        self.addAsyncCleanup(owner.close)
        self.addAsyncCleanup(recorder.close)
        await recorder.start("flac")
        expected_pcm = bytearray()

        async def record_block(pcm):
            before = recorder.writer.frames
            timestamp = owner.clock.now_us()
            inputs[0].queue.put_nowait((pcm, timestamp))
            expected_pcm.extend(pcm)
            await eventually(lambda: recorder.writer.frames == before + 1200)
            return timestamp

        await record_block(b"\xe8\x03\xd0\x07" * 1200)
        for _ in range(2):
            streams = asyncio.Queue()
            client = make_client(self.config, self.identity, self.store, clock=owner.clock)
            bridge = SourceBridge(client, self.config.device, owner=owner)
            try:
                await client.connect(self.config.server_url)
                await eventually(client.is_time_synchronized, timeout=15)
                peer = self.server.get_client(self.identity.peer_id)
                role = peer.role("source@v1")

                def on_event(_client, event):
                    if isinstance(event, SourceStreamStartedEvent):
                        streams.put_nowait(event.handle)

                unsubscribe = peer.add_event_listener(on_event)
                role.request_start()
                async with asyncio.timeout(5):
                    stream = await streams.get()
                await eventually(lambda: len(owner.consumers) == 2)
                block = b"\xb8\x0b\xa0\x0f" * 1200
                captured_at = await record_block(block)
                async with asyncio.timeout(5):
                    decoded, timestamp = await anext(stream)
                self.assertEqual(decoded, block)
                self.assertLess(abs(timestamp - client.compute_server_time(captured_at)), 5000)
                role.request_stop()
                await eventually(lambda: bridge.active is None and not role.stream_active)
                self.assertFalse(inputs[0].closed)
                unsubscribe()
            finally:
                await bridge.close()
                await client.disconnect()
            self.assertTrue(recorder.status()["active"])
            await record_block(b"\x88\x13\x70\x17" * 1200)
        await recorder.stop()
        self.assertEqual(len(inputs), 1)
        self.assertTrue(inputs[0].closed)
        with sf.SoundFile(recorder.writer.path) as handle:
            self.assertEqual(handle.frames, 6000)
            self.assertEqual(bytes(handle.buffer_read(handle.frames, dtype="int16")), bytes(expected_pcm))


if __name__ == "__main__":
    unittest.main()
