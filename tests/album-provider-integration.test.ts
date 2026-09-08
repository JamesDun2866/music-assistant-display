import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { AlbumEditions, type OriginalAlbumContext } from "../src/server/album-editions.js";
import { LineInAlbum } from "../src/server/line-in-album.js";
import { albumViewSchema, type AlbumSnapshot, type Tracklist } from "../src/shared/line-in-album.js";
import type { CatalogEvidence, ProviderCandidate } from "../src/shared/album-provider.js";
import type { MusicBrainzRelease } from "../src/server/musicbrainz-catalog.js";
import { recordingAlbumContext } from "../src/server/source-tools.js";

const releaseId = "76df3287-6cda-33eb-8e9a-044b5e15ffdd";
const sourceId = "a".repeat(64), boot = "b".repeat(32), session = "c".repeat(64);
const originals = (): OriginalAlbumContext => ({
  sourceId, albumKey: `${boot}-1`, success: { boot_id: boot, generation: 1, at_ms: 1000 },
  album: { title: "Original recognition", artist: "Original artist", artwork: null,
    catalog: { kind: "collection", id: "123", country: "gb" } },
});
const candidate: ProviderCandidate = {
  release: { provider: "musicbrainz", releaseId }, title: "Exact release", artist: "Catalog artist",
  country: "GB", date: "2000", format: "CD", disambiguation: "Test",
};
const tracks: Tracklist = { status: "complete", message: null, title: candidate.title, artist: candidate.artist,
  discCount: 2, tracks: [{ disc: 1, number: 1, title: "First" }, { disc: 2, number: 1, title: "Second" }] };
