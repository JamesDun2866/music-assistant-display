import { createHash } from "node:crypto";
import { z } from "zod";
import type { QueueAnchor } from "./bridge.js";
import type { ArtworkStore } from "./artwork.js";

const text = z.string().max(4096);
const seconds = z.number().finite().nonnegative().nullable().optional();
const playerMediaSchema = z.object({
  uri: text,
  media_type: z.string(),
  title: text.nullable().optional(),
  artist: text.nullable().optional(),
  album: text.nullable().optional(),
  duration: seconds,
  image_url: text.nullable().optional(),
  queue_item_id: text.nullable().optional(),
});
export const playerEventSchema = z.object({
  active_source: text.nullable().optional(),
  active_group: text.nullable().optional(),
  synced_to: text.nullable().optional(),
  available: z.boolean().optional(),
  playback_state: z.enum(["playing", "paused", "idle"]).optional(),
  current_media: playerMediaSchema.nullable().optional(),
});
const playerSchema = playerEventSchema.extend({
  player_id: text,
  available: z.boolean(),
  playback_state: z.enum(["playing", "paused", "idle"]),
  elapsed_time: seconds,
  elapsed_time_last_updated: seconds,
});

export function spotifyTrackUri(uri: string): string | null {
  const match = /^(?:spotify:track:|spotify:\/\/track\/)([a-zA-Z0-9]{22})$/.exec(uri)
    ?? /^https:\/\/open\.spotify\.com\/track\/([a-zA-Z0-9]{22})(?:\?[^#]*)?$/.exec(uri);
  return match ? `spotify://track/${match[1]}` : null;
}

/** Only used after MA explicitly reports that this player has no active queue. */
export function playerAnchor(raw: unknown, playerId: string, queueId: string,
  serverNowMs: number, artwork?: ArtworkStore): QueueAnchor {
  const player = playerSchema.parse(raw);
  if (player.player_id !== playerId) throw new Error("target_player_mismatch");
  if (!player.available) throw new Error("target_player_unavailable");
  const owner = player.synced_to && player.synced_to !== playerId ? player.synced_to
    : player.active_group && player.active_group !== playerId ? player.active_group : playerId;
  if (owner !== queueId) throw new Error("target_queue_mismatch");
  const idle: QueueAnchor = {
    track: null, itemKey: null, request: null, playback: "idle", positionMs: 0, precision: "ma-player",
  };
  if (player.playback_state === "idle") return idle;
  if (!player.active_source || [playerId, queueId].includes(player.active_source)) {
    throw new Error("external_source_unconfirmed");
  }
  const media = player.current_media;
  if (!media) throw new Error("external_metadata_unavailable");
  if (!["track", "audio_source"].includes(media.media_type) || media.queue_item_id) {
    throw new Error("unsupported_media_type");
  }
  const uri = media.media_type === "track" ? spotifyTrackUri(media.uri) : null;
  const spotifySource = player.active_source === "spotify"
    || /^spotify_connect(?:--[^:]+)?:\/\/audio_source\//.test(player.active_source);
  // This hash is a display occurrence key, never a catalog identity or lyrics lookup.
  const occurrence = createHash("sha256").update(JSON.stringify([
    playerId, player.active_source, media.uri, media.title, media.artist, media.album, media.duration,
  ])).digest("hex");
  const identity = uri ?? `external:${occurrence}`;
  const age = player.playback_state === "playing" && player.elapsed_time_last_updated != null
    ? serverNowMs - player.elapsed_time_last_updated * 1000 : 0;
  const timed = player.elapsed_time != null &&
    (player.playback_state === "paused" || player.elapsed_time_last_updated != null && age >= -5000 && age <= 120_000);
  return {
    track: {
      identity, title: media.title || "External audio", artist: media.artist ?? "",
      album: media.album ?? "", durationMs: media.duration == null ? null : media.duration * 1000,
      artworkUrl: media.image_url && artwork ? artwork.setFromPlayerUrl(identity, media.image_url,
        spotifySource) : null,
    },
    itemKey: `external:${occurrence}`,
    request: uri && timed ? { identity: uri, uri } : null,
    lyricsUnavailable: !uri
      ? spotifySource ? "Music Assistant does not yet support lyrics via Connect."
        : "Music Assistant exposes external-source metadata but no exact supported track URI. Lyrics cannot be matched safely."
      : !timed ? "Music Assistant exposes this track without a reliable playback clock. Synchronized lyrics are unavailable." : undefined,
    playback: player.playback_state,
    positionMs: timed ? player.elapsed_time! * 1000 + Math.max(0, age) : 0,
    speed: timed && player.playback_state === "playing" ? 1 : 0,
    precision: "ma-player",
  };
}
