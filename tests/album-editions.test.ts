import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { AlbumEditions, type OriginalAlbumContext } from "../src/server/album-editions.js";
import type { CatalogReference } from "../src/shared/line-in-album.js";
import { ALBUM_COVER_RETRY_MS } from "../src/server/album-cover.js";

const roots: string[] = [], services: AlbumEditions[] = [];
const art = "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/a/b/c/100x100bb.jpg";
const original = (): OriginalAlbumContext => ({
  sourceId: "a".repeat(64), albumKey: `${"b".repeat(32)}-1`,
  success: { boot_id: "b".repeat(32), generation: 1, at_ms: 1000 },
  album: { title: "Original", artist: "Recognized", artwork: art,
    catalog: { kind: "collection", id: "123", country: "gb" } },
});
const collection = (id = 456, cover = false) => ({
  resultCount: 3, results: [
    { wrapperType: "collection", collectionType: "Album", collectionId: id, collectionName: "Chosen edition",
      artistName: "Catalog artist", trackCount: 2, ...(cover ? { artworkUrl100: art } : {}) },
    ...[1, 2].map((number) => ({ wrapperType: "track", kind: "song", collectionId: id, trackId: 100 + number,
      trackName: `Song ${number}`, discCount: 2, discNumber: number, trackCount: 1, trackNumber: 1 })),
  ],
});
const searchResult = { resultCount: 1, results: [collection().results[0]] };
afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture(options: ConstructorParameters<typeof AlbumEditions>[2] = {}) {
  const root = await mkdtemp(path.join(process.cwd(), ".edition-test-")); roots.push(root);
  let current = original();
  const search = vi.fn(async () => searchResult);
  const catalog = vi.fn(async (reference: CatalogReference) => reference.kind === "track"
    ? { resultCount: 1, results: [{ wrapperType: "track", kind: "song", trackId: Number(reference.id), collectionId: 123 }] }
    : collection());
  const service = new AlbumEditions(root, async () => current, { search, fetchCatalog: catalog, ...options });
  services.push(service); await service.init();
  return { root, service, search, catalog, current: () => current, set: (value: OriginalAlbumContext) => { current = value; } };
}
async function preview(f: Awaited<ReturnType<typeof fixture>>) {
  const binding = await f.service.binding(f.current());
  const result = await f.service.search({ binding, artist: "Artist", album: "Album", country: "gb" }, "session", AbortSignal.timeout(5000));
  const selected = await f.service.preview({ binding, searchToken: result.searchToken, collectionId: "456", country: "gb" },
    "session", AbortSignal.timeout(5000));
  return { binding, selected, confirm: { binding, previewToken: selected.previewToken, confirm: true } };
}

it("does not search automatically; saves only after confirmation and restores exact offline corrections and undo", async () => {
  const f = await fixture();
  expect(await f.service.effective(f.current())).toBeNull();
  expect(f.search).not.toHaveBeenCalled();
  const flow = await preview(f);
  expect(flow.selected).toMatchObject({ scope: "remembered", artworkUrl: null, artworkUnavailable: true });
  expect(flow.selected.tracklist.tracks).toHaveLength(2);
  expect(await f.service.effective(f.current())).toBeNull();
  await f.service.confirm(flow.confirm, "session");
  expect((await f.service.effective(f.current()))?.album.title).toBe("Chosen edition");
  expect(f.current().album.title).toBe("Original");
  const files = await readdir(path.join(f.root, "album-editions"));
  const stored = await readFile(path.join(f.root, "album-editions", files[0]!), "utf8");
  expect(JSON.parse(stored).original.album.title).toBe("Original");
  expect(stored).not.toMatch(/previewUrl|audio|rawPayload/);
  f.service.close();
  const offline = new AlbumEditions(f.root, async () => f.current(), { search: vi.fn(), fetchCatalog: vi.fn() });
  services.push(offline); await offline.init();
  expect((await offline.effective(f.current()))?.tracklist.status).toBe("complete");
  const binding = await offline.binding(f.current());
  await offline.remove({ binding, correctionRevision: binding.revision, confirm: true }, "session");
  expect(await offline.effective(f.current())).toBeNull();
  expect((await offline.binding(f.current())).revision).toBe(2);
});

