# Local identification journal and album editions

The journal records **album identification successes**, not songs played,
completed plays, listening duration or the contents of a recording. Recognition
still requires its existing explicit opt-in. These features neither start audio
capture nor change the recognition attempt/retry policy.

## Journal

Open **Journal** in the local Tools panel. Each row shows the original recognized
album, artist, date and a locally cached cover when available. **Older
identifications** browses another page; **Latest / refresh** returns to the latest
page. Correcting an edition does not rewrite these historical titles.

The source produces an event for each genuine successful recognition, including
a new successful recognition of the same album. Polling, reboots, restored album
caches, failed attempts, previewing and manual corrections do not create events.
The durable identity is the configured source plus the historical success's
boot ID and generation, not the last-album display key.

The source retains events in private SQLite storage for a rolling **90 days**.
The display daemon imports pages in the background; the browser and Line-in view
do not need to be open. After the display daemon is stopped, it catches up from
the source's retained feed. An outage longer than the retention window cannot
recover expired events. Upgrading does not turn an existing last-album cache into
new journal history.

There is no 1,000-entry cap or other count-based deletion inside the retention
window. Database work runs away from the audio and HTTP event loops. Browsing,
importing and export use bounded pages rather than loading the journal into
memory.

### Dates and failure limits

Dates describe when identification succeeded according to the appliance clock.
The original logical success timestamp is retained internally, separately from
the source's observed wall-clock time. Logical success time preserves causal
ordering through a clock rollback; it is bounded on first import by the display's
persisted, nondecreasing clock horizon, rather than accepting an arbitrary future
date. Adjusted dates and detected source-clock differences are marked approximate.
Replaying an already imported sequence does not refresh its age, including after
expiry, and rolling the clock backward does not resurrect expired events.

Keep the appliance clock correct. No local implementation can reconstruct a
trustworthy real-world date after arbitrary clock changes without a trusted
clock. A large forward clock jump can expire history.

The journal cannot guarantee capture if the process or power fails before the
success commits to disk, or if storage is full, unsafe or unwritable. The source
reports journal health separately; audio streaming and recognition consent are
not changed to hide a journal failure. A committed source event survives later
display/cache failures and can be imported exactly once through replay.

### Covers and storage

Journal covers are sanitized, deduplicated local JPEG thumbnails. The journal
thumbnail cache has a **256 MiB** budget. Least-recently-used cached images can be
evicted when that budget is reached; the full 90-day event metadata remains.
Missing, failed or evicted covers show a placeholder. Failed downloads are not
retried by every status poll.

Expiry and clear remove event references and unused journal artwork. Database
space is reclaimed incrementally and can be reused. Confirmed edition assets
belong to the separate correction store and are not removed by journal clear.

### Export and clear

**Export JSON** downloads a versioned JSON document containing original album
title/artist, identification date and clock-adjustment status. It does not
include audio, source/boot identifiers, provider payloads, remote artwork URLs,
local paths or credentials. Export is paged and respects client backpressure;
an interrupted export must be downloaded again.

**Clear journal** opens an explicit confirmation. Clearing removes retained
source and display events plus unreferenced journal artwork. It does **not**
clear the current last album, recognition consent or remembered corrections.
Small internal deduplication watermarks and the last-album recovery record remain;
they prevent old successes from becoming new journal entries after deletion.
The source must be reachable: an offline or incomplete clear is reported as an
error, not successful deletion.

A persistent clear revision and sequence watermark prevent an in-flight page or
a stale success from reappearing after clear. New successes after the clear
remain valid events. If the source commits clear but the response/display
commit is interrupted, history is unavailable until synchronization resolves the
pending clear; reconnect to the source and refresh.

## Correct an album edition

In **Line-in album**, or **Vinyl > Line-in details**, choose **Correct album edition**. Search using artist and album,
choose Apple (and its storefront) or MusicBrainz, choose a result, and review its cover and **full
tracklist** before confirming. Search is an explicit action: opening the dialog,
typing and polling do not submit the manual search form. Automatic fallback is
separate and described below.

The form discloses that the entered artist/album text is sent to the chosen
catalog: Apple's iTunes catalog or MusicBrainz. No audio is sent by edition
search or metadata retry, and no API keys are required. The original catalog reference's
country is the default Apple storefront; without one, select a country explicitly.
MusicBrainz needs no storefront. A failed original Apple identity lookup does
not prevent manually choosing a MusicBrainz release for the current album.
When fallback needs a choice or finds no usable match, the dialog defaults to
MusicBrainz; otherwise the existing Apple default remains.

