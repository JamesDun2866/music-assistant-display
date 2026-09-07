"""Private identity, single-process ownership and the SDK's atomic pairing store."""

import json
import os
import stat
from contextlib import contextmanager
from pathlib import Path

from aiosendspin.noise.keys import Identity, b64url_decode, b64url_encode
from aiosendspin.noise.trust_store import FileClientPairingStore

from .config import SourceError


def check_private(path: Path, *, directory=False):
    if path.is_symlink():
        raise SourceError("State must not contain symbolic links.")
    if not path.exists():
        return
    info = path.stat()
    if (directory and not stat.S_ISDIR(info.st_mode)) or (
        not directory and not stat.S_ISREG(info.st_mode)
    ):
        raise SourceError("State paths must be ordinary private directories/files.")
    if os.name == "posix" and (
        info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077
    ):
        raise SourceError("State must belong to this user with directory mode 0700/files 0600.")


@contextmanager
def locked_state(path: Path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    check_private(path, directory=True)
    for name in ("identity.json", "identity.json.next", "pairing.json", "pairing.json.tmp", "lock"):
        check_private(path / name)
    fd = os.open(path / "lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        try:
            if os.name == "posix":
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                import msvcrt
                os.write(fd, b"\0")
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            raise SourceError("State is in use. Stop the source service before pairing/running manually.") from None
        yield
    finally:
        os.close(fd)


def load_identity(state_dir: Path) -> Identity:
    path = state_dir / "identity.json"
    check_private(path)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return Identity.from_private_bytes(b64url_decode(data["private_key_b64u"]))
        except (ValueError, KeyError, TypeError):
            raise SourceError("Identity is corrupt; restore its private backup, or explicitly reset and re-pair.") from None
    if (state_dir / "pairing.json").exists():
        raise SourceError("Identity is missing but pairings exist; restore the matching identity backup.")
    identity = Identity.generate()
    pending = path.with_suffix(".json.next")
    check_private(pending)
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"private_key_b64u": b64url_encode(identity.private_bytes)}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        pending.replace(path)
    finally:
        pending.unlink(missing_ok=True)
    return identity


async def open_store(state_dir: Path):
    check_private(state_dir / "pairing.json")
    check_private(state_dir / "pairing.json.tmp")
    try:
        return await FileClientPairingStore.open(state_dir / "pairing.json")
    except (ValueError, KeyError, TypeError):
        raise SourceError("Pairing state is corrupt; restore its private backup or explicitly re-pair.") from None
