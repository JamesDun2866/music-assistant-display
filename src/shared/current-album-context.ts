import { z } from "zod";
import { albumKeySchema, albumMetadataSchema, albumSuccessSchema, catalogReferenceSchema, tracklistSchema } from "./line-in-album.js";
import { providerProvenanceSchema } from "./album-provider.js";

/** Internal local integration contract; never serialize this directly into recording sidecars. */
export const currentAlbumContextSchema = z.object({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/),
  original: z.object({
    albumKey: albumKeySchema,
    success: albumSuccessSchema.nullable(),
    album: albumMetadataSchema,
  }).strict(),
  effective: z.object({
    title: z.string().min(1).max(256),
    artist: z.string().min(1).max(256),
    catalog: catalogReferenceSchema.nullable(),
    tracklist: tracklistSchema,
    artworkAsset: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    provenance: providerProvenanceSchema.nullable().optional(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  correction: z.object({
    applied: z.boolean(),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    scope: z.enum(["original", "remembered", "current-album"]),
  }).strict(),
}).strict();
export type CurrentAlbumContext = z.infer<typeof currentAlbumContextSchema>;
