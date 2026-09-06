# Music Assistant integration and verified baseline

Source verification: **2026-09-05**, Music Assistant **2.10.2**, server commit
`243c4561c1744501a3087101127c339f4269831b`, API schema **65**,
`music-assistant-models` **1.1.205**. This is source/contract verification, not a
test against your server. Versions below schema 65 are intentionally rejected.
Newer versions are accepted only if their declared minimum schema still includes
65; changed response shapes fail validation rather than being guessed.

## Provisioning

Enable an appropriate lyrics metadata provider in MA and ensure you have the
necessary provider accounts/entitlements. A song can legitimately have no lyrics,
plain lyrics only, or imperfect line timestamps.

Create a dedicated **Music Assistant** long-lived access token in MA's account
settings. This is not a Home Assistant token. Provision it in `.env` for local
development or `/etc/sendspin-karaoke/environment` on the Pi, never in a URL or
frontend build variable. Current MA long-lived tokens expire after one year;
rotate them and restart the backend when necessary. Use the raw token string,
without a Bearer prefix.

Set `MA_URL` to the direct MA base URL, typically
`http://music-assistant.local:8095`. HTTP/HTTPS and WS/WSS are accepted;
the bridge adds `/ws`, preserving a reverse-proxy prefix. A reverse proxy must
forward WebSocket upgrades and allow the backend to reach MA. HA ingress URLs
that depend on a browser session are not a substitute for a reachable MA API.

To discover IDs from your own installation, set `MA_URL` and `MA_TOKEN`, then:

```sh
npm run discover
```

This outputs accessible player/queue IDs and names, never the token. Set
`MA_PLAYER_ID` to the CAST's exact player ID and rerun discovery to print its
current `activeQueueId`. Set that exact value as `MA_QUEUE_ID`. Group queue IDs
can differ from individual player IDs. When group membership/source changes,
the bridge re-resolves the active queue and **refuses to follow a different
configured queue**. Reconfigure the expected queue deliberately if needed.
Perform this initial discovery during ordinary MA queue playback, not while
an external Spotify Connect source is active: the latter can have no active queue.

Set `DEMO_MODE=false` and restart after configuring all four MA values. Demo
does not automatically fall back to or from live mode. The production JS
discovery entry point is `node dist/server/server/discover.js`; it can be run
with Node's `--env-file` option when using the installed environment file.

## Actual wire contract

The server first sends an unwrapped `server_id`, `server_version`,
`schema_version`, `min_supported_schema_version` greeting. The bridge sends:

```json
{"message_id":"1","command":"auth","args":{"token":"YOUR_MA_TOKEN"}}
```

Success is `{"message_id":"1","result":{"authenticated":true,...},"partial":false}`.
Errors use top-level `error_code`; upstream error text is not logged or exposed.
MA forwards authorized events automatically after authentication: there is no
wire-level subscription command.

| Command | Arguments and result |
|---|---|
| `player_queues/get_active_queue` | `{player_id}` -> full queue or null; follows synced/group/active-source routing |
| `players/get` | `{player_id}` -> player state, including `current_media`; used only when the active queue is null |
| `music/item_by_uri` | `{uri, allow_update_metadata:false}` -> actual full Track |
| `metadata/get_track_lyrics` | `{track: fullTrack}` -> `[plainLyricsOrNull, lrcLyricsOrNull]` |
| `players/all`, `player_queues/all` | Discovery only; results are stripped to IDs/names before printing |

`queue_updated` and `queue_items_updated` carry a full queue snapshot.
`queue_time_updated` carries a scalar elapsed time in **seconds**, not a
timestamped object. Ordinary elapsed-only updates can be suppressed; the
bridge extrapolates and reconciles the target queue every ten seconds.
There is no aggressive lyrics polling. Positive lyrics cache TTL is one day;
missing results last five minutes; failed fetch retries are delayed one minute.

Track identity uses the actual queue item's `media_item.uri`. Queue occurrence
identity separately includes the queue and `queue_item_id` to handle repeated
tracks/next correctly. Metadata resolution may return a library representation
for a provider URI; pass that entire returned Track to the lyrics endpoint.
Do not mix a library item ID with another provider instance, search by title,
or invent a simplified endpoint.

## Spotify Connect and external sources

