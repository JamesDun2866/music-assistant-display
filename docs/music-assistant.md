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
