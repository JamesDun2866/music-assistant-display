# Security and data handling

This is a **local, single-user TV appliance**, not an Internet-facing server.
The service accepts loopback binds only (`127.0.0.1` or `::1`), verifies the HTTP
Host and Origin, and rejects cross-site requests. Never bypass these checks to
expose the kiosk to a LAN. For administration from another computer use an SSH
tunnel: `ssh -L 8787:127.0.0.1:8787 your-user@your-pi`, then browse
`http://127.0.0.1:8787`. SSH authentication is the remote access boundary.

Local processes/users are trusted. Browser commands additionally require an
HttpOnly SameSite=Strict session cookie and an HMAC-derived CSRF header. The
cookie deliberately has no Secure flag because the loopback kiosk uses HTTP.
There is no CORS allowance. A same-origin script compromise would bypass CSRF;
the restrictive CSP, React text escaping, schema validation and locally built
assets are additional defenses. Do not load untrusted extensions in the kiosk
Chromium profile.

The Music Assistant token is read by the backend only, never serialized to the
browser or included in URLs, logs or error responses. Provision a dedicated MA
account/token with the necessary read permissions; no MA play, group, seek,
volume or power commands are issued by this application. Demo playback controls
only affect the local simulator. Prefer TLS for MA traffic on an untrusted
network, with a trusted certificate; certificate verification is never disabled.
Unencrypted MA WebSocket traffic is readable by a network observer.

## Optional USB audio source

The separately installed [UCA222 source service](uca222-source.md) is an
explicit exception to the display's no-audio role: it captures the selected
stereo input and sends audio to its paired Sendspin server when that server
requests playback. Treat pairing as authorization for the MA server to
request capture, not merely permission to show a device name. Do not connect
a microphone or other sensitive source unintentionally.

It uses its own service account, audio-device access, configuration and
private pairing state, not the display's MA token or browser. Protect
`/var/lib/sendspin-karaoke-source` and its backups as credentials. Do not share
pairing PINs or copy an identity to another concurrently running device.
Pair only with your intended MA server on a trusted network. The ordinary
display installer does not enable this service; stop and disable
`sendspin-karaoke-source.service` to prevent future capture requests.

Captured samples are not saved by default. Explicit local recording commands
can start capture immediately, independently of MA playback or connectivity,
and save FLAC/WAV files under the private
`/var/lib/sendspin-karaoke-source/recordings` directory. Five seconds of
continuous below-threshold audio stops recording; it does not rearm itself,
stop MA playback, or guarantee a stop if surface noise exceeds the threshold.
Stopping playback in MA is therefore not a recording-stop command. Use the
local recording stop control or stop the source service to end local capture.

Recording controls use a private Unix socket in the source state directory,
not the display browser or a LAN HTTP endpoint. Run them as the source service
account; do not make the state directory or socket accessible to everyone.
Keep recordings and backups private, including files marked incomplete after
an error. Export individual completed audio files rather than sharing the
whole state directory with its pairing credentials. Recording is off after a
service restart and is never enabled by installation or ordinary MA playback.

Sending audio to MA still makes it available to MA and the selected
downstream players; their retention, access and transport security are
separate from this Pi service. No audio is uploaded for lyrics.

### Optional ShazamIO album identification

Recognition is separately opt-in and requires the optional source dependency
extra. Fresh installations start disabled; an explicit enable/disable choice
and silence threshold are remembered in private source settings. A restart
can therefore resume previously authorized recognition, but never a recording.
Enabling it observes
input already captured for MA playback or an explicit recording; it does not
open the input on its own. Do not enable it on an input carrying sensitive
audio. It processes a bounded 12-second sample in an isolated local worker,
then sends an audio-derived fingerprint/signature to Shazam over HTTPS.
The recognition request is not a raw PCM/WAV or full recording upload, but it
still discloses recognizable information about the audio and the network's
public IP to an external service. It is not offline or anonymous recognition.

The provider transport allows one automatic recognition POST to `amp.shazam.com`
per session and refuses redirects and transport retries. A deliberate
**Retry identification** action permits one additional fresh-sample attempt;
accepted retries are at least 15 seconds apart and cannot overlap an attempt.
Five seconds of silence
or a new capture context can permit a new session; this is not a monthly quota
or a guarantee of one request per vinyl. ShazamIO is unofficial; open-source
licensing does not establish authorization under the service's terms or
guarantee continued no-charge access. No paid API credentials are installed.

Only bounded album title, detected artist and approved artwork metadata leave
the worker. Lyrics and other provider fields are discarded. A private-group,
read-only snapshot at `/run/sendspin-karaoke-album/album.json` lets the display
read this minimal context without access to the source's identity, recordings
or general recording/control socket. The display binds to the configured source public-identity
hash and numeric service UID, validates file ownership/schema, and expires old
snapshots. Do not relax the source state directory's permissions to enable it.

