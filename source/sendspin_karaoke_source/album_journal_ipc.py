"""Source-bound journal IPC; never exposes the private database or control API."""

import asyncio
import json
import os
import re

from .album_handoff import DIRECTORY
from .album_journal import MAX_INT, MAX_PAYLOAD, STORAGE_ERROR, encode
from .album_retry import AlbumRetryServer, peer_allowed
from .config import SourceError
from .control import _object

MAX_REQUEST = 1024
MAX_CLIENTS = 4


def decode_journal(raw):
    try:
        if len(raw) > MAX_REQUEST:
            raise ValueError()
        value = json.loads(raw, object_pairs_hook=_object)
        if type(value) is not dict:
            raise ValueError()
        command = value.get("command")
        fields = {"command", "source_id"}
        if command == "journal-page":
            fields |= {"epoch", "after", "limit"}
        elif command == "journal-clear":
            fields |= {"epoch", "revision", "confirm"}
        elif command != "journal-head":
            raise ValueError()
        if (set(value) != fields or type(value["source_id"]) is not str
                or not re.fullmatch(r"[a-f0-9]{64}", value["source_id"])):
            raise ValueError()
        if command != "journal-head" and (type(value["epoch"]) is not str
                or not re.fullmatch(r"[a-f0-9]{32}", value["epoch"])):
            raise ValueError()
        for name in ("after", "revision"):
            if name in value and (type(value[name]) is not int or not 0 <= value[name] <= MAX_INT):
                raise ValueError()
        if command == "journal-page" and (
                type(value["limit"]) is not int or not 1 <= value["limit"] <= 100):
            raise ValueError()
        if command == "journal-clear" and value["confirm"] is not True:
            raise ValueError()
        return value
    except (ValueError, UnicodeError, RecursionError, TypeError):
        raise SourceError("Invalid journal request.") from None


class AlbumJournalServer(AlbumRetryServer):
    def __init__(self, recognition, directory=DIRECTORY, parent=None):
        super().__init__(recognition, directory, parent)
        self.path = directory / "journal.sock"

    def _accept(self, reader, writer):
        if self.closing or len(self.handlers) >= MAX_CLIENTS:
            writer.write(b'{"ok":false,"error":"Journal busy."}\n')
            writer.close()
            return
        task = asyncio.create_task(self._handle(reader, writer))
        self.handlers.add(task)
        task.add_done_callback(self._finished)

    def _finished(self, task):
        self.handlers.discard(task)
        if not task.cancelled() and task.exception() is not None:
            if self.recognition.journal is not None:
                self.recognition.journal.fail()

    async def _handle(self, reader, writer):
        try:
            try:
                async with asyncio.timeout(3):
                    if not peer_allowed(writer.get_extra_info("socket"), os.geteuid(), self.display_uid):
                        raise SourceError("Journal peer is not authorized.")
                    request = decode_journal(await reader.readuntil(b"\n"))
                    if self.recognition.journal is None:
                        raise SourceError(STORAGE_ERROR)
                    response = await self.recognition.journal.request(request)
                    raw = encode(response) + b"\n"
                    if len(raw) > MAX_PAYLOAD:
                        raise SourceError("Journal response too large.")
            except (SourceError, OSError, TimeoutError, asyncio.IncompleteReadError,
                    asyncio.LimitOverrunError) as error:
                reason = str(error) if isinstance(error, SourceError) else "Journal unavailable or timed out."
                raw = encode({"ok": False, "error": reason}) + b"\n"
                if len(raw) > 1024:
                    raw = encode({"ok": False, "error": STORAGE_ERROR}) + b"\n"
            writer.write(raw)
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