it("binds previews to session, source, success, album and revision", async () => {
  const f = await fixture();
  const flow = await preview(f);
  await expect(f.service.confirm(flow.confirm, "different")).rejects.toThrow(/session/);
  for (const patch of [
    { sourceId: "c".repeat(64) }, { albumKey: `${"b".repeat(32)}-2` },
    { success: { ...f.current().success!, generation: 2 } },
  ]) {
    f.set({ ...original(), ...patch });
    await expect(f.service.confirm(flow.confirm, "session")).rejects.toThrow(/changed/);
  }
  f.set(original());
  await f.service.confirm(flow.confirm, "session");
  await expect(f.service.confirm(flow.confirm, "session")).rejects.toThrow(/changed/);
});

it("never admits arbitrary preview selections or incomplete, wrong or over-200 collections", async () => {
  let raw: unknown = collection();
  const f = await fixture({ fetchCatalog: async () => raw });
  const binding = await f.service.binding(f.current());
  const result = await f.service.search({ binding, artist: "A", album: "B", country: "gb" }, "session", AbortSignal.timeout(5000));
  await expect(f.service.preview({ binding, searchToken: result.searchToken, collectionId: "999", country: "gb" },
    "session", AbortSignal.timeout(5000))).rejects.toThrow(/Select/);
  for (const invalid of [
    { resultCount: 2, results: collection().results.slice(0, 2) }, collection(999),
    { resultCount: 202, results: Array(202).fill(collection().results[0]) },
  ]) {
    raw = invalid;
    await expect(f.service.preview({ binding, searchToken: result.searchToken, collectionId: "456", country: "gb" },
      "session", AbortSignal.timeout(5000))).rejects.toThrow(/Complete tracklist/);
  }
});

it("resolves exact original track aliases across later successes, never fuzzy title matches", async () => {
  const f = await fixture();
  f.set({ ...original(), album: { ...original().album, catalog: { kind: "track", id: "99", country: "gb" } } });
  const flow = await preview(f);
  await f.service.confirm(flow.confirm, "session");
  f.set({ ...original(), success: { ...original().success!, generation: 3 },
    album: { ...original().album, catalog: { kind: "track", id: "98", country: "gb" } } });
  expect(await f.service.effective(f.current())).toBeNull();
  f.service.observe(f.current());
  await vi.waitFor(async () => expect((await f.service.effective(f.current()))?.scope).toBe("remembered"));
  f.set({ ...original(), album: { ...original().album, catalog: { kind: "collection", id: "789", country: "gb" } } });
  expect(await f.service.effective(f.current())).toBeNull();
  f.set({ ...original(), album: { ...original().album, catalog: { kind: "collection", id: "123", country: "us" } } });
  expect(await f.service.effective(f.current())).toBeNull();
});

it("labels no-reference corrections current-only and expires even on another success for the same album", async () => {
  const f = await fixture();
  f.set({ ...original(), album: { ...original().album, catalog: null } });
  const flow = await preview(f);
  expect(flow.selected.scope).toBe("current-album");
  await f.service.confirm(flow.confirm, "session");
  expect((await f.service.effective(f.current()))?.scope).toBe("current-album");
  f.set({ ...f.current(), success: { ...original().success!, generation: 2 } });
  expect(await f.service.effective(f.current())).toBeNull();
});

it("does not apply a correction if its atomic persistence fails", async () => {
  const f = await fixture();
  const flow = await preview(f);
  const directory = path.join(f.root, "album-editions");
  await rm(directory, { recursive: true });
  await writeFile(directory, "not a directory");
  await expect(f.service.confirm(flow.confirm, "session")).rejects.toThrow();
  await rm(directory); await mkdir(directory, { mode: 0o700 });
  const fresh = new AlbumEditions(f.root, async () => f.current()); services.push(fresh);
  await fresh.init();
  expect(await fresh.effective(f.current())).toBeNull();
});

