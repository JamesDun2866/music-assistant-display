"""Narrow Linux peer-authenticated tools ABI, isolated from recording controls."""

import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import struct

from .recording_library import (
    HEX, LibraryError, RecordingLibrary, album_metadata, identity, parse_json, text,
)
from .source_health import worker_call

LOG = logging.getLogger(__name__)
DIRECTORY = Path("/run/sendspin-karaoke-tools")
MAX_REQUEST = 8192
MAX_RESPONSE = 262144
BOOT = re.compile(r"[a-f0-9]{32}\Z")
COMMANDS = {
    "telemetry": set(), "health": set(), "recordings-list": {"cursor", "limit"},
    "recording-label": {"boot_id", "id", "revision", "label"},
    "recording-album": {"boot_id", "id", "revision", "album"},
    "recording-download": {"boot_id", "id", "revision"},
}


def decode_request(raw):
    try:
        if len(raw) > MAX_REQUEST or not raw.endswith(b"\n") or b"\n" in raw[:-1]:
            raise ValueError()
        request = parse_json(raw)
        if type(request) is not dict:
            raise ValueError()
        command = request.get("command")
        if type(command) is not str or command not in COMMANDS:
            raise ValueError()
        required = {"version", "source_id", "command"}
        optional = COMMANDS[command] if command == "recordings-list" else set()
        required |= COMMANDS[command] - optional
        if (not required <= set(request) or set(request) - required - optional
                or type(request["version"]) is not int or request["version"] != 1
                or type(request["source_id"]) is not str or not HEX.fullmatch(request["source_id"])):
            raise ValueError()
        for key, pattern in (("boot_id", BOOT), ("id", HEX), ("revision", HEX), ("cursor", HEX)):
            if key in request and not (key == "cursor" and request[key] is None):
                if type(request[key]) is not str or not pattern.fullmatch(request[key]):
                    raise ValueError()
        if "limit" in request and (type(request["limit"]) is not int or not 1 <= request["limit"] <= 50):
            raise ValueError()
        if "label" in request:
            request["label"] = text(request["label"], 120, label=True)
        if "album" in request:
            request["album"] = album_metadata(request["album"])
        return request
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        raise LibraryError("invalid-request") from None


def peer_allowed(sock, uid, gid):
    if not hasattr(socket, "SO_PEERCRED") or uid is None or gid is None:
        return False
    _, actual_uid, actual_gid = struct.unpack(
        "iII", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    )
    return actual_uid == uid and actual_gid == gid


def runtime_directory(path, group):
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid not in {0, os.geteuid()} or stat.S_IMODE(info.st_mode) & 0o022:
                raise LibraryError("unsafe-socket")
        info = os.fstat(fd)
        if (info.st_uid != os.geteuid() or info.st_gid != group
                or stat.S_IMODE(info.st_mode) != 0o2750):
            raise LibraryError("unsafe-socket")
        return fd
    except BaseException:
        os.close(fd)
        raise


