"""Private, single-request Unix-socket control; no filenames or network API."""

import asyncio
import json
import logging
import os
import stat

from .config import SourceError
from .recording import validate_options
from .state import check_private

LOG = logging.getLogger(__name__)
SOCKET_NAME = "record-control.sock"
MAX_MESSAGE = 1024
REQUEST_SECONDS = 12.0
MAX_CLIENTS = 8


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate key")
        result[key] = value
    return result


def decode(data):
    if len(data) > MAX_MESSAGE:
        raise SourceError("Recording control message is too large.")
    try:
        message = json.loads(data, object_pairs_hook=_object)
    except (ValueError, UnicodeError, RecursionError):
        raise SourceError("Recording control requires one valid JSON object.") from None
    if type(message) is not dict or type(message.get("command")) is not str:
        raise SourceError("Recording control requires a command object.")
    command = message["command"]
    allowed = ({"command", "format", "silence_dbfs"} if command == "record-start"
               else {"command", "silence_dbfs"} if command == "recognition-enable" else {"command"})
    if command not in ("record-start", "record-stop", "record-status", "recognition-enable",
                       "recognition-disable", "recognition-status", "recognition-retry") or set(message) - allowed:
        raise SourceError("Unsupported recording command or fields; paths/filenames are not accepted.")
    if command == "record-start":
        validate_options(message.get("format", "flac"), message.get("silence_dbfs", -45.0))
    if command == "recognition-enable":
        validate_options("flac", message.get("silence_dbfs", -45.0))
    return message


def check_socket(path):
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise SourceError("Recording socket must be a private socket owned by the service user.")


class ControlServer:
    def __init__(self, state_dir, recorder, recognition=None):
        self.path = state_dir / SOCKET_NAME
        self.recorder = recorder
        self.recognition = recognition
        self.server = None
        self.handlers = set()
        self.failed = asyncio.Event()
        self.failure = None
        self.socket_identity = None
        self.closing = False
        self.album_retry = None

    async def start(self):
        self.closing = False
        if os.name != "posix":
            raise SourceError("Recording service control requires Linux/Unix AF_UNIX sockets.")
        check_private(self.path.parent, directory=True)
        # The caller holds locked_state for the entire service lifetime. A private
        # leftover socket can only be from its previous process, never another owner.
        if self.path.exists() or self.path.is_symlink():
            check_socket(self.path)
            self.path.unlink()
        self.server = await asyncio.start_unix_server(
            self._accept, path=self.path, limit=MAX_MESSAGE,
        )
        os.chmod(self.path, 0o600)
        info = self.path.lstat()
        self.socket_identity = (info.st_dev, info.st_ino)
        if self.recognition is not None:
            from .album_retry import AlbumRetryServer
            self.album_retry = AlbumRetryServer(self.recognition, parent=self)
            try:
                await self.album_retry.start()
            except (SourceError, OSError) as error:
                LOG.warning("Album retry socket unavailable (%s); update the source installation.",
                            type(error).__name__)

    def _accept(self, reader, writer):
        if self.closing or len(self.handlers) >= MAX_CLIENTS:
            writer.write(b'{"ok":false,"error":"Recording control is busy."}\n')
            writer.close()
            return
        task = asyncio.create_task(self._handle(reader, writer))
        self.handlers.add(task)
        task.add_done_callback(self._finished)

    def _finished(self, task):
        self.handlers.discard(task)
        if not task.cancelled() and task.exception() is not None:
            self.failure = task.exception()
            self.failed.set()

    async def _handle(self, reader, writer):
        recognition_command = False
        try:
            try:
                async with asyncio.timeout(2):
                    data = await reader.readuntil(b"\n")
                request = decode(data)
                recognition_command = request["command"].startswith("recognition-")
                async with asyncio.timeout(REQUEST_SECONDS - 2):
                    command = request["command"]
                    if command.startswith("recognition-"):
                        if self.recognition is None:
                            raise SourceError("Recognition is unavailable.")
                        if command == "recognition-enable":
                            status = await self.recognition.enable(request.get("silence_dbfs", -45.0))
                        elif command == "recognition-disable":
                            status = await self.recognition.disable()
                        elif command == "recognition-retry":
                            status = await self.recognition.retry()
                        else:
                            status = self.recognition.status()
                    elif command == "record-start":
                        status = await self.recorder.start(
                            request.get("format", "flac"), request.get("silence_dbfs", -45.0),
                        )
                    elif command == "record-stop":
                        status = await self.recorder.stop()
                    else:
                        status = self.recorder.status()
                response = {"ok": True, "recognition" if command.startswith("recognition-") else "recording": status}
            except (SourceError, OSError, TimeoutError, asyncio.LimitOverrunError,
                    asyncio.IncompleteReadError) as error:
                field = "recognition" if recognition_command else "recording"
                component = self.recognition if recognition_command else self.recorder
                status_command = "recognition-status" if recognition_command else "record-status"
                response = {
                    "ok": False,
                    "error": str(error) if isinstance(error, SourceError)
                    else f"Source control I/O failed or timed out; inspect {status_command}.",
                    field: component.status() if component is not None else {},
                }
            writer.write(json.dumps(response, allow_nan=False).encode() + b"\n")
            async with asyncio.timeout(1):
                await writer.drain()
        except (OSError, TimeoutError):
            LOG.warning("Recording control client disconnected before receiving its result.")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Programming errors must fail the service, not become successful replies.
            self.failure = error
            self.failed.set()
        finally:
            writer.close()
            try:
                async with asyncio.timeout(1):
                    await writer.wait_closed()
            except (OSError, TimeoutError):
                pass

    async def close(self):
        self.closing = True
        if self.album_retry is not None:
            await self.album_retry.close()
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
        for task in tuple(self.handlers):
            task.cancel()
        await asyncio.gather(*self.handlers, return_exceptions=True)
        if self.socket_identity is not None and self.path.exists():
            info = self.path.lstat()
            if (info.st_dev, info.st_ino) == self.socket_identity:
                self.path.unlink()