it("decodes a local JPEG, isolates preview artwork by session and restores sanitized bytes offline", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#abcdef" } }).png().toBuffer();
  const f = await fixture({ fetchCatalog: async () => collection(456, true),
    fetchCover: async () => ({ bytes: png, type: "image/png" }) });
  const flow = await preview(f);
  expect(flow.selected.artworkUrl).toMatch(/^\/api\/line-in-album\/edition\/artwork\//);
  const art = await f.service.artwork(flow.selected.previewToken, "session", AbortSignal.timeout(5000));
  expect(art?.contentType).toBe("image/jpeg");
  await expect(f.service.artwork(flow.selected.previewToken, "other", AbortSignal.timeout(5000))).rejects.toThrow();
  await f.service.confirm(flow.confirm, "session");
  expect((await f.service.effective(f.current()))?.jpeg).toEqual(art!.bytes);
});

it("upgrades a saved legacy correction atomically with backoff, keeping selection/history and rejecting stale confirmation", async () => {
  let time = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => time);
  const old = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#abcdef" } }).jpeg().toBuffer();
  const f = await fixture({ fetchCatalog: async () => collection(456, true),
    fetchCover: async () => ({ bytes: old, type: "image/jpeg" }) });
  const flow = await preview(f);
  await f.service.confirm(flow.confirm, "session");
  f.service.close();
  const file = (await readdir(path.join(f.root, "album-editions"))).find((name) => /^[a-f0-9]{64}\.json$/.test(name))!;
  const filePath = path.join(f.root, "album-editions", file);
  const legacy = JSON.parse(await readFile(filePath, "utf8"));
  delete legacy.coverVersion;
  await writeFile(filePath, JSON.stringify(legacy));
  const high = await sharp(randomBytes(1800 * 1200 * 3), { raw: { width: 1800, height: 1200, channels: 3 } }).png().toBuffer();
  let available = false;
  const fetchCover = vi.fn(async () => {
    if (!available) throw new Error("Offline");
    return { bytes: high, type: "image/png" };
  });
  const service = new AlbumEditions(f.root, async () => f.current(), { fetchCover,
    fetchCatalog: async () => collection(456, true), search: async () => searchResult });
  services.push(service); await service.init();
  service.observe(f.current(), false);
  expect((await service.effective(f.current()))?.jpeg).toEqual(Buffer.from(legacy.jpeg, "base64"));
  expect(fetchCover).not.toHaveBeenCalled();
  service.observe(f.current(), true);
  await vi.waitFor(() => expect(fetchCover).toHaveBeenCalledTimes(1));
  for (let index = 0; index < 20; index++) {
    service.observe(f.current());
    expect((await service.effective(f.current()))?.revision).toBe(1);
  }
  expect(fetchCover).toHaveBeenCalledTimes(1);
  // A pending preview made against revision 1 must not confirm after enrichment.
  const pending = await preview({ ...f, service });
  available = true;
  time += ALBUM_COVER_RETRY_MS + 1;
  service.observe(f.current());
  await vi.waitFor(async () => expect((await service.effective(f.current()))?.revision).toBe(2), { timeout: 5000 });
  const upgraded = (await service.effective(f.current()))!;
  expect(upgraded.jpeg!.length).toBeGreaterThan(256 * 1024);
  expect(upgraded.album.title).toBe("Chosen edition");
  expect(upgraded.tracklist).toEqual(legacy.tracklist);
  expect(await sharp(upgraded.jpeg!).metadata()).toMatchObject({ width: 1200, height: 800 });
  await expect(service.confirm(pending.confirm, "session")).rejects.toThrow(/changed/);
  const saved = JSON.parse(await readFile(filePath, "utf8"));
  expect(saved).toMatchObject({ coverVersion: 1, revision: 2, original: legacy.original, album: legacy.album });
  service.close();
  const offline = new AlbumEditions(f.root, async () => f.current(), { fetchCover });
  services.push(offline); await offline.init();
  expect((await offline.effective(f.current()))?.jpeg).toEqual(upgraded.jpeg);
  const calls = fetchCover.mock.calls.length;
  for (let index = 0; index < 20; index++) offline.observe(f.current());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetchCover).toHaveBeenCalledTimes(calls);
});

