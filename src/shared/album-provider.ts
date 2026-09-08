import { z } from "zod";
import { albumArtworkReference, catalogReferenceSchema } from "./album-reference.js";

export const releaseIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
export const providerText = z.string().trim().min(1).max(256).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const detail = z.string().max(256).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
export const providerReleaseSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("apple"), collectionId: catalogReferenceSchema.shape.id,
    country: catalogReferenceSchema.shape.country }).strict(),
  z.object({ provider: z.literal("musicbrainz"), releaseId: releaseIdSchema }).strict(),
]);
export type ProviderRelease = z.infer<typeof providerReleaseSchema>;
export const providerCandidateSchema = z.object({
  release: providerReleaseSchema, title: providerText, artist: providerText,
  country: detail.nullable(), date: detail.nullable(), format: detail.nullable(), disambiguation: detail.nullable(),
}).strict();
export type ProviderCandidate = z.infer<typeof providerCandidateSchema>;
export const catalogEvidenceSchema = z.object({
  kind: z.literal("apple-release-url"),
  original: catalogReferenceSchema.refine((value) => value.kind === "collection"),
  releaseId: releaseIdSchema, resource: z.string().max(1024).regex(/^https:\/\/(?:music|itunes)\.apple\.com\/[a-z]{2}\/album\/(?:[^/?#%\\]+\/)?(?:id)?[1-9][0-9]{0,14}$/),
  relationshipType: z.enum(["98e08c20-8402-4163-8970-53504bb6a1e4", "320adf26-96fa-4183-9045-1f5f32f833cb", "08445ccf-7b99-4438-9f9a-fb9ac18099ee"]),
}).strict().superRefine((value, ctx) => {
  const match = /^https:\/\/(music|itunes)\.apple\.com\/([a-z]{2})\/album\/(?:[^/.]+\/)?(id)?([1-9][0-9]{0,14})$/.exec(value.resource);
  if (!match || match[2] !== value.original.country || match[4] !== value.original.id
    || match[1] === "music" && match[3] || match[1] === "itunes" && !match[3]) {
    ctx.addIssue({ code: "custom", message: "Evidence must identify the exact original Apple collection and storefront" });
  }
});
export type CatalogEvidence = z.infer<typeof catalogEvidenceSchema>;
export const providerArtworkSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("apple"), sourceUrl: albumArtworkReference }).strict(),
  z.object({ provider: z.literal("cover-art-archive"), releaseId: releaseIdSchema,
    imageId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    sourceUrl: z.string().max(1024).regex(/^https:\/\/coverartarchive\.org\/release\/[a-f0-9-]+\/[1-9][0-9]{0,19}-1200\.jpg$/) }).strict(),
]);
export const providerProvenanceSchema = z.object({
  release: providerReleaseSchema, origin: z.enum(["automatic-catalog", "manual"]),
  catalogUrl: z.string().max(1024), evidence: catalogEvidenceSchema.nullable(),
  artwork: providerArtworkSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  const release = value.release;
  const expected = release.provider === "apple"
    ? `https://music.apple.com/${release.country}/album/${release.collectionId}`
    : `https://musicbrainz.org/release/${release.releaseId}`;
  if (value.catalogUrl !== expected
    || value.origin === "automatic-catalog" && (!value.evidence || release.provider !== "musicbrainz")
    || value.evidence && (release.provider !== "musicbrainz" || release.releaseId !== value.evidence.releaseId)
    || value.artwork?.provider === "cover-art-archive" && (release.provider !== "musicbrainz"
      || value.artwork.releaseId !== release.releaseId
      || value.artwork.sourceUrl !== `https://coverartarchive.org/release/${release.releaseId}/${value.artwork.imageId}-1200.jpg`)
    || value.artwork?.provider === "apple" && release.provider !== "apple") {
    ctx.addIssue({ code: "custom", message: "Inconsistent catalog provenance" });
  }
});
export type ProviderProvenance = z.infer<typeof providerProvenanceSchema>;
export const fallbackStatusSchema = z.object({
  state: z.enum(["idle", "loading", "resolved", "confirmation-required", "no-match", "incomplete", "unavailable", "suppressed"]),
  message: z.string().max(256), retryAt: z.number().int().nonnegative().nullable(),
  candidates: z.array(providerCandidateSchema).max(20),
}).strict();
export type FallbackStatus = z.infer<typeof fallbackStatusSchema>;
