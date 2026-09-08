import { z } from "zod";
import { albumEditionBindingSchema, tracklistSchema } from "./line-in-album.js";
import { providerCandidateSchema, providerProvenanceSchema, releaseIdSchema } from "./album-provider.js";

const token = z.string().regex(/^[a-f0-9]{64}$/);
const country = z.string().regex(/^[a-z]{2}$/);
const collectionId = z.string().regex(/^[1-9][0-9]{0,14}$/);
const text = z.string().trim().min(1).max(256).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const query = text.refine((value) => !/https?:|www\.|:\/\//i.test(value), "Enter names, not URLs");
export const editionBindingSchema = albumEditionBindingSchema;
export type EditionBinding = z.infer<typeof editionBindingSchema>;
export const editionSearchInputSchema = z.union([
  z.object({ binding: editionBindingSchema, artist: query, album: query, country, provider: z.literal("apple").optional() }).strict(),
  z.object({ binding: editionBindingSchema, artist: query, album: query, provider: z.literal("musicbrainz") }).strict(),
]);
export const editionPreviewInputSchema = z.union([
  z.object({ binding: editionBindingSchema, searchToken: token, collectionId, country, provider: z.literal("apple").optional() }).strict(),
  z.object({ binding: editionBindingSchema, searchToken: token, releaseId: releaseIdSchema, provider: z.literal("musicbrainz") }).strict(),
]);
export const editionMetadataRetrySchema = z.object({ binding: editionBindingSchema }).strict();
export const editionConfirmInputSchema = z.object({
  binding: editionBindingSchema, previewToken: token, confirm: z.literal(true),
}).strict();
export const editionRemoveInputSchema = z.object({
  binding: editionBindingSchema, correctionRevision: z.number().int().positive(), confirm: z.literal(true),
}).strict();
export const editionResultSchema = z.union([
  z.object({ collectionId, country, title: text, artist: text }).strict(),
  providerCandidateSchema.omit({ release: true }).extend({ provider: z.literal("musicbrainz"), releaseId: releaseIdSchema }).strict(),
]);
export const editionSearchResponseSchema = z.object({
  searchToken: token, results: z.array(editionResultSchema).max(20),
}).strict();
const previewCommon = z.object({
  previewToken: token, title: text, artist: text,
  artworkUrl: z.string().regex(/^\/api\/line-in-album\/edition\/artwork\/[a-f0-9]{64}$/).nullable(),
  artworkUnavailable: z.boolean(),
  tracklist: tracklistSchema.refine((value) => value.status === "complete"),
  scope: z.enum(["remembered", "current-album"]),
  provenance: providerProvenanceSchema.optional(),
}).strict();
export const editionPreviewResponseSchema = z.union([
  previewCommon.extend({ country, collectionId }).strict(),
  previewCommon.extend({ provider: z.literal("musicbrainz"), releaseId: releaseIdSchema,
    country: z.string().max(256).nullable(), date: z.string().max(256).nullable(), format: z.string().max(256).nullable(),
    disambiguation: z.string().max(256).nullable() }).strict(),
]);
export const editionMutationResponseSchema = z.object({
  binding: editionBindingSchema, corrected: z.boolean(), scope: z.enum(["remembered", "current-album", "original"]),
}).strict();
export type EditionSearchInput = z.infer<typeof editionSearchInputSchema>;
export type EditionPreviewInput = z.infer<typeof editionPreviewInputSchema>;
export type EditionConfirmInput = z.infer<typeof editionConfirmInputSchema>;
export type EditionRemoveInput = z.infer<typeof editionRemoveInputSchema>;
export type EditionSearchResponse = z.infer<typeof editionSearchResponseSchema>;
export type EditionPreviewResponse = z.infer<typeof editionPreviewResponseSchema>;
export type EditionMutationResponse = z.infer<typeof editionMutationResponseSchema>;