it("shows cover failure without borrowing the original cover and rate limits explicit searches", async () => {
  const f = await fixture({ fetchCatalog: async () => collection(456, true), fetchCover: async () => { throw new Error("Unavailable"); } });
  const flow = await preview(f);
  expect(flow.selected).toMatchObject({ artworkUnavailable: true, artworkUrl: null });
  await expect(f.service.search({ binding: flow.binding, artist: "A", album: "B", country: "gb" }, "session",
    AbortSignal.timeout(5000))).rejects.toThrow(/Wait a moment/);
  await expect(f.service.search({ binding: flow.binding, artist: "https://evil.example", album: "B", country: "gb" },
    "session", AbortSignal.timeout(5000))).rejects.toThrow();
});

it("expires abandoned tokens and refuses concurrent search work rather than building an unbounded queue", async () => {
  let time = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => time);
  const f = await fixture();
  const flow = await preview(f);
  time += 5 * 60_000 + 1;
  await expect(f.service.confirm(flow.confirm, "session")).rejects.toThrow(/expired/);
  let release!: (value: unknown) => void;
  const blocking = await fixture({ search: () => new Promise((resolve) => { release = resolve; }) });
  const binding = await blocking.service.binding(blocking.current());
  const body = { binding, artist: "A", album: "B", country: "gb" };
  const pending = blocking.service.search(body, "session", AbortSignal.timeout(5000));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await expect(blocking.service.search(body, "other-session", AbortSignal.timeout(5000))).rejects.toThrow(/running/);
  release(searchResult);
  await pending;
});

it("keeps view-facing methods cache-only and restores the verified alias offline", async () => {
  const f = await fixture();
  f.set({ ...original(), album: { ...original().album, catalog: { kind: "track", id: "99", country: "gb" } } });
  await Promise.all([f.service.binding(f.current()), f.service.effective(f.current())]);
  expect(f.catalog).not.toHaveBeenCalled();
  f.service.observe(f.current());
  await vi.waitFor(() => expect(f.catalog).toHaveBeenCalledTimes(1));
  const flow = await preview(f);
  await f.service.confirm(flow.confirm, "session");
  f.service.close();
  const network = vi.fn(async () => { throw new Error("Offline"); });
  const offline = new AlbumEditions(f.root, async () => f.current(), { fetchCatalog: network });
  services.push(offline); await offline.init();
  expect((await offline.effective(f.current()))?.album.title).toBe("Chosen edition");
  expect(network).not.toHaveBeenCalled();
});

it("rechecks historical success immediately before atomic publication", async () => {
  const f = await fixture();
  f.service.close();
  let confirming = false, reads = 0;
  const service = new AlbumEditions(f.root, async () => {
    if (confirming && ++reads === 2) f.set({ ...f.current(), success: { ...f.current().success!, generation: 2 } });
    return f.current();
  }, { search: f.search, fetchCatalog: f.catalog });
  services.push(service);
  await service.init();
  const flow = await preview({ ...f, service });
  confirming = true;
  await expect(service.confirm(flow.confirm, "session")).rejects.toThrow(/changed/);
  expect(await service.effective(original())).toBeNull();
  expect((await readdir(path.join(f.root, "album-editions"))).filter((file) => file.endsWith(".next"))).toEqual([]);
});

