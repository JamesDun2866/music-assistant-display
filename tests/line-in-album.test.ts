import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { albumArtworkReference, albumSnapshotSchema, type AlbumSnapshot } from "../src/shared/line-in-album.js";
import { LineInAlbum, publicAddress, readAlbum } from "../src/server/line-in-album.js";
import { loadConfig } from "../src/server/config.js";

const source = "a".repeat(64);
const boot = "b".repeat(32);
const art = "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/ab/cd/ef/album/400x400bb.jpg";
function snapshot(patch: Partial<AlbumSnapshot> = {}): AlbumSnapshot {
  const now = Date.now();
  return {
    version: 2, source_id: source, boot_id: boot, generation: 1,
    updated_at_ms: now, expires_at_ms: now + 4000, enabled: true, active: true, silence_dbfs: -45,
    remembered_enabled: true, settings_error: null,
    state: "identified", album: { title: "Real album", artist: "Artist", artwork: art, catalog: null }, ...patch,
  };
}
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const cover = async () => ({
  bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: "#789a93" } }).png().toBuffer(),
  type: "image/png",
});

it("validates source configuration as a complete binding, never an arbitrary path", () => {
  expect(() => loadConfig({ DEMO_MODE: "true", LINE_IN_ALBUM_SOURCE_ID: source })).toThrow();
  expect(() => loadConfig({ DEMO_MODE: "true", LINE_IN_ALBUM_SOURCE_ID: source, LINE_IN_ALBUM_SOURCE_UID: "abc" })).toThrow();
  expect(loadConfig({ DEMO_MODE: "true", LINE_IN_ALBUM_SOURCE_ID: source, LINE_IN_ALBUM_SOURCE_UID: "123" }).LINE_IN_ALBUM_SOURCE_UID).toBe(123);
});

it("rejects inconsistent metadata, unknown fields, lyrics and provider responses", () => {
  expect(albumSnapshotSchema.safeParse(snapshot()).success).toBe(true);
  for (const patch of [
    { version: 1 }, { state: "disabled" }, { active: false }, { enabled: false },
    { lyrics: "not allowed" }, { album: { title: "Song pretending to be album" } },
    { expires_at_ms: Date.now() + 90_000 }, { source_id: "../identity" },
    { album: { title: "x".repeat(257), artist: "Artist", artwork: null } },
  ]) expect(albumSnapshotSchema.safeParse({ ...snapshot(), ...patch }).success).toBe(false);
});

it("only accepts canonical Apple cover URLs and public resolved addresses", () => {
  expect(albumArtworkReference.safeParse(art).success).toBe(true);
  for (const url of [
    art.replace("https:", "http:"), art.replace("is1-ssl", "evil"), art.replace(".com/", ".com:443/"),
    art.replace("https://", "https://user@"), `${art}?x=1`, `${art}#x`, art.replace("/album/", "/../"),
    "https://127.0.0.1/image/thumb/a/400x400bb.jpg", art.replace("mzstatic.com", "mzstatic.com.evil"),
  ]) expect(albumArtworkReference.safeParse(url).success).toBe(false);
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.2", "169.254.169.254",
    "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "fe80::1", "224.0.0.1"]) {
    expect(publicAddress(ip)).toBe(false);
  }
  expect(publicAddress("17.253.144.10")).toBe(true);
  expect(publicAddress("2600:1408:ec00::1736:7f24")).toBe(true);
});

