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

Persistent state contains display/Ambient preferences, uploaded image copies
and a bounded local lyrics cache.
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
