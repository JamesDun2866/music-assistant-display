"""Only the last safe album identity is durable; live recognition is never restored."""

import re

from .album_catalog import valid_reference
from .album_provider import ARTWORK, text
from .config import SourceError
from .recognition_settings import RecognitionSettings, read_settings, write_settings
from .state import check_private

NAME = "last-album.json"
MAX_BYTES = 4096
PENDING = ".last-album.next"


def cleanup(directory):
    check_private(directory, directory=True)
    pending = directory / PENDING
    check_private(pending)
    if pending.exists():
        info = pending.stat()
        if info.st_size > MAX_BYTES or info.st_nlink != 1:
            raise SourceError("Unsafe pending album cache.")
        pending.unlink()


def read_album(directory, _cancelled):
    cleanup(directory)
    return read_settings(directory, NAME, MAX_BYTES, validate)


def write_album(directory, value, cancelled):
    cleanup(directory)
    write_settings(directory, value, cancelled, NAME, MAX_BYTES, validate, PENDING)


def validate(value):
    if (type(value) is dict and type(value.get("version")) is int and value["version"] == 1
            and set(value) == {"version", "source_id", "key", "album"}):
        value = {**value, "version": 2, "success": None}
    if (type(value) is not dict or set(value) != {"version", "source_id", "key", "album", "success"}
            or type(value["version"]) is not int or value["version"] != 2
            or type(value["source_id"]) is not str or not re.fullmatch(r"[a-f0-9]{64}", value["source_id"])
            or type(value["key"]) is not str or not re.fullmatch(r"[a-f0-9]{32}-[0-9]{1,16}", value["key"])):
        raise SourceError("Invalid last-album cache.")
    album = value["album"]
    if (type(album) is not dict or set(album) != {"title", "artist", "artwork", "catalog"}
            or not text(album["title"]) or not text(album["artist"])
            or not valid_reference(album["catalog"])
            or (album["artwork"] is not None and (
                type(album["artwork"]) is not str or not ARTWORK.fullmatch(album["artwork"])
                or ".." in album["artwork"]))):
        raise SourceError("Invalid cached album metadata.")
    success = value["success"]
    if success is not None and (
            type(success) is not dict or set(success) != {"at_ms", "boot_id", "generation"}
            or type(success["boot_id"]) is not str or not re.fullmatch(r"[a-f0-9]{32}", success["boot_id"])
            or any(type(success[field]) is not int or not 0 <= success[field] <= 2**53 - 1
                   for field in ("at_ms", "generation"))):
        raise SourceError("Invalid cached recognition success.")
    return value


class AlbumMemory(RecognitionSettings):
    async def load(self):
        return await self._run(read_album, self.directory)

    async def save_album(self, source_id, key, album, success=None):
        value = {"version": 2, "source_id": source_id, "key": key, "album": album, "success": success}
        await self._run(write_album, self.directory, value)
