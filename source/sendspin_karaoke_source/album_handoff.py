"""Narrow public metadata handoff, deliberately outside the private source identity."""

import json
import os
from pathlib import Path
import stat
import uuid

DIRECTORY = Path("/run/sendspin-karaoke-album")
MAX_SNAPSHOT = 4096


def write_snapshot(snapshot, directory=DIRECTORY):
    data = json.dumps(snapshot, ensure_ascii=False, allow_nan=False).encode()
    if len(data) > MAX_SNAPSHOT:
        raise ValueError("Album snapshot exceeds limit")
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o2750):
        raise PermissionError("Album handoff requires source-owned setgid 2750 directory")
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    name = f".album-{uuid.uuid4().hex}"
    try:
        current = os.fstat(fd)
        if (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino):
            raise PermissionError("Album handoff directory changed")
        out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                      0o640, dir_fd=fd)
        try:
            os.fchmod(out, 0o640)
            with os.fdopen(out, "wb", closefd=False) as stream:
                stream.write(data)
                stream.flush()
            os.replace(name, "album.json", src_dir_fd=fd, dst_dir_fd=fd)
        finally:
            os.close(out)
    finally:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.close(fd)
