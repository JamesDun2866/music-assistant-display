"""Bounded, descriptor-relative access to immutable finalized recordings."""

from collections import OrderedDict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time
import unicodedata

HEX = re.compile(r"[a-f0-9]{64}\Z")
NAME = re.compile(r"(\d{8}T\d{6}\.\d{6}Z)-[a-f0-9]{32}\.(flac|wav)\Z")
MAX_BYTES = 2**32
MAX_METADATA = 8192


class LibraryError(Exception):
    def __init__(self, category):
        super().__init__(category)
        self.category = category


def strict_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate field.")
        value[key] = item
    return value


def parse_json(raw):
    return json.loads(raw, object_pairs_hook=strict_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite number.")))


def text(value, maximum=256, *, label=False):
    if type(value) is not str or len(value) > maximum:
        raise LibraryError("invalid-request")
    value = unicodedata.normalize("NFC", value).strip()
    if (not value or len(value) > maximum
            or any(unicodedata.category(c).startswith("C") for c in value)
            or (label and (any(c in '/\\:*?"<>|' for c in value) or value in {".", ".."}))):
        raise LibraryError("invalid-request")
    return value


def album_metadata(value):
    if type(value) is not dict or set(value) != {"title", "artist", "catalog", "provenance"}:
        raise LibraryError("invalid-request")
    result = {"title": text(value["title"]), "artist": text(value["artist"])}
    catalog = value["catalog"]
    if catalog is not None:
        if type(catalog) is not dict or set(catalog) != {"kind", "id", "country"}:
            raise LibraryError("invalid-request")
        if type(catalog["kind"]) is not str or catalog["kind"] not in {"collection", "track"}:
            raise LibraryError("invalid-request")
        if type(catalog["id"]) is not str or not re.fullmatch(
            r"[1-9][0-9]{0,14}", catalog["id"]
        ):
            raise LibraryError("invalid-request")
        if type(catalog["country"]) is not str or not re.fullmatch(r"[a-z]{2}", catalog["country"]):
            raise LibraryError("invalid-request")
        catalog = dict(catalog)
    provenance = value["provenance"]
    if (type(provenance) is not dict or set(provenance) != {"kind", "revision"}
            or type(provenance["kind"]) is not str or provenance["kind"] not in {"recognition", "correction"}
            or (provenance["revision"] is not None and (
                type(provenance["revision"]) is not str
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", provenance["revision"])
            ))):
        raise LibraryError("invalid-request")
    result.update(catalog=catalog, provenance=dict(provenance))
    return result


def identity(info):
    return info.st_dev, info.st_ino


def fingerprint(info):
    return (*identity(info), info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def regular(info, *, directory=False):
    if (not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077
            or (not directory and info.st_nlink != 1)):
        raise LibraryError("unavailable")


def open_directory(path):
    """Walk every ancestor without following links, retaining no path-based authority."""
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
        raise LibraryError("unavailable")
    path = Path(path).absolute()
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid not in {0, os.geteuid()} or stat.S_IMODE(info.st_mode) & 0o022:
                raise LibraryError("unavailable")
        regular(os.fstat(fd), directory=True)
        return fd
    except BaseException:
        os.close(fd)
        raise


class Download:
    def __init__(self, library, fd, info, record, name):
        self.library, self.fd, self.info = library, fd, info
        self.record, self.name, self.offset = record, name, 0

    def read(self):
        self.library._check_directory()
        self.library._check_final(self.name, self.fd)
        if fingerprint(os.fstat(self.fd)) != fingerprint(self.info):
            raise LibraryError("conflict")
        block = os.read(self.fd, min(65536, self.info.st_size - self.offset))
        self.offset += len(block)
        if fingerprint(os.fstat(self.fd)) != fingerprint(self.info):
            raise LibraryError("conflict")
        if not block and self.offset != self.info.st_size:
            raise LibraryError("conflict")
        return block

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class RecordingLibrary:
    def __init__(self, state_dir, source_id, *, clock=time.monotonic):
        self.path = Path(state_dir) / "recordings"
        self.metadata_path = Path(state_dir) / "recording-metadata"
        self.source_id, self.clock = source_id, clock
        self.directory = None
        self.directory_identity = None
        self.scans = OrderedDict()

    def _open(self):
        if self.directory is None:
            try:
                self.directory = open_directory(self.path)
            except FileNotFoundError:
                return False
            self.directory_identity = identity(os.fstat(self.directory))
        self._check_directory()
        return True

    def _check_directory(self):
        check = open_directory(self.path)
        try:
            if identity(os.fstat(check)) != self.directory_identity:
                raise LibraryError("unavailable")
        finally:
            os.close(check)

    def _check_final(self, name, fd):
        info = os.fstat(fd)
        regular(info)
        if not 0 < info.st_size <= MAX_BYTES:
            raise LibraryError("unavailable")
        current = os.stat(name, dir_fd=self.directory, follow_symlinks=False)
        if fingerprint(current) != fingerprint(info):
            raise LibraryError("conflict")
        try:
            os.stat(name + ".partial", dir_fd=self.directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise LibraryError("conflict")
        return info

    @contextmanager
    def _file(self, name):
        self._check_directory()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.directory)
        try:
            yield fd, self._check_final(name, fd)
        finally:
            os.close(fd)

    def _id(self, name):
        match = NAME.fullmatch(name)
        if match is None:
            raise LibraryError("not-found")
        stamp = datetime.strptime(match[1], "%Y%m%dT%H%M%S.%fZ")
        elapsed = stamp - datetime(1, 1, 1)
        micros = (elapsed.days * 86400 + elapsed.seconds) * 1_000_000 + elapsed.microseconds
        nonce = bytes.fromhex(name.split("-", 1)[1].rsplit(".", 1)[0])
        payload = micros.to_bytes(8, "big") + nonce + bytes([match[2] == "flac"])
        binding = hashlib.sha256(self.source_id.encode() + payload).digest()[:7]
        return (payload + binding).hex()

    def _name(self, record_id):
        # Self-resolving IDs do not expire when a bounded listing cache evicts
        # entries. They are not authorization: every open still validates the
        # source peer, directory, final file and full file/metadata revision.
        encoded = bytes.fromhex(record_id)
        payload, binding = encoded[:25], encoded[25:]
        expected = hashlib.sha256(self.source_id.encode() + payload).digest()[:7]
        if not hmac.compare_digest(binding, expected) or payload[24] not in (0, 1):
            raise LibraryError("not-found")
        try:
            stamp = datetime(1, 1, 1) + timedelta(microseconds=int.from_bytes(payload[:8], "big"))
        except OverflowError:
            raise LibraryError("not-found") from None
        date = f"{stamp.year:04d}{stamp.month:02d}{stamp.day:02d}T{stamp.hour:02d}{stamp.minute:02d}{stamp.second:02d}.{stamp.microsecond:06d}Z"
        return f"{date}-{payload[8:24].hex()}.{'flac' if payload[24] else 'wav'}"

    @contextmanager
    def _metadata_directory(self, *, create=False):
        parent = open_directory(self.path.parent)
        try:
            if create:
                try:
                    os.mkdir("recording-metadata", 0o700, dir_fd=parent)
                except FileExistsError:
                    pass
            fd = os.open("recording-metadata", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                regular(os.fstat(fd), directory=True)
                yield fd
                check = open_directory(self.metadata_path)
                try:
                    if identity(os.fstat(check)) != identity(os.fstat(fd)):
                        raise LibraryError("unavailable")
                finally:
                    os.close(check)
            finally:
                os.close(fd)
        finally:
            os.close(parent)

    def _metadata(self, record_id, info):
        empty = {"version": 1, "file": list(fingerprint(info)), "label": None, "album": None}
        try:
            with self._metadata_directory() as directory:
                fd = os.open(record_id + ".json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    regular(os.fstat(fd))
                    raw = os.read(fd, MAX_METADATA + 1)
                    if len(raw) > MAX_METADATA:
                        raise LibraryError("unavailable")
                    value = parse_json(raw)
                finally:
                    os.close(fd)
        except FileNotFoundError:
            return empty
        except (ValueError, UnicodeError, RecursionError):
            raise LibraryError("unavailable") from None
        if (type(value) is not dict or set(value) != {"version", "file", "label", "album"}
                or type(value["version"]) is not int or value["version"] != 1
                or type(value["file"]) is not list or len(value["file"]) != 5
                or any(type(item) is not int or item < 0 for item in value["file"])):
            raise LibraryError("unavailable")
        try:
            if value["label"] is not None:
                value["label"] = text(value["label"], 120, label=True)
            if value["album"] is not None:
                value["album"] = album_metadata(value["album"])
        except LibraryError:
            raise LibraryError("unavailable") from None
        return value if value["file"] == empty["file"] else empty

    def _record(self, name, info, metadata=None):
        match = NAME.fullmatch(name)
        if match is None:
            raise LibraryError("not-found")
        try:
            completed = datetime.strptime(match[1], "%Y%m%dT%H%M%S.%fZ").replace(tzinfo=timezone.utc)
        except ValueError:
            raise LibraryError("not-found") from None
        record_id = self._id(name)
        metadata = self._metadata(record_id, info) if metadata is None else metadata
        revision = hashlib.sha256(json.dumps(
            [record_id, fingerprint(info), metadata], sort_keys=True, separators=(",", ":")
        ).encode()).hexdigest()
        album = metadata["album"]
        return {"id": record_id, "revision": revision, "label": metadata["label"] or name.rsplit(".", 1)[0],
                "format": match[2], "bytes": info.st_size,
                "completedAt": completed.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "album": None if album is None else {k: album[k] for k in ("title", "artist")}}

    def _expire(self):
        for key, scan in tuple(self.scans.items()):
            if self.clock() - scan["created"] > 60:
                self.scans.pop(key)["iterator"].close()

    def list(self, cursor=None, limit=50):
        if type(limit) is not int or not 1 <= limit <= 50:
            raise LibraryError("invalid-request")
        if cursor is not None and (type(cursor) is not str or not HEX.fullmatch(cursor)):
            raise LibraryError("invalid-request")
        self._expire()
        if not self._open():
            if cursor is not None:
                raise LibraryError("restart-needed")
            return {"version": 1, "items": [], "nextCursor": None}
        if cursor is not None:
            scan = self.scans.pop(cursor, None)
            if scan is None:
                raise LibraryError("restart-needed")
            if scan["directory"] != fingerprint(os.fstat(self.directory)):
                scan["iterator"].close()
                raise LibraryError("restart-needed")
        else:
            if len(self.scans) >= 8:
                raise LibraryError("busy")
            scan_fd = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.directory)
            try:
                iterator = os.scandir(scan_fd)
            finally:
                os.close(scan_fd)
            scan = {"iterator": iterator, "created": self.clock(),
                    "directory": fingerprint(os.fstat(self.directory))}
        items, exhausted = [], False
        try:
            for _ in range(256):
                try:
                    entry = next(scan["iterator"])
                except StopIteration:
                    exhausted = True
                    break
                if NAME.fullmatch(entry.name) is None:
                    continue
                try:
                    with self._file(entry.name) as (_, info):
                        record = self._record(entry.name, info)
                except (OSError, LibraryError):
                    continue
                items.append(record)
                if len(items) == limit:
                    break
            if scan["directory"] != fingerprint(os.fstat(self.directory)):
                raise LibraryError("restart-needed")
            self._check_directory()
        except BaseException:
            scan["iterator"].close()
            raise
        next_cursor = None
        if exhausted:
            scan["iterator"].close()
        else:
            next_cursor = secrets.token_hex(32)
            self.scans[next_cursor] = scan
        return {"version": 1, "items": items, "nextCursor": next_cursor}

    def _resolve(self, record_id, revision):
        if (type(record_id) is not str or not HEX.fullmatch(record_id)
                or type(revision) is not str or not HEX.fullmatch(revision)):
            raise LibraryError("invalid-request")
        if not self._open():
            raise LibraryError("not-found")
        return self._name(record_id)

    def update(self, record_id, revision, *, label=None, album=None):
        name = self._resolve(record_id, revision)
        with self._file(name) as (audio_fd, info):
            metadata = self._metadata(record_id, info)
            if self._record(name, info, metadata)["revision"] != revision:
                raise LibraryError("conflict")
            if label is not None:
                metadata["label"] = text(label, 120, label=True)
            if album is not None:
                metadata["album"] = album_metadata(album)
            raw = json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode()
            if len(raw) > MAX_METADATA:
                raise LibraryError("invalid-request")
            with self._metadata_directory(create=True) as directory:
                pending = record_id + "." + secrets.token_hex(16) + ".next"
                fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                try:
                    with os.fdopen(fd, "wb") as handle:
                        handle.write(raw)
                        handle.flush()
                        os.fsync(handle.fileno())
                    if fingerprint(self._check_final(name, audio_fd)) != fingerprint(info):
                        raise LibraryError("conflict")
                    self._check_directory()
                    os.replace(pending, record_id + ".json", src_dir_fd=directory, dst_dir_fd=directory)
                    os.fsync(directory)
                finally:
                    try:
                        os.unlink(pending, dir_fd=directory)
                    except FileNotFoundError:
                        pass
            return self._record(name, info, metadata)

    def download(self, record_id, revision):
        name = self._resolve(record_id, revision)
        self._check_directory()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.directory)
        try:
            info = self._check_final(name, fd)
            record = self._record(name, info)
            if record["revision"] != revision:
                raise LibraryError("conflict")
            return Download(self, fd, info, record, name)
        except BaseException:
            os.close(fd)
            raise

    def close(self):
        for scan in self.scans.values():
            scan["iterator"].close()
        self.scans.clear()
        if self.directory is not None:
            os.close(self.directory)
            self.directory = None
