import { randomUUID } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import * as fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmbientStore, AMBIENT_LIMITS, imageTitle, UPLOAD_TIMEOUT_MS } from "../src/server/ambient.js";
import { decodeAmbientImage, MAX_DIMENSION, MAX_PIXELS, MAX_UPLOAD_BYTES } from "../src/server/ambient-decoder.js";
import { SettingsStore } from "../src/server/settings.js";
import { Bridge } from "../src/server/bridge.js";
import { DemoProvider } from "../src/server/demo.js";
import { createApp } from "../src/server/http.js";
import { BUILTIN_BACKGROUNDS, DEFAULT_AMBIENT, type AmbientImage, type AmbientLibrary } from "../src/shared/ambient.js";
import { DEFAULT_VINYL } from "../src/shared/vinyl.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const dir = path.resolve(`.test-ambient-${randomUUID()}`);
  await fs.mkdir(dir);
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const png = (width = 32, height = 24) => sharp({ create: { width, height, channels: 4, background: "#31556680" } }).png().toBuffer();
const jpg = () => sharp({ create: { width: 48, height: 32, channels: 3, background: "#aabbcc" } }).jpeg().toBuffer();
async function storeFixture() {
  const dir = await directory();
  const store = new AmbientStore(dir);
  await store.init();
  return { dir, store };
}
async function fixture() {
  const { dir, store } = await storeFixture();
  const settings = new SettingsStore(dir);
  await settings.init();
  const bridge = new Bridge(new DemoProvider(), { get: async () => null, put: async () => {} }, settings, true);
  const status = { enabled: false, available: false, message: "disabled", owned: false };
  const cec = { status: () => status, execute: vi.fn(async () => status) };
  const server: Server = createServer(createApp({ bridge, settings, ambient: store, cec, webDirectory: path.resolve("public") }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    bridge.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const response = await fetch(`${base}/api/session`);
  const { csrfToken } = await response.json() as { csrfToken: string };
  const auth = { Cookie: response.headers.get("set-cookie")!.split(";")[0]!, "X-CSRF-Token": csrfToken };
  const upload = (data: Buffer, contentType = "image/png", extra = {}) => fetch(`${base}/api/backgrounds/upload`, {
    method: "POST", headers: { ...auth, "Content-Type": contentType, ...extra }, body: new Uint8Array(data),
  });
  const post = (endpoint: string, body: unknown) => fetch(`${base}${endpoint}`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { base, auth, upload, post, dir, store, bridge, cec, settings };
}

describe("ambient native decoding", () => {
  it("accepts actual PNG/JPEG, auto-orients, strips metadata, resizes inside bounds and does not enlarge", async () => {
    const oriented = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#304060" } })
      .withMetadata({ orientation: 6 }).withExif({ IFD0: { Artist: "Private EXIF author" } }).jpeg().toBuffer();
    const rotated = await decodeAmbientImage(oriented, "image/jpeg");
    expect([rotated.width, rotated.height]).toEqual([1080, 2160]);
    const metadata = await sharp(rotated.data).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    const small = await decodeAmbientImage(await png(), "image/png");
    expect([small.width, small.height]).toEqual([32, 24]);
    expect((await sharp(small.data).metadata()).hasAlpha).toBe(false);
    const wide = await decodeAmbientImage(await png(2400, 1200), "image/png");
    expect([wide.width, wide.height]).toEqual([2400, 1200]);
  });

  it("preserves native 4K and resizes larger images inside 4K bounds", async () => {
    const native = await decodeAmbientImage(await png(3840, 2160), "image/png");
    expect([native.width, native.height]).toEqual([3840, 2160]);
    const oversized = await decodeAmbientImage(await png(5000, 3000), "image/png");
    expect([oversized.width, oversized.height]).toEqual([3600, 2160]);
  });

  it("rejects corrupt raster payloads, signatures alone, MIME mismatch, unsupported formats and trailing pages", async () => {
    const validPng = await png();
    const corrupt = Buffer.from(validPng);
    const idat = corrupt.indexOf("IDAT");
    corrupt[idat + 5] = corrupt[idat + 5]! ^ 0xff;
    const cases: [Buffer, string][] = [
      [Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg"],
      [validPng.subarray(0, 30), "image/png"], [corrupt, "image/png"],
      [await jpg(), "image/png"], [validPng, "image/jpeg"],
      [Buffer.from("<svg><script/></svg>"), "image/png"], [validPng, "image/webp"],
      [Buffer.concat([await jpg(), await jpg()]), "image/jpeg"],
    ];
    for (const [data, type] of cases) await expect(decodeAmbientImage(data, type)).rejects.toThrow();
  });

  it("rejects animation and MPO containers even when their default raster is otherwise valid", async () => {
    const data = await png();
    const animation = Buffer.alloc(20);
    animation.writeUInt32BE(8, 0);
    animation.write("acTL", 4);
    animation.writeUInt32BE(2, 8);
    await expect(decodeAmbientImage(Buffer.concat([data.subarray(0, 33), animation, data.subarray(33)]), "image/png"))
      .rejects.toThrow("Animated");
    const jpeg = await jpg();
    const mpo = Buffer.from([0xff, 0xe2, 0, 6, 0x4d, 0x50, 0x46, 0]);
    await expect(decodeAmbientImage(Buffer.concat([jpeg.subarray(0, 2), mpo, jpeg.subarray(2)]), "image/jpeg"))
      .rejects.toThrow("multipage");
  });

  it("bounds input bytes, dimensions and pixels before allocating raster buffers", async () => {
    await expect(decodeAmbientImage(Buffer.alloc(MAX_UPLOAD_BYTES + 1), "image/png")).rejects.toMatchObject({ status: 413 });
    for (const [width, height] of [[MAX_DIMENSION + 1, 1], [8000, 4001]]) {
      const bomb = await png();
      bomb.writeUInt32BE(width!, 16); bomb.writeUInt32BE(height!, 20);
      await expect(decodeAmbientImage(bomb, "image/png")).rejects.toMatchObject({ status: 413 });
    }
    expect(MAX_PIXELS).toBe(32_000_000);
    const dimensionJpeg = await sharp({ create: { width: 16_385, height: 1, channels: 3, background: "#000000" } }).jpeg().toBuffer();
    await expect(decodeAmbientImage(dimensionJpeg, "image/jpeg")).rejects.toMatchObject({ status: 413 });
  });

  it("kills a native decoder on cancellation and never returns a late success", async () => {
    const data = await png();
    const controller = new AbortController();
    const pending = decodeAmbientImage(data, "image/png", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 408 });
  });

  it("strips compressed PNG metadata before native decoding and bounds chunk bookkeeping", async () => {
    const data = await png();
    const text = Buffer.concat([Buffer.from("Comment\0\0"), deflateSync(Buffer.alloc(16 * 1024 * 1024, 65))]);
    const chunk = Buffer.alloc(text.length + 12);
    chunk.writeUInt32BE(text.length); chunk.write("zTXt", 4); text.copy(chunk, 8);
    const canonical = await decodeAmbientImage(Buffer.concat([data.subarray(0, 33), chunk, data.subarray(33)]), "image/png");
    expect((await sharp(canonical.data).metadata()).comments).toBeUndefined();
    const empty = Buffer.alloc(12); empty.write("tEXt", 4);
    await expect(decodeAmbientImage(Buffer.concat([data.subarray(0, 33), ...Array<Buffer>(4096).fill(empty), data.subarray(33)]), "image/png"))
      .rejects.toThrow("too many chunks");
  });
});

describe("ambient durable library", () => {
  it("uses generated ids and canonical URLs, sanitizes titles and reloads with the photo catalog", async () => {
    const { dir, store } = await storeFixture();
    expect(store.library().images).toEqual(BUILTIN_BACKGROUNDS);
    const image = await store.upload(await png(), "image/png", imageTitle(encodeURIComponent("../../odd\\<title>\0.png")));
    expect(image.id).toMatch(/^upload-[a-f0-9-]{36}$/);
    expect(image.title).toBe(".. .. odd title .png");
    expect(image.url).toBe(`/api/backgrounds/image/${image.id}`);
    expect((await fs.readdir(store.directory)).sort()).toEqual([`${image.id}.jpg`, "index.json"].sort());
    const restored = new AmbientStore(dir);
    await restored.init();
    expect(restored.library().images).toEqual([...BUILTIN_BACKGROUNDS, image]);
    expect(await restored.read("../index.json")).toBeNull();
    expect(await restored.read("builtin-paper")).toBeNull();
    expect(await restored.read(`upload-${randomUUID()}`)).toBeNull();
    expect((await restored.read(image.id))?.length).toBe(image.bytes);
  });

  it("keeps settings ids after deletion and rejects duplicate, missing or builtin ids without partial changes", async () => {
    const { store } = await storeFixture();
    const one = await store.upload(await png(), "image/png", "One");
    const two = await store.upload(await jpg(), "image/jpeg", "Two");
    for (const ids of [[], [one.id, one.id], [one.id, "builtin-paper"], [one.id, `upload-${randomUUID()}`]]) {
      await expect(store.delete(ids)).rejects.toThrow();
      expect(store.library().images).toContainEqual(one);
      expect(store.library().images).toContainEqual(two);
    }
    expect(await store.delete([two.id, one.id])).toEqual([two.id, one.id]);
    expect(await store.read(one.id)).toBeNull();
    expect(await fs.readdir(store.directory)).toEqual(["index.json"]);
  });

  it("cleans upload orphans and temporary files and recovers both phases of interrupted deletion", async () => {
    const { store, dir } = await storeFixture();
    const image = await store.upload(await jpg(), "image/jpeg", "Preserved");
    await fs.rename(path.join(store.directory, `${image.id}.jpg`), path.join(store.directory, `${image.id}.jpg.deleted`));
    await fs.writeFile(path.join(store.directory, `upload-${randomUUID()}.jpg`), await jpg());
    await fs.writeFile(path.join(store.directory, `upload-${randomUUID()}.jpg.deleted`), await jpg());
    await fs.writeFile(path.join(store.directory, `.write-${randomUUID()}.tmp`), "unfinished");
    const restored = new AmbientStore(dir);
    await restored.init();
    expect(restored.library().images).toContainEqual(image);
    expect((await fs.readdir(store.directory)).sort()).toEqual([`${image.id}.jpg`, "index.json"].sort());
  });

  it("does not follow symlinked storage directories or linked image files", async () => {
    const { store, dir } = await storeFixture();
    const outside = await directory();
    const rootLink = path.join(dir, "linked-state");
    await fs.symlink(outside, rootLink, "junction");
    await expect(new AmbientStore(rootLink).init()).rejects.toThrow("symbolic links");
    expect(await fs.readdir(outside)).toEqual([]);
    const image = await store.upload(await jpg(), "image/jpeg", "Linked");
    const file = path.join(store.directory, `${image.id}.jpg`);
    await fs.rename(file, path.join(outside, "private.jpg"));
    await fs.link(path.join(outside, "private.jpg"), file);
    await expect(store.read(image.id)).rejects.toThrow("Unsafe");
    await expect(store.delete([image.id])).rejects.toThrow("Unsafe");
    await expect(new AmbientStore(dir).init()).rejects.toThrow("Unsafe");
    expect((await fs.readFile(path.join(outside, "private.jpg"))).length).toBe(image.bytes);
    await fs.unlink(file);
    await fs.symlink(outside, file, "junction");
    await expect(store.read(image.id)).rejects.toThrow("Unsafe");
    await expect(store.delete([image.id])).rejects.toThrow("Unsafe");
    await expect(new AmbientStore(dir).init()).rejects.toThrow("Unsafe");
    expect(await fs.readdir(outside)).toEqual(["private.jpg"]);
  });

  it("enforces 40 images including orphans and counts actual canonical bytes toward the storage quota", async () => {
    const { store, dir } = await storeFixture();
    const data = await jpg();
    const images = [];
    for (let i = 0; i < 40; i++) {
      const id = `upload-${randomUUID()}`;
      await fs.writeFile(path.join(store.directory, `${id}.jpg`), data);
      images.push({ id, title: `Image ${i}`, width: 48, height: 32, bytes: data.length });
    }
    await expect(store.upload(await png(), "image/png", "Over count")).rejects.toMatchObject({ status: 409 });
    await fs.writeFile(path.join(store.directory, "index.json"), JSON.stringify({ version: 1, images }));
    const restored = new AmbientStore(dir);
    await restored.init();
    expect(() => restored.reserveUpload()).toThrow("full");
    await restored.delete(images.map((image) => image.id));
    const orphan = path.join(store.directory, `upload-${randomUUID()}.jpg`);
    await fs.writeFile(orphan, "");
    await fs.truncate(orphan, AMBIENT_LIMITS.maxStorageBytes);
    await expect(restored.upload(await png(), "image/png", "Over bytes")).rejects.toMatchObject({ status: 409 });
    const recovered = new AmbientStore(dir);
    await recovered.init();
    expect(recovered.library().images).toEqual(BUILTIN_BACKGROUNDS);
    expect((await recovered.upload(await png(), "image/png", "Recovered")).bytes).toBeLessThan(MAX_UPLOAD_BYTES);
  }, 20_000);

  it("rejects symlinked ambient and settings temporary files without touching their targets", async () => {
    const { store, dir } = await storeFixture();
    const outside = await directory();
    const target = path.join(outside, "private.json");
    await fs.writeFile(target, '{"private":true}');
    const temporary = path.join(store.directory, `.write-${randomUUID()}.tmp`);
    await fs.symlink(outside, temporary, "junction");
    await expect(store.upload(await png(), "image/png", "No linked writes")).rejects.toThrow("Unsafe");
    await expect(new AmbientStore(dir).init()).rejects.toThrow("Unsafe");
    expect(await fs.readFile(target, "utf8")).toBe('{"private":true}');
    const settings = new SettingsStore(dir);
    await settings.init();
    const settingsTemporary = path.join(dir, "settings.json.tmp");
    await fs.symlink(outside, settingsTemporary, "junction");
    await expect(settings.set({ viewMode: "ambient" })).rejects.toThrow("Unsafe");
    await expect(new SettingsStore(dir).init()).rejects.toThrow("Unsafe");
    expect(settings.viewMode).toBe("split");
    await fs.unlink(settingsTemporary);
    await fs.link(target, settingsTemporary);
    await expect(settings.set({ ambient: { dwellSeconds: 120 } })).rejects.toThrow("Unsafe");
    expect(await fs.readFile(target, "utf8")).toBe('{"private":true}');
    expect(settings.ambient.dwellSeconds).toBe(60);
    await fs.unlink(settingsTemporary);
    await settings.set({ viewMode: "ambient" });
    expect(settings.viewMode).toBe("ambient");
  });

  it("surfaces failed metadata writes, rolls back deletion staging and leaves settings unchanged", async () => {
    const { store } = await storeFixture();
    const image = await store.upload(await jpg(), "image/jpeg", "Must survive");
    const index = path.join(store.directory, "index.json");
    const saved = await fs.readFile(index);
    await fs.unlink(index);
    await fs.mkdir(index);
    await expect(store.delete([image.id])).rejects.toThrow();
    expect(store.library().images).toContainEqual(image);
    expect(await store.read(image.id)).not.toBeNull();
    await expect(store.upload(await png(), "image/png", "Must not succeed")).rejects.toThrow();
    expect(store.library().images).toHaveLength(BUILTIN_BACKGROUNDS.length + 1);
    expect((await fs.readdir(store.directory)).sort()).toEqual([`${image.id}.jpg`, "index.json"].sort());
    await fs.rmdir(index);
    await fs.writeFile(index, saved);
    expect(await store.delete([image.id])).toEqual([image.id]);
  });

  it("reports postcommit cleanup failures explicitly and recovers the committed deletion on restart", async () => {
    const { store, dir } = await storeFixture();
    const image = await store.upload(await jpg(), "image/jpeg", "Cleanup fails");
    vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("simulated disk failure"));
    await expect(store.delete([image.id])).rejects.toThrow("Images removed from the library, but file cleanup failed");
    expect(store.library().images).toEqual(BUILTIN_BACKGROUNDS);
    expect(await fs.readdir(store.directory)).toContain(`${image.id}.jpg.deleted`);
    expect(await store.read(image.id)).toBeNull();
    const restored = new AmbientStore(dir);
    await restored.init();
    expect(restored.library().images).toEqual(BUILTIN_BACKGROUNDS);
    expect(await fs.readdir(store.directory)).toEqual(["index.json"]);
  });

  it("rolls back an entire deletion batch when staging a later file fails", async () => {
    const { store, dir } = await storeFixture();
    const first = await store.upload(await jpg(), "image/jpeg", "First");
    const second = await store.upload(await png(), "image/png", "Second");
    const secondFile = path.join(store.directory, `${second.id}.jpg`);
    const savedFile = path.join(dir, "saved-image.jpg");
    const manifest = await fs.readFile(path.join(store.directory, "index.json"), "utf8");
    const revision = store.revision;
    await fs.rename(secondFile, savedFile);
    await expect(store.delete([first.id, second.id])).rejects.toThrow();
    expect(store.revision).toBe(revision);
    expect(await fs.readFile(path.join(store.directory, "index.json"), "utf8")).toBe(manifest);
    expect(await store.read(first.id)).not.toBeNull();
    expect(await fs.readdir(store.directory)).not.toContain(`${first.id}.jpg.deleted`);
    await fs.rename(savedFile, secondFile);
    expect(await store.delete([first.id, second.id])).toEqual([first.id, second.id]);
  });
});

describe("ambient HTTP", () => {
  it("caches only catalog-versioned bundled assets and serves a small local catalog preview", async () => {
    const { base } = await fixture();
    const photo = BUILTIN_BACKGROUNDS[0]!;
    const preview = await fetch(`${base}${photo.thumbnailUrl}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).toMatchObject({ width: 480, height: 270 });
    const unversioned = await fetch(`${base}${photo.thumbnailUrl!.split("?")[0]}`);
    expect(unversioned.headers.get("cache-control")).toBe("no-store");
    const original = await fetch(`${base}${photo.url}`);
    expect(original.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await sharp(Buffer.from(await original.arrayBuffer())).metadata()).toMatchObject({ width: 3840, height: 2160 });
  });

  it("serves bounded previews with revalidated caching and stops serving them after deletion", async () => {
    const { base, upload, post } = await fixture();
    const response = await upload(await png(3840, 2160));
    expect(response.status).toBe(201);
    const { image } = await response.json() as { image: AmbientImage };
    expect([image.width, image.height]).toEqual([3840, 2160]);
    const preview = await fetch(`${base}${image.thumbnailUrl}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("private, no-cache");
    expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
    expect(preview.headers.get("content-type")).toContain("image/jpeg");
    expect(await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).toMatchObject({ width: 480, height: 270 });
    const etag = preview.headers.get("etag")!;
    expect(etag).toBeTruthy();
    expect((await fetch(`${base}${image.thumbnailUrl}`, { headers: { "If-None-Match": etag, "Cache-Control": "max-age=0" } })).status).toBe(304);
    expect((await post("/api/backgrounds/delete", { ids: [image.id] })).status).toBe(200);
    const missing = await fetch(`${base}${image.thumbnailUrl}`, { headers: { "If-None-Match": etag } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${base}/api/backgrounds/thumbnail/..%2Findex.json`)).status).toBe(404);
  });

  it("lists without a session, uploads canonical images with hardened headers and broadcasts changes", async () => {
    const { base, upload, post, store, bridge, cec, settings } = await fixture();
    const library = await (await fetch(`${base}/api/backgrounds`)).json() as AmbientLibrary;
    expect(library.images).toEqual(BUILTIN_BACKGROUNDS);
    expect(library.limits).toEqual({ maxUploadBytes: 12 * 1024 * 1024, maxImages: 40, maxStorageBytes: 128 * 1024 * 1024, maxPixels: 32_000_000 });
    const changed = vi.fn();
    bridge.on("change", changed);
    const response = await upload(await png(), "image/png", { "X-Image-Title": encodeURIComponent("Café dawn.png") });
    expect(response.status).toBe(201);
    const { image } = await response.json() as { image: AmbientImage };
    expect(image.title).toBe("Café dawn.png");
    expect(changed).toHaveBeenCalledTimes(1);
    const rendered = await fetch(`${base}${image.url}`);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("content-type")).toMatch(/^image\/jpeg/);
    expect(rendered.headers.get("x-content-type-options")).toBe("nosniff");
    expect(rendered.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect((await sharp(Buffer.from(await rendered.arrayBuffer())).metadata()).format).toBe("jpeg");
    const preferences = { selectedIds: [image.id], slideshow: false, dwellSeconds: 15 };
    const updated = await post("/api/settings", { ambient: preferences, viewMode: "ambient" });
    expect(await updated.json()).toEqual({ visualOffsetMs: 0, viewMode: "ambient", lyricFollowMode: "smooth", ambient: preferences, vinyl: DEFAULT_VINYL });
    expect(await (await fetch(`${base}/api/state`)).json()).toMatchObject({ viewMode: "ambient", ambient: preferences });
    expect((await post("/api/backgrounds/delete", { ids: [image.id] })).status).toBe(200);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(settings.ambient).toEqual(preferences);
    expect(store.library().images).toEqual(BUILTIN_BACKGROUNDS);
    expect((await fetch(`${base}${image.url}`)).status).toBe(404);
    expect(cec.execute).not.toHaveBeenCalled();
  });

  it("authenticates all modifications before buffering or parsing even malformed and oversized bodies", async () => {
    const { base, auth, store } = await fixture();
    const reserve = vi.spyOn(store, "reserveUpload");
    const cases = [
      { "Content-Type": "image/png" },
      { ...auth, Host: "evil.example", "Content-Type": "image/png" },
      { ...auth, Origin: "https://evil.example", "Content-Type": "image/png" },
      { ...auth, "Sec-Fetch-Site": "cross-site", "Content-Type": "image/png" },
      { ...auth, Cookie: "karaoke_session=bad", "Content-Type": "image/png" },
    ];
    for (const headers of cases) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${base}/api/backgrounds/upload`, {
          method: "POST", headers: { ...headers, "Content-Length": MAX_UPLOAD_BYTES + 1 },
        }, (res) => { res.resume(); resolve(res.statusCode); req.destroy(); });
        req.on("error", reject); req.flushHeaders();
      });
      expect(status).toBe(403);
    }
    for (const endpoint of ["/api/settings", "/api/backgrounds/delete"]) {
      const res = await fetch(`${base}${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{".repeat(5000),
      });
      expect(res.status).toBe(403);
    }
    expect(reserve).not.toHaveBeenCalled();
  });

  it("rejects unsupported MIME/encoding, arbitrary URL imports and untrusted ids", async () => {
    const { base, upload, post, store } = await fixture();
    const reserve = vi.spyOn(store, "reserveUpload");
    for (const type of ["image/svg+xml", "image/gif", "image/webp", "image/png; charset=utf-8", "application/json"]) {
      expect((await upload(await png(), type)).status).toBe(415);
    }
    expect((await upload(await png(), "image/png", { "Content-Encoding": "gzip" })).status).toBe(415);
    expect((await upload(await png(), "image/png", { "X-Image-Title": "%" })).status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
    expect((await post("/api/backgrounds/upload", { url: "http://127.0.0.1/private" })).status).toBe(415);
    for (const ids of [[], ["builtin-paper"], ["../index.json"], [`upload-${randomUUID()}`]]) {
      expect((await post("/api/backgrounds/delete", { ids })).status).toBe(ids[0]?.startsWith("upload-") ? 404 : 400);
    }
    expect((await fetch(`${base}/api/backgrounds/image/..%2Findex.json`)).status).toBe(404);
  });

  it("limits Content-Length and chunked streaming bytes and admits only one body at a time", async () => {
    const { base, auth, store, upload } = await fixture();
    const imageHeaders = { ...auth, "Content-Type": "image/png" };
    const headersOnly = (headers: Record<string, string | number>) => new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/backgrounds/upload`, { method: "POST", headers }, (res) => {
        res.resume(); resolve(res.statusCode); req.destroy();
      });
      req.on("error", reject); req.flushHeaders();
    });
    expect(await headersOnly({ ...imageHeaders, "Content-Length": MAX_UPLOAD_BYTES + 1 })).toBe(413);
    const reserve = vi.spyOn(store, "reserveUpload");
    const held = request(`${base}/api/backgrounds/upload`, { method: "POST", headers: { ...imageHeaders, "Transfer-Encoding": "chunked" } });
    held.on("error", () => {});
    held.flushHeaders();
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledTimes(1));
    expect(await headersOnly({ ...imageHeaders, "Content-Length": 1 })).toBe(429);
    held.destroy();
    await vi.waitFor(() => {
      const release = store.reserveUpload();
      release();
    });
    const overflow = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/backgrounds/upload`, {
        method: "POST", headers: { ...imageHeaders, "Transfer-Encoding": "chunked" },
      }, (res) => { res.resume(); resolve(res.statusCode); req.destroy(); });
      req.on("error", reject);
      req.end(Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    });
    expect(overflow).toBe(413);
    expect((await upload(await png())).status).toBe(201);
  });

  it("times out an incomplete upload and releases admission without creating files", async () => {
    const { base, auth, store } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reserve = vi.spyOn(store, "reserveUpload");
    const pending = new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/backgrounds/upload`, {
        method: "POST", headers: { ...auth, "Content-Type": "image/png", "Content-Length": 100 },
      }, (res) => { res.resume(); resolve(res.statusCode); req.destroy(); });
      req.on("error", reject); req.flushHeaders();
    });
    for (let i = 0; i < 100 && !reserve.mock.calls.length; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reserve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS + 1);
    expect(await pending).toBe(408);
    const release = store.reserveUpload();
    release();
    expect(await fs.readdir(store.directory)).toEqual([]);
    expect(store.library().images).toEqual(BUILTIN_BACKGROUNDS);
  });

  it("returns errors rather than success when image or settings persistence fails", async () => {
    const { upload, post, dir, store, settings, bridge } = await fixture();
    await fs.mkdir(path.join(store.directory, "index.json"));
    expect((await upload(await png())).status).toBe(500);
    expect(store.library().images).toHaveLength(BUILTIN_BACKGROUNDS.length);
    expect(await fs.readdir(store.directory)).toEqual(["index.json"]);
    await fs.mkdir(path.join(dir, "settings.json"));
    const changed = vi.fn();
    bridge.on("change", changed);
    expect((await post("/api/settings", { viewMode: "ambient", ambient: { dwellSeconds: 180 } })).status).toBe(500);
    expect(settings.viewMode).toBe("split");
    expect(settings.ambient).toEqual(DEFAULT_AMBIENT);
    expect(changed).not.toHaveBeenCalled();
  });

  it("accepts every builtin plus 40 selected uploads, rejects one extra and preserves concurrent partial patches", async () => {
    const { base, post, settings } = await fixture();
    const selectedIds = [...DEFAULT_AMBIENT.selectedIds, ...Array.from({ length: 40 }, () => `upload-${randomUUID()}`)];
    const full = await post("/api/settings", { ambient: { ...DEFAULT_AMBIENT, selectedIds }, viewMode: "ambient", visualOffsetMs: 1000 });
    expect(full.status).toBe(200);
    expect((await post("/api/settings", { ambient: { selectedIds: [...selectedIds, `upload-${randomUUID()}`] } })).status).toBe(400);
    expect((await Promise.all([
      post("/api/settings", { ambient: { dwellSeconds: 90 } }),
      post("/api/settings", { ambient: { slideshow: false } }),
      post("/api/settings", { visualOffsetMs: -200 }),
    ])).map((res) => res.status)).toEqual([200, 200, 200]);
    expect(settings.ambient).toEqual({ selectedIds, slideshow: false, dwellSeconds: 90 });
    expect(await (await fetch(`${base}/api/settings`)).json()).toEqual({
      visualOffsetMs: -200, viewMode: "ambient", lyricFollowMode: "smooth", ambient: settings.ambient, vinyl: DEFAULT_VINYL,
    });
  });
});
