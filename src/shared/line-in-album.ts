import { z } from "zod";
import { catalogReferenceSchema, albumArtworkReference } from "./album-reference.js";
import { fallbackStatusSchema, providerProvenanceSchema } from "./album-provider.js";
export { catalogReferenceSchema, albumArtworkReference, type CatalogReference } from "./album-reference.js";

const text = z.string().min(1).max(256).refine((value) => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value));
export const tracklistSchema = z.object({
  status: z.enum(["loading", "complete", "unavailable"]),
  message: z.string().max(256).nullable(),
  title: text.nullable(),
  artist: text.nullable(),
  discCount: z.number().int().min(1).max(200).nullable(),
  tracks: z.array(z.object({
    disc: z.number().int().min(1).max(200),
    number: z.number().int().min(1).max(200),
    title: text,
  }).strict()).max(200),
}).strict().refine((value) => {
  if (value.status !== "complete") return value.tracks.length === 0
    && value.title === null && value.artist === null && value.discCount === null;
  if (!value.tracks.length || !value.title || !value.artist || !value.discCount || value.discCount > value.tracks.length) return false;
  let index = 0;
  for (let disc = 1; disc <= value.discCount; disc++) {
    let number = 1;
    while (value.tracks[index]?.disc === disc) {
      if (value.tracks[index]!.number !== number++) return false;
      index++;
    }
    if (number === 1) return false;
  }
  return index === value.tracks.length;
});
export type Tracklist = z.infer<typeof tracklistSchema>;
export const unavailableTracklist = (message = "Tracklist unavailable"): Tracklist => ({
  status: "unavailable", message, title: null, artist: null, discCount: null, tracks: [],
});
export const albumKeySchema = z.string().regex(/^[a-f0-9]{32}-[0-9]{1,16}$/);
export const albumMetadataSchema = z.object({
  title: text, artist: text, artwork: albumArtworkReference.nullable(), catalog: catalogReferenceSchema.nullable(),
}).strict();
export const retryBindingSchema = z.object({
  source_id: z.string().regex(/^[a-f0-9]{64}$/),
  boot_id: z.string().regex(/^[a-f0-9]{32}$/),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type RetryBinding = z.infer<typeof retryBindingSchema>;
export const albumSuccessSchema = retryBindingSchema.omit({ source_id: true }).extend({
  at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type AlbumSuccess = z.infer<typeof albumSuccessSchema>;
export function albumEligibility(value: AlbumSnapshot): string {
  const success = value.album_success;
  return `${value.boot_id}-${value.generation}:${success ? `${success.boot_id}-${success.generation}` : "legacy"}`;
}
export const albumSnapshotSchema = z.object({
  version: z.literal(3),
  source_id: z.string().regex(/^[a-f0-9]{64}$/),
  boot_id: z.string().regex(/^[a-f0-9]{32}$/),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updated_at_ms: z.number().int().nonnegative(),
  expires_at_ms: z.number().int().nonnegative(),
  state: z.enum(["disabled", "idle", "armed", "sampling", "recognizing", "identified", "unavailable"]),
  enabled: z.boolean(),
  active: z.boolean(),
  silence_dbfs: z.number().finite().negative(),
  remembered_enabled: z.boolean(),
  settings_error: z.enum(["restore_failed", "save_failed"]).nullable(),
  album: albumMetadataSchema.nullable(),
  album_key: albumKeySchema.nullable(),
  album_success: albumSuccessSchema.nullable(),
  cache_error: z.enum(["restore_failed", "save_failed"]).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.expires_at_ms - value.updated_at_ms !== 4000
      || (value.state === "identified" && value.album === null)
      || (value.album !== null) !== (value.album_key !== null)
      || (value.album === null && value.album_success !== null)
      || (value.album_success?.boot_id === value.boot_id && value.album_success.generation > value.generation)
      || (!value.enabled && (value.state !== "disabled" || value.active))
      || (value.enabled && value.state === "disabled")
      || (value.enabled && !value.active && value.state !== "idle")
      || (value.active && ["disabled", "idle"].includes(value.state))) {
    ctx.addIssue({ code: "custom", message: "Inconsistent album snapshot" });
  }
});
export type AlbumSnapshot = z.infer<typeof albumSnapshotSchema>;
export const albumEditionBindingSchema = z.object({
  sourceId: retryBindingSchema.shape.source_id,
  albumKey: albumKeySchema, success: albumSuccessSchema.nullable(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const albumViewSchema = z.object({
  state: z.enum(["not-configured", "offline", "disabled", "idle", "armed", "sampling", "recognizing", "identified", "unavailable"]),
  expiresAt: z.number().finite(),
  key: z.string().regex(/^[a-f0-9]{32}-[0-9]+$/).nullable(),
  album: z.object({
    title: text, artist: text,
    artworkUrl: z.string().regex(/^\/api\/line-in-album\/artwork\/[a-f0-9]{32}-[0-9]+(?:\?(?:edition=[1-9][0-9]{0,15}|cover=[a-f0-9]{64}))?$/).nullable(),
  }).strict().nullable(),
  tracklist: tracklistSchema.default(() => unavailableTracklist()),
  retry: retryBindingSchema.nullable().default(null),
  cacheError: z.string().max(256).nullable().default(null),
  edition: z.object({
    binding: albumEditionBindingSchema,
    original: z.object({ title: text, artist: text, country: z.string().regex(/^[a-z]{2}$/).optional() }).strict(),
    corrected: z.boolean(),
    scope: z.enum(["original", "remembered", "current-album"]),
    provenance: providerProvenanceSchema.nullable().optional(),
    fallback: fallbackStatusSchema.optional(),
  }).strict().nullable().optional(),
}).strict();
export type AlbumView = z.infer<typeof albumViewSchema>;
