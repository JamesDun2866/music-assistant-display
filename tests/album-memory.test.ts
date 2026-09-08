import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { LineInAlbum } from "../src/server/line-in-album.js";
import { AlbumMemoryStore } from "../src/server/album-memory.js";
import { ALBUM_COVER_RETRY_MS, MAX_ALBUM_COVER_RECORD_BYTES } from "../src/server/album-cover.js";
import { unavailableTracklist, type AlbumSnapshot } from "../src/shared/line-in-album.js";

const sourceId = "a".repeat(64), boot = "b".repeat(32), key = `${boot}-1`;
const art = "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/ab/cd/ef/album/400x400bb.jpg";
const source = (patch: Partial<AlbumSnapshot> = {}): AlbumSnapshot => ({
  version: 3, source_id: sourceId, boot_id: boot, generation: 1, album_key: key,
  album_success: { boot_id: boot, generation: patch.generation ?? 1, at_ms: Date.now() },
  updated_at_ms: Date.now(), expires_at_ms: Date.now() + 4000,
  state: "identified", enabled: true, active: true, silence_dbfs: -45,
  remembered_enabled: true, settings_error: null, cache_error: null,
  album: { title: "Recognized album", artist: "Artist", artwork: art,
    catalog: { kind: "collection", id: "123", country: "gb" } },
  ...patch,
});
const release = {
  resultCount: 3, results: [
    { wrapperType: "collection", collectionType: "Album", collectionId: 123, collectionName: "Complete release",
      artistName: "Album artist", trackCount: 2 },
    ...[1, 2].map((number) => ({ wrapperType: "track", kind: "song", collectionId: 123, trackId: number,
      trackName: `Track ${number}`, discCount: 1, discNumber: 1, trackCount: 2, trackNumber: number })),
  ],
};
const roots: string[] = [], services: LineInAlbum[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) { service.close(); await service.flush().catch(() => {}); }
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(path.join(process.cwd(), ".album-memory-"));
  roots.push(root);
  return root;
}
function service(read: () => Promise<AlbumSnapshot | null>, directory?: string,
  fetcher = vi.fn(async () => ({
    bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: "#789a93" } }).png().toBuffer(),
    type: "image/png",
  })), catalog = vi.fn(async () => release), id = sourceId, uid = 123) {
  const value = new LineInAlbum(id, uid, read, fetcher, catalog, directory);
  services.push(value);
  return { value, fetcher, catalog };
}