External-source playback is not necessarily MA queue playback. In the verified
**MA 2.10.2** source, the Spotify Connect plugin updates live source metadata and
emits `player_updated`. The MA queue is preserved, and
`player_queues/get_active_queue` normally returns null while the source is active.
Reading the old queue cannot identify the externally playing song.

Only after an explicit null active-queue response, the display reads the
configured player's `current_media` using `players/get`. Title, artist and album
are display metadata, not search inputs. Song changes are detected even when the
source URI stays constant. The old queue's lyrics, pending lyric requests and
timing events cannot replace this external-source display. Returning to the
configured MA queue restores the ordinary exact-URI lyrics path.

Player identity and grouping are still checked. For the external-source path,
the selected player's sync leader, active group, or ungrouped player ID must
match `MA_QUEUE_ID`. Unknown or differently routed groups are refused, not followed
by name. A non-null but mismatched/unavailable MA queue is never replaced with an
external-source fallback.

**This fixes stale/blank metadata, not the MA Connect lyrics identity limitation.**
The plugin internally knows the Spotify track URI, but MA's public player
projection sets `current_media.uri` to the **AudioSource endpoint URI** and
`media_type` to `audio_source`. It copies title/artist/album but does not expose
that internal track URI. The registered source item/browse/provider APIs do not
provide it either. The display shows an explicit unsupported-lyrics explanation;
it never sends this endpoint URI to a Track/lyrics lookup or caches lyrics under it.
Its hashed display occurrence key is not a catalog identity.

Some other external player integrations can report an actual Spotify **track**
URI in `current_media` with media type `track`. Only recognized exact Spotify
track URIs use the existing `music/item_by_uri` and lyrics provider path; provider
availability and the existing library-refresh opt-in still apply. Titles are
never fuzzy-matched. Missing or stale player timing disables synchronized lyrics
without hiding the reported metadata. Timing is labelled approximate MA player
timing, not queue or native Sendspin synchronization.

By default, artwork is shown only when MA supplies an image URL on its own verified
`/imageproxy/<64-hex-id>` route (including the configured reverse-proxy prefix),
or an exact Track lookup supplies a proxy ID. Raw Spotify/CDN image URLs are not
fetched by default; those sources show the normal artwork placeholder.

### Optional Spotify Connect artwork

Connect can supply a direct Spotify cover URL rather than an MA image-proxy URL.
To permit the backend to fetch these covers, explicitly set this in
`/etc/sendspin-karaoke/environment` (or `.env` for development) and restart the
service after installing a release with this setting:

```ini
MA_ALLOW_SPOTIFY_ARTWORK=true
```

This is off by default, including when the setting is absent in an existing
installation. It allows only canonical HTTPS `i.scdn.co/image/<40-hex-id>` URLs
reported by MA for a Spotify/Spotify Connect source. No title search, Spotify
account login, MA metadata refresh, or new lyric provider is involved.

**Privacy:** enabling it contacts Spotify's image service from the Pi, exposing
your public IP and the requested cover identifier to that service. The backend
sends no MA token, cookies or referrer. The browser still loads a local artwork
route; the external URL is not sent to it. Redirects and other hosts/paths are
rejected. Downloads retain the eight-second timeout, 2 MiB byte cap, raster
type/signature checks and eight-entry in-memory cache. Artwork changes are
versioned separately from lyrics identity; unavailable artwork uses a placeholder.
Other URL formats remain unsupported rather than expanding network access silently.

This does not fix Connect's missing exact track URI or enable lyric matching.
Set `MA_ALLOW_SPOTIFY_ARTWORK=false` and restart to disable direct cover fetching.

For troubleshooting, first compare MA's own player screen with this display.
Correct title/artist in MA but not on the display points to the source/queue path,
not to lyric provider availability. Enabling `MA_ALLOW_LYRICS_REFRESH`, clearing
the lyrics cache, or changing token permissions cannot recover an unexposed track
URI. Do not change those settings merely to diagnose Connect.

## Read-only and enrichment policy

`metadata/get_track_lyrics` requires `library.read` but can call MA's library
metadata updater when `track.provider === "library"` and lyrics are missing.
There is **no refresh-disable argument on that endpoint**.

