import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { LineInAlbum } from "../src/server/line-in-album.js";
import { AlbumEditions } from "../src/server/album-editions.js";
import { albumViewSchema, type AlbumSnapshot } from "../src/shared/line-in-album.js";

const sourceId = "a".repeat(64), boot = "b".repeat(32), key = `${boot}-1`, owner = "c".repeat(64);
const cover = "https://is1-ssl.mzstatic.com/image/thumb/Music/selected/400x400bb.jpg";
const roots: string[] = [], albums: LineInAlbum[] = [], editions: AlbumEditions[] = [];
afterEach(async () => {
  for (const value of editions.splice(0)) value.close();
  for (const value of albums.splice(0)) { value.close(); await value.flush(); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const source = (): AlbumSnapshot => ({
  version: 3, source_id: sourceId, boot_id: boot, generation: 1,
  album_key: key, album_success: { boot_id: boot, generation: 1, at_ms: Date.now() },
  updated_at_ms: Date.now(), expires_at_ms: Date.now() + 4000, enabled: true, active: true,
  state: "identified", silence_dbfs: -45, remembered_enabled: true, settings_error: null, cache_error: null,
  album: { title: "Original recognized title", artist: "Original artist", artwork: null,
    catalog: { kind: "collection", id: "123", country: "gb" } },
});
function collection(id: string) {
  return { resultCount: 3, results: [
    { wrapperType: "collection", collectionType: "Album", collectionId: Number(id),
      collectionName: id === "456" ? "Selected edition" : "Original catalog edition",
      artistName: "Catalog artist", trackCount: 2, ...(id === "456" ? { artworkUrl100: cover } : {}) },
    ...[1, 2].map((track) => ({
      wrapperType: "track", kind: "song", collectionId: Number(id), trackId: track,
      trackName: `Edition ${id} track ${track}`, discCount: 1, discNumber: 1, trackCount: 2, trackNumber: track,
    })),
  ] };
}
async function setup(directory: string, read: () => Promise<AlbumSnapshot | null>) {
  const catalog = vi.fn(async (reference: { id: string }) => collection(reference.id));
  const value = new LineInAlbum(sourceId, 123, read, undefined, catalog, directory);
  albums.push(value); await value.init();
  const service = new AlbumEditions(directory, () => value.originalAlbumContext(), {
    musicBrainz: { search: vi.fn(async () => []), release: vi.fn(), resolve: vi.fn(async () => null) },
    archive: { cover: vi.fn(async () => null) },
    fetchCatalog: catalog,
    search: vi.fn(async () => ({ resultCount: 1, results: [{
      wrapperType: "collection", collectionType: "Album", collectionId: 456,
      collectionName: "Selected edition", artistName: "Catalog artist",
    }] })),
    fetchCover: vi.fn(async () => ({
      bytes: await sharp({ create: { width: 1800, height: 1200, channels: 3, background: "#123456" } }).png().toBuffer(),
      type: "image/png",
    })),
  });
  editions.push(service); await service.init(); value.setEditions(service);
  return { value, service, catalog };
}

it("changes the recording effective revision when a restored selected cover is enriched, never its original context", async () => {
    const directory = await mkdtemp(path.join(process.cwd(), ".edition-integration-")); roots.push(directory);
    const identified = source();
    let snapshot: AlbumSnapshot | null = identified;
    const live = await setup(directory, async () => snapshot);
    const binding = (await live.value.view()).edition!.binding;
    const search = await live.service.search({ binding, artist: "Artist", album: "Album", country: "gb" }, owner, AbortSignal.timeout(5000));
    const preview = await live.service.preview({ binding, searchToken: search.searchToken, collectionId: "456", country: "gb" },
      owner, AbortSignal.timeout(5000));
    await live.service.confirm({ binding, previewToken: preview.previewToken, confirm: true }, owner);
    await live.value.flush(); live.value.close(); live.service.close();
    const name = (await readdir(path.join(directory, "album-editions"))).find((name) => /^[a-f0-9]{64}\.json$/.test(name))!;
    const file = path.join(directory, "album-editions", name);
    const record = JSON.parse(await readFile(file, "utf8"));
    delete record.coverVersion;
    record.jpeg = (await sharp({ create: { width: 270, height: 270, channels: 3, background: "#123456" } }).jpeg().toBuffer()).toString("base64");
    await writeFile(file, JSON.stringify(record));
    snapshot = null;
    const restored = await setup(directory, async () => snapshot);
    const before = (await restored.value.currentAlbumContext())!;
    expect(before.correction).toMatchObject({ applied: true, revision: 1 });
    snapshot = { ...identified, updated_at_ms: Date.now(), expires_at_ms: Date.now() + 4000 };
    await vi.waitFor(async () => expect((await restored.value.currentAlbumContext())?.correction.revision).toBe(2), { timeout: 5000 });
    const after = (await restored.value.currentAlbumContext())!;
    expect(after.original).toEqual(before.original);
    expect(after.effective.title).toBe(before.effective.title);
    expect(after.effective.tracklist).toEqual(before.effective.tracklist);
    expect(after.effective.artworkAsset).not.toBe(before.effective.artworkAsset);
    expect(after.effective.revision).not.toBe(before.effective.revision);
    expect(albumViewSchema.parse(await restored.value.view()).album?.artworkUrl).toBe(`/api/line-in-album/artwork/${key}?edition=2`);
    const image = await restored.value.artwork(key, AbortSignal.timeout(1000), 2);
    expect(await sharp(image!.bytes).metadata()).toMatchObject({ width: 1200, height: 800 });
    expect(await restored.value.artwork(key, AbortSignal.timeout(1000), 1)).toBeNull();
});

it("switches title/full tracks/cover together only on confirm, remembers future success and restores offline with undo", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".edition-integration-")); roots.push(directory);
  let snapshot: AlbumSnapshot | null = source();
  const live = await setup(directory, async () => snapshot);
  await vi.waitFor(async () => expect((await live.value.view()).tracklist.status).toBe("complete"));
  const original = await live.value.currentAlbumContext();
  const view = albumViewSchema.parse(await live.value.view());
  expect(view.edition?.corrected).toBe(false);
  const binding = view.edition!.binding;
  const result = await live.service.search({
    binding, artist: "Artist", album: "Album", country: "gb",
  }, owner, AbortSignal.timeout(5000));
  const preview = await live.service.preview({
    binding, searchToken: result.searchToken, collectionId: "456", country: "gb",
  }, owner, AbortSignal.timeout(5000));
  expect((await live.value.view()).album?.title).toBe("Original recognized title");
  await live.service.confirm({ binding, previewToken: preview.previewToken, confirm: true }, owner);
  const corrected = albumViewSchema.parse(await live.value.view());
  expect(corrected.album).toMatchObject({ title: "Selected edition", artworkUrl: `/api/line-in-album/artwork/${key}?edition=1` });
  expect(corrected.tracklist.tracks[0]!.title).toBe("Edition 456 track 1");
  expect(await live.value.artwork(key, AbortSignal.timeout(1000))).toBeNull();
  const image = await live.value.artwork(key, AbortSignal.timeout(1000), 1);
  expect(image?.contentType).toBe("image/jpeg");
  const context = await live.value.currentAlbumContext();
  expect(context?.original.album.title).toBe("Original recognized title");
  expect(context?.effective.catalog?.id).toBe("456");
  expect(context?.effective.revision).not.toBe(original?.effective.revision);
  expect(context?.effective.artworkAsset).toMatch(/^[a-f0-9]{64}$/);
  expect(context?.correction).toEqual({ applied: true, revision: 1, scope: "remembered" });
  snapshot = { ...snapshot!, generation: 2, album_success: { boot_id: boot, generation: 2, at_ms: Date.now() } };
  expect((await live.value.view()).edition?.corrected).toBe(true);
  await live.value.flush(); live.value.close(); live.service.close();
  snapshot = null;
  const restored = await setup(directory, async () => snapshot);
  const offline = await restored.value.view();
  expect(offline).toMatchObject({ state: "offline", edition: { corrected: true }, album: { title: "Selected edition" } });
  expect(await restored.value.artwork(key, AbortSignal.timeout(1000), 1)).toEqual(image);
  expect(restored.catalog).not.toHaveBeenCalled();
  await restored.service.remove({
    binding: offline.edition!.binding, correctionRevision: 1, confirm: true,
  }, owner);
  expect((await restored.value.view()).album?.title).toBe("Original recognized title");
  expect(await restored.value.artwork(key, AbortSignal.timeout(1000), 1)).toBeNull();
  expect((await restored.value.currentAlbumContext())?.correction).toEqual({ applied: false, revision: 2, scope: "original" });
});
