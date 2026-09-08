import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AlbumEditions, type OriginalAlbumContext } from "../src/server/album-editions.js";

vi.mock("node:fs/promises", async (actual) => {
  const filesystem = await actual<typeof import("node:fs/promises")>();
  return { ...filesystem, rename: vi.fn(filesystem.rename) };
});
const renameMock = vi.mocked(rename);
const roots: string[] = [], services: AlbumEditions[] = [];
afterEach(async () => {
  services.splice(0).forEach((service) => service.close());
  renameMock.mockClear();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  renameMock.mockImplementation(actual.rename);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(process.cwd(), ".edition-storage-")); roots.push(root);
  let original: OriginalAlbumContext = {
    sourceId: "a".repeat(64), albumKey: `${"b".repeat(32)}-1`,
    success: { boot_id: "b".repeat(32), generation: 1, at_ms: 1000 },
    album: { title: "Original", artist: "Artist", artwork: null, catalog: { kind: "collection", id: "123", country: "gb" } },
  };
  const collection = { wrapperType: "collection", collectionType: "Album", collectionId: 456,
    collectionName: "Selected", artistName: "Artist", trackCount: 1 };
  const service = new AlbumEditions(root, async () => original, {
    search: async () => ({ resultCount: 1, results: [collection] }),
    fetchCatalog: async () => ({ resultCount: 2, results: [collection, {
      wrapperType: "track", kind: "song", collectionId: 456, trackId: 789, trackName: "Track",
      trackCount: 1, trackNumber: 1, discNumber: 1, discCount: 1,
    }] }),
  });
  services.push(service); await service.init();
  const binding = await service.binding(original);
  const search = await service.search({ binding, artist: "Artist", album: "Album", country: "gb" }, "session", AbortSignal.timeout(1000));
  const preview = await service.preview({ binding, searchToken: search.searchToken, collectionId: "456", country: "gb" },
    "session", AbortSignal.timeout(1000));
  return { service, root, get: () => original, change: () => { original = { ...original, success: { ...original.success!, generation: 2 } }; },
    input: { binding, previewToken: preview.previewToken, confirm: true } };
}
const transient = () => Object.assign(new Error("Temporary replacement contention"), { code: "EPERM" });
it.skipIf(process.platform !== "win32")("retries transient Windows atomic replacement without refetching or unlinking accepted data", async () => {
  const f = await fixture();
  renameMock.mockRejectedValueOnce(transient()).mockRejectedValueOnce(transient());
  await f.service.confirm(f.input, "session");
  expect(renameMock).toHaveBeenCalledTimes(3);
  expect((await f.service.effective(f.get()))?.album.title).toBe("Selected");
});
it.skipIf(process.platform !== "win32")("rechecks the binding before retrying a contended replacement", async () => {
  const f = await fixture();
  renameMock.mockImplementationOnce(async () => { f.change(); throw transient(); });
  await expect(f.service.confirm(f.input, "session")).rejects.toThrow(/changed/);
  expect(renameMock).toHaveBeenCalledOnce();
  expect(await readdir(path.join(f.root, "album-editions"))).toEqual([]);
});
it.skipIf(process.platform !== "win32")("surfaces persistent replacement errors and cleans its temporary record", async () => {
  const f = await fixture();
  renameMock.mockRejectedValue(transient());
  await expect(f.service.confirm(f.input, "session")).rejects.toThrow(/contention/);
  expect(renameMock).toHaveBeenCalledTimes(4);
  expect(await readdir(path.join(f.root, "album-editions"))).toEqual([]);
});
