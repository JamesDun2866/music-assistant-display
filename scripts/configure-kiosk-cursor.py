#!/usr/bin/python3
"""Opt-in native startup cursor hiding for the managed labwc kiosk."""
import argparse
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from xml.parsers import expat

APP_ID = "sendspin-karaoke-kiosk"
BEGIN = b"<!-- BEGIN sendspin-karaoke startup cursor -->"
END = b"<!-- END sendspin-karaoke startup cursor -->"
BLOCK = (
    BEGIN + b"\n<windowRules>\n"
    b'  <windowRule identifier="sendspin-karaoke-kiosk" event="onFirstMap">\n'
    b'    <action name="HideCursor" />\n'
    b"  </windowRule>\n</windowRules>\n" + END + b"\n"
)


def transform(data, enable):
    data.decode("utf-8")  # Byte offsets below require UTF-8, not UTF-16 XML.
    if data.count(BEGIN) != data.count(END) or data.count(BEGIN) > 1:
        raise ValueError("Malformed or duplicate managed cursor markers; repair rc.xml manually.")
    managed_start = None
    if BEGIN in data:
        managed_start = data.index(BEGIN)
        if data[managed_start:managed_start + len(BLOCK)] != BLOCK:
            raise ValueError("Managed cursor block was edited; preserve/reconcile it manually.")

    parser = expat.ParserCreate("UTF-8")
    stack = []
    root_end = None
    identifier = []
    markers = []

    def unsupported(*_args):
        raise ValueError("DTD/entity declarations are not supported; rc.xml was not changed.")

    def managed_position():
        return managed_start is not None and managed_start <= parser.CurrentByteIndex < managed_start + len(BLOCK)

    def comment(text):
        if text in (BEGIN[4:-3].decode(), END[4:-3].decode()):
            if len(stack) != 1:
                raise ValueError("Managed cursor markers must be comments directly inside the XML root.")
            markers.append(parser.CurrentByteIndex)

    def start(name, attrs):
        if not stack and name not in ("labwc_config", "openbox_config"):
            raise ValueError("Expected labwc_config or openbox_config XML root.")
        attributes = {key.lower(): value for key, value in attrs.items()}
        if enable and not managed_position() and name.lower() == "windowrule" and attributes.get("identifier", "").lower() == APP_ID:
            raise ValueError("An unmanaged rule already uses the kiosk identifier; reconcile it manually.")
        if name.lower() == "identifier":
            identifier.clear()
        stack.append(name)

    def end(_name):
        nonlocal root_end
        if enable and not managed_position() and len(stack) >= 2 and [value.lower() for value in stack[-2:]] == ["windowrule", "identifier"]:
            if "".join(identifier).strip().lower() == APP_ID:
                raise ValueError("An unmanaged rule already uses the kiosk identifier; reconcile it manually.")
        if len(stack) == 1:
            root_end = parser.CurrentByteIndex
        stack.pop()

    def characters(text):
        if stack and stack[-1].lower() == "identifier":
            identifier.append(text)

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = characters
    parser.CommentHandler = comment
    parser.StartDoctypeDeclHandler = unsupported
    parser.EntityDeclHandler = unsupported
    parser.ExternalEntityRefHandler = unsupported
    parser.Parse(data, True)
    if root_end is None or data[root_end:root_end + 2] != b"</":
        raise ValueError("Use an explicit closing root tag in rc.xml before enabling this rule.")
    if managed_start is not None:
        expected = [managed_start, managed_start + len(BLOCK) - len(END) - 1]
        if markers != expected:
            raise ValueError("Cursor markers are not an active root-level XML block; rc.xml was not changed.")
        data = data[:managed_start] + data[managed_start + len(BLOCK):]
        root_end -= len(BLOCK)
    if not enable:
        return data
    # labwc appends rules from each windowRules section. Inserting a separate
    # section preserves every byte of existing rules, comments and formatting.
    return data[:root_end] + BLOCK + data[root_end:]


def check_versions():
    for package, minimum in (("labwc", "0.9.7"), ("chromium", "152")):
        result = subprocess.run(
            ["/usr/bin/dpkg-query", "-W", "-f=${db:Status-Status}\t${Version}", package],
            capture_output=True, text=True, check=True, timeout=10,
        )
        status, version = result.stdout.strip().split("\t", 1)
        # Ignore the Debian epoch so Chromium 1:older is not mistaken for >=152.
        version = version.split(":")[-1]
        compared = subprocess.run(
            ["/usr/bin/dpkg", "--compare-versions", version, "ge", minimum],
            check=False, timeout=10,
        )
        if status != "installed" or compared.returncode != 0:
            raise ValueError(f"Installed {package} >= {minimum} is required for this verified workaround.")


