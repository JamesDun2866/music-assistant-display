import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BUILTIN_BACKGROUNDS, uploadIdSchema, type AmbientImage, type AmbientLibrary } from "../shared/ambient.js";
import { AmbientError, decodeAmbientImage, MAX_CANONICAL_BYTES, MAX_PIXELS, MAX_UPLOAD_BYTES, MAX_THUMBNAIL_BYTES } from "./ambient-decoder.js";
import { isFsError } from "./cache.js";

export { AmbientError } from "./ambient-decoder.js";
export const AMBIENT_LIMITS = {
  maxUploadBytes: MAX_UPLOAD_BYTES, maxImages: 40, maxStorageBytes: 128 * 1024 * 1024, maxPixels: MAX_PIXELS,
};
export const UPLOAD_TIMEOUT_MS = 15_000;
export const deleteImagesSchema = z.object({
  ids: z.array(uploadIdSchema).min(1).max(40).refine((ids) => new Set(ids).size === ids.length, "Duplicate image ids"),
}).strict();
const imageSchema = z.object({
  id: uploadIdSchema, title: z.string().min(1).max(120),
  width: z.number().int().min(1).max(3840), height: z.number().int().min(1).max(2160),
  bytes: z.number().int().min(1).max(MAX_CANONICAL_BYTES),
  thumbnail: z.object({
    width: z.number().int().min(1).max(480), height: z.number().int().min(1).max(270),
    bytes: z.number().int().min(1).max(MAX_THUMBNAIL_BYTES),
  }).strict().optional(),
}).strict();
const indexSchema = z.object({
  version: z.literal(1),
  images: z.array(imageSchema).max(40).refine((images) => new Set(images.map((image) => image.id)).size === images.length),
}).strict();
type StoredImage = z.infer<typeof imageSchema>;
const toImage = ({ thumbnail, ...image }: StoredImage): AmbientImage => ({
  ...image, source: "upload", url: `/api/backgrounds/image/${image.id}`,
  thumbnailUrl: `/api/backgrounds/thumbnail/${image.id}`, ...(thumbnail ? { thumbnailBytes: thumbnail.bytes } : {}),
});
const filePattern = /^upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg(?:\.deleted)?$/;
const thumbnailPattern = /^upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.thumb\.jpg(?:\.deleted)?$/;
const temporaryPattern = /^\.write-[0-9a-f-]{36}\.tmp$/;

export function imageTitle(encoded?: string): string {
  if (encoded === undefined) return "Uploaded image";
  if (encoded.length > 2048) throw new AmbientError(400, "Image title is too long");
  let title: string;
  try { title = decodeURIComponent(encoded); } catch { throw new AmbientError(400, "Image title must be percent-encoded text"); }
  title = title.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\<>]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 120);
  return title || "Uploaded image";
}

async function assertDirectories(directory: string): Promise<void> {
  let current = path.resolve(directory);
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new AmbientError(500, "Ambient storage must not use symbolic links");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function createDirectory(directory: string): Promise<void> {
  let existing = directory;
  while (true) {
    try { await lstat(existing); break; }
    catch (error) { if (!isFsError(error, "ENOENT")) throw error; existing = path.dirname(existing); }
  }
  await assertDirectories(existing);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertDirectories(directory);
}

async function safeRead(file: string, maximum: number): Promise<Buffer> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
    throw new AmbientError(500, "Unsafe or oversized ambient storage file");
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev || actual.size > maximum) {
      throw new AmbientError(500, "Ambient storage file changed unexpectedly");
    }
    const buffer = Buffer.alloc(actual.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new AmbientError(500, "Incomplete ambient storage file");
      offset += bytesRead;
    }
    return buffer;
  } finally { await handle.close(); }
}