The separate `/run/sendspin-karaoke-album/retry.sock` accepts only a retry
request, not enable/disable, recording or pairing commands. Its mode is 0660
inside the source-owned 2750 directory. Linux peer credentials restrict callers
to root, the source account or the installed display account. The request must
match the source identity and live boot/generation; disabled, inactive, stale
or busy requests are rejected. The browser reaches this through a loopback-only,
session/CSRF-protected POST. Retry does not grant consent or open audio capture.

When the Line-in album view requests current artwork, the display server may
fetch an approved HTTPS thumbnail from `is1-ssl.mzstatic.com` through
`is5-ssl.mzstatic.com`. This discloses the requested artwork and public IP to
Apple's CDN. URLs, DNS destinations, response sizes, image decoding and
album identity are checked; redirects are refused, and the browser receives only
a local image route. This opt-in is separate from Spotify Connect artwork.
Disabling recognition stops new identification but retains the cached album;
it does not stop listening or recording. Expiring live status never presents
the cached album as a fresh recognition result.
The album view can also request the exact matched album's public catalog
tracklist from `https://itunes.apple.com/lookup`. A validated collection
reference needs one GET; a track reference needs up to two GETs to resolve
its collection first. This is a metadata lookup, not another audio-recognition
request or an upload of audio. It discloses the catalog identifier, storefront
and public IP to Apple; no credentials, private recordings, previews or lyrics
are sent. Complete bounded results are reused per album identity; failed or
interrupted lookups can recover on a new session or successful explicit
recognition retry, not repeated display polling.

The source stores the last identified album in private `last-album.json`
(at most 4 KiB). The display stores the bound source ID/UID, album metadata,
processed JPEG and resolved tracklist in `STATE_DIR/line-in-album/last-album.json`
(at most 1 MiB, including a JPEG up to 256 KiB and at most 200 tracks).
Files are owner-only (0600), atomically replaced, and validated on restore.
Already cached artwork and complete tracklists can be displayed after reboot
without downloading them again. This retains a record of the last identified
album, not audio, raw provider responses, lyrics or an album history. Include
this metadata when considering the privacy of service-state backups.

## Display data and controls

Spotify Connect cover downloads are separately opt-in with
`MA_ALLOW_SPOTIFY_ARTWORK=true`; absent/false keeps artwork requests restricted
to MA. This permits only HTTPS `i.scdn.co/image/<40-hex-id>` URLs from MA-reported
Spotify sources, never arbitrary image URLs, URL credentials, ports, queries,
redirects or additional hosts. Spotify's image service sees your public IP and
the cover requested. No MA token, cookies or referrer is sent, and the browser
receives only a local image route. Downloads retain the bounded raster handling
and in-memory cache used for MA artwork. This flag does not change library
refresh permissions or resolve missing lyric identities.

Persistent state contains display/Ambient preferences, uploaded image copies,
a bounded local lyrics cache and, when configured, the last identified line-in album.
Lyrics may be copyrighted; this project ships only original synthetic examples.
Enable only providers you are entitled to use, follow provider terms, do not
redistribute the cache, and protect backups like personal media metadata. Cache
files and settings use owner-only modes; the install directory has no secrets.

Browser TV control is disabled by default, accepts only an enumerated command set,
requires local browser authorization, and is rate-limited. The CEC worker never
uses a shell to interpolate user input. No automated TV standby is performed.
An enabled adapter can still exhibit TV-specific CEC quirks; review
[CEC](cec.md) before connecting it.

Native remote input is separately opt-in (`CEC_REMOTE_ENABLED`) and also requires
the master CEC flag and non-demo mode. A fixed, isolated stdlib Python worker
owns the exact kernel character device with no shell, credentials, injected
loaders, root privileges, monitor capabilities or broad input-device access.
Normal exclusive-follower mode retains kernel core replies; RC passthrough is
disabled to prevent duplicate kernel keyboard actions. Only directed allowlisted
keys from TV/AVR addresses become navigation. HDMI participants are not
cryptographically authenticated: an untrusted device on the same CEC bus can
impersonate a source address. This is a trusted local appliance, not an
authorization mechanism for sensitive actions.

The native owner may acknowledge only a valid received TV-origin broadcast
Set Stream Path matching its exact verified physical address. This allowlisted
Active Source reply is solicited by the bus, not the browser, and sends no extra
wake. Neither startup, reconnect, generic routing nor Request Active Source
authorizes it. Single-owner receive ordering, registration revalidation,
monotonic deduplication and bounded transmit-result tracking prevent deferred
route takeovers or retries. A malicious bus participant can still spoof TV
logical 0; vendor routing/power side effects cannot be ruled out.