const release: MusicBrainzRelease = { candidate, tracklist: tracks, links: [] };
const evidence: CatalogEvidence = {
  kind: "apple-release-url", original: originals().album.catalog!, releaseId,
  resource: "https://music.apple.com/gb/album/123", relationshipType: "320adf26-96fa-4183-9045-1f5f32f833cb",
};
const roots: string[] = [], services: AlbumEditions[] = [], albums: LineInAlbum[] = [];
afterEach(async () => {
  services.splice(0).forEach((service) => service.close());
  for (const album of albums.splice(0)) { album.close(); await album.flush(); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
async function setup(options: ConstructorParameters<typeof AlbumEditions>[2] = {}) {
  const root = await mkdtemp(path.join(process.cwd(), ".provider-test-")); roots.push(root);
  let original = originals();
  const mb = { search: vi.fn(async () => [candidate]), release: vi.fn(async () => release),
    resolve: vi.fn(async () => ({ release, evidence })) };
  const archive = { cover: vi.fn(async () => null) };
  const service = new AlbumEditions(root, async () => original, { sourceUid: 123, musicBrainz: mb, archive, ...options });
  services.push(service); await service.init();
  return { root, service, mb, archive, get: () => original, set: (next: OriginalAlbumContext) => { original = next; } };
}
async function select(f: Awaited<ReturnType<typeof setup>>) {
  const binding = await f.service.binding(f.get());
  const search = await f.service.search({ binding, artist: "Search artist", album: "Search album", provider: "musicbrainz" }, session, AbortSignal.timeout(5000));
  const preview = await f.service.preview({ binding, searchToken: search.searchToken, releaseId, provider: "musicbrainz" }, session, AbortSignal.timeout(5000));
  return { binding, preview, input: { binding, previewToken: preview.previewToken, confirm: true } };
}
it("applies an exact automatic catalog result without altering original recognition or claiming manual correction", async () => {
  const f = await setup();
  const original = structuredClone(f.get());
  const status = await f.service.retryMetadata({ binding: await f.service.binding(f.get()) }, session, AbortSignal.timeout(5000));
  expect(status).toMatchObject({ state: "resolved" });
  const effective = await f.service.effective(f.get());
  expect(effective).toMatchObject({ album: { catalog: null, artwork: null }, tracklist: tracks,
    provenance: { origin: "automatic-catalog", release: { provider: "musicbrainz", releaseId }, evidence } });
  expect(f.get()).toEqual(original);
  expect(f.archive.cover).toHaveBeenCalledWith(releaseId, expect.any(AbortSignal), expect.anything());
});
it("missing original identity yields cached candidates only until a complete manual preview is confirmed", async () => {
  const f = await setup();
  f.set({ ...f.get(), album: { ...f.get().album, catalog: null } });
  const status = await f.service.retryMetadata({ binding: await f.service.binding(f.get()) }, session, AbortSignal.timeout(5000));
  expect(status.state).toBe("confirmation-required");
  expect(f.mb.resolve).not.toHaveBeenCalled();
  expect(await f.service.effective(f.get())).toBeNull();
  const flow = await select(f);
  expect(flow.preview).toMatchObject({ scope: "current-album", artworkUnavailable: true, tracklist: tracks });
  await f.service.confirm(flow.input, session);
  expect((await f.service.effective(f.get()))?.provenance.origin).toBe("manual");
  f.set({ ...f.get(), success: { ...f.get().success!, generation: 2 } });
  expect(await f.service.effective(f.get())).toBeNull();
});
it("failed original Apple track lookup does not block current-success manual selection", async () => {
  const f = await setup({ fetchCatalog: vi.fn(async () => { throw new Error("Apple outage"); }) });
  f.set({ ...f.get(), album: { ...f.get().album, catalog: { kind: "track", id: "9", country: "gb" } } });
  const flow = await select(f);
  expect(flow.preview.scope).toBe("current-album");
  await f.service.confirm(flow.input, session);
  expect((await f.service.effective(f.get()))?.album.title).toBe("Exact release");
});
it("explicit metadata retry recovers an original identity past a current-success removal and restores it offline", async () => {
  let available = false;
  const lookup = vi.fn(async () => {
    if (!available) throw new Error("Apple outage");
    return { resultCount: 1, results: [{ wrapperType: "track", kind: "song", trackId: 9, collectionId: 123 }] };
  });
  const f = await setup({ fetchCatalog: lookup });
  f.set({ ...f.get(), album: { ...f.get().album, catalog: { kind: "track", id: "9", country: "gb" } } });
  const flow = await select(f);
  await f.service.confirm(flow.input, session);
  const binding = await f.service.binding(f.get());
  await f.service.remove({ binding, correctionRevision: binding.revision, confirm: true }, session);
  lookup.mockClear(); available = true;
  const result = await f.service.retryMetadata({ binding: await f.service.binding(f.get()) }, session, AbortSignal.timeout(5000));
  expect(result.state).toBe("resolved");
  expect(lookup).toHaveBeenCalledOnce();
  expect(f.mb.resolve).toHaveBeenCalledOnce();
  const effective = await f.service.effective(f.get());
  expect(effective).toMatchObject({ scope: "remembered", provenance: { origin: "automatic-catalog" } });
  f.service.close();
  const restored = new AlbumEditions(f.root, async () => f.get(), { sourceUid: 123, fetchCatalog: vi.fn() });
  services.push(restored); await restored.init();
  expect(await restored.effective(f.get())).toEqual(effective);
});
it("manual selection wins and restore-original suppresses automatic reattachment for the same success", async () => {
  const f = await setup();
  const flow = await select(f); await f.service.confirm(flow.input, session);
  const binding = await f.service.binding(f.get());
  expect((await f.service.retryMetadata({ binding }, session, AbortSignal.timeout(5000))).state).toBe("suppressed");
  expect(f.mb.resolve).not.toHaveBeenCalled();
  await f.service.remove({ binding, correctionRevision: binding.revision, confirm: true }, session);
  expect(await f.service.effective(f.get())).toBeNull();
  f.service.catalogFallback(f.get(), true, true);
  await vi.waitFor(() => expect(f.service.catalogFallback(f.get(), true, true).state).not.toBe("loading"));
  expect(f.mb.resolve).not.toHaveBeenCalled();
});
it("restores provider identity, complete tracks and synthetic full-size artwork offline", async () => {
  const png = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#123456" } }).png().toBuffer();
  const f = await setup({ archive: { cover: vi.fn(async () => ({
    bytes: png, type: "image/png", provenance: { provider: "cover-art-archive" as const, releaseId,
      imageId: "1234", sourceUrl: `https://coverartarchive.org/release/${releaseId}/1234-1200.jpg` },
  })) } });
  await f.service.retryMetadata({ binding: await f.service.binding(f.get()) }, session, AbortSignal.timeout(5000));
  const before = (await f.service.effective(f.get()))!;
  expect(await sharp(before.jpeg!).metadata()).toMatchObject({ width: 1200, height: 900 });
  f.service.close();
  const network = vi.fn(async () => { throw new Error("offline"); });
  const restored = new AlbumEditions(f.root, async () => f.get(), {
    sourceUid: 123, musicBrainz: { search: network, release: network, resolve: network }, archive: { cover: network },
  });
  services.push(restored); await restored.init();
  expect(await restored.effective(f.get())).toEqual(before);
  expect(restored.catalogFallback(f.get(), true, false).state).toBe("resolved");
  expect(network).not.toHaveBeenCalled();
});
it("rejects cross-UID provider restoration and leaves durable choices on disk", async () => {
  const f = await setup(); const flow = await select(f); await f.service.confirm(flow.input, session);
  const wrong = new AlbumEditions(f.root, async () => f.get(), { sourceUid: 999 });
  services.push(wrong); await wrong.init();
  await expect(wrong.effective(f.get())).rejects.toThrow(/ownership/);
  expect((await readdir(path.join(f.root, "album-editions"))).some((file) => /^[a-f0-9]{64}\.json$/.test(file))).toBe(true);
});
it("does not commit an automatic result after a manual choice wins the same binding", async () => {
  let finish!: (value: { release: MusicBrainzRelease; evidence: CatalogEvidence }) => void;
  const resolve = vi.fn(() => new Promise<{ release: MusicBrainzRelease; evidence: CatalogEvidence }>((done) => { finish = done; }));
  const f = await setup({ musicBrainz: { search: vi.fn(async () => [candidate]), release: vi.fn(async () => release), resolve } });
  f.service.catalogFallback(f.get(), true, true);
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  const flow = await select(f);
  await f.service.confirm(flow.input, session);
  finish({ release, evidence });
  await vi.waitFor(() => expect(f.service.catalogFallback(f.get(), false, true).state).toBe("suppressed"));
  expect((await f.service.effective(f.get()))?.provenance.origin).toBe("manual");
  expect((await f.service.binding(f.get())).revision).toBe(1);
});
it("cancels a provider result when the original success changes before persistence", async () => {
  let finish!: (value: { release: MusicBrainzRelease; evidence: CatalogEvidence }) => void;
  const resolve = vi.fn(() => new Promise<{ release: MusicBrainzRelease; evidence: CatalogEvidence }>((done) => { finish = done; }));
  const f = await setup({ musicBrainz: { search: vi.fn(async () => []), release: vi.fn(async () => release), resolve } });
  const pending = f.service.retryMetadata({ binding: await f.service.binding(f.get()) }, session, AbortSignal.timeout(5000));
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  f.set({ ...f.get(), success: { ...f.get().success!, generation: 2 } });
  finish({ release, evidence }); await pending;
  expect(await f.service.effective(f.get())).toBeNull();
});
it("migrates legacy manual Apple records without repurposing their catalog identity", async () => {
  const f = await setup(); const flow = await select(f); await f.service.confirm(flow.input, session);
  const directory = path.join(f.root, "album-editions");
  const file = (await readdir(directory)).find((value) => /^[a-f0-9]{64}\.json$/.test(value))!;
  const data = JSON.parse(await readFile(path.join(directory, file), "utf8"));
  delete data.provenance; delete data.sourceUid; data.version = 1;
  data.album.catalog = { kind: "collection", country: "gb", id: "456" };
  await writeFile(path.join(directory, file), JSON.stringify(data));
  expect(await f.service.effective(f.get())).toMatchObject({
    album: { catalog: { id: "456" } }, provenance: { origin: "manual", release: { provider: "apple", collectionId: "456" } },
  });
});
it("wires cached/offline view, effective revision and unchanged minimal recording projection", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".provider-test-")); roots.push(root);
  let live = true;
  const snapshot = (): AlbumSnapshot | null => live ? ({
    version: 3, source_id: sourceId, boot_id: boot, generation: 1, album_key: `${boot}-1`, album_success: originals().success,
    updated_at_ms: Date.now(), expires_at_ms: Date.now() + 4000, enabled: true, active: true, state: "identified",
    silence_dbfs: -45, remembered_enabled: true, settings_error: null, cache_error: null, album: originals().album,
  }) : null;
  const album = new LineInAlbum(sourceId, 123, async () => snapshot(), undefined,
    vi.fn(async () => { throw new Error("Apple unavailable"); }), root);
  albums.push(album); await album.init();
  const service = new AlbumEditions(root, () => album.originalAlbumContext(), {
    sourceUid: 123, musicBrainz: { search: vi.fn(async () => []), release: vi.fn(async () => release),
      resolve: vi.fn(async () => ({ release, evidence })) }, archive: { cover: vi.fn(async () => null) },
  });
  services.push(service); await service.init(); album.setEditions(service);
  const original = await album.originalAlbumContext();
  await vi.waitFor(async () => expect((await album.view()).edition?.provenance?.origin).toBe("automatic-catalog"));
  const view = albumViewSchema.parse(await album.view());
  expect(view.edition?.corrected).toBe(false);
  expect(view.tracklist).toEqual(tracks);
  expect(await album.originalAlbumContext()).toEqual(original);
  const context = (await album.currentAlbumContext())!;
  expect(context.effective.catalog).toBeNull();
  const projection = await recordingAlbumContext(album, 123)();
  expect(projection).toMatchObject({ sourceUid: 123, sourceId, album: {
    catalog: null, title: "Exact release", provenance: { kind: "recognition", revision: context.effective.revision },
  } });
  expect(JSON.stringify(projection)).not.toMatch(/releaseId|tracklist|artwork|apple-release-url/);
  live = false;
  expect(await album.view()).toMatchObject({ state: "offline", tracklist: tracks, album: { title: "Exact release" } });
});