The default `MA_ALLOW_LYRICS_REFRESH=false` first reads stored
`metadata.lrc_lyrics` or `metadata.lyrics` and declines this library enrichment
path if neither is present, with an explicit UI message. Non-library tracks may
still use the verified provider endpoint. To allow MA to retrieve/enrich missing
library lyrics, explicitly set:

```ini
MA_ALLOW_LYRICS_REFRESH=true
```

This may write lyric metadata to **your MA library** during normal runtime.
Authentication/provider/image reads can also update MA's activity and caches;
we do not claim zero server-side writes. The bridge never sends playback,
grouping, power or configuration mutation commands. MA's ordinary user token
may have more permissions than this app uses; the backend enforces a command
allowlist rather than claiming the token itself is read-only.

## Timing and artwork

For full snapshots, MA's formula is `elapsed_time + (now -
elapsed_time_last_updated)` while playing, with both values in Unix seconds.
**Keep both the Pi and MA host synchronized with NTP.** Once converted, playback
advances using a monotonic millisecond clock. Timestamp-less seek events anchor
at receipt. HTTP Date headers are not used as an audio clock; reverse proxies
and whole-second header resolution make that misleading. Grossly old/future
queue timestamps stop rendering with an explicit diagnostic.

Only 1x track playback is supported. Other media types and playback speeds
fail closed rather than showing drifting lyrics. Pause is clock speed zero,
not a substitute for arbitrary MA playback multipliers. Manual offset can
compensate a stable latency but cannot eliminate variable Wi-Fi jitter.

Artwork uses MA's current server-issued 64-hex `proxy_id` and
`/imageproxy/<id>?size=512&fmt=jpeg`. The backend never fetches or exposes raw
provider image paths, never sends the MA token in an image URL, rejects
redirects/SVG/HTML, and limits raster response size. Missing images show a local
placeholder. Legacy `?provider=...&path=...` proxy syntax is not used.

## Authoritative source references

- [MA 2.10.2 release](https://github.com/music-assistant/server/releases/tag/2.10.2)
- [WS greeting/auth/events](https://github.com/music-assistant/server/blob/2.10.2/music_assistant/controllers/webserver/websocket_client.py)
- [Wire models](https://github.com/music-assistant/models/blob/1.1.205/music_assistant_models/api.py)
- [Active queue and queue APIs](https://github.com/music-assistant/server/blob/2.10.2/music_assistant/controllers/player_queues/controller.py)
- [Player/group resolution](https://github.com/music-assistant/server/blob/2.10.2/music_assistant/controllers/players/controller.py)
- [Track URI lookup](https://github.com/music-assistant/server/blob/2.10.2/music_assistant/controllers/music/controller.py)
- [Lyrics endpoint and side effects](https://github.com/music-assistant/server/blob/2.10.2/music_assistant/controllers/metadata/controller.py)
- [LRC normalization](https://github.com/music-assistant/server/blob/2.10.2/music_assistant/helpers/lyrics.py)
- [Queue clock model](https://github.com/music-assistant/models/blob/1.1.205/music_assistant_models/player_queue.py)
- [Current image proxy](https://github.com/music-assistant/server/blob/2.10.2/music_assistant/controllers/metadata/images.py)
- [MA lyrics setup](https://www.music-assistant.io/metadata/lyrics/)
- [Connect backend metadata projection](https://github.com/music-assistant/server/blob/243c4561c1744501a3087101127c339f4269831b/music_assistant/providers/spotify_connect/provider.py#L1160-L1171)
- [Public external-source PlayerMedia (endpoint URI, not track URI)](https://github.com/music-assistant/server/blob/243c4561c1744501a3087101127c339f4269831b/music_assistant/models/player.py#L3040-L3078)
- [External-source active-queue resolution](https://github.com/music-assistant/server/blob/243c4561c1744501a3087101127c339f4269831b/music_assistant/controllers/players/controller.py#L2176-L2194)
- [Public Player/PlayerMedia fields and player clock](https://github.com/music-assistant/models/blob/99df2a566be5a58150d13c08823069e382b516ce/music_assistant_models/player.py)
- [AudioSource item lookup returns the source catalog object](https://github.com/music-assistant/server/blob/243c4561c1744501a3087101127c339f4269831b/music_assistant/controllers/music/controller.py#L1158-L1169)
