"""Optional Shazam adapter. Imported only inside the isolated recognition process."""

import asyncio
import io
import json
import os
import re
import sys
import wave
from urllib.parse import urlsplit
from .album_catalog import catalog_reference

MAX_RESPONSE = 512 * 1024
MAX_PCM = 12 * 48000 * 2 * 2
ARTWORK = re.compile(
    r"https://is[1-5]-ssl\.mzstatic\.com/image/thumb/"
    r"[A-Za-z0-9_./-]{1,800}/[1-9][0-9]{1,3}x[1-9][0-9]{1,3}(?:bb|cc)\.(?:jpg|png)"
)


def text(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 256:
        return None
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        return None
    return value.strip()


def album_fields(raw):
    """Export only album presentation fields and an exact, bounded catalog reference."""
    if type(raw) is not dict or type(raw.get("track")) is not dict:
        return None
    track = raw["track"]
    sections = track.get("sections", [])
    if type(sections) is not list or len(sections) > 32:
        return None
    title = None
    for section in sections:
        if type(section) is not dict or section.get("type") != "SONG":
            continue
        metadata = section.get("metadata", [])
        if type(metadata) is not list or len(metadata) > 32:
            return None
        for entry in metadata:
            if type(entry) is dict and entry.get("title") == "Album":
                candidate = text(entry.get("text"))
                if title is not None and candidate != title:
                    return None
                title = candidate
    artist = text(track.get("subtitle"))
    if not title or not artist:
        return None
    images = track.get("images")
    artwork = images.get("coverart") if type(images) is dict else None
    if not isinstance(artwork, str) or not ARTWORK.fullmatch(artwork) or ".." in artwork:
        artwork = None
    return {"title": title, "artist": artist, "artwork": artwork, "catalog": catalog_reference(track)}


class SingleRequestClient:
    """ShazamIO defaults to 20 retries. This transport permits exactly one POST."""

    def __init__(self, session):
        self.session = session
        self.used = False

    async def request(self, method, url, *args, **kwargs):
        parsed = urlsplit(url)
        if (self.used or method != "POST" or parsed.scheme != "https"
                or parsed.hostname != "amp.shazam.com" or parsed.port is not None
                or parsed.username or parsed.password or parsed.fragment
                or not parsed.path.startswith("/discovery/")):
            raise ValueError("Unexpected recognition request")
        self.used = True
        kwargs.pop("proxy", None)
        async with self.session.post(url, allow_redirects=False, **kwargs) as response:
            if response.status != 200:
                raise ValueError("Recognition unavailable")
            data = bytearray()
            async for chunk in response.content.iter_chunked(16384):
                data.extend(chunk)
                if len(data) > MAX_RESPONSE:
                    raise ValueError("Recognition response too large")
            return json.loads(data)


async def recognize(pcm):
    import aiohttp
    from shazamio import Shazam

    # Core 1.1.2 decodes WAV in Rodio, then UniformSourceIterator produces 16kHz mono.
    audio = io.BytesIO()
    with wave.open(audio, "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(48000)
        output.writeframes(pcm)
    async with aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=20), trust_env=False,
    ) as session:
        provider = Shazam(language="en-US", http_client=SingleRequestClient(session),
                          segment_duration_seconds=12)
        return album_fields(await provider.recognize(audio.getvalue()))


def main():
    if os.name == "posix":
        import resource
        os.nice(10)
        resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
    # Hard bounds also cover malformed input if this private module is invoked directly.
    pcm = sys.stdin.buffer.read(MAX_PCM + 1)
    if len(pcm) != MAX_PCM:
        return 2
    try:
        album = asyncio.run(recognize(pcm))
    except Exception as error:
        # Provider/native/network errors are isolated; never log response bodies/audio.
        sys.stdout.write(json.dumps({"error": type(error).__name__}))
        return 1
    sys.stdout.buffer.write(json.dumps({"album": album}, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