it("observes failed original-track resolution once per success without blocking or retrying status polling", async () => {
  let reject!: (error: Error) => void;
  const catalog = vi.fn(() => new Promise<unknown>((_resolve, fail) => { reject = fail; }));
  const f = await fixture({ fetchCatalog: catalog });
  f.set({ ...original(), album: { ...original().album, catalog: { kind: "track", id: "99", country: "gb" } } });
  for (let index = 0; index < 20; index++) {
    f.service.observe(f.current());
    expect((await f.service.binding(f.current())).revision).toBe(0);
    expect(await f.service.effective(f.current())).toBeNull();
  }
  await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
  reject(new Error("Network failed"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let index = 0; index < 20; index++) {
    f.service.observe(f.current());
    expect(await f.service.effective(f.current())).toBeNull();
  }
  expect(catalog).toHaveBeenCalledTimes(1);
  f.set({ ...f.current(), success: { ...f.current().success!, generation: 2 } });
  f.service.observe(f.current());
  await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
  reject(new Error("Still offline"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  f.service.observe(f.current());
  expect(catalog).toHaveBeenCalledTimes(2);
  expect(f.search).not.toHaveBeenCalled();
});

it("requires reopening when explicit track resolution discovers an existing correction revision", async () => {
  const f = await fixture();
  const flow = await preview(f);
  await f.service.confirm(flow.confirm, "session");
  f.set({ ...original(), album: { ...original().album, catalog: { kind: "track", id: "99", country: "gb" } } });
  const unresolved = await f.service.binding(f.current());
  expect(unresolved.revision).toBe(0);
  await expect(f.service.search({ binding: unresolved, artist: "A", album: "B", country: "gb" }, "session",
    AbortSignal.timeout(5000))).rejects.toThrow(/changed/);
  expect((await f.service.binding(f.current())).revision).toBe(1);
  expect(f.search).toHaveBeenCalledTimes(1);
});

it("collects obsolete current-only records and their JPEGs on any new success, including after restart", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#abcdef" } }).png().toBuffer();
  const f = await fixture({ fetchCatalog: async () => collection(456, true),
    fetchCover: async () => ({ bytes: png, type: "image/png" }) });
  f.set({ ...original(), album: { ...original().album, catalog: null } });
  const flow = await preview(f);
  await f.service.confirm(flow.confirm, "session");
  expect((await f.service.effective(f.current()))?.jpeg).not.toBeNull();
  const directory = path.join(f.root, "album-editions");
  expect(await readdir(directory)).toHaveLength(1);
  f.service.observe(f.current());
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(await readdir(directory)).toHaveLength(1);
  f.service.close();
  f.set({ ...f.current(), success: { ...f.current().success!, boot_id: "c".repeat(32), generation: 0 } });
  const restored = new AlbumEditions(f.root, async () => f.current());
  services.push(restored); await restored.init();
  restored.observe(f.current());
  expect(await restored.effective(f.current())).toBeNull();
  await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]));
});

it("defers optional network-disabled observations without consuming the single permitted lookup", async () => {
  const f = await fixture();
  f.set({ ...original(), album: { ...original().album, catalog: { kind: "track", id: "99", country: "gb" } } });
  f.service.observe(f.current(), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(f.catalog).not.toHaveBeenCalled();
  expect((await f.service.binding(f.current())).revision).toBe(0);
  f.service.observe(f.current(), true);
  await vi.waitFor(() => expect(f.catalog).toHaveBeenCalledTimes(1));
  for (let index = 0; index < 20; index++) f.service.observe(f.current(), true);
  expect(f.catalog).toHaveBeenCalledTimes(1);
});

it("does not start a queued original lookup after that source becomes inactive", async () => {
  let reject!: (error: Error) => void;
  const catalog = vi.fn(() => new Promise<unknown>((_resolve, fail) => { reject = fail; }));
  const f = await fixture({ fetchCatalog: catalog });
  f.set({ ...original(), album: { ...original().album, catalog: { kind: "track", id: "99", country: "gb" } } });
  f.service.observe(f.current(), true);
  await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
  f.set({ ...f.current(), success: { ...f.current().success!, generation: 2 },
    album: { ...f.current().album, catalog: { kind: "track", id: "98", country: "gb" } } });
  f.service.observe(f.current(), true);
  f.service.observe(f.current(), false);
  reject(new Error("Old lookup failed"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(catalog).toHaveBeenCalledTimes(1);
  f.service.observe(f.current(), true);
  await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
  reject(new Error("Unavailable"));
});
