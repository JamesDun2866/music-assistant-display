# Alternate album catalogs

Line-in and Vinyl share the same display-side catalog resolver. MusicBrainz
can supply a complete release tracklist and Cover Art Archive can supply that
release's front cover when Apple's original catalog reference, lookup or cover
is unavailable. Healthy Apple results stay unchanged. For an alternative cover
on an otherwise recognized album, open **Correct album edition** and select
**MusicBrainz**.

## Exactness and confirmation

Automatic resolution requires an exact original Apple collection ID and
storefront, a unique reverse MusicBrainz URL relationship, a corroborating
release-to-Apple purchase/streaming relationship, and a complete ordered release
tracklist of at most 200 tracks. A track reference must first be resolved to its
Apple collection. Artist/title equality and search scores are never evidence of
an exact edition.

Canonical Apple URL-resource indexing is incomplete. Missing legacy/slug URL
variants, missing relationships, ambiguous releases, unresolvable original
tracks and incomplete tracklists can prevent automatic resolution. The display
offers searchable candidates instead of silently choosing one. Candidate
country, release date, medium format, disambiguation and release ID help
distinguish editions. The complete multidisc list and corresponding cover
(or an explicit unavailable message) appear before confirmation.

**Catalog resolved via MusicBrainz** describes a community-maintained catalog
mapping, not a verified physical pressing or manual correction. A confirmed
manual choice is authoritative. **Restore original album** suppresses automatic
reattachment for that recognition; an explicit metadata retry permits another
resolution.

Selections are remembered only for the configured source and verified original
Apple collection/storefront. Without that identity, they apply only to the
current successful identification and expire on the next genuine success,
including another identification of the same album. Polling, silence and
failed recognition do not expire a valid selection.

## Artwork and continuity

Artwork is selected from the approved front entry of the **same MusicBrainz
release**, using its CAA image ID and 1200-pixel endpoint. No release-group
artwork, arbitrary image URL, original-cover substitution or other edition is
used to fill a gap. The common bounded decoder preserves aspect ratio, does
not enlarge small originals, and stores a sanitized JPEG up to 1200 pixels.

Accepted complete metadata and decoded artwork are stored locally. Offline
status, restart, silence, failed lookups and missing artwork do not erase an
existing complete display. Original Shazam recognition and original journal
entries remain unchanged. Provider identity and provenance live separately
from the original Apple-only schemas.

**Retry album metadata** uses the cached album even when capture or the source
is offline. It does not sample audio, retry recognition, start playback or
record anything. Cooldown and incomplete/outage messages describe the catalog
result. Recording attachment still requires an online matching source; see
[the unchanged recording projection](source-tools.md#completed-recordings).

## Bounded requests and storage

Automatic work is daemon-owned and starts only for an active source. A persisted
attempt ledger prevents UI polling or restart from repeating the same
eligibility attempt. It retains up to 64 small status/candidate entries;
accepted edition records are separate. Accepted/manual choices are not evicted
to make room for automatic work. New automatic records are refused once their
aggregate admission limits are reached (64 records or 256 MiB). Existing
explicit manual-selection behavior is unchanged.

One process-wide provider scheduler admits one HTTP request at a time, with
at least 1100 ms between starts and at most eight waiting requests. Redirects
consume the same budget. Automatic operations have a 12-hop budget, a 45-second
deadline and no immediate retry loop. Requests have an eight-second deadline;
JSON, manifest and encoded image bodies are limited to 2 MiB, 512 KiB and
12 MiB respectively. Transient failures have persisted backoff, and provider
`Retry-After` is honored. Waiting does not automatically replay a lookup.

Only fixed HTTPS MusicBrainz/CAA endpoints and narrowly validated archive
redirects are accepted. CAA archive paths must carry the same release UUID and
selected image filename. Known `archive.org`, `s3.us.archive.org`,
`iaNNNNNN.us.archive.org` and `dnNNNNNN.ca.archive.org` storage forms are allowed;
unknown hosts and paths fail closed. Every connection checks DNS results
against public-address rules. No cookies or credentials are forwarded, and
Apple's separate network policy is unchanged.

Display edition records migrate from v1 to provider-aware v2 without changing
source handoff v3 or Python 0.6. The high-resolution `coverVersion` migration
remains intact. Canonical covers retain the 2 MiB JPEG and 3 MiB per-record
bounds; ephemeral preview cover strings share an 8 MiB aggregate cap.

## Privacy, attribution and coverage

Queries send artist/album text and public catalog/release identifiers, never
audio, private source IDs, session tokens, recordings, logs or local paths.
No paid API keys are required. Requests identify the application using the
public project contact, not any local checkout or installation details.

The UI links to the exact MusicBrainz release and its CAA artwork page.
[MusicBrainz core metadata is CC0; supplementary data has separate
CC BY-NC-SA terms](https://musicbrainz.org/doc/About/Data_License).
The public API has [non-commercial use and rate-limit
conditions](https://musicbrainz.org/doc/MusicBrainz_API).
[CAA images are not covered by a blanket CC0 license](https://musicbrainz.org/doc/Cover_Art_Archive);
respect individual artist/label rights.

Provider tests use synthetic metadata and synthetic image buffers. Public
metadata-only validation also covered MusicBrainz's documented release
`76df3287-6cda-33eb-8e9a-044b5e15ffdd` (Dummy: 11 tracks, one medium) and its
approved CAA front manifest through the hardened client. No cover-image bytes
were acquired for that validation or added to this repository.