Remote events never appear as actionable snapshot history. CSRF-protected POST
registration ties one live input stream to a session, per-page UUID and random
epoch; competing tabs receive 409, not a takeover. Renewals expire after 30
seconds, and disconnect/transport loss releases the lease. Sequence validation,
bounded buffers and short event expiry prevent duplicate or stale replay.
Only the explicit `?kiosk=1` UI auto-registers; ordinary admin/tunnel tabs do not.
Loopback does **not** identify the physical display: a trusted tunnel user can
deliberately select the kiosk role and acquire a vacant lease. No production
endpoint accepts injected remote keys. State exposes only allowed-key/time and
transport/lease diagnostics plus one allowlisted last-routing/result record,
never a full bus dump. Transmission success does not establish TV ownership.

Kernel logical-address configuration survives process death. The listener refuses
an already configured adapter rather than assuming an OSD name proves ownership
or silently clearing another client's registration. Forced termination may need
the documented operator recovery. Explicit actions are never replayed after
reconnect, and standby remains unsupported despite persistent adapter ownership.

Boundaries include a 4 KiB HTTP JSON limit, bounded SSE clients/backpressure,
bounded upstream WebSocket payloads and RPC lifetimes, bounded lyrics and cache,
and bounded CEC subprocess output/runtime. Logs contain fixed event names and
operational codes, not raw upstream exceptions. The systemd unit bounds journal
rate and restarts failed processes. `/healthz` reports HTTP process liveness;
`/readyz` returns 503 until a fresh target queue has been read (or the explicit
demo has started). Readiness does not assert that a provider has lyrics, HDMI is
connected, or that a TV is on.

## Private Ambient image library

Image uploads and deletions use the same loopback/Host/Origin/cross-site checks,
session cookie and CSRF token as settings. Upload authorization and work limits
are checked before buffering the image. There is no external image URL import.
Only JPEG/PNG are accepted, with a 12 MiB byte limit, 32 million decoded-pixel
limit, 16,384-pixel axis limit, and rejection of animated/multipage inputs.
Signatures and declared MIME types are not considered proof of a valid image:
the maintained Sharp decoder must successfully decode/re-encode it.

One upload is admitted at a time before body listeners are attached. Compressed
PNG text/profile chunks are removed before native parsing, and ancillary
orientation data and chunk bookkeeping are bounded. Native decoding runs in a
separate process with disabled libvips cache and one worker thread: Sharp's
processing limit is 8 seconds, the hard process deadline is 10 seconds, and the
whole upload has a 15-second abort deadline. The decoder's 96 MiB V8 heap limit
is **not** a native/RSS memory cap; the systemd service's 512 MiB cgroup covers
the backend and decoder child together. Already-running filesystem writes are
not forcibly interrupted mid-commit.

Accepted inputs are auto-oriented, resized within 3840x2160 without enlargement, flattened and
re-encoded as JPEG without source EXIF/GPS/embedded metadata. Uploaded SVG/HTML
and other formats cannot execute as web content. Bundled backgrounds are
individually rights-cleared CC0 photographs, acquired from the photographer-linked
source files and canonically re-encoded; see [provenance](background-credits.md).
They are same-origin local JPEGs. There is no runtime photo feed, external
thumbnail request, arbitrary URL fetch, redirect following, or new SSRF surface.
The repository's code license is never used as evidence of third-party photo rights.

Storage uses generated IDs, not source filenames, under `STATE_DIR/ambient`.
Library metadata is schema-validated and atomically replaced through serialized
mutations. Image routes only serve known library IDs and fixed canonical types,
with CSP/nosniff/same-origin response protections; the state directory is never
mounted as a static web root. Symlinks are rejected. Quotas bound both the number
of uploads (40) and total canonical-plus-thumbnail stored bytes (128 MiB).
Raising the display dimensions does not raise the 12 MiB input, 32-million-pixel
source or 8 MiB canonical-output budgets.
Upload previews are generated lazily with the same isolated decoder and a
480x270 / 256 KiB output cap. Concurrent requests for one ID share the work;
different preview decodes are serialized with at most 40 pending IDs. There is
also only **one active native worker across uploads and previews together**,
so generating a preview cannot double the service's native-decoder concurrency.
An upload's existing abort deadline still applies while waiting; cancelled
queued work is skipped. There is no startup decode sweep. Optional v1 derivative metadata and files participate
in quota accounting, atomic persistence and deletion recovery. Failed previews
remain explicit placeholders rather than loading full-size images in the grid.

An image's sanitized filename may remain as its display title. Neither metadata
stripping nor deletion can remove visible personal details, copies already
downloaded by a trusted browser, or previous backups. Treat pictures and titles
as private, and back up state only to protected storage. Only selected uploaded
images may be deleted; the UI asks for confirmation. Deleting an image filters
it out of any saved selection, without resetting unrelated preferences.