it.each([100, 270])("upgrades a legacy %ipx original without recognition, preserves it offline, and persists new pixels/revisions", async (size) => {
  const root = await directory();
  const store = new AlbumMemoryStore(root);
  await store.init(sourceId, 123);
  const jpeg = await sharp({ create: { width: size, height: size, channels: 3, background: "#789a93" } }).jpeg().toBuffer();
  const snapshot = source({ album: { ...source().album!, catalog: null } });
  await store.save({ version: 2, sourceId, uid: 123, key, album: snapshot.album!, success: snapshot.album_success,
    jpeg: jpeg.toString("base64"), tracklist: unavailableTracklist() });
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let current: AlbumSnapshot | null = null;
  const high = await sharp({ create: { width: 1800, height: 1800, channels: 3, background: "#789a93" } }).png().toBuffer();
  const fetcher = vi.fn(async () => ({ bytes: high, type: "image/png" })).mockRejectedValueOnce(new Error("Offline"));
  const live = service(async () => current, root, fetcher);
  await live.value.init();
  const before = await live.value.currentAlbumContext();
  const oldUrl = (await live.value.view()).album!.artworkUrl;
  expect((await live.value.artwork(key, AbortSignal.timeout(1000)))?.bytes).toEqual(jpeg);
  expect(fetcher).not.toHaveBeenCalled();
  current = { ...snapshot, updated_at_ms: Date.now(), expires_at_ms: Date.now() + 4000 };
  expect((await live.value.artwork(key, AbortSignal.timeout(1000)))?.bytes).toEqual(jpeg);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  for (let index = 0; index < 20; index++) {
    await live.value.view();
    expect((await live.value.artwork(key, AbortSignal.timeout(1000)))?.bytes).toEqual(jpeg);
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
  now += ALBUM_COVER_RETRY_MS + 1;
  current = { ...snapshot, updated_at_ms: Date.now(), expires_at_ms: Date.now() + 4000 };
  await live.value.artwork(key, AbortSignal.timeout(1000));
  await vi.waitFor(async () => expect((await live.value.currentAlbumContext())?.effective.artworkAsset)
    .not.toBe(before!.effective.artworkAsset), { timeout: 5000 });
  const after = await live.value.currentAlbumContext();
  expect(after!.original).toEqual(before!.original);
  expect(after!.effective.revision).not.toBe(before!.effective.revision);
  expect((await live.value.view()).album!.artworkUrl).not.toBe(oldUrl);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledWith(art.replace("400x400", "1200x1200"), expect.any(AbortSignal));
  const upgraded = await live.value.artwork(key, AbortSignal.timeout(1000));
  expect((await sharp(upgraded!.bytes).metadata()).width).toBe(1200);
  await live.value.flush();
  expect(JSON.parse(await readFile(path.join(root, "line-in-album", "last-album.json"), "utf8")).coverVersion).toBe(1);
  live.value.close();
  current = null;
  const restored = service(async () => current, root);
  await restored.value.init();
  expect((await restored.value.artwork(key, AbortSignal.timeout(1000)))?.bytes).toEqual(upgraded!.bytes);
  current = { ...snapshot, updated_at_ms: Date.now(), expires_at_ms: Date.now() + 4000 };
  for (let index = 0; index < 20; index++) await restored.value.artwork(key, AbortSignal.timeout(1000));
  expect(restored.fetcher).not.toHaveBeenCalled();
});

it("exports a source-bound cloned album context with a content revision, not a playback claim", async () => {
  const snapshot = source({ album: { ...source().album!, artwork: null, catalog: null } });
  const live = service(async () => snapshot);
  const context = await live.value.currentAlbumContext();
  expect(context).toMatchObject({
    sourceId,
    original: { albumKey: key, success: snapshot.album_success },
    effective: { title: "Recognized album", artworkAsset: null },
    correction: { applied: false, scope: "original", revision: 0 },
  });
  expect(context!.effective.revision).toMatch(/^[a-f0-9]{64}$/);
  context!.original.album.title = "Caller mutation";
  expect((await live.value.originalAlbumContext())!.album.title).toBe("Recognized album");
  expect(JSON.stringify(context)).not.toMatch(/duration|positionMs|recording|playing/);
});

it("round trips a detailed full-cover record above the former 1 MiB file budget", async () => {
  const root = await directory();
  const jpeg = await sharp(randomBytes(1200 * 1200 * 3), { raw: { width: 1200, height: 1200, channels: 3 } })
    .jpeg({ quality: 85 }).toBuffer();
  const store = new AlbumMemoryStore(root);
  await store.init(sourceId, 123);
  const record = { version: 2 as const, sourceId, uid: 123, key, album: source().album!,
    success: source().album_success, jpeg: jpeg.toString("base64"), coverVersion: 1 as const, tracklist: unavailableTracklist() };
  expect(Buffer.byteLength(JSON.stringify(record))).toBeGreaterThan(1024 * 1024);
  await store.save(record);
  expect(await new AlbumMemoryStore(root).init(sourceId, 123)).toEqual(record);
  await expect(store.save({ ...record, jpeg: "A".repeat(MAX_ALBUM_COVER_RECORD_BYTES) })).rejects.toThrow();
  expect(await new AlbumMemoryStore(root).init(sourceId, 123)).toEqual(record);
});

it("persists safe metadata, decoded JPEG and complete tracklist across offline reboot without network or fake freshness", async () => {
  const root = await directory();
  const live = service(async () => source(), root);
  await live.value.init();
  await vi.waitFor(async () => expect((await live.value.view()).tracklist.status).toBe("complete"));
  const image = await live.value.artwork(key, AbortSignal.timeout(3000));
  expect(image?.contentType).toBe("image/jpeg");
  await live.value.flush();
  const file = path.join(root, "line-in-album", "last-album.json");
  const raw = await readFile(file, "utf8");
  expect(raw).not.toMatch(/expires|enabled|audio|lyrics|previewUrl/);
  expect(JSON.parse(raw).success).toMatchObject({ boot_id: boot, generation: 1 });
  expect(Buffer.byteLength(raw)).toBeLessThan(1024 * 1024);
  if (process.platform !== "win32") expect((await lstat(file)).mode & 0o777).toBe(0o600);
  live.value.close();
  let snapshot: AlbumSnapshot | null = null;
  const restored = service(async () => snapshot, root);
  await restored.value.init();
  const offline = await restored.value.view();
  expect(offline).toMatchObject({ state: "offline", key, retry: null, album: { title: "Recognized album" } });
  expect(offline.expiresAt).toBeLessThanOrEqual(Date.now());
  expect(offline.tracklist).toMatchObject({ status: "complete", title: "Complete release" });
  expect(offline.tracklist.tracks).toHaveLength(2);
  expect(await restored.value.artwork(key, AbortSignal.timeout(1000))).toEqual(image);
  snapshot = source({ boot_id: "c".repeat(32), generation: 0, state: "disabled", enabled: false, active: false });
  expect((await restored.value.view()).tracklist.status).toBe("complete");
  expect(await restored.value.artwork(key, AbortSignal.timeout(1000))).toEqual(image);
  restored.fetcher.mockClear();
  restored.catalog.mockClear();
  await restored.value.view();
  expect(restored.fetcher).not.toHaveBeenCalled();
  expect(restored.catalog).not.toHaveBeenCalled();
});

it("keeps assets through silence, no match, retry, disabled and lost source, replacing only on new album key", async () => {
  let snapshot: AlbumSnapshot | null = source();
  const live = service(async () => snapshot);
  await live.value.view();
  await vi.waitFor(async () => expect((await live.value.view()).tracklist.status).toBe("complete"));
  const image = await live.value.artwork(key, AbortSignal.timeout(3000));
  let generation = 2;
  for (const state of ["armed", "sampling", "recognizing", "unavailable", "disabled"] as const) {
    snapshot = source({ state, generation: generation++, enabled: state !== "disabled", active: state !== "disabled" });
    const result = await live.value.view();
    expect(result.album?.title).toBe("Recognized album");
    expect(result.key).toBe(key);
    expect(result.tracklist.status).toBe("complete");
    expect(await live.value.artwork(key, AbortSignal.timeout(1000))).toEqual(image);
  }
  snapshot = null;
  expect((await live.value.view()).album?.title).toBe("Recognized album");
  expect((await live.value.view()).state).toBe("offline");
  snapshot = source({ generation: generation++, album_key: `${boot}-9`,
    album: { title: "Second album", artist: "Second artist", artwork: null, catalog: null } });
  const next = await live.value.view();
  expect(next.album?.title).toBe("Second album");
  expect(next.tracklist.status).toBe("unavailable");
  expect(await live.value.artwork(key, AbortSignal.timeout(1000))).toBeNull();
  expect(live.fetcher).toHaveBeenCalledOnce();
  expect(live.catalog).toHaveBeenCalledOnce();
});

it("continues an in-flight complete catalog lookup over a silence generation change with the same album identity", async () => {
  let snapshot = source();
  let finish!: (value: typeof release) => void;
  const fetcher = vi.fn(() => new Promise<typeof release>((resolve) => { finish = resolve; }));
  const live = service(async () => snapshot, undefined, undefined, fetcher);
  await live.value.view();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  snapshot = source({ state: "armed", generation: 2 });
  await live.value.view();
  finish(release);
  await vi.waitFor(async () => expect((await live.value.view()).tracklist.status).toBe("complete"));
  expect(fetcher).toHaveBeenCalledOnce();
});

it("does not restore another source's cache or accept a stale snapshot as live metadata", async () => {
  const root = await directory();
  const live = service(async () => source({ album: { title: "Stored", artist: "Artist", artwork: null, catalog: null } }), root);
  await live.value.init(); await live.value.view(); await live.value.flush(); live.value.close();
  for (const [id, uid] of [["c".repeat(64), 123], [sourceId, 456]] as const) {
    const other = service(async () => null, root, undefined, undefined, id, uid);
    await other.value.init();
    expect((await other.value.view()).album).toBeNull();
  }
  const stale = service(async () => source({ expires_at_ms: Date.now() - 1 }));
  expect((await stale.value.view()).album).toBeNull();
  const foreign = service(async () => source({ source_id: "d".repeat(64) }));
  expect((await foreign.value.view()).album).toBeNull();
});

it("reports old, corrupt and oversized cache records without restoring raw runtime state", async () => {
  const root = await directory();
  const store = new AlbumMemoryStore(root);
  await store.init(sourceId, 123);
  const file = path.join(root, "line-in-album", "last-album.json");
  const pending = path.join(root, "line-in-album", ".last-album.next");
  await writeFile(pending, '{"interrupted":', { mode: 0o600 });
  expect(await store.init(sourceId, 123)).toBeNull();
  await expect(lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
  for (const raw of [JSON.stringify(source()), JSON.stringify({ version: 0, album: "old" }), "{", "x".repeat(MAX_ALBUM_COVER_RECORD_BYTES + 1)]) {
    await writeFile(file, raw, { mode: 0o600 });
    const live = service(async () => null, root);
    await live.value.init();
    expect(await live.value.view()).toMatchObject({ state: "offline", album: null, cacheError: expect.stringMatching(/restored/) });
  }
});

it.skipIf(process.platform === "win32")("rejects writable or symlinked private cache files and directories", async () => {
  const root = await directory();
  const store = new AlbumMemoryStore(root);
  await store.init(sourceId, 123);
  const file = path.join(root, "line-in-album", "last-album.json");
  await writeFile(file, "{}", { mode: 0o644 });
  await expect(store.init(sourceId, 123)).rejects.toThrow("Unsafe");
  await rm(file);
  const target = path.join(root, "target");
  await writeFile(target, "unchanged");
  await symlink(target, file);
  await expect(store.init(sourceId, 123)).rejects.toThrow("Unsafe");
  expect(await readFile(target, "utf8")).toBe("unchanged");
  await rm(file);
  await chmod(path.dirname(file), 0o777);
  await expect(store.init(sourceId, 123)).rejects.toThrow("Unsafe");
});

it("surfaces persistence failures without erasing the useful in-memory album", async () => {
  const root = await directory();
  vi.spyOn(AlbumMemoryStore.prototype, "save").mockRejectedValue(new Error("disk full"));
  const live = service(async () => source({ album: { title: "Stored", artist: "Artist", artwork: null, catalog: null } }), root);
  await live.value.init(); await live.value.view();
  await expect(live.value.flush()).rejects.toThrow("not saved");
  expect(await live.value.view()).toMatchObject({ album: { title: "Stored" }, cacheError: expect.stringMatching(/not be saved/) });
});

it("does not create or commit a cache write after its I/O deadline expires", async () => {
  const root = await directory();
  const store = new AlbumMemoryStore(root);
  await store.init(sourceId, 123);
  const expired = AbortSignal.abort(new Error("deadline"));
  await expect(store.save({ version: 2, sourceId, uid: 123, key, album: source().album!, success: source().album_success,
    jpeg: null, tracklist: unavailableTracklist() }, expired)).rejects.toThrow("deadline");
  expect(await store.init(sourceId, 123)).toBeNull();
});

it("coalesces persistence into one active write and one latest record, never writes an old album last", async () => {
  const root = await directory();
  let finish!: () => void;
  const saved: string[] = [];
  vi.spyOn(AlbumMemoryStore.prototype, "save").mockImplementation(async (value) => {
    saved.push(value.key);
    if (saved.length === 1) await new Promise<void>((resolve) => { finish = resolve; });
  });
  let snapshot = source({ album: { title: "One", artist: "Artist", artwork: null, catalog: null } });
  const live = service(async () => snapshot, root);
  await live.value.init(); await live.value.view();
  await vi.waitFor(() => expect(saved).toEqual([key]));
  for (let generation = 2; generation <= 20; generation++) {
    snapshot = source({ generation, album_key: `${boot}-${generation}`,
      album: { title: `Album ${generation}`, artist: "Artist", artwork: null, catalog: null } });
    await live.value.view();
  }
  expect(saved).toEqual([key]);
  finish();
  await live.value.flush();
  expect(saved).toEqual([key, `${boot}-20`]);
});

it("binds retry to fresh source identity and generation, rejecting concurrent and stale requests", async () => {
  let snapshot = source({ state: "unavailable" });
  let finish!: () => void;
  const retry = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const live = new LineInAlbum(sourceId, 123, async () => snapshot, undefined, undefined, undefined, retry);
  services.push(live);
  const binding = { source_id: sourceId, boot_id: boot, generation: 1 };
  const first = live.retry(binding);
  await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
  await expect(live.retry(binding)).rejects.toThrow("busy");
  finish(); await first;
  snapshot = source({ generation: 2 });
  await expect(live.retry(binding)).rejects.toThrow("changed");
  await expect(live.retry({ ...binding, source_id: "d".repeat(64) })).rejects.toThrow("changed");
  expect(retry).toHaveBeenCalledExactlyOnceWith(binding, 123);
});

it("never rolls durable display B back to restored source A, including tied history and a clock rollback", async () => {
  const root = await directory();
  const bKey = `${boot}-2`;
  const b = source({ generation: 2, album_key: bKey,
    album_success: { boot_id: boot, generation: 2, at_ms: 200 } });
  const first = service(async () => b, root);
  await first.value.init();
  await vi.waitFor(async () => expect((await first.value.view()).tracklist.status).toBe("complete"));
  const image = await first.value.artwork(bKey, AbortSignal.timeout(3000));
  await first.value.flush(); first.value.close();
  let restored = source({ boot_id: "c".repeat(32), generation: 0, state: "disabled", enabled: false, active: false,
    album_success: { boot_id: boot, generation: 1, at_ms: 100 },
    album: { title: "Old A", artist: "Artist", artwork: null, catalog: null } });
  const next = service(async () => restored, root);
  await next.value.init();
  expect(await next.value.view()).toMatchObject({ state: "disabled", key: bKey, album: { title: b.album!.title } });
  expect((await next.value.view()).tracklist.status).toBe("complete");
  expect(await next.value.artwork(bKey, AbortSignal.timeout(1000))).toEqual(image);
  restored = { ...restored, boot_id: "d".repeat(32), updated_at_ms: Date.now(), expires_at_ms: Date.now() + 4000,
    album_key: `${"e".repeat(32)}-1`, album_success: { boot_id: "e".repeat(32), generation: 1, at_ms: 200 } };
  expect((await next.value.view()).key).toBe(bKey);
  const currentBoot = restored.boot_id;
  restored = source({ boot_id: currentBoot, generation: 1, album_key: `${currentBoot}-1`,
    album_success: { boot_id: currentBoot, generation: 1, at_ms: 101 },
    album: { title: "Fresh C after clock rollback", artist: "Artist", artwork: null, catalog: null } });
  expect((await next.value.view()).album?.title).toBe("Fresh C after clock rollback");
  await next.value.flush();
  const currentKey = restored.album_key;
  restored = source({ ...b, updated_at_ms: Date.now(), expires_at_ms: Date.now() + 4000 });
  expect((await next.value.view()).key).toBe(currentKey);
  expect(next.fetcher).not.toHaveBeenCalled();
  expect(next.catalog).not.toHaveBeenCalled();
  next.value.close();
  const disk = JSON.parse(await readFile(path.join(root, "line-in-album", "last-album.json"), "utf8"));
  expect(disk.key).toBe(currentKey);
  expect(disk.success.at_ms).toBe(101);
});

it("recovers failed persistence on new same-album success while keeping complete artwork and tracks", async () => {
  const root = await directory();
  const save = AlbumMemoryStore.prototype.save;
  const writes = vi.spyOn(AlbumMemoryStore.prototype, "save").mockRejectedValue(new Error("disk full"));
  let snapshot = source({ album_success: { boot_id: boot, generation: 1, at_ms: 100 } });
  const live = service(async () => snapshot, root);
  await live.value.init();
  await vi.waitFor(async () => expect((await live.value.view()).tracklist.status).toBe("complete"));
  const image = await live.value.artwork(key, AbortSignal.timeout(3000));
  await expect(live.value.flush()).rejects.toThrow("not saved");
  const before = writes.mock.calls.length;
  for (let i = 0; i < 50; i++) await live.value.view();
  expect(writes).toHaveBeenCalledTimes(before);
  writes.mockImplementation(save);
  snapshot = source({ generation: 2, album_success: { boot_id: boot, generation: 2, at_ms: 101 } });
  expect((await live.value.view()).tracklist.status).toBe("complete");
  await live.value.flush();
  expect((await live.value.view()).cacheError).toBeNull();
  expect(await live.value.artwork(key, AbortSignal.timeout(1000))).toEqual(image);
  snapshot = source({ generation: 3, album_key: `${boot}-3`,
    album_success: { boot_id: boot, generation: 3, at_ms: 102 } });
  expect((await live.value.view()).tracklist.status).toBe("complete");
  expect(await live.value.artwork(`${boot}-3`, AbortSignal.timeout(1000))).toEqual(image);
  await live.value.flush();
  const restored = service(async () => null, root);
  live.value.close();
  await restored.value.init();
  expect((await restored.value.view()).tracklist.status).toBe("complete");
  expect(await restored.value.artwork(`${boot}-3`, AbortSignal.timeout(1000))).toEqual(image);
  expect(live.fetcher).toHaveBeenCalledOnce();
  expect(live.catalog).toHaveBeenCalledOnce();
});

it("retries dirty storage on bounded backoff even without another recognition, and stops retries on shutdown", async () => {
  const root = await directory();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const writes = vi.spyOn(AlbumMemoryStore.prototype, "save").mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  const live = service(async () => source({ album: { title: "A", artist: "Artist", artwork: null, catalog: null } }), root);
  await live.value.init(); await live.value.view();
  await Promise.resolve(); await Promise.resolve();
  expect(writes).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(4999);
  expect(writes).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await live.value.flush();
  expect(writes).toHaveBeenCalledTimes(2);
  expect((await live.value.view()).cacheError).toBeNull();
  writes.mockRejectedValue(new Error("disk full"));
  const pending = service(async () => source({ album: { title: "B", artist: "Artist", artwork: null, catalog: null } }), await directory());
  await pending.value.init(); await pending.value.view();
  pending.value.close();
  await expect(pending.value.flush()).rejects.toThrow("not saved");
  const count = writes.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(writes).toHaveBeenCalledTimes(count);
});

it("bounds flush while an I/O worker retires without starting overlapping writes", async () => {
  const root = await directory();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  let finish!: () => void;
  const writes = vi.spyOn(AlbumMemoryStore.prototype, "save").mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const live = service(async () => source({ album: { title: "A", artist: "Artist", artwork: null, catalog: null } }), root);
  await live.value.init(); await live.value.view();
  live.value.close();
  const flushing = expect(live.value.flush()).rejects.toThrow("still retiring");
  await vi.advanceTimersByTimeAsync(3500);
  await flushing;
  expect(writes).toHaveBeenCalledOnce();
  finish();
  await live.value.flush();
  expect(writes).toHaveBeenCalledOnce();
});

it("upgrades v1 display caches without discarding assets or inventing success ordering", async () => {
  const root = await directory();
  const store = new AlbumMemoryStore(root);
  await store.init(sourceId, 123);
  await writeFile(path.join(root, "line-in-album", "last-album.json"), JSON.stringify({
    version: 1, sourceId, uid: 123, key, album: source().album!, jpeg: null, tracklist: unavailableTracklist(),
  }), { mode: 0o600 });
  const legacy = await store.init(sourceId, 123);
  expect(legacy).toMatchObject({ version: 2, key, success: null, album: { title: "Recognized album" } });
});

it("retries missing artwork on a new success but never refetches completed cached artwork on polling", async () => {
  const root = await directory();
  const image = { bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).png().toBuffer(), type: "image/png" };
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(image);
  let snapshot = source({ album_success: { boot_id: boot, generation: 1, at_ms: 100 },
    album: { ...source().album!, catalog: null } });
  const live = service(async () => snapshot, root, fetcher);
  await live.value.init();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  for (let i = 0; i < 20; i++) expect((await live.value.view()).album?.artworkUrl).toBeNull();
  snapshot = { ...snapshot, generation: 2, album_success: { boot_id: boot, generation: 2, at_ms: 101 } };
  await live.value.view();
  await vi.waitFor(async () => expect((await live.value.view()).album?.artworkUrl).not.toBeNull(), { timeout: 4000 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  snapshot = { ...snapshot, generation: 3, album_success: { boot_id: boot, generation: 3, at_ms: 102 } };
  for (let i = 0; i < 20; i++) await live.value.view();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not treat a previously observed future-dated heartbeat as fresh after clock rollback", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
  let snapshot = source({ generation: 2, album: { title: "B", artist: "Artist", artwork: null, catalog: null } });
  const live = service(async () => snapshot);
  expect((await live.value.view()).state).toBe("identified");
  now.mockReturnValue(9000);
  snapshot = source({ generation: 1, album: { title: "Old A", artist: "Artist", artwork: null, catalog: null } });
  expect(await live.value.view()).toMatchObject({ state: "offline", album: { title: "B" }, retry: null });
});
