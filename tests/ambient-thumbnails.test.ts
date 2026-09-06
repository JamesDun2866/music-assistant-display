import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AMBIENT_LIMITS, AmbientStore } from "../src/server/ambient.js";
import * as decoder from "../src/server/ambient-decoder.js";
import { SettingsStore } from "../src/server/settings.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

const directories: string[] = [];
const storageLimit = AMBIENT_LIMITS.maxStorageBytes;
afterEach(async () => {
  vi.restoreAllMocks();
  AMBIENT_LIMITS.maxStorageBytes = storageLimit;
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = path.resolve(`.test-ambient-thumbnails-${randomUUID()}`);
  directories.push(dir);
  const store = new AmbientStore(dir);
  await store.init();
  return { dir, store };
}
const jpeg = (width = 3840, height = 2160) =>
  sharp({ create: { width, height, channels: 3, background: "#456789" } }).jpeg().toBuffer();

describe("bounded local ambient previews", () => {
  it("preserves old v1 uploads and preferences without decoding at startup, then persists one lazy derivative", async () => {
    const { dir, store } = await fixture();
    const data = await jpeg(1920, 1080);
    const image = { id: `upload-${randomUUID()}`, title: "Existing upload", width: 1920, height: 1080, bytes: data.length };
    const index = JSON.stringify({ version: 1, images: [image] });
    await fs.writeFile(path.join(store.directory, `${image.id}.jpg`), data);
    await fs.writeFile(path.join(store.directory, "index.json"), index);
    const settingsData = JSON.stringify({
      visualOffsetMs: -50, viewMode: "ambient",
      ambient: { selectedIds: ["builtin-golden-gate", image.id], dwellSeconds: 315, slideshow: false },
    });
    await fs.writeFile(path.join(dir, "settings.json"), settingsData);
    const decode = vi.spyOn(decoder, "decodeAmbientImage");
    const restored = new AmbientStore(dir);
    await restored.init();
    const settings = new SettingsStore(dir);
    await settings.init();
    expect(decode).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(store.directory, "index.json"), "utf8")).toBe(index);
    expect(restored.library().images.find((item) => item.id === image.id)).toMatchObject({
      ...image, thumbnailUrl: `/api/backgrounds/thumbnail/${image.id}`,
    });
    const thumbnail = await restored.thumbnail(image.id);
    expect(await sharp(thumbnail!).metadata()).toMatchObject({ width: 480, height: 270, format: "jpeg" });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(thumbnail!.length).toBeLessThanOrEqual(decoder.MAX_THUMBNAIL_BYTES);
    expect(await restored.read(image.id)).toEqual(data);
    expect(await fs.readFile(path.join(dir, "settings.json"), "utf8")).toBe(settingsData);
    const again = new AmbientStore(dir);
    await again.init();
    expect(await again.thumbnail(image.id)).toEqual(thumbnail);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(again.library().images.find((item) => item.id === image.id)?.thumbnailBytes).toBe(thumbnail!.length);
  });

  it("keeps native 4K originals and coalesces concurrent preview requests into one isolated decode", async () => {
    const { store } = await fixture();
    const image = await store.upload(await jpeg(), "image/jpeg", "Native 4K");
    expect([image.width, image.height]).toEqual([3840, 2160]);
    const decode = vi.spyOn(decoder, "decodeAmbientImage");
    const thumbnails = await Promise.all(Array.from({ length: 25 }, () => store.thumbnail(image.id)));
    expect(decode).toHaveBeenCalledTimes(1);
    for (const thumbnail of thumbnails) expect(thumbnail).toEqual(thumbnails[0]);
    expect(await sharp(thumbnails[0]!).metadata()).toMatchObject({ width: 480, height: 270 });
    expect(await sharp((await store.read(image.id))!).metadata()).toMatchObject({ width: 3840, height: 2160 });
    expect(await store.thumbnail("../index.json")).toBeNull();
    expect(await store.thumbnail("builtin-golden-gate")).toBeNull();
  });

  it("serializes different lazy decodes, does not enlarge previews, and honors decoder cancellation", async () => {
    const { store } = await fixture();
    const images = await Promise.all([jpeg(32, 24), jpeg(64, 48)]);
    const one = await store.upload(images[0]!, "image/jpeg", "One");
    const two = await store.upload(images[1]!, "image/jpeg", "Two");
    const actual = decoder.decodeAmbientImage;
    let active = 0;
    let peak = 0;
    vi.spyOn(decoder, "decodeAmbientImage").mockImplementation(async (...args) => {
      peak = Math.max(peak, ++active);
      try { return await actual(...args); } finally { active--; }
    });
    const previews = await Promise.all([store.thumbnail(one.id), store.thumbnail(two.id)]);
    expect(peak).toBe(1);
    expect(await sharp(previews[0]!).metadata()).toMatchObject({ width: 32, height: 24 });
    const controller = new AbortController();
    const pending = actual(images[0]!, "image/jpeg", controller.signal, true);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 408 });
  });

  it("charges derivative bytes to upload and startup quotas but not the image count", async () => {
    const { store, dir } = await fixture();
    const image = await store.upload(await jpeg(32, 24), "image/jpeg", "Quota");
    AMBIENT_LIMITS.maxStorageBytes = image.bytes;
    await expect(store.thumbnail(image.id)).rejects.toMatchObject({ status: 409 });
    expect(await fs.readdir(store.directory)).not.toContain(`${image.id}.thumb.jpg`);
    AMBIENT_LIMITS.maxStorageBytes = storageLimit;
    const thumbnail = await store.thumbnail(image.id);
    AMBIENT_LIMITS.maxStorageBytes = image.bytes + thumbnail!.length;
    await expect(store.upload(await jpeg(32, 24), "image/jpeg", "Over quota")).rejects.toMatchObject({ status: 409 });
    const restored = new AmbientStore(dir);
    await restored.init();
    const release = restored.reserveUpload();
    release();
    AMBIENT_LIMITS.maxStorageBytes--;
    await expect(new AmbientStore(dir).init()).rejects.toThrow("quota");
  });

  it("does not block scene reads or deletion during decoding and never resurrects a deleted image", async () => {
    const { store } = await fixture();
    const image = await store.upload(await jpeg(32, 24), "image/jpeg", "Delete while decoding");
    const actual = decoder.decodeAmbientImage;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const decoding = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(decoder, "decodeAmbientImage").mockImplementationOnce(async (...args) => {
      started();
      await gate;
      return actual(...args);
    });
    const pending = store.thumbnail(image.id);
    await decoding;
    try {
      expect(await store.read(image.id)).not.toBeNull();
      expect(await store.delete([image.id])).toEqual([image.id]);
    } finally { release(); }
    expect(await pending).toBeNull();
    expect(await fs.readdir(store.directory)).toEqual(["index.json"]);
  });

  it("rolls back failed derivative metadata writes and recovers orphan and both deletion phases", async () => {
    const { store, dir } = await fixture();
    const image = await store.upload(await jpeg(32, 24), "image/jpeg", "Recover");
    const originalRename = vi.mocked(fs.rename).getMockImplementation()!;
    vi.mocked(fs.rename).mockImplementationOnce(originalRename);
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("metadata write failed"));
    await expect(store.thumbnail(image.id)).rejects.toThrow("metadata write failed");
    expect(await fs.readdir(store.directory)).not.toContain(`${image.id}.thumb.jpg`);
    expect(store.library().images.find((item) => item.id === image.id)?.thumbnailBytes).toBeUndefined();
    const thumbnail = await store.thumbnail(image.id);
    for (const suffix of [".jpg", ".thumb.jpg"]) {
      await fs.rename(path.join(store.directory, `${image.id}${suffix}`), path.join(store.directory, `${image.id}${suffix}.deleted`));
    }
    const orphan = `upload-${randomUUID()}.thumb.jpg`;
    await fs.writeFile(path.join(store.directory, orphan), thumbnail!);
    const restored = new AmbientStore(dir);
    await restored.init();
    expect(await restored.thumbnail(image.id)).toEqual(thumbnail);
    expect(await fs.readdir(store.directory)).not.toContain(orphan);
    vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(restored.delete([image.id])).rejects.toThrow("file cleanup failed");
    const final = new AmbientStore(dir);
    await final.init();
    expect(await fs.readdir(store.directory)).toEqual(["index.json"]);
    expect(await final.thumbnail(image.id)).toBeNull();
  });

  it("rolls back original and derivative staging together when deletion metadata fails", async () => {
    const { store } = await fixture();
    const image = await store.upload(await jpeg(32, 24), "image/jpeg", "Rollback");
    const thumbnail = await store.thumbnail(image.id);
    const originalRename = vi.mocked(fs.rename).getMockImplementation()!;
    vi.mocked(fs.rename).mockImplementationOnce(originalRename).mockImplementationOnce(originalRename)
      .mockRejectedValueOnce(new Error("cannot commit deletion"));
    await expect(store.delete([image.id])).rejects.toThrow("cannot commit deletion");
    expect(await store.read(image.id)).not.toBeNull();
    expect(await store.thumbnail(image.id)).toEqual(thumbnail);
    expect((await fs.readdir(store.directory)).some((name) => name.endsWith(".deleted"))).toBe(false);
  });

  it("refuses linked derivative files during reads, deletion and startup", async () => {
    const { store, dir } = await fixture();
    const image = await store.upload(await jpeg(32, 24), "image/jpeg", "Linked preview");
    await store.thumbnail(image.id);
    const file = path.join(store.directory, `${image.id}.thumb.jpg`);
    const outside = path.join(dir, "private.jpg");
    await fs.rename(file, outside);
    await fs.link(outside, file);
    await expect(store.thumbnail(image.id)).rejects.toThrow("Unsafe");
    await expect(store.delete([image.id])).rejects.toThrow("Unsafe");
    await expect(new AmbientStore(dir).init()).rejects.toThrow("Unsafe");
    expect(await store.read(image.id)).not.toBeNull();
    await fs.unlink(file);
    await fs.symlink(dir, file, "junction");
    await expect(store.thumbnail(image.id)).rejects.toThrow("Unsafe");
    await expect(store.delete([image.id])).rejects.toThrow("Unsafe");
    await expect(new AmbientStore(dir).init()).rejects.toThrow("Unsafe");
  });
});