export class AmbientStore {
  readonly directory: string;
  private images: StoredImage[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  private uploading = false;
  private initialized = false;
  private thumbnails = new Map<string, Promise<Buffer | null>>();
  private thumbnailWrites: Promise<unknown> = Promise.resolve();
  revision = 0;

  constructor(stateDirectory: string) { this.directory = path.resolve(stateDirectory, "ambient"); }

  async init(): Promise<void> {
    await createDirectory(this.directory);
    const manifest = path.join(this.directory, "index.json");
    let images: StoredImage[] = [];
    try { images = indexSchema.parse(JSON.parse((await safeRead(manifest, 64 * 1024)).toString("utf8"))).images; }
    catch (error) { if (!isFsError(error, "ENOENT")) throw error; }
    const names = await readdir(this.directory);
    for (const name of names) {
      const file = path.join(this.directory, name);
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new AmbientError(500, "Unsafe ambient storage entry");
      const thumbnail = thumbnailPattern.test(name);
      const imageFile = thumbnail || filePattern.test(name);
      const original = name.replace(/\.deleted$/, "");
      const tracked = images.some((image) => original === `${image.id}.jpg` ||
        (image.thumbnail && original === `${image.id}.thumb.jpg`));
      if (imageFile && name.endsWith(".deleted")) {
        if (tracked) {
          if (names.includes(original)) throw new AmbientError(500, "Conflicting ambient deletion recovery files");
          await rename(file, path.join(this.directory, original));
        } else await unlink(file);
      } else if (temporaryPattern.test(name) || (imageFile && !tracked)) {
        await unlink(file);
      } else if (name !== "index.json" && !imageFile) {
        throw new AmbientError(500, "Unexpected file in ambient storage");
      }
    }
    for (const image of images) {
      const data = await safeRead(this.imagePath(image.id), MAX_CANONICAL_BYTES);
      if (data.length !== image.bytes || data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
        throw new AmbientError(500, "Ambient image is missing or corrupt");
      }
      if (image.thumbnail) await this.readThumbnailFile(image);
    }
    if (images.reduce((total, image) => total + image.bytes + (image.thumbnail?.bytes ?? 0), 0) > AMBIENT_LIMITS.maxStorageBytes) {
      throw new AmbientError(500, "Ambient storage exceeds its quota");
    }
    this.images = images;
    this.initialized = true;
  }

  library(): AmbientLibrary {
    this.ready();
    return { images: [...BUILTIN_BACKGROUNDS.map((image) => ({ ...image })), ...this.images.map(toImage)], limits: { ...AMBIENT_LIMITS } };
  }

  reserveUpload(): () => void {
    this.ready();
    if (this.uploading) throw new AmbientError(429, "Another image upload is in progress; try again shortly");
    if (this.images.length >= AMBIENT_LIMITS.maxImages) throw new AmbientError(409, "The 40-image upload library is full");
    this.uploading = true;
    return () => { this.uploading = false; };
  }

  async upload(input: Buffer, contentType: string, title: string, signal?: AbortSignal): Promise<AmbientImage> {
    this.ready();
    const canonical = await decodeAmbientImage(input, contentType, signal);
    return this.serialize(async () => {
      await assertDirectories(this.directory);
      if (signal?.aborted) throw new AmbientError(408, "Image upload timed out or was cancelled");
      const usage = await this.diskUsage();
      if (usage.count >= AMBIENT_LIMITS.maxImages || usage.bytes + canonical.data.length > AMBIENT_LIMITS.maxStorageBytes) {
        throw new AmbientError(409, "Ambient image count or storage quota exceeded; delete uploads first");
      }
      const image: StoredImage = imageSchema.parse({
        id: `upload-${randomUUID()}`, title, width: canonical.width, height: canonical.height, bytes: canonical.data.length,
      });
      const file = this.imagePath(image.id);
      await this.atomicWrite(file, canonical.data);
      try {
        if (signal?.aborted) throw new AmbientError(408, "Image upload timed out or was cancelled");
        await this.saveIndex([...this.images, image]);
      } catch (error) {
        await unlink(file);
        throw error;
      }
      this.images.push(image);
      this.revision++;
      return toImage(image);
    });
  }

  async delete(ids: string[]): Promise<string[]> {
    this.ready();
    const parsed = deleteImagesSchema.parse({ ids }).ids;
    return this.serialize(async () => {
      await assertDirectories(this.directory);
      if (parsed.some((id) => !this.images.some((image) => image.id === id))) throw new AmbientError(404, "One or more uploaded images do not exist");
      const staged: string[] = [];
      try {
        for (const id of parsed) {
          const image = this.images.find((image) => image.id === id)!;
          for (const file of [this.imagePath(id), ...(image.thumbnail ? [this.thumbnailPath(id)] : [])]) {
            await safeRead(file, file.endsWith(".thumb.jpg") ? MAX_THUMBNAIL_BYTES : MAX_CANONICAL_BYTES);
            try { await lstat(`${file}.deleted`); throw new AmbientError(500, "Unfinished image deletion; restart the service to recover"); }
            catch (error) { if (!isFsError(error, "ENOENT")) throw error; }
            await rename(file, `${file}.deleted`);
            staged.push(file);
          }
        }
        await this.saveIndex(this.images.filter((image) => !parsed.includes(image.id)));
      } catch (error) {
        for (const file of staged.reverse()) await rename(`${file}.deleted`, file);
        throw error;
      }
      this.images = this.images.filter((image) => !parsed.includes(image.id));
      this.revision++;
      // Settings intentionally keep selected ids. Clients exclude missing ids; no cross-file settings transaction.
      try { for (const file of staged) await unlink(`${file}.deleted`); }
      catch { throw new AmbientError(500, "Images removed from the library, but file cleanup failed; restart the service to recover"); }
      return parsed;
    });
  }

  async read(id: string): Promise<Buffer | null> {
    this.ready();
    if (!uploadIdSchema.safeParse(id).success) return null;
    return this.serialize(async () => {
      const image = this.images.find((image) => image.id === id);
      if (!image) return null;
      await assertDirectories(this.directory);
      const data = await safeRead(this.imagePath(id), MAX_CANONICAL_BYTES);
      if (data.length !== image.bytes || data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
        throw new AmbientError(500, "Ambient image is missing or corrupt");
      }
      return data;
    });
  }

  async thumbnail(id: string): Promise<Buffer | null> {
    this.ready();
    if (!uploadIdSchema.safeParse(id).success || !this.images.some((image) => image.id === id)) return null;
    const pending = this.thumbnails.get(id);
    if (pending) return pending;
    if (this.thumbnails.size >= AMBIENT_LIMITS.maxImages) throw new AmbientError(429, "Thumbnail queue is full");
    // Decode only requested previews, one at a time, without blocking scenes or deletion behind native work.
    const operation = this.thumbnailWrites.then(async () => {
      const source = await this.serialize(async () => {
        const image = this.images.find((image) => image.id === id);
        if (!image) return null;
        await assertDirectories(this.directory);
        if (image.thumbnail) return { data: await this.readThumbnailFile(image), cached: true };
        const data = await safeRead(this.imagePath(id), MAX_CANONICAL_BYTES);
        if (data.length !== image.bytes) throw new AmbientError(500, "Ambient image is missing or corrupt");
        return { data, cached: false };
      });
      if (!source) return null;
      if (source.cached) return source.data;
      const thumbnail = await decodeAmbientImage(source.data, "image/jpeg", undefined, true);
      return this.serialize(async () => {
        const image = this.images.find((image) => image.id === id);
        if (!image) return null;
        await assertDirectories(this.directory);
        const usage = await this.diskUsage();
        if (usage.bytes + thumbnail.data.length > AMBIENT_LIMITS.maxStorageBytes) {
          throw new AmbientError(409, "Ambient storage quota exceeded; delete uploads to create previews");
        }
        const updated = { ...image, thumbnail: { width: thumbnail.width, height: thumbnail.height, bytes: thumbnail.data.length } };
        const file = this.thumbnailPath(id);
        await this.atomicWrite(file, thumbnail.data);
        try { await this.saveIndex(this.images.map((item) => item.id === id ? updated : item)); }
        catch (error) { await unlink(file); throw error; }
        this.images = this.images.map((item) => item.id === id ? updated : item);
        this.revision++;
        return thumbnail.data;
      });
    });
    this.thumbnailWrites = operation.catch(() => {});
    this.thumbnails.set(id, operation);
    try { return await operation; } finally { this.thumbnails.delete(id); }
  }

  private thumbnailPath(id: string): string { return this.imagePath(id).replace(/\.jpg$/, ".thumb.jpg"); }
  private async readThumbnailFile(image: StoredImage): Promise<Buffer> {
    const data = await safeRead(this.thumbnailPath(image.id), MAX_THUMBNAIL_BYTES);
    if (data.length !== image.thumbnail?.bytes || data[0] !== 0xff || data[1] !== 0xd8 ||
        data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
      throw new AmbientError(500, "Ambient thumbnail is missing or corrupt");
    }
    return data;
  }

  private ready(): void { if (!this.initialized) throw new AmbientError(503, "Ambient storage is not initialized"); }
  private imagePath(id: string): string {
    if (!uploadIdSchema.safeParse(id).success) throw new AmbientError(400, "Invalid uploaded image id");
    return path.join(this.directory, `${id}.jpg`);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }
  private async diskUsage(): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    for (const name of await readdir(this.directory)) {
      const info = await lstat(path.join(this.directory, name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new AmbientError(500, "Unsafe ambient storage entry");
      if (filePattern.test(name)) { count++; bytes += info.size; }
      else if (thumbnailPattern.test(name)) bytes += info.size;
      else if (name !== "index.json" && !temporaryPattern.test(name)) throw new AmbientError(500, "Unexpected file in ambient storage");
    }
    return { count, bytes };
  }
  private async saveIndex(images: StoredImage[]): Promise<void> {
    const file = path.join(this.directory, "index.json");
    try { await safeRead(file, 64 * 1024); } catch (error) { if (!isFsError(error, "ENOENT")) throw error; }
    await this.atomicWrite(file, Buffer.from(JSON.stringify({ version: 1, images })));
  }
  private async atomicWrite(file: string, data: Buffer): Promise<void> {
    const temporary = path.join(this.directory, `.write-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    } catch (error) {
      try { await unlink(temporary); } catch (cleanupError) { if (!isFsError(cleanupError, "ENOENT")) throw cleanupError; }
      throw error;
    }
  }
}
