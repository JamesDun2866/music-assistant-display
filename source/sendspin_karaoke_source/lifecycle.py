"""Pinned SDK error translation and explicit, credential-safe cleanup boundaries."""

import asyncio
import logging
from contextlib import contextmanager

from aiohttp import ClientError
from aiosendspin.client import SendspinClient
from aiosendspin.noise.driver import HandshakeAbortedError
from aiosendspin.noise.pairing import PairingError

from .config import CaptureError, PairingRequired

LOG = logging.getLogger(__name__)
TRANSPORT_ERRORS = (ClientError, OSError, TimeoutError, HandshakeAbortedError)
EXPECTED_ERRORS = (*TRANSPORT_ERRORS, CaptureError, PairingError, PairingRequired)
GOODBYE_SECONDS = 2.0
TRANSPORT_CLOSE_SECONDS = 2.0


class DisconnectCleanupError(RuntimeError):
    """Terminal: old network resources could not be retired; never reconnect."""


class _SdkResources:
    """Isolated aiosendspin 9.1.1 fallback for its non-finally/idempotent teardown.

    Public session injection cannot join connection tasks, and closing an injected
    session would also violate its caller's ownership. Keep SDK-owned sessions and
    connection handles captured before disconnect can clear them or set connected
    false. This service only creates SDK-owned sessions.
    """

    def __init__(self, client):
        self.client = client
        self.session = client._session if client._owns_session else None
        self.connections = set()
        self.tasks = set()
        self.sockets = set()
        self.refresh()

    def refresh(self):
        self.connections.update(self.client._provisional_connections)
        if self.client._admitted_connection is not None:
            self.connections.add(self.client._admitted_connection)
        for connection in self.connections:
            self.tasks.update(task for task in (
                connection._time_task, connection._reader_task,
            ) if task is not None)
            if connection._ws is not None:
                self.sockets.add(connection._ws)

    def closed(self):
        return (
            all(task.done() for task in self.tasks)
            and all(socket.closed for socket in self.sockets)
            and (self.session is None or self.session.closed)
        )

    def retired(self):
        return (
            self.closed() and all(connection._closed.is_set() for connection in self.connections)
            and self.client._admitted_connection is None and not self.client._provisional_connections
        )

    async def force_close(self, graceful):
        self.refresh()
        # Reader finally blocks call disconnect themselves. Disable that reentrant
        # path before cancellation; do not rely on repeating SDK disconnect().
        for connection in self.connections:
            connection._connected = False
        tasks = {graceful, *self.tasks}
        for task in tasks:
            if not task.done():
                task.cancel()
        if self.session is not None:
            tasks.add(asyncio.create_task(self.session.close()))
        tasks.update(asyncio.create_task(socket.close()) for socket in self.sockets)
        done, pending = await asyncio.wait(tasks, timeout=TRANSPORT_CLOSE_SECONDS)
        if pending:
            for task in pending:
                task.cancel()
            # No retry is allowed with unresolved cleanup. Reap any cooperative
            # cancellation without turning the deadline into an unbounded gather.
            more_done, pending = await asyncio.wait(pending, timeout=0.1)
            done.update(more_done)
        failures = [
            task.exception() for task in done
            if not task.cancelled() and task.exception() is not None
        ]
        if pending or not self.closed():
            raise DisconnectCleanupError(
                "Sendspin teardown could not finish; stopping without reconnecting."
            )
        for connection in self.connections:
            connection._time_task = None
            connection._reader_task = None
            connection._ws = None
            connection._closed.set()
            self.client.on_connection_closed(connection)
        if self.session is not None and self.client._session is self.session:
            self.client._session = None
        for error in failures:
            LOG.warning("Forced Sendspin teardown operation failed (%s).", error_classes(error))
        _finish_cleanup(failures, primary=None)


async def _disconnect_client(client, interrupted):
    resources = _SdkResources(client) if isinstance(client, SendspinClient) else None
    graceful = asyncio.create_task(sdk_call(client.disconnect))
    force = asyncio.create_task(interrupted.wait())
    try:
        await asyncio.wait((graceful, force), timeout=GOODBYE_SECONDS,
                           return_when=asyncio.FIRST_COMPLETED)
    finally:
        force.cancel()
        await asyncio.gather(force, return_exceptions=True)
    error = None
    if graceful.done():
        if graceful.cancelled():
            error = asyncio.CancelledError()
        else:
            error = graceful.exception()
        if resources is None or resources.retired():
            if error is not None:
                raise error
            return
    LOG.warning("Sendspin graceful shutdown incomplete; forcing transport/session/task cleanup.")
    if resources is None:
        graceful.cancel()
        done, _ = await asyncio.wait((graceful,), timeout=TRANSPORT_CLOSE_SECONDS)
        for task in done:
            if not task.cancelled():
                task.exception()
        raise DisconnectCleanupError("Cannot verify cleanup of a non-SDK client; stopping without reconnecting.")
    await resources.force_close(graceful)
    if error is not None:
        raise error


