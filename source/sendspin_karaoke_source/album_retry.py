"""Retry-only display IPC. No arbitrary commands, consent, capture or recording access."""

import asyncio
import json
import logging
import os
import socket
import stat
import struct

from .album_handoff import DIRECTORY
from .config import SourceError
from .control import ControlServer, _object


def decode_retry(raw):
    try:
        value = json.loads(raw, object_pairs_hook=_object)
    except (ValueError, UnicodeError, RecursionError):
        raise SourceError("Invalid retry request.") from None
    import re
    if (len(raw) > 512 or type(value) is not dict
            or set(value) != {"command", "source_id", "boot_id", "generation"}
            or value["command"] != "recognition-retry"
            or type(value["source_id"]) is not str or not re.fullmatch(r"[a-f0-9]{64}", value["source_id"])
            or type(value["boot_id"]) is not str or not re.fullmatch(r"[a-f0-9]{32}", value["boot_id"])
            or type(value["generation"]) is not int or not 0 <= value["generation"] <= 2**53 - 1):
        raise SourceError("Only a source-bound recognition retry is accepted.")
    return value["source_id"], value["boot_id"], value["generation"]


def peer_allowed(sock, source_uid, display_uid):
    _pid, uid, _gid = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    return uid in {0, source_uid, display_uid}


class AlbumRetryServer(ControlServer):
    def __init__(self, recognition, directory=DIRECTORY, parent=None):
        super().__init__(directory, None, recognition)
        self.path = directory / "retry.sock"
        self.display_uid = None
        self.parent = parent

    async def start(self):
        import pwd
        if not hasattr(socket, "SO_PEERCRED"):
            raise SourceError("Album retry requires Linux peer credentials.")
        try:
            self.display_uid = pwd.getpwnam("sendspin-karaoke").pw_uid
        except KeyError:
            pass
        info = self.path.parent.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o2750):
            raise SourceError("Retry IPC requires the source-owned 2750 album directory.")
        if self.path.exists() or self.path.is_symlink():
            old = self.path.lstat()
            if (not stat.S_ISSOCK(old.st_mode) or old.st_uid != os.geteuid()
                    or old.st_gid != info.st_gid or stat.S_IMODE(old.st_mode) != 0o660):
                raise SourceError("Unsafe existing album retry socket.")
            self.path.unlink()
        self.server = await asyncio.start_unix_server(self._accept, path=self.path, limit=512)
        os.chmod(self.path, 0o660)
        created = self.path.lstat()
        self.socket_identity = (created.st_dev, created.st_ino)
        after = self.path.parent.lstat()
        if ((after.st_dev, after.st_ino) != (info.st_dev, info.st_ino)
                or created.st_gid != info.st_gid):
            await self.close()
            raise SourceError("Album retry directory changed.")

    def _finished(self, task):
        super()._finished(task)
        if self.failure is not None:
            logging.getLogger(__name__).error("Album retry handler failed (%s).", type(self.failure).__name__)
            if self.parent is not None:
                self.parent.failure = self.failure
                self.parent.failed.set()

    async def _handle(self, reader, writer):
        try:
            async with asyncio.timeout(3):
                if not peer_allowed(writer.get_extra_info("socket"), os.geteuid(), self.display_uid):
                    raise SourceError("Album retry peer is not authorized.")
                binding = decode_retry(await reader.readuntil(b"\n"))
                await self.recognition.retry(binding)
                writer.write(b'{"ok":true}\n')
                await writer.drain()
        except (SourceError, OSError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
            message = str(error) if isinstance(error, SourceError) else "Album retry unavailable or timed out."
            writer.write(json.dumps({"ok": False, "error": message}).encode() + b"\n")
            try:
                async with asyncio.timeout(1):
                    await writer.drain()
            except (OSError, TimeoutError):
                pass
        finally:
            writer.close()
            try:
                async with asyncio.timeout(1):
                    await writer.wait_closed()
            except (OSError, TimeoutError):
                pass