MusicBrainz candidates show their exact release ID, country, date, format and
disambiguation where known. Unknown details stay unknown; titles alone are not
enough to identify an edition. Cached candidate counts and summaries are visible
without starting a search. Explicitly searching MusicBrainz with the original
artist/album names reuses persisted candidate summaries. Compare the selected
release's own cover and complete ordered, multidisc tracklist before confirming.

Preview does not replace the current album. Confirmation requires a complete,
exact collection or MusicBrainz release lookup of at most 200 tracks with consistent disc and track
numbering. Incomplete or mismatched tracklists cannot be confirmed. Unavailable
cover art is shown honestly rather than borrowing the original edition's image.
If the original album or recognition success changes during the workflow,
refresh and search/preview again.

The selected edition is labelled **corrected catalog edition**, not a verified
physical vinyl pressing. It does not add current-track highlighting, playback
timing, completion tracking or synchronized lyrics.

### Automatic catalog fallback and metadata retry

MusicBrainz/CAA fallback is distinct from manual correction. A release may be
automatically resolved only with accepted exact original Apple release-URL
relationship evidence and a complete validated tracklist. Text-only candidates
require user confirmation: a similar name is not proof of an edition or pressing.
The original recognized title and artist remain separate from the effective
catalog display, and automatic resolution is **not** labelled corrected.

Line-in album and Vinyl's Line-in details share the same album status and report
loading, resolved, confirmation required, no match, incomplete, unavailable or
suppressed fallback states. **Retry album metadata** is explicit, uses the cached
album binding, and can work while the source is offline and audio identification
retry is disabled. It never samples audio or enables recognition. Rate-limit
deadlines disable retry until the displayed time; reaching that time does not
automatically send a request. This is separate from **Retry identification**.

Use **Restore original album** to remove an automatic resolution, or **Remove
correction** for a manual choice. Both require confirmation. Restoring the
original suppresses automatic fallback for that context rather than immediately
selecting the removed edition again. Metadata retry is the deliberate way to
ask for lookup again.

### Remembering and undoing corrections

When the original recognition has a verifiable Apple catalog identity, the
correction is remembered for that original collection and storefront, scoped to
the configured source. Exact original track references resolve to a collection;
artist/title text is never used for fuzzy automatic matching.

Without a verifiable original catalog identity, a correction applies only to
the **current identified album success**. The UI labels that it is not
remembered for future matches. It expires on the next successful recognition,
even if that success identifies the same album. Rebooting or restoring the same
historical success does not fabricate a new match.

Change an edition by repeating search, preview and confirmation. Remove a
correction to restore the original recognized context. Original allowlisted
recognition metadata remains separate for identity and undo. Confirmed
corrections include a locally saved full tracklist and cover when available, so
the selected edition can be displayed offline and after reboot.

Recording attachments and vinyl presentation reuse the effective catalog
album context, while retaining original provenance. Attaching that context to a
recording still needs explicit user confirmation and a matching source. A
cached album is not proof of what was recorded.

The Python recording projection and handoff schema are unchanged. A MusicBrainz
effective album projects with `catalog: null`, never an invented Apple catalog
reference. Display-side provenance retains its exact MusicBrainz release and
optional CAA artwork source, and distinguishes `automatic-catalog`
(recognition-derived) from `manual` selection. Only a manual edition is a
correction; automatic catalog enrichment is not manual correction provenance.
The original recognition context and immutable original journal remain unchanged.

## Local access and privacy

Use the existing loopback kiosk or SSH tunnel. No public listener is added.
Host/Origin and fetch-site checks apply to journal and edition APIs; mutations
require the existing local session and CSRF token. Source journal IPC accepts
only narrowly defined feed/clear commands from authorized local peers, not
general source controls.

Apple requests use fixed catalog endpoints and validated artwork hosts, bounded
responses/timeouts, no redirects or arbitrary-URL proxying, and public-address
checks. Neither the journal nor correction feature adds telemetry. Logs and
diagnostics do not contain journal titles or source identifiers.

MusicBrainz release metadata and Cover Art Archive images use separate bounded
provider requests and local sanitized artwork endpoints. Exact release and cover
source links identify their provenance. [MusicBrainz data licenses](https://musicbrainz.org/doc/About/Data_License)
cover core data under CC0 and supplementary data under CC BY-NC-SA.
[Cover Art Archive rights](https://musicbrainz.org/doc/Cover_Art_Archive) are
separate: cover images retain their individual copyrights and are **not** all
licensed CC0. Local caching does not grant redistribution rights.

Source and display data are owner-private. Native `node:sqlite` runs in an
isolated display worker. Node 22.12 uses the SQLite experimental flag only for
that worker; newer supported versions do not need it. No new framework or
database package is required.