it("exposes album-only UI metadata with guarded local artwork, not raw source or lyrics", async () => {
  const fetcher = vi.fn();
  const service = new LineInAlbum(source, 123, async () => snapshot(), fetcher);
  const result = await service.view();
  expect(result).toEqual({
    state: "identified", key: `${boot}-1`, expiresAt: expect.any(Number),
    album: { title: "Real album", artist: "Artist", artworkUrl: `/api/line-in-album/artwork/${boot}-1` },
    tracklist: expect.objectContaining({ status: "unavailable", tracks: [] }),
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("clears stale metadata and never fetches disabled, idle, absent or old-generation artwork", async () => {
  const fetcher = vi.fn();
  let value: AlbumSnapshot | null = snapshot();
  const service = new LineInAlbum(source, 123, async () => value, fetcher);
  expect((await service.view()).album?.title).toBe("Real album");
  for (const patch of [
    { state: "disabled" as const, enabled: false, active: false, album: null },
    { state: "idle" as const, active: false, album: null },
    { state: "armed" as const, album: null },
  ]) {
    value = snapshot(patch);
    expect((await service.view()).album).toBeNull();
    expect(await service.artwork(`${boot}-1`, AbortSignal.timeout(1000))).toBeNull();
  }
  value = snapshot({ generation: 2 });
  expect(await service.artwork(`${boot}-1`, AbortSignal.timeout(1000))).toBeNull();
  value = null;
  expect((await service.view()).state).toBe("offline");
  expect((await service.view()).album).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it("coalesces concurrent cover clients into one fetch/decode result and cache", async () => {
  let complete!: (image: Awaited<ReturnType<typeof cover>>) => void;
  const fetcher = vi.fn(() => new Promise<Awaited<ReturnType<typeof cover>>>((resolve) => { complete = resolve; }));
  const service = new LineInAlbum(source, 123, async () => snapshot(), fetcher);
  const first = service.artwork(`${boot}-1`, AbortSignal.timeout(3000));
  const second = service.artwork(`${boot}-1`, AbortSignal.timeout(3000));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  complete(await cover());
  const [tv, admin] = await Promise.all([first, second]);
  expect(tv).not.toBeNull();
  expect(admin).toBe(tv);
  expect(tv?.contentType).toBe("image/jpeg");
  expect(await service.artwork(`${boot}-1`, AbortSignal.timeout(3000))).toBe(tv);
  expect(fetcher).toHaveBeenCalledOnce();
  service.close();
});

it("disconnecting one client rejects only its waiter and removes its listener", async () => {
  let complete!: (image: Awaited<ReturnType<typeof cover>>) => void;
  let sharedSignal!: AbortSignal;
  const fetcher = vi.fn((_url: string, signal: AbortSignal) => {
    sharedSignal = signal;
    return new Promise<Awaited<ReturnType<typeof cover>>>((resolve) => { complete = resolve; });
  });
  const service = new LineInAlbum(source, 123, async () => snapshot(), fetcher);
  const disconnected = new AbortController();
  const remaining = new AbortController();
  const removedFirst = vi.spyOn(disconnected.signal, "removeEventListener");
  const removedSecond = vi.spyOn(remaining.signal, "removeEventListener");
  const first = service.artwork(`${boot}-1`, disconnected.signal);
  const firstResult = expect(first).rejects.toThrow("client disconnected");
  const second = service.artwork(`${boot}-1`, remaining.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  disconnected.abort(new Error("client disconnected"));
  await firstResult;
  expect(sharedSignal.aborted).toBe(false);
  expect(removedFirst).toHaveBeenCalledWith("abort", expect.any(Function));
  complete(await cover());
  expect(await second).not.toBeNull();
  expect(removedSecond).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(fetcher).toHaveBeenCalledOnce();
  service.close();
});

it("isolates a shared artwork failure and settles every waiting client", async () => {
  let rejectFetch!: (error: Error) => void;
  const fetcher = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectFetch = reject; }));
  const service = new LineInAlbum(source, 123, async () => snapshot(), fetcher);
  const first = service.artwork(`${boot}-1`, AbortSignal.timeout(1000));
  const second = service.artwork(`${boot}-1`, AbortSignal.timeout(1000));
  const results = Promise.allSettled([first, second]);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const failure = new Error("image unavailable");
  rejectFetch(failure);
  expect(await results).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect((await service.view()).album?.title).toBe("Real album");
  service.close();
});

it("retires an old generation before coalescing the new generation without stale artwork", async () => {
  let value = snapshot();
  const image = await cover();
  let finishOld!: () => void;
  let oldSignal!: AbortSignal;
  const fetcher = vi.fn((_url: string, signal: AbortSignal) => {
    if (fetcher.mock.calls.length === 1) {
      oldSignal = signal;
      return new Promise<typeof image>((_resolve, reject) => {
        // Simulate asynchronous retirement after cancellation, not an overlapping fetch.
        finishOld = () => reject(signal.reason);
      });
    }
    return Promise.resolve(image);
  });
  const service = new LineInAlbum(source, 123, async () => value, fetcher);
  const old = service.artwork(`${boot}-1`, AbortSignal.timeout(3000));
  const oldResult = Promise.allSettled([old]);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  value = snapshot({ generation: 2 });
  const next = service.artwork(`${boot}-2`, AbortSignal.timeout(3000));
  const another = service.artwork(`${boot}-2`, AbortSignal.timeout(3000));
  await vi.waitFor(() => expect(oldSignal.aborted).toBe(true));
  expect(fetcher).toHaveBeenCalledOnce();
  finishOld();
  expect((await oldResult)[0]?.status).toBe("rejected");
  const [first, second] = await Promise.all([next, another]);
  expect(first).not.toBeNull();
  expect(second).toBe(first);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await service.artwork(`${boot}-1`, AbortSignal.timeout(1000))).toBeNull();
  service.close();
});

it("does not let an older snapshot cancel newer-generation artwork", async () => {
  let value = snapshot({ generation: 2 });
  let complete!: (image: Awaited<ReturnType<typeof cover>>) => void;
  let sharedSignal!: AbortSignal;
  const fetcher = vi.fn((_url: string, signal: AbortSignal) => {
    sharedSignal = signal;
    return new Promise<Awaited<ReturnType<typeof cover>>>((resolve) => { complete = resolve; });
  });
  const service = new LineInAlbum(source, 123, async () => value, fetcher);
  const current = service.artwork(`${boot}-2`, new AbortController().signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  value = snapshot({ generation: 1 });
  expect(await service.artwork(`${boot}-1`, new AbortController().signal)).toBeNull();
  expect(sharedSignal.aborted).toBe(false);
  value = snapshot({ generation: 2 });
  complete(await cover());
  expect(await current).not.toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
  service.close();
});

it("aborts shared work on lost metadata and settles all clients before the deadline", async () => {
  let value: AlbumSnapshot | null = snapshot();
  let sharedSignal!: AbortSignal;
  const fetcher = vi.fn((_url: string, signal: AbortSignal) => {
    sharedSignal = signal;
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const service = new LineInAlbum(source, 123, async () => value, fetcher);
  const clients = [new AbortController(), new AbortController()];
  const results = Promise.allSettled(clients.map((client) => service.artwork(`${boot}-1`, client.signal)));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  value = null;
  const settled = await results;
  expect(sharedSignal.aborted).toBe(true);
  expect(settled.every((result) => result.status === "rejected")).toBe(true);
  expect((await service.view()).album).toBeNull();
  service.close();
});

it("retains one shared timeout that rejects all waiting clients without stale caching", async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const fetcher = vi.fn((_url: string, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const service = new LineInAlbum(source, 123, async () => snapshot(), fetcher);
  const results = Promise.allSettled([
    service.artwork(`${boot}-1`, new AbortController().signal),
    service.artwork(`${boot}-1`, new AbortController().signal),
  ]);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(timeout).toHaveBeenCalledExactlyOnceWith(12_000);
  const reason = new Error("artwork deadline");
  deadline.abort(reason);
  expect(await results).toEqual([{ status: "rejected", reason }, { status: "rejected", reason }]);
  expect((await service.view()).album?.title).toBe("Real album");
  service.close();
});

it("bounds waiting clients and releases aborted waiters without accumulating shared listeners", async () => {
  const fetcher = vi.fn((_url: string, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const service = new LineInAlbum(source, 123, async () => snapshot(), fetcher);
  const clients = Array.from({ length: 32 }, () => new AbortController());
  const requests = clients.map((client) => service.artwork(`${boot}-1`, client.signal));
  const results = Promise.allSettled(requests);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await expect(service.artwork(`${boot}-1`, new AbortController().signal)).rejects.toThrow("album_artwork_busy");
  clients[0]!.abort();
  const replacementClient = new AbortController();
  const added = vi.spyOn(replacementClient.signal, "addEventListener");
  const replacement = service.artwork(`${boot}-1`, replacementClient.signal);
  const replacementResult = Promise.allSettled([replacement]);
  await vi.waitFor(() => expect(added).toHaveBeenCalledWith("abort", expect.any(Function), { once: true }));
  service.close();
  expect((await results).every((result) => result.status === "rejected")).toBe(true);
  expect((await replacementResult)[0]?.status).toBe("rejected");
  expect(fetcher).toHaveBeenCalledOnce();
});

it("does not start artwork after shutdown or for an already disconnected client", async () => {
  let finishRead!: (value: AlbumSnapshot) => void;
  const fetcher = vi.fn();
  const read = vi.fn(() => new Promise<AlbumSnapshot>((resolve) => { finishRead = resolve; }));
  const service = new LineInAlbum(source, 123, read, fetcher);
  const client = new AbortController();
  client.abort(new Error("already disconnected"));
  await expect(service.artwork(`${boot}-1`, client.signal)).rejects.toThrow("already disconnected");
  expect(read).not.toHaveBeenCalled();
  const request = service.artwork(`${boot}-1`, new AbortController().signal);
  service.close();
  finishRead(snapshot());
  expect(await request).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")("reads bounded atomic snapshots with identity, permissions, symlink and expiry checks", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".album-test-"));
  dirs.push(root);
  const directory = path.join(root, "handoff");
  await mkdir(directory, { mode: 0o2750 });
  await chmod(directory, 0o2750);
  const info = await lstat(directory);
  const file = path.join(directory, "album.json");
  const save = async (value: unknown) => { await writeFile(file, JSON.stringify(value)); await chmod(file, 0o640); };
  await save(snapshot());
  expect((await readAlbum(source, info.uid, Date.now(), directory))?.album?.title).toBe("Real album");
  expect(await readAlbum("c".repeat(64), info.uid, Date.now(), directory)).toBeNull();
  expect(await readAlbum(source, info.uid + 1, Date.now(), directory)).toBeNull();
  expect(await readAlbum(source, info.uid, Date.now() + 5000, directory)).toBeNull();
  expect(await readAlbum(source, info.uid, Date.now() - 1000, directory)).toBeNull();
  await chmod(file, 0o644);
  expect(await readAlbum(source, info.uid, Date.now(), directory)).toBeNull();
  await save({ ...snapshot(), ignored: "x".repeat(5000) });
  expect(await readAlbum(source, info.uid, Date.now(), directory)).toBeNull();
  await rm(file);
  await symlink(path.join(root, "private"), file);
  await expect(readAlbum(source, info.uid, Date.now(), directory)).rejects.toThrow();
  const link = path.join(root, "link");
  await symlink(directory, link);
  expect(await readAlbum(source, info.uid, Date.now(), link)).toBeNull();
});
