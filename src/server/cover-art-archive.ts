import { z } from "zod";
import { releaseIdSchema, type ProviderProvenance } from "../shared/album-provider.js";
import { ProviderError, ProviderNetwork, type ProviderBudget } from "./album-provider-network.js";

const imageId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String),
  z.string().regex(/^[1-9][0-9]{0,19}$/)]);
const manifestSchema = z.object({
  release: z.string().max(1024),
  images: z.array(z.object({
    id: imageId, front: z.boolean(), approved: z.boolean(),
    image: z.string().max(1024),
    thumbnails: z.object({ "1200": z.string().max(1024).optional() }),
  })).max(200),
});
export type ArchiveArtwork = Extract<NonNullable<ProviderProvenance["artwork"]>, { provider: "cover-art-archive" }>;

export function coverArtManifest(raw: unknown, releaseId: string): ArchiveArtwork | null {
  const id = releaseIdSchema.parse(releaseId);
  const value = manifestSchema.safeParse(raw);
  if (!value.success || ![`https://musicbrainz.org/release/${id}`, `http://musicbrainz.org/release/${id}`].includes(value.data.release)) {
    throw new ProviderError("invalid-response");
  }
  const fronts = value.data.images.filter((image) => image.front && image.approved);
  if (fronts.length > 1 || new Set(value.data.images.map((image) => image.id)).size !== value.data.images.length) {
    throw new ProviderError("invalid-response");
  }
  const front = fronts[0];
  if (!front || !front.thumbnails["1200"]) return null;
  const base = `coverartarchive.org/release/${id}/${front.id}`;
  if (![...["http", "https"].flatMap((scheme) => ["jpg", "png"].map((ext) => `${scheme}://${base}.${ext}`))]
    .includes(front.image) || ![`http://${base}-1200.jpg`, `https://${base}-1200.jpg`].includes(front.thumbnails["1200"])) {
    throw new ProviderError("denied");
  }
  return { provider: "cover-art-archive", releaseId: id, imageId: front.id, sourceUrl: `https://${base}-1200.jpg` };
}

export class CoverArtArchive {
  constructor(private readonly network = new ProviderNetwork()) {}
  async cover(releaseId: string, signal: AbortSignal, budget?: ProviderBudget): Promise<{
    bytes: Buffer; type: string; provenance: ArchiveArtwork;
  } | null> {
    const id = releaseIdSchema.parse(releaseId);
    try {
      const manifest = await this.network.get(`https://coverartarchive.org/release/${id}`, signal,
        { kind: "caa-manifest", releaseId: id, budget });
      let raw: unknown;
      try { raw = JSON.parse(manifest.bytes.toString("utf8")); }
      catch { throw new ProviderError("invalid-response"); }
      const provenance = coverArtManifest(raw, id);
      if (!provenance) return null;
      const image = await this.network.get(provenance.sourceUrl, signal,
        { kind: "caa-image", releaseId: id, imageId: provenance.imageId, budget });
      return { ...image, provenance };
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not-found") return null;
      throw error;
    }
  }
}