class ToolsServer:
    def __init__(self, state_dir, source_identity, meters, health, *, directory=DIRECTORY,
                 peer_uid=None, peer_gid=None, group_gid=None):
        self.source_id = hashlib.sha256(source_identity.public_bytes).hexdigest()
        self.boot_id = secrets.token_hex(16)
        self.meters, self.health = meters, health
        self.path = Path(directory).absolute() / "tools.sock"
        self.peer_uid, self.peer_gid, self.group_gid = peer_uid, peer_gid, group_gid
        self.library = RecordingLibrary(state_dir, self.source_id)
        self.library_lock = asyncio.Lock()
        self.server = None
        self.directory_fd = None
        self.socket_identity = None
        self.tasks = set()
        self.downloads = 0
        self.controls = 0
        self.disabled = False

    def _credentials(self):
        import grp
        import pwd
        if self.peer_uid is None or self.peer_gid is None:
            account = pwd.getpwnam("sendspin-karaoke")
            self.peer_uid, self.peer_gid = account.pw_uid, account.pw_gid
        if self.group_gid is None:
            self.group_gid = grp.getgrnam("sendspin-karaoke-tools").gr_gid

    def _configured_identity(self):
        # Source identity always comes from the actual paired key, never an
        # environment override. Explicit settings are assertions only.
        for prefix in ("SOURCE_TOOLS_SOURCE", "LINE_IN_ALBUM_SOURCE"):
            source_id, uid = os.environ.get(prefix + "_ID"), os.environ.get(prefix + "_UID")
            if source_id is None and uid is None:
                continue
            if (source_id is None or uid is None or not HEX.fullmatch(source_id)
                    or not re.fullmatch(r"0|[1-9][0-9]{0,9}", uid) or int(uid) > 2**32 - 2):
                raise LibraryError("unavailable")
            if prefix == "SOURCE_TOOLS_SOURCE" and (
                source_id != self.source_id or int(uid) != os.geteuid()
            ):
                raise LibraryError("forbidden")

    async def start(self):
        try:
            if not hasattr(socket, "SO_PEERCRED"):
                raise LibraryError("unavailable")
            self._credentials()
            self._configured_identity()
            self.directory_fd = runtime_directory(self.path.parent, self.group_gid)
            try:
                previous = os.stat("tools.sock", dir_fd=self.directory_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                if (not stat.S_ISSOCK(previous.st_mode) or previous.st_uid != os.geteuid()
                        or previous.st_gid != self.group_gid or stat.S_IMODE(previous.st_mode) != 0o660):
                    raise LibraryError("unsafe-socket")
                os.unlink("tools.sock", dir_fd=self.directory_fd)
            self.server = await asyncio.start_unix_server(
                self._accept, path=f"/proc/self/fd/{self.directory_fd}/tools.sock", limit=MAX_REQUEST
            )
            created = os.stat("tools.sock", dir_fd=self.directory_fd, follow_symlinks=False)
            self.socket_identity = identity(created)
            os.chmod("tools.sock", 0o660, dir_fd=self.directory_fd)
            self._check_socket()
            return True
        except (OSError, KeyError, LibraryError, NotImplementedError):
            self.health.error("unavailable")
            LOG.warning("Source tools unavailable; check the dedicated runtime directory and account installation. Audio is unaffected.")
            await self.close()
            return False
        except Exception:
            self.disabled = True
            self.health.error("unavailable")
            LOG.error("Source tools initialization failed; tools disabled, audio unaffected.")
            await self.close()
            return False

    def _check_socket(self):
        directory = runtime_directory(self.path.parent, self.group_gid)
        try:
            if identity(os.fstat(directory)) != identity(os.fstat(self.directory_fd)):
                raise LibraryError("unsafe-socket")
            info = os.stat("tools.sock", dir_fd=directory, follow_symlinks=False)
            if (identity(info) != self.socket_identity or not stat.S_ISSOCK(info.st_mode)
                    or info.st_uid != os.geteuid() or info.st_gid != self.group_gid
                    or stat.S_IMODE(info.st_mode) != 0o660):
                raise LibraryError("unsafe-socket")
        finally:
            os.close(directory)

    def _accept(self, reader, writer):
        if self.disabled or len(self.tasks) >= 16:
            self.health.error("busy")
            writer.close()
            return
        task = asyncio.create_task(self._handle(reader, writer))
        self.tasks.add(task)
        task.add_done_callback(self._finished)

    def _finished(self, task):
        self.tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            self.disabled = True
            self.health.error("unavailable")
            LOG.error("Source tools handler failed; tools disabled, audio unaffected.")

    async def _send(self, writer, *, data=None, error=None):
        response = {"version": 1, "source_id": self.source_id, "boot_id": self.boot_id,
                    "ok": error is None}
        response["data" if error is None else "error"] = data if error is None else error
        raw = json.dumps(response, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode() + b"\n"
        if len(raw) > MAX_RESPONSE:
            raise LibraryError("unavailable")
        writer.write(raw)
        async with asyncio.timeout(30):
            await writer.drain()

    async def _library_call(self, function, *args, **kwargs):
        if self.library_lock.locked():
            raise LibraryError("busy")
        async with self.library_lock:
            return await worker_call(function, *args, **kwargs)

    async def _handle(self, reader, writer):
        downloading, controlled, headers = False, False, False
        transfer = None
        try:
            async with asyncio.timeout(3):
                self._check_socket()
                if not peer_allowed(writer.get_extra_info("socket"), self.peer_uid, self.peer_gid):
                    raise LibraryError("forbidden")
                request = decode_request(await reader.readuntil(b"\n"))
                if request["source_id"] != self.source_id:
                    raise LibraryError("forbidden")
                if "boot_id" in request and request["boot_id"] != self.boot_id:
                    raise LibraryError("revision-changed")
            command = request["command"]
            if command == "recording-download":
                if self.downloads >= 2:
                    raise LibraryError("busy")
                self.downloads += 1
                downloading = True
                # Retain ownership even if cancellation arrives during open.
                holder = []
                def open_download():
                    item = self.library.download(request["id"], request["revision"])
                    holder.append(item)
                    return item
                try:
                    transfer = await self._library_call(open_download)
                except BaseException:
                    if holder:
                        await worker_call(holder[0].close)
                    raise
                async with asyncio.timeout(7200):
                    await self._send(writer, data={key: transfer.record[key] for key in ("bytes", "format", "label")})
                    headers = True
                    async with asyncio.timeout(30):
                        pending = await worker_call(transfer.read)
                    while pending:
                        async with asyncio.timeout(30):
                            # EOF validation must precede releasing the last
                            # block, so a detected change leaves a short stream.
                            following = await worker_call(transfer.read)
                            writer.write(pending)
                            await writer.drain()
                            pending = following
            else:
                if self.controls >= 8:
                    raise LibraryError("busy")
                self.controls += 1
                controlled = True
                async with asyncio.timeout(30):
                    if command == "telemetry":
                        data = self.meters.snapshot()
                        if self.meters not in self.health.owner.observers:
                            data["state"] = "unavailable"
                            for channel in ("left", "right"):
                                data[channel] = {"rmsDbfs": -60.0, "peakDbfs": -60.0,
                                                 "holdDbfs": -60.0, "possibleClipping": False}
                    elif command == "health":
                        data = self.health.snapshot()
                    elif command == "recordings-list":
                        data = await self._library_call(self.library.list, request.get("cursor"), request.get("limit", 50))
                    else:
                        key = "label" if command == "recording-label" else "album"
                        data = await self._library_call(self.library.update, request["id"], request["revision"], **{key: request[key]})
                    await self._send(writer, data=data)
        except (LibraryError, OSError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
            category = error.category if isinstance(error, LibraryError) else (
                "timeout" if isinstance(error, TimeoutError) else "unavailable"
            )
            category = {"conflict": "revision-changed", "unauthorized": "forbidden"}.get(category, category)
            self.health.error(category)
            if not headers:
                try:
                    await self._send(writer, error=category)
                except (OSError, TimeoutError):
                    pass
        finally:
            if transfer is not None:
                await worker_call(transfer.close)
            if downloading:
                self.downloads -= 1
            if controlled:
                self.controls -= 1
            writer.close()
            try:
                async with asyncio.timeout(1):
                    await writer.wait_closed()
            except (OSError, TimeoutError):
                pass

    async def close(self):
        server, self.server = self.server, None
        if server is not None:
            server.close()
        for task in tuple(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if server is not None:
            await server.wait_closed()
        await worker_call(self.library.close)
        if self.directory_fd is not None:
            try:
                info = os.stat("tools.sock", dir_fd=self.directory_fd, follow_symlinks=False)
                if identity(info) == self.socket_identity:
                    os.unlink("tools.sock", dir_fd=self.directory_fd)
            except FileNotFoundError:
                pass
            except OSError:
                self.health.error("unavailable")
                LOG.warning("Source tools socket cleanup unavailable; audio unaffected.")
            finally:
                os.close(self.directory_fd)
                self.directory_fd = None
