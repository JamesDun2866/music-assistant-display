import { z } from "zod";
import { catalogReferenceSchema, tracklistSchema, type CatalogReference, type Tracklist } from "../shared/line-in-album.js";
import { catalogEvidenceSchema, providerCandidateSchema, providerText, releaseIdSchema, type CatalogEvidence,
  type ProviderCandidate } from "../shared/album-provider.js";
import { ProviderError, ProviderNetwork, type ProviderBudget } from "./album-provider-network.js";

const relationships = new Set([
  "98e08c20-8402-4163-8970-53504bb6a1e4", // Purchase for download.
  "320adf26-96fa-4183-9045-1f5f32f833cb", // Subscription streaming.
  "08445ccf-7b99-4438-9f9a-fb9ac18099ee", // Free streaming.
]);
const count = z.number().int().min(1).max(200);
const credit = z.array(z.object({ name: providerText, joinphrase: z.string().max(64).optional() })).min(1).max(32);
const descriptor = z.string().max(256).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const releaseSummary = z.object({
  id: releaseIdSchema, title: providerText, "artist-credit": credit,
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  date: z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/).optional(),
  disambiguation: descriptor.optional(),
  media: z.array(z.object({ format: descriptor.nullable().optional() })).max(200).optional(),
});
const relation = z.object({
  "target-type": z.string(), "type-id": releaseIdSchema, direction: z.enum(["forward", "backward"]),
  ended: z.boolean().optional(), attributes: z.array(z.string()).max(32).optional(),
  url: z.object({ resource: z.string().max(1024) }).optional(),
  release: z.object({ id: releaseIdSchema }).optional(),
});
const relationList = z.array(relation).max(100);
const track = z.object({ id: releaseIdSchema, position: count, title: providerText });
const fullRelease = releaseSummary.extend({
  media: z.array(z.object({
    position: count, "track-count": count, "track-offset": z.literal(0).optional(),
    tracks: z.array(track).min(1).max(200),
    pregap: z.null().optional(), "data-tracks": z.array(z.unknown()).max(0).optional(),
    "data-track-count": z.literal(0).optional(),
  })).min(1).max(200),
  relations: relationList,
});

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const value = schema.safeParse(raw);
  if (!value.success) throw new ProviderError("invalid-response");
  return value.data;
}
function artistName(value: z.infer<typeof credit>): string {
  return parse(providerText, value.map((part) => part.name + (part.joinphrase ?? "")).join(""));
}
function candidate(raw: unknown): ProviderCandidate {
  const release = parse(releaseSummary, raw);
  return providerCandidateSchema.parse({
    release: { provider: "musicbrainz", releaseId: release.id }, title: release.title,
    artist: artistName(release["artist-credit"]), country: release.country ?? null, date: release.date ?? null,
    format: [...new Set(release.media?.map((medium) => medium.format).filter(Boolean))].join(" / ").slice(0, 256) || null,
    disambiguation: release.disambiguation || null,
  });
}

export function musicBrainzSearch(raw: unknown): ProviderCandidate[] {
  const value = parse(z.object({ releases: z.array(z.unknown()).max(20), count: z.number().int().nonnegative(),
    offset: z.literal(0) }), raw);
  if (value.count < value.releases.length) throw new ProviderError("invalid-response");
  const results = value.releases.map(candidate);
  if (new Set(results.map((item) => JSON.stringify(item.release))).size !== results.length) throw new ProviderError("invalid-response");
  return results;
}

export interface MusicBrainzRelease {
  candidate: ProviderCandidate;
  tracklist: Tracklist;
  links: z.infer<typeof relationList>;
}
export function musicBrainzRelease(raw: unknown, releaseId: string): MusicBrainzRelease {
  const release = parse(fullRelease, raw);
  if (release.id !== releaseIdSchema.parse(releaseId)) throw new ProviderError("invalid-response");
  const media = [...release.media].sort((a, b) => a.position - b.position);
  const tracks: Tracklist["tracks"] = [];
  const trackIds = new Set<string>();
  for (const [index, medium] of media.entries()) {
    if (medium.position !== index + 1 || medium.tracks.length !== medium["track-count"]) throw new ProviderError("invalid-response");
    for (const [position, item] of [...medium.tracks].sort((a, b) => a.position - b.position).entries()) {
      if (item.position !== position + 1 || trackIds.has(item.id)) throw new ProviderError("invalid-response");
      trackIds.add(item.id);
      tracks.push({ disc: medium.position, number: item.position, title: item.title });
    }
  }
  const summary = candidate(raw);
  const tracklist = parse(tracklistSchema, { status: "complete", message: null, title: summary.title,
    artist: summary.artist, discCount: media.length, tracks });
  return { candidate: summary, tracklist, links: release.relations };
}

