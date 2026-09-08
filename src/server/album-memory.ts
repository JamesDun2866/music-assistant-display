import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { albumKeySchema, albumMetadataSchema, albumSuccessSchema, tracklistSchema } from "../shared/line-in-album.js";
import { isFsError } from "./cache.js";
import { ALBUM_COVER_VERSION, albumCoverJpegSchema, MAX_ALBUM_COVER_RECORD_BYTES } from "./album-cover.js";

const MAX_BYTES = MAX_ALBUM_COVER_RECORD_BYTES;
const memorySchema = z.object({
  version: z.literal(2), sourceId: z.string().regex(/^[a-f0-9]{64}$/), uid: z.number().int().nonnegative(),
  key: albumKeySchema, album: albumMetadataSchema,
  success: albumSuccessSchema.nullable(),
  tracklist: tracklistSchema.refine((value) => value.status !== "loading"),
  jpeg: albumCoverJpegSchema,
  coverVersion: z.literal(ALBUM_COVER_VERSION).optional(),
}).strict();
const storedMemorySchema = z.union([
  memorySchema,
  memorySchema.omit({ success: true }).extend({ version: z.literal(1) })
    .transform((value) => ({ ...value, version: 2 as const, success: null })),
]);
export type AlbumMemory = z.infer<typeof memorySchema>;

/** One owner-private, bounded atomic record, never a source runtime snapshot. */
export class AlbumMemoryStore {
  private readonly directory: string;
  private readonly file: string;
  private readonly pending: string;
  constructor(directory: string) {
    this.directory = path.join(directory, "line-in-album");
    this.file = path.join(this.directory, "last-album.json");
    this.pending = path.join(this.directory, ".last-album.next");
  }
  private async checkDirectory() {
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()
      || (process.platform !== "win32" && (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700))) {
      throw new Error("Unsafe album cache directory");
    }
    return info;
  }
  private checkFile(info: Stats) {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES
      || (process.platform !== "win32" && (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600))) {
      throw new Error("Unsafe album cache file");
    }
  }
  async init(sourceId: string, uid: number): Promise<AlbumMemory | null> {
    try { await mkdir(this.directory, { mode: 0o700 }); }
    catch (error) { if (!isFsError(error, "EEXIST")) throw error; }
    await this.checkDirectory();
    try { this.checkFile(await lstat(this.pending)); await unlink(this.pending); }
    catch (error) { if (!isFsError(error, "ENOENT")) throw error; }
    return this.read(sourceId, uid);
  }
  private async read(sourceId: string, uid: number): Promise<AlbumMemory | null> {
    const directory = await this.checkDirectory();
    let handle;
    try {
      this.checkFile(await lstat(this.file));
      handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) { if (isFsError(error, "ENOENT")) return null; throw error; }
    try {
      this.checkFile(await handle.stat());
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_BYTES) throw new Error("Album cache is too large");
      const value = storedMemorySchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
      const after = await this.checkDirectory();
      if (directory.ino !== after.ino || directory.dev !== after.dev) throw new Error("Album cache directory changed");
      return value.sourceId === sourceId && value.uid === uid ? value : null;
    } finally { await handle.close(); }
  }
  async save(value: AlbumMemory, signal = AbortSignal.timeout(3000)): Promise<void> {
    signal.throwIfAborted();
    const data = JSON.stringify(memorySchema.parse(value));
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("Album cache is too large");
    const directory = await this.checkDirectory();
    const checkDestination = async () => {
      try { this.checkFile(await lstat(this.file)); }
      catch (error) { if (!isFsError(error, "ENOENT")) throw error; }
    };
    await checkDestination();
    signal.throwIfAborted();
    const pending = this.pending;
    const handle = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await handle.writeFile(data, { signal }); await handle.sync(); }
      finally { await handle.close(); }
      const after = await this.checkDirectory();
      if (directory.ino !== after.ino || directory.dev !== after.dev) throw new Error("Album cache directory changed");
      await checkDestination();
      signal.throwIfAborted();
      await rename(pending, this.file);
      if (process.platform !== "win32") {
        const dir = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } finally {
      await unlink(pending).catch((error: unknown) => { if (!isFsError(error, "ENOENT")) throw error; });
    }
  }
}
