import { z } from "zod";

const text = z.string().min(1).max(256).refine((value) => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value));
export const catalogReferenceSchema = z.object({
  kind: z.enum(["collection", "track"]),
  id: z.string().regex(/^[1-9][0-9]{0,14}$/),
  country: z.string().regex(/^[a-z]{2}$/),
}).strict();
export type CatalogReference = z.infer<typeof catalogReferenceSchema>;
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
export const albumArtworkReference = z.string().max(1024).regex(
  /^https:\/\/is[1-5]-ssl\.mzstatic\.com\/image\/thumb\/[A-Za-z0-9_./-]{1,800}\/[1-9][0-9]{1,3}x[1-9][0-9]{1,3}(?:bb|cc)\.(?:jpg|png)$/,
).refine((value) => !value.includes(".."));
export const albumSnapshotSchema = z.object({
  version: z.literal(2),
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
  album: z.object({
    title: text, artist: text, artwork: albumArtworkReference.nullable(), catalog: catalogReferenceSchema.nullable(),
  }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.expires_at_ms - value.updated_at_ms !== 4000
      || (value.state === "identified") !== (value.album !== null)
      || (!value.enabled && (value.state !== "disabled" || value.active))
      || (value.enabled && value.state === "disabled")
      || (value.enabled && !value.active && value.state !== "idle")
      || (value.active && ["disabled", "idle"].includes(value.state))) {
    ctx.addIssue({ code: "custom", message: "Inconsistent album snapshot" });
  }
});
export type AlbumSnapshot = z.infer<typeof albumSnapshotSchema>;
export const albumViewSchema = z.object({
  state: z.enum(["not-configured", "offline", "disabled", "idle", "armed", "sampling", "recognizing", "identified", "unavailable"]),
  expiresAt: z.number().finite(),
  key: z.string().regex(/^[a-f0-9]{32}-[0-9]+$/).nullable(),
  album: z.object({
    title: text, artist: text,
    artworkUrl: z.string().regex(/^\/api\/line-in-album\/artwork\/[a-f0-9]{32}-[0-9]+$/).nullable(),
  }).strict().nullable(),
  tracklist: tracklistSchema.default(() => unavailableTracklist()),
}).strict();
export type AlbumView = z.infer<typeof albumViewSchema>;