/** Parse the original storefront identity, never a song URL or another storefront. */
export function appleCollectionResource(resource: string): CatalogReference | null {
  if (resource.length > 1024 || /[%\\?#\s]/.test(resource)) return null;
  const match = /^https:\/\/(music|itunes)\.apple\.com\/([a-z]{2})\/album\/(?:[^/.]+\/)?(id)?([1-9][0-9]{0,14})$/.exec(resource);
  if (!match || match[1] === "music" && match[3] || match[1] === "itunes" && !match[3]) return null;
  return { kind: "collection", id: match[4]!, country: match[2]! };
}
export function appleCollectionResources(reference: CatalogReference): string[] {
  const value = catalogReferenceSchema.parse(reference);
  if (value.kind !== "collection") throw new ProviderError("denied");
  return [`https://music.apple.com/${value.country}/album/${value.id}`,
    `https://itunes.apple.com/${value.country}/album/id${value.id}`];
}
const sameCollection = (left: CatalogReference | null, right: CatalogReference) =>
  left?.kind === "collection" && right.kind === "collection" && left.id === right.id && left.country === right.country;
const approved = (value: z.infer<typeof relation>, direction: "forward" | "backward") =>
  value.direction === direction && relationships.has(value["type-id"]) && !value.ended && !value.attributes?.length;

export function reverseAppleReleases(raw: unknown, original: CatalogReference): string[] {
  const urls = parse(z.object({ urls: z.array(z.object({
    resource: z.string().max(1024), relations: relationList,
  })).max(4), "url-offset": z.literal(0), "url-count": z.number().int().min(0).max(4) }), raw);
  if (urls["url-count"] !== urls.urls.length) throw new ProviderError("invalid-response");
  const requested = new Set(appleCollectionResources(original));
  const ids = new Set<string>();
  for (const url of urls.urls) {
    if (!requested.has(url.resource) || !sameCollection(appleCollectionResource(url.resource), original)
      || url.relations.length >= 25) throw new ProviderError("invalid-response");
    for (const link of url.relations) {
      if (link["target-type"] !== "release") continue;
      if (!link.release || !approved(link, "backward")) return [];
      ids.add(link.release.id);
    }
  }
  return [...ids];
}

export function corroborateAppleRelease(release: MusicBrainzRelease, original: CatalogReference): CatalogEvidence | null {
  if (release.candidate.release.provider !== "musicbrainz" || original.kind !== "collection" || release.links.length >= 25) return null;
  const links = release.links.filter((link) => link["target-type"] === "url" && approved(link, "forward") && link.url);
  const matching = links.filter((link) => sameCollection(appleCollectionResource(link.url!.resource), original));
  if (!matching.length || links.some((link) => {
    const value = appleCollectionResource(link.url!.resource);
    return value?.country === original.country && value.id !== original.id;
  })) return null;
  const link = matching[0]!;
  return catalogEvidenceSchema.parse({ kind: "apple-release-url", original, releaseId: release.candidate.release.releaseId,
    resource: link.url!.resource, relationshipType: link["type-id"] });
}

function searchQuery(artist: string, album: string): string {
  const escape = (value: string) => providerText.parse(value).replace(/([+\-!(){}[\]^"~*?:\\/&|])/g, "\\$1");
  return `artist:"${escape(artist)}" AND release:"${escape(album)}"`;
}
export class MusicBrainzCatalog {
  constructor(private readonly network = new ProviderNetwork()) {}
  private async json(url: string, signal: AbortSignal, budget?: ProviderBudget): Promise<unknown> {
    const response = await this.network.get(url, signal, { kind: "musicbrainz", budget });
    try { return JSON.parse(response.bytes.toString("utf8")) as unknown; }
    catch { throw new ProviderError("invalid-response"); }
  }
  async search(artist: string, album: string, signal: AbortSignal, budget?: ProviderBudget): Promise<ProviderCandidate[]> {
    const query = new URLSearchParams({ query: searchQuery(artist, album), limit: "20", fmt: "json" });
    return musicBrainzSearch(await this.json(`https://musicbrainz.org/ws/2/release?${query}`, signal, budget));
  }
  async release(id: string, signal: AbortSignal, budget?: ProviderBudget): Promise<MusicBrainzRelease> {
    const query = new URLSearchParams({ inc: "recordings+artist-credits+url-rels", fmt: "json" });
    return musicBrainzRelease(await this.json(`https://musicbrainz.org/ws/2/release/${releaseIdSchema.parse(id)}?${query}`, signal, budget), id);
  }
  async resolve(original: CatalogReference, signal: AbortSignal, budget?: ProviderBudget): Promise<{
    release: MusicBrainzRelease; evidence: CatalogEvidence;
  } | null> {
    const query = new URLSearchParams({ inc: "release-rels", fmt: "json" });
    for (const resource of appleCollectionResources(original)) query.append("resource", resource);
    let raw: unknown;
    try { raw = await this.json(`https://musicbrainz.org/ws/2/url?${query}`, signal, budget); }
    catch (error) { if (error instanceof ProviderError && error.code === "not-found") return null; throw error; }
    const ids = reverseAppleReleases(raw, original);
    if (ids.length !== 1) return null;
    const release = await this.release(ids[0]!, signal, budget);
    const evidence = corroborateAppleRelease(release, original);
    return evidence ? { release, evidence } : null;
  }
}
