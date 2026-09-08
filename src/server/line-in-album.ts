import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { albumSnapshotSchema, type AlbumSnapshot, type AlbumView } from "../shared/line-in-album.js";
import { decodeAmbientImage } from "./ambient-decoder.js";
import type { Artwork } from "./http.js";
import { log } from "./log.js";
import { trustedGet } from "./line-in-network.js";
import { AlbumCatalog, fetchCatalog } from "./album-catalog.js";
export { publicAddress } from "./line-in-network.js";

export const ALBUM_DIRECTORY = "/run/sendspin-karaoke-album";
const MAX_BYTES = 4096;
const MAX_ARTWORK_WAITERS = 32;
type ArtworkResult = { image: Artwork | null } | { error: unknown };
interface PendingArtwork {
  key: string;
  controller: AbortController;
  promise: Promise<Artwork | null>;
  waiters: Set<(result: ArtworkResult) => void>;
}

export async function readAlbum(sourceId: string, uid: number, now = Date.now(),
  directory = ALBUM_DIRECTORY): Promise<AlbumSnapshot | null> {
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o7777) !== 0o2750) return null;
  const handle = await open(`${directory}/album.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid || info.gid !== dir.gid || (info.mode & 0o777) !== 0o640
        || info.size < 2 || info.size > MAX_BYTES || info.nlink !== 1) return null;
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) return null;
    const result = albumSnapshotSchema.safeParse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
    if (!result.success || result.data.source_id !== sourceId
        || result.data.updated_at_ms > now || result.data.expires_at_ms <= now) return null;
    // Reject directory replacement while opening the fixed file (no configurable paths).
    const after = await lstat(directory);
    if (after.dev !== dir.dev || after.ino !== dir.ino) return null;
    return result.data;
  } finally { await handle.close(); }
}

function fetchCover(url: string, signal: AbortSignal): Promise<{ bytes: Buffer; type: string }> {
  return trustedGet(url, signal, ["image/jpeg", "image/png"], 2 * 1024 * 1024);
}

export class LineInAlbum {
  private cached: { key: string; artwork: Artwork } | null = null;
  private pending: PendingArtwork | null = null;
  private lastError: string | null = null;
  private closed = false;
  private catalog: AlbumCatalog;
  constructor(private readonly sourceId: string, private readonly uid: number,
    private readonly read = readAlbum, private readonly fetch = fetchCover, catalogFetch = fetchCatalog) {
    this.catalog = new AlbumCatalog(() => this.snapshot(), catalogFetch);
  }

  private async snapshot(): Promise<AlbumSnapshot | null> {
    try {
      const value = await this.read(this.sourceId, this.uid);
      this.lastError = null;
      return value;
    } catch (error) {
      const code = error instanceof SyntaxError ? "invalid_json"
        : error instanceof Error && "code" in error ? String(error.code) : "unexpected";
      if (code !== this.lastError) log("line_in_album_unavailable", code);
      this.lastError = code;
      return null;
    }
  }

  async view(): Promise<AlbumView> {
    const value = await this.snapshot();
    const key = value ? `${value.boot_id}-${value.generation}` : null;
    if (!value?.album || this.cached?.key !== key) this.cached = null;
    return {
      state: value?.state ?? "offline", expiresAt: value?.expires_at_ms ?? Date.now(),
      key, tracklist: this.catalog.view(value), album: value?.album ? {
        title: value.album.title, artist: value.album.artist,
        artworkUrl: value.album.artwork ? `/api/line-in-album/artwork/${key}` : null,
      } : null,
    };
  }

  async artwork(key: string, signal: AbortSignal): Promise<Artwork | null> {
    signal.throwIfAborted();
    if (this.closed) return null;
    if (!/^[a-f0-9]{32}-[0-9]+$/.test(key)) return null;
    const current = await this.snapshot();
    signal.throwIfAborted();
    if (this.closed) return null;
    if (!current?.album?.artwork || `${current.boot_id}-${current.generation}` !== key) {
      this.cached = null; return null;
    }
    if (this.cached?.key === key) return this.cached.artwork;
    if (this.pending && this.pending.key !== key) {
      const previous = this.pending;
      const sameBoot = previous.key.slice(0, 32) === current.boot_id;
      if (sameBoot && Number(previous.key.slice(33)) > current.generation) return null;
      const retired = this.waitForArtwork(previous, signal);
      // An older in-flight snapshot must not cancel newer work. Across restarts,
      // let the freshness watcher determine which boot is current.
      if (sameBoot) previous.controller.abort();
      try { await retired; }
      catch { signal.throwIfAborted(); }
      // Retire the old operation before revalidating and starting another generation.
      return this.artwork(key, signal);
    }
    if (!this.pending) {
      const controller = new AbortController();
      const operation: PendingArtwork = {
        key, controller, waiters: new Set(),
        promise: this.loadArtwork(key, current.album.artwork, controller),
      };
      this.pending = operation;
      const finish = (result: ArtworkResult) => {
        if (this.pending === operation) this.pending = null;
        for (const waiter of operation.waiters) waiter(result);
      };
      void operation.promise.then((image) => finish({ image }), (error: unknown) => finish({ error }));
    }
    return this.waitForArtwork(this.pending, signal);
  }

  private waitForArtwork(operation: PendingArtwork, signal: AbortSignal): Promise<Artwork | null> {
    signal.throwIfAborted();
    if (operation.waiters.size >= MAX_ARTWORK_WAITERS) throw new Error("album_artwork_busy");
    return new Promise((resolve, reject) => {
      const settle = (result: ArtworkResult) => {
        signal.removeEventListener("abort", aborted);
        operation.waiters.delete(settle);
        if ("error" in result) reject(result.error);
        else resolve(result.image);
      };
      const aborted = () => settle({ error: signal.reason });
      operation.waiters.add(settle);
      // Client cancellation removes only that waiter, not another client's shared fetch.
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  private async loadArtwork(key: string, url: string, controller: AbortController): Promise<Artwork | null> {
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.snapshot().then((value) => {
        if (!value?.album || `${value.boot_id}-${value.generation}` !== key) controller.abort();
      }).finally(() => { checking = false; });
    }, 250);
    try {
      const image = await this.fetch(url, combined);
      const decoded = await decodeAmbientImage(image.bytes, image.type, combined, true);
      const after = await this.snapshot();
      if (combined.aborted || !after?.album || `${after.boot_id}-${after.generation}` !== key) return null;
      const artwork: Artwork = { bytes: decoded.data, contentType: "image/jpeg" };
      this.cached = { key, artwork };
      return artwork;
    } finally {
      clearInterval(timer);
    }
  }

  close() { this.closed = true; this.pending?.controller.abort(); this.cached = null; this.catalog.close(); }
}
