"""Explicit configuration and stable ALSA input selection."""

import argparse
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


class SourceError(RuntimeError):
    """An actionable, safe-to-log operational error."""


class PairingRequired(SourceError):
    """The operator must explicitly pair the service identity."""


class CaptureError(SourceError):
    """A recoverable device or admitted source-stream failure."""


DEVICE_PATTERN = re.compile(r"hw:CARD=([A-Za-z_][A-Za-z0-9_-]*),DEV=([0-9]+)")


@dataclass(frozen=True)
class Config:
    command: str
    server_url: str
    device: str
    name: str
    state_dir: Path
    format: str = "flac"
    silence_dbfs: float = -45.0


def parse_args(argv=None) -> Config:
    parser = argparse.ArgumentParser(prog="sendspin-karaoke-source")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("devices", "check-device", "pair", "run", "record-start", "record-stop", "record-status"):
        sub = commands.add_parser(name)
        sub.add_argument("--server-url", default=os.getenv("SOURCE_SERVER_URL", ""))
        sub.add_argument("--device", default=os.getenv("SOURCE_DEVICE", ""))
        sub.add_argument("--name", default=os.getenv("SOURCE_NAME", "UCA222 Line In"))
        sub.add_argument(
            "--state-dir", type=Path,
            default=Path("/var/lib/sendspin-karaoke-source"),
        )
        if name == "record-start":
            sub.add_argument("--format", choices=("flac", "wav"), default="flac")
            sub.add_argument("--silence-dbfs", type=float, default=-45.0)
    args = parser.parse_args(argv)
    if args.command in ("pair", "run"):
        try:
            url = urlsplit(args.server_url)
            valid = (
                url.scheme in ("ws", "wss") and url.hostname
                and url.port != 0 and url.path == "/sendspin"
                and not url.username and not url.password and not url.query and not url.fragment
                and not any(c.isspace() for c in args.server_url)
            )
        except ValueError:
            valid = False
        if not valid:
            parser.error("--server-url must be ws[s]://HOST:PORT/sendspin (no credentials/query)")
        if not args.name.strip() or len(args.name) > 128 or any(ord(c) < 32 for c in args.name):
            parser.error("--name must contain 1-128 printable characters")
    if args.command in ("pair", "run", "record-start", "record-stop", "record-status"):
        if not args.state_dir.is_absolute():
            parser.error("--state-dir must be absolute and match the service identity's state")
    threshold = getattr(args, "silence_dbfs", -45.0)
    if not math.isfinite(threshold) or threshold >= 0:
        parser.error("--silence-dbfs must be finite and negative")
    if args.command in ("run", "check-device") and not DEVICE_PATTERN.fullmatch(args.device):
        parser.error("--device must be an exact hw:CARD=NAME,DEV=N selector from 'devices'")
    return Config(
        args.command, args.server_url, args.device, args.name, args.state_dir,
        getattr(args, "format", "flac"), threshold,
    )


@dataclass(frozen=True)
class InputDevice:
    selector: str
    index: int
    name: str


def input_devices(devices, hostapis, cards: dict[int, str]) -> list[InputDevice]:
    result = []
    for index, device in enumerate(devices):
        match = re.search(r"\(hw:(\d+),(\d+)\)$", device["name"])
        if (
            not match or device["max_input_channels"] < 2
            or hostapis[device["hostapi"]]["name"] != "ALSA"
        ):
            continue
        card, pcm = map(int, match.groups())
        if card in cards:
            result.append(InputDevice(f"hw:CARD={cards[card]},DEV={pcm}", index, device["name"]))
    return result


def alsa_cards(root: Path = Path("/proc/asound")) -> dict[int, str]:
    return {
        int(path.parent.name[4:]): path.read_text().strip()
        for path in root.glob("card[0-9]*/id")
        if path.parent.name[4:].isdigit()
    }


def select_device(selector: str, devices: list[InputDevice]) -> InputDevice:
    matches = [device for device in devices if device.selector == selector]
    if len(matches) != 1:
        reason = "ambiguous" if matches else "not present as a stereo ALSA capture input"
        raise CaptureError(
            f"Selected device is {reason}; run 'devices' as the service user. "
            "Use the exact card-ID selector, not a number, default, playback device or substring."
        )
    return matches[0]
