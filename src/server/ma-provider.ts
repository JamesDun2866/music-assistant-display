import { z } from "zod";
import type { Lyrics } from "../shared/protocol.js";
import type { LyricsProvider, TrackRequest } from "./provider.js";
import type { MaRpc } from "./ma-client.js";
import { MAX_LYRICS_BYTES, parseLyrics } from "./lrc.js";

export const imageSchema = z.object({
  type: z.string().optional(),
  proxy_id: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),
}).passthrough();
export const metadataSchema = z.object({
  lyrics: z.string().max(MAX_LYRICS_BYTES).nullable().optional(),
  lrc_lyrics: z.string().max(MAX_LYRICS_BYTES).nullable().optional(),
  images: z.array(imageSchema).max(200).nullable().optional(),
}).passthrough();
export const mediaSchema = z.object({
  uri: z.string().min(1).max(4096),
  name: z.string().max(4096),
  provider: z.string().max(256),
  item_id: z.string().max(4096),
  media_type: z.string(),
  duration: z.number().finite().nonnegative().nullable().optional(),
  artists: z.array(z.object({ name: z.string().max(4096) }).passthrough()).max(100).optional(),
  album: z.object({
    name: z.string().max(4096),
    metadata: metadataSchema.optional(),
    image: imageSchema.nullable().optional(),
  }).passthrough().nullable().optional(),
  metadata: metadataSchema.optional(),
  image: imageSchema.nullable().optional(),
}).passthrough();
const trackSchema = mediaSchema.extend({
  media_type: z.literal("track"),
  provider_mappings: z.array(z.record(z.unknown())).max(500),
});
export function imageId(item: z.infer<typeof mediaSchema>): string | null {
  return item.metadata?.images?.find((image) => image.type === "thumb" && image.proxy_id)?.proxy_id
    ?? item.image?.proxy_id
    ?? item.album?.metadata?.images?.find((image) => image.type === "thumb" && image.proxy_id)?.proxy_id
    ?? item.album?.image?.proxy_id ?? null;
}
export class MaLyricsProvider implements LyricsProvider {
  readonly capability = "available";
  constructor(
    private readonly rpc: MaRpc,
    private readonly allowMetadataRefresh = false,
    private readonly onTrack?: (identity: string, track: z.infer<typeof mediaSchema>) => void,
  ) {}
  async fetch(request: TrackRequest, signal: AbortSignal): Promise<Lyrics> {
    const track = trackSchema.parse(await this.rpc.request("music/item_by_uri", {
      uri: request.uri, allow_update_metadata: false,
    }, signal));
    signal.throwIfAborted();
    this.onTrack?.(request.identity, track);
    const stored = track.metadata?.lrc_lyrics?.trim() ? track.metadata.lrc_lyrics : track.metadata?.lyrics;
    if (stored?.trim()) return parseLyrics(stored);
    if (track.provider === "library" && !this.allowMetadataRefresh) {
      return {
        status: "missing", lines: [], plain: null,
        message: "No stored lyrics. MA library metadata refresh is disabled; see MA_ALLOW_LYRICS_REFRESH.",
      };
    }
    const result = z.tuple([
      z.string().max(MAX_LYRICS_BYTES).nullable(), z.string().max(MAX_LYRICS_BYTES).nullable(),
    ]).parse(await this.rpc.request("metadata/get_track_lyrics", { track }, signal));
    signal.throwIfAborted();
    return parseLyrics(result[1]?.trim() ? result[1] : result[0]);
  }
}
