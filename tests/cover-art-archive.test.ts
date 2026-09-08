import { expect, it, vi } from "vitest";
import { coverArtManifest, CoverArtArchive } from "../src/server/cover-art-archive.js";
import { ProviderError, ProviderNetwork } from "../src/server/album-provider-network.js";
const id = "76df3287-6cda-33eb-8e9a-044b5e15ffdd";
function manifest() {
  return { release: `https://musicbrainz.org/release/${id}`, images: [{
    id: 829521842, front: true, approved: true,
    image: `http://coverartarchive.org/release/${id}/829521842.jpg`,
    thumbnails: { "1200": `http://coverartarchive.org/release/${id}/829521842-1200.jpg` },
  }] };
}
it("normalizes a published manifest shape into a constructed HTTPS 1200 same-release identity", () => {
  expect(coverArtManifest(manifest(), id)).toEqual({
    provider: "cover-art-archive", releaseId: id, imageId: "829521842",
    sourceUrl: `https://coverartarchive.org/release/${id}/829521842-1200.jpg`,
  });
});
it("rejects ambiguous fronts, wrong releases/image IDs and untrusted image metadata", () => {
  const other = manifest(); other.release = `https://musicbrainz.org/release-group/${id}`;
  expect(() => coverArtManifest(other, id)).toThrow();
  const multiple = manifest(); multiple.images.push({ ...multiple.images[0]!, id: 999 });
  expect(() => coverArtManifest(multiple, id)).toThrow();
  const wrong = manifest(); wrong.images[0]!.thumbnails["1200"] = "https://localhost/cover.jpg";
  expect(() => coverArtManifest(wrong, id)).toThrow();
  const image = manifest(); image.images[0]!.image = image.images[0]!.image.replace("829521842", "1");
  expect(() => coverArtManifest(image, id)).toThrow();
});
it("reports no approved high-resolution front honestly, without other-edition or low-res guessing", () => {
  const unapproved = manifest(); unapproved.images[0]!.approved = false;
  expect(coverArtManifest(unapproved, id)).toBeNull();
  expect(coverArtManifest({ ...manifest(), images: [] }, id)).toBeNull();
  const low = manifest(); Object.assign(low.images[0]!, { thumbnails: { "500": "https://never-fetch" } });
  expect(coverArtManifest(low, id)).toBeNull();
});
it("fetches only the chosen manifest and canonical image, propagating errors but distinguishing 404", async () => {
  const network = new ProviderNetwork();
  const get = vi.spyOn(network, "get").mockResolvedValueOnce({
    bytes: Buffer.from(JSON.stringify(manifest())), type: "application/json",
  }).mockResolvedValueOnce({ bytes: Buffer.from("synthetic-image"), type: "image/jpeg" });
  const cover = new CoverArtArchive(network);
  const result = await cover.cover(id, new AbortController().signal);
  expect(result?.provenance.imageId).toBe("829521842");
  expect(get.mock.calls[1]![0]).toBe(`https://coverartarchive.org/release/${id}/829521842-1200.jpg`);
  get.mockRejectedValueOnce(new ProviderError("not-found"));
  expect(await cover.cover(id, new AbortController().signal)).toBeNull();
  get.mockRejectedValueOnce(new ProviderError("unavailable"));
  await expect(cover.cover(id, new AbortController().signal)).rejects.toThrow();
  get.mockRestore();
});