def check_session_config():
    # Read only labwc's own argv; the stock Pi wrapper launches it with -m.
    # Never print command lines or inspect browser arguments.
    modes = set()
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if entry.stat().st_uid != os.getuid() or (entry / "comm").read_text().strip() != "labwc":
                continue
            args = (entry / "cmdline").read_bytes().split(b"\0")
        except (FileNotFoundError, ProcessLookupError):
            continue
        if any(arg in (b"-c", b"-C", b"--config", b"--config-dir") or arg.startswith(
            (b"--config=", b"--config-dir=", b"-C", b"-c")) for arg in args[1:]):
            raise ValueError("Custom labwc config paths are unsupported; use the XDG per-user rc.xml.")
        modes.add(any(arg in (b"-m", b"--merge-config") for arg in args[1:]))
    if len(modes) > 1:
        raise ValueError("Desktop sessions disagree on labwc merge mode; close the extra session before setup.")
    return next(iter(modes), None)


def configure(config_home, config_dirs, enable, merge_config=False):
    folder = config_home / "labwc"
    target = folder / "rc.xml"
    backup = folder / "rc.xml.before-sendspin-karaoke-cursor"
    if folder.is_symlink() or target.is_symlink() or backup.is_symlink():
        raise ValueError("Refusing a symlinked labwc directory, rc.xml or cursor backup.")
    if backup.exists() and not backup.is_file():
        raise ValueError("The cursor backup path must be a regular file.")
    if enable and merge_config:
        # These files remain active in merged mode. Validate possible duplicate
        # kiosk rules, but never copy or modify the system configuration layers.
        for directory in config_dirs:
            source = directory / "labwc" / "rc.xml"
            if source.resolve() == target.resolve():
                raise ValueError("User rc.xml also appears in XDG_CONFIG_DIRS; reconcile the duplicate search path.")
            if not source.is_file():
                continue
            layer = source.read_bytes()
            if BEGIN in layer or END in layer:
                raise ValueError("A system config layer already contains cursor markers; reconcile it manually.")
            transform(layer, True)
    existed = target.exists()
    if existed:
        original = target.read_bytes()
        mode = stat.S_IMODE(target.stat().st_mode)
    elif not enable:
        return False
    else:
        inherited = None if merge_config else next(
            (directory / "labwc" / "rc.xml" for directory in config_dirs
             if (directory / "labwc" / "rc.xml").is_file()), None)
        original = inherited.read_bytes() if inherited else b"<labwc_config>\n</labwc_config>\n"
        mode = 0o600
    updated = transform(original, enable)
    if updated == original:
        return False
    folder.mkdir(parents=True, exist_ok=True)
    if not backup.exists():
        with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
            output.write(original)
    fd, temporary = tempfile.mkstemp(prefix=".rc.xml.cursor-", dir=folder)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(updated)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        if target.is_symlink() or (existed and target.read_bytes() != original) or (not existed and target.exists()):
            raise ValueError("rc.xml changed during setup; retry after other editors finish.")
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--enable", action="store_true")
    actions.add_argument("--remove", action="store_true")
    enable = parser.parse_args().enable
    if sys.platform != "linux" or os.geteuid() == 0:
        raise ValueError("Run on the Pi as the desktop user WITHOUT sudo.")
    merge_config = check_session_config()
    if enable:
        if merge_config is None:
            raise ValueError("No running labwc desktop found; enable while the desktop session is active.")
        check_versions()
        launcher = Path("/opt/sendspin-karaoke/current/kiosk.sh").read_text()
        if f"--class={APP_ID}" not in launcher:
            raise ValueError("Upgrade/install the managed kiosk launcher before enabling this rule.")
    home = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    directories = [Path(value) for value in (os.environ.get("XDG_CONFIG_DIRS") or "/etc/xdg").split(":") if value]
    if not home.is_absolute() or any(not directory.is_absolute() for directory in directories):
        raise ValueError("XDG configuration directories must be absolute paths.")
    changed = configure(home, directories, enable, merge_config=merge_config is True)
    print("Kiosk startup cursor rule " + ("enabled" if enable else "removed") +
          ("." if changed else " (already configured)."))
    if merge_config:
        print("labwc merge mode: system layers retained; only the user rc.xml was edited.")
    print("Reboot once when ready: labwc must reload config before a fresh managed kiosk process starts.")
    print("No reboot, browser restart, input injection or CEC action was performed.")
    if enable:
        print("Tradeoff: hides the seat cursor on kiosk startup; mouse activity restores desktop visibility.")
    else:
        print("An already-hidden cursor returns on mouse activity or the next desktop session.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, expat.ExpatError, subprocess.SubprocessError) as error:
        print(f"Cursor setup failed: {error}", file=sys.stderr)
        sys.exit(1)