async def disconnect_client(client):
    """Bound goodbye, finish teardown, then propagate any caller cancellation."""
    interrupted = asyncio.Event()
    cleanup = asyncio.create_task(_disconnect_client(client, interrupted))
    cancelled = None
    while not cleanup.done():
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError as error:
            cancelled = error
            interrupted.set()
        except (Exception, BaseExceptionGroup):
            # Inspect the task below so an operational error cannot replace an
            # already requested cancellation and accidentally enter the retry loop.
            break
    try:
        cleanup.result()
    except (Exception, BaseExceptionGroup) as error:
        if cancelled is None:
            raise
        LOG.warning("Cancelled Sendspin cleanup failed (%s).", error_classes(error))
        _finish_cleanup([error], primary=cancelled)
        raise cancelled
    if cancelled is not None:
        raise cancelled

# aiosendspin 9.1.1 uses RuntimeError for these particular connection states.
# Do not treat arbitrary RuntimeError/ValueError/TypeError as transport failures.
_UNAVAILABLE = {
    "Client is not connected",
    "WebSocket is not connected",
    "Source role is not active",
    "Source stream is not active",
    "Source capture requires a synchronized clock",
    "Connection is busy with an in-band exchange",
    "Timed out waiting for server/hello response",
    "Connection closed or non-text frame while awaiting server/hello",
    "Connection closed or non-text frame while awaiting server/activate",
}


@contextmanager
def sdk_errors():
    try:
        yield
    except RuntimeError as error:
        if str(error) == "Source role requires a paired connection":
            raise PairingRequired("Source admission lost pairing; stop the service and explicitly re-pair.") from None
        if str(error) in _UNAVAILABLE:
            raise CaptureError("Sendspin connection/stream became unavailable; reconnecting without buffered audio.") from None
        raise


async def sdk_call(operation, *args, **kwargs):
    with sdk_errors():
        return await operation(*args, **kwargs)


def error_classes(error):
    if isinstance(error, BaseExceptionGroup):
        return type(error).__name__ + "[" + ",".join(error_classes(item) for item in error.exceptions) + "]"
    return type(error).__name__


def _finish_cleanup(failures, primary):
    if not failures:
        return
    unexpected = any(not isinstance(error, EXPECTED_ERRORS) for error in failures)
    if not unexpected:
        if primary is not None:
            primary.add_note("Expected cleanup failures were logged by class and operation.")
            return
        failures[0].add_note("All expected cleanup failures were logged by class and operation.")
        raise failures[0]
    if primary is not None:
        raise BaseExceptionGroup("Source operation and cleanup failed", [primary, *failures]) from None
    if len(failures) == 1:
        raise failures[0]
    raise ExceptionGroup("Source cleanup failed", failures)


def cleanup_sync(steps, primary=None):
    failures = []
    for context, action in steps:
        try:
            action()
        except EXPECTED_ERRORS as error:
            LOG.warning("Cleanup %s failed (%s).", context, error_classes(error))
            failures.append(error)
        except (Exception, BaseExceptionGroup) as error:
            # Terminal cleanup boundary: never hide or retry a programming error.
            LOG.error("Unexpected cleanup %s failure (%s).", context, error_classes(error))
            failures.append(error)
    _finish_cleanup(failures, primary)


async def cleanup_async(steps, primary=None):
    failures = []
    for context, action in steps:
        try:
            await action()
        except EXPECTED_ERRORS as error:
            LOG.warning("Cleanup %s failed (%s).", context, error_classes(error))
            failures.append(error)
        except (Exception, BaseExceptionGroup) as error:
            LOG.error("Unexpected cleanup %s failure (%s).", context, error_classes(error))
            failures.append(error)
    _finish_cleanup(failures, primary)


async def finish_open(opening, audio):
    try:
        await asyncio.shield(opening)
    except asyncio.CancelledError as cancelled:
        audio.mute()
        await cleanup_async([("pending device open", lambda: opening)], primary=cancelled)
        raise