async def request(config):
    if os.name != "posix":
        raise SourceError("Recording control requires Linux/Unix AF_UNIX sockets.")
    check_private(config.state_dir, directory=True)
    path = config.state_dir / SOCKET_NAME
    message = {"command": config.command}
    if config.command == "record-start":
        message.update(format=config.format, silence_dbfs=config.silence_dbfs)
    if config.command == "recognition-enable":
        message.update(silence_dbfs=config.silence_dbfs)
    writer = None
    field = "recognition" if config.command.startswith("recognition-") else "recording"
    try:
        check_socket(path)
        async with asyncio.timeout(REQUEST_SECONDS):
            reader, writer = await asyncio.open_unix_connection(path, limit=8192)
            writer.write(json.dumps(message, allow_nan=False).encode() + b"\n")
            await writer.drain()
            raw = await reader.readuntil(b"\n")
            try:
                response = json.loads(raw)
            except (ValueError, UnicodeError, RecursionError):
                raise SourceError("Invalid response from recording service.") from None
            if type(response) is not dict or type(response.get("ok")) is not bool:
                raise SourceError("Invalid response from recording service.")
            if not response["ok"]:
                raise SourceError(
                    f"{response.get('error', 'Recording request failed.')} "
                    f"Status: {json.dumps(response.get(field, {}))}"
                )
            if type(response.get(field)) is not dict:
                raise SourceError("Invalid recording status from service.")
            return response[field]
    except (OSError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        if field == "recognition":
            raise SourceError(
                "Recognition service unavailable or timed out. Run as its user with the same --state-dir; "
                "check recognition-status. A timed-out enable may have enabled recognition."
            ) from None
        raise SourceError(
            "Recording service unavailable or timed out. Run as its user with the same --state-dir; "
            "check service status. A timed-out command may have started recording: use record-status."
        ) from None
    finally:
        if writer is not None:
            writer.close()
            try:
                async with asyncio.timeout(1):
                    await writer.wait_closed()
            except (OSError, TimeoutError):
                pass
