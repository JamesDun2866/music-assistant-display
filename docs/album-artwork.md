# Full-resolution album artwork

## MusicBrainz and Cover Art Archive fallback

When the original Apple lookup cannot supply a complete catalog edition,
MusicBrainz can supply an exact release and Cover Art Archive (CAA) can supply
that release's front cover. This is a separate provider path; it does not broaden
the original Apple artwork allowlist. Automatic catalog resolution requires
accepted exact Apple release-URL relationship evidence and a complete tracklist;
text-only matches remain candidates for explicit preview and confirmation.
The catalog edition is not verification of a physical pressing.

The correction dialog lets users choose Apple or MusicBrainz, compare country,
date, format and disambiguation, and preview the exact release's complete ordered
tracklist (up to 200 tracks, including multiple discs) alongside its own cover.
A missing or failed selected cover stays unavailable: the original cover is not
borrowed, and a different edition's art is not substituted. The browser displays
local sanitized artwork URLs, not direct third-party images.

Line-in and Vinyl details expose the exact MusicBrainz release and its CAA cover
page. Provenance retains the CAA release ID, image ID and source URL separately
from catalog evidence. Automatically resolved catalog editions are not manual
corrections; the original recognized title and artist remain visible and can be
restored. See [journal and editions](journal-and-editions.md) for selection,
restore, metadata-only retry and recording-projection behavior.

Metadata lookup sends artist/album text, never audio; no API keys are needed.
**Retry album metadata** uses the cached binding even when audio retry is
unavailable, respects displayed rate-limit deadlines, and does not start recording
or recognition. Cached candidates are not an invitation to guess an edition.

[MusicBrainz data licensing](https://musicbrainz.org/doc/About/Data_License)
distinguishes core CC0 data from supplementary CC BY-NC-SA data.
[Cover Art Archive rights](https://musicbrainz.org/doc/Cover_Art_Archive)
are separate: images retain individual copyrights, not a blanket CC0 license.
Caching an image does not grant redistribution rights.

## Full-cover decoding

Line-in album artwork and confirmed edition covers use a separate full-cover
decoder, shared by the existing local Library, Vinyl and Line-in views. This
changes the actual image pixels, not CSS scaling. Images fit inside 1200 by
1200 pixels with their aspect ratio intact; smaller source images are never
upscaled. A source that only contains a small image cannot gain missing detail.

Only the existing validated `https://is[1-5]-ssl.mzstatic.com/image/thumb/...`
Apple artwork URLs are enlarged. The final size suffix becomes
`1200x1200bb.jpg` (or PNG); `bb` avoids requesting a cropped square. Already
large `bb` URLs are retained. Credentials, ports, queries, fragments,
path traversal and arbitrary hosts remain rejected. Downloads use the existing
public-address DNS checks and reject redirects rather than following them.
Exact Apple collection lookups still require a complete, validated tracklist.

## Resource limits

| Resource | Bound |
| --- | --- |
| Download/input | 12 MiB, JPEG or PNG only |
| Input raster | 32 million pixels, at most 16,384 pixels per dimension; one frame |
| Full-cover output | 1200 by 1200 bounding box, JPEG quality 85, at most 2 MiB |
| Decode work | One shared native worker across covers, Ambient and thumbnails; cache disabled, one native thread, 96 MiB V8 heap |
| Deadline | 10 seconds per decoder process (8-second native timeout); 12 seconds total for original cover work, 15 seconds for edition work |
| Private record | 3 MiB including base64, metadata and complete tracklist |
| Pending edition previews | At most 24 tokens and 8 MiB total encoded cover data, five-minute expiry |

The V8 heap bound is not a whole-process RSS limit; compressed input, raster
limits and worker serialization also bound native decoding work. Private
directories remain mode 0700 and records mode 0600 on Unix, with the existing
owner/link checks and atomic publication.

Journal artwork remains a separate 480 by 270 bounding-box thumbnail (a square
is at most 270 pixels), capped at 256 KiB. Its 256 MiB artwork cache and immutable
original recognition history are unchanged. Ambient full images and previews
retain their existing presets.

## Existing caches and offline operation

The optional `coverVersion: 1` fingerprint marks artwork processed by the new
pipeline. Existing album-memory v1/v2 and edition v1 records without that field
remain readable, including the old 100/270-pixel images. No eager deletion or
bulk rewrite is performed.

When the same remembered album is enabled and active, a legacy original cover
is served immediately while one shared background fetch/decode attempts an
upgrade. Confirmed legacy corrections similarly upgrade their selected cover
in the background, without searching for or selecting a different edition.
Failures retain the old image and correction on disk. Retries start at five
minutes and back off to one hour, with bounded in-memory bookkeeping, rather
than retrying on every status poll. A service restart permits a fresh attempt.
Inactive/disabled/offline source state never authorizes new network work.

Successful upgrades persist the fingerprint, including genuinely small source
images, so polling and restarts do not repeatedly fetch completed artwork.
Original image URLs gain a local content-hash query so displays reload changed
pixels. A corrected cover is atomically saved with a higher correction revision;
stale edition confirmations must reopen. The recording context's effective
revision changes with the image's content hash, while its original recognition
context remains unchanged.

Full-resolution decoding itself adds no endpoints, telemetry, recognition
attempts, audio uploads or Python source/handoff version changes. The
MusicBrainz fallback adds the separate metadata retry command described above,
without changing that audio/handoff contract. The provider-independent
`decodeAlbumCover(bytes, contentType, signal?)` export in
`src/server/album-cover.ts` can decode already-fetched bytes; it does not
authorize another provider's URLs or redirects.
