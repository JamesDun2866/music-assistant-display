# Source tools: meters, completed recordings and health

Open **Tools** in the local display, or administer through an SSH tunnel:

```sh
ssh -L 8787:127.0.0.1:8787 your-user@your-pi
```

Browse `http://127.0.0.1:8787`. Do not expose the HTTP service to the LAN or
change its loopback/Host/Origin checks. Tools do not start playback, open the
audio device, start or rearm recording, or change recognition consent.

## Install and configure

Install source **0.6.0** and the matching display from the same public `main`
checkout using the existing [source upgrade](uca222-source.md#operation-updates-and-recovery)
and [display upgrade](upgrading.md) procedures. Keep `--with-recognition` if
you use recognition. The source installer does not restart or enable either
service; explicitly restart the source after installation and restart/update
the display to load the new code and group membership. Do not interrupt an
active recording.

Tools use the complete existing `LINE_IN_ALBUM_SOURCE_ID` and
`LINE_IN_ALBUM_SOURCE_UID` pair by default. Existing album users do not need
to duplicate their configuration. To use tools without album identification,
set both independent values in the protected display environment file:

```text
SOURCE_TOOLS_SOURCE_ID=REPLACE_WITH_64_LOWERCASE_HEX_SOURCE_ID
SOURCE_TOOLS_SOURCE_UID=REPLACE_WITH_NUMERIC_SOURCE_UID
```

Use the source public-identity hash reported by the service-user
`recognition-status` command (recognition need not be enabled), and the UID
from `id -u sendspin-karaoke-source`. Never copy the private identity file into
the display account. Explicit tools values override the album pair; partial
or invalid pairs reject startup rather than silently choosing another source.
If both complete pairs identify different sources, tools remain independent,
but attaching that album to a recording is rejected.

The installers create a dedicated `sendspin-karaoke-tools` group and a
source-owned `/run/sendspin-karaoke-tools` directory with mode 2750.
Its `tools.sock` has mode 0660 and authenticates the installed display
account with Linux peer credentials. This is a separate version-1 protocol;
album handoff v3 and the retry-only socket retain their existing meanings.
Do not grant the display access to the source's 0700 state directory,
recordings directory, or private `record-control.sock`.

## Stereo input meters

Meters passively observe blocks already captured for streaming or an explicit
CLI recording. No active consumer means **Input inactive**, not a new capture.
Recognition can be disabled; its last album and refresh timing do not affect
the meters.

The left/right bars show approximately 300 ms smoothed RMS and sample peak,
with a peak hold of about 1.5 seconds, on a **-60 to 0 dBFS** scale. Digital
silence has a finite -60 dBFS display floor. These are VU-style average-level
meters, **not calibrated studio VU or true-peak meters**.

**Possible input clipping** means repeated full-scale digital samples were
observed. It is a conservative warning, not a guarantee that all analogue or
upstream distortion can be detected. Lower the source's level where suitable;
the display does not adjust any hardware, MA or recording gain.

Updates are bounded at about 15 per second. Multiple meter components share
one browser poller; hidden/unmounted views stop polling. Inactive, stale and
offline states clear old bars instead of displaying a frozen "live" level.
Reduced motion disables visual transitions. No raw audio is sent to the
browser or any external service for metering.

## Completed recordings

The library lists only stable final source-created FLAC/WAV files. Active,
incomplete, symlinked, replaced or otherwise unsafe files are not downloadable
as completed recordings. Large directories are scanned incrementally with
bounded pages; follow the continuation control when more entries remain.
Existing CLI recording commands and file naming continue to work unchanged.

**Rename changes the display and download label only.** Original filenames and
audio bytes are not changed. Labels are stored in private source-owned metadata
sidecars. A changed file or stale library revision requires refreshing before
editing or downloading.

**Attach album** previews the effective album, including a confirmed edition
correction where present, and requires explicit
confirmation. It binds the selected recording revision to that exact source
and album context, rejecting a context that changed during confirmation.
An identified album is not proof of what the recording contains. No song is
guessed, no track split is made, and no audio tags are rewritten. Metadata
sidecars stay on the Pi; **downloaded FLAC/WAV audio remains unchanged**.
The remembered album can be selected after capture stops or recognition is
disabled; identification does not have to be active. The source tools service
must still be online to validate and update the completed recording.

MusicBrainz catalog fallback does not change source 0.6.0, album handoff v3,
or tools v1. A MusicBrainz-only selection attaches title/artist and the effective
revision with a **null Apple catalog reference**; a MusicBrainz UUID is never
written into an Apple collection ID. The unchanged sidecar uses `recognition`
for automatic recognition-derived catalog enrichment and `correction` for a
manual selection. Exact provider/release, relationship evidence and artwork
provenance remain in the display's edition state, not the source sidecar.
Provider, tracklist or cover enrichment changes the effective revision and
invalidates an older attachment preview. The original recognition and journal
are not rewritten.

**Retry album metadata** may query public catalogs using a cached album while
capture or the source is offline. It is separate from retrying identification:
it never samples audio or changes recording state. Recording attachment still
requires the configured source ID/UID to match and the source tools service
to be online.

Downloads stream from the source through an authenticated local bridge, with
bounded chunks/backpressure rather than loading a recording into Node or
browser memory. A short-lived, one-use ticket is bound to the local browser
session. A disconnected browser cancels the source transfer. Competing
downloads are limited, and stalled transfers time out. Range/resume downloads
are not supported; restart a failed download. Keep downloaded recordings and
backups private. There is no delete, recording-start or automatic-rearm action
in this library.

## Health and diagnostic export

Health separates capture, Sendspin transport, the display's MA connection,
recording storage and versions. A recording can capture with no Sendspin
connection; a connected Sendspin source can be idle. **Inactive input means
the device is not currently verified**, not that it is healthy or missing.
No repeated hardware probes or subprocesses run on HTTP polls.

Source health is optional: an absent/unconfigured source does not make the
display's health page disappear. Cached disk data has an age, and unknown
versions/statuses remain unknown rather than being inferred from unrelated
components. Runtime versions describe the running process; an on-disk install
that cannot be checked safely is not claimed to match it.

**Download diagnostics** exports a small, explicitly allowlisted JSON health
summary. It excludes source/boot IDs, hostnames, IP addresses, tokens,
environment values, filesystem paths, song/album history and raw logs.
Recent errors are bounded fixed categories, not exception payloads. The
export is useful for status triage, not a full support bundle or proof that
the physical signal path is fault-free.

## Integration contract

`src/shared/source-tools.ts` owns tools v1 schemas.
`useSourceTelemetry(enabled?)` is the shared visible-only subscription;
`StereoMeters({ telemetry, compact? })` only renders and never polls.
The HTTP namespace is `/api/source-tools`. Mutations use the normal local
session/CSRF flow; the broader recording-control and retry APIs are not reused.

`ToolsPanel({ onClose, extraSections? })` accepts sections with
`{ id, title, content }`; only the selected section mounts. Built-in IDs are
`meters`, `recordings`, and `health`. The application adds `ListeningJournal`
through `extraSections` as **Tools > Journal**.
