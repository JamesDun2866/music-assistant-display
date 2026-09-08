import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { albumEligibility, albumSnapshotSchema, unavailableTracklist, type AlbumSnapshot, type AlbumView, type RetryBinding } from "../shared/line-in-album.js";
import { decodeAmbientImage } from "./ambient-decoder.js";
import type { Artwork } from "./http.js";
import { log } from "./log.js";
import { trustedGet } from "./line-in-network.js";
import { AlbumCatalog, fetchCatalog } from "./album-catalog.js";
import { AlbumMemoryStore, type AlbumMemory } from "./album-memory.js";
import { retryAlbum } from "./album-retry.js";
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
  private remembered: AlbumMemory | null = null;
  private latest: AlbumSnapshot | null = null;
  private cacheError: string | null = null;
  private dirty = false;
  private saving: Promise<void> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private prefetchedKey: string | null = null;
  private store: AlbumMemoryStore | null;
  private retryPending = false;
  private saveRetry: ReturnType<typeof setTimeout> | null = null;
  private saveBackoff = 5000;
  private rejectedAlbum: string | null = null;
  private readSequence = 0;
  private appliedRead = 0;
  private observation: AlbumSnapshot | null = null;
  private retiredBoots = new Set<string>();
  constructor(private readonly sourceId: string, private readonly uid: number,
    private readonly read = readAlbum, private readonly fetch = fetchCover, catalogFetch = fetchCatalog,
    directory?: string, private readonly requestRetry = retryAlbum) {
    this.store = directory ? new AlbumMemoryStore(directory) : null;
    this.catalog = new AlbumCatalog(async () => this.forRemembered(await this.snapshot()), catalogFetch, (key, result) => {
      if (this.remembered?.key === key) {
        this.remembered = { ...this.remembered, tracklist: result };
        this.persist();
      }
    });
  }

  async init(): Promise<void> {
    if (!this.store) return;
    try {
      this.remembered = await this.store.init(this.sourceId, this.uid);
      if (this.remembered?.jpeg) this.cached = {
        key: this.remembered.key,
        artwork: { bytes: Buffer.from(this.remembered.jpeg, "base64"), contentType: "image/jpeg" },
      };
    } catch {
      this.cacheError = "Last album cache could not be restored.";
      log("line_in_album_cache_restore_failed");
    }
    let polling = false;
    const poll = () => {
      if (polling || this.closed) return;
      polling = true;
      void this.view().then(async (value) => {
        const current = this.forRemembered(this.latest);
        const eligibility = current ? `${current.album_key}:${albumEligibility(current)}` : null;
        if (this.remembered?.album.artwork && value.key && this.cached?.key !== value.key
          && this.prefetchedKey !== eligibility && current?.enabled && current.active
          && current.expires_at_ms > Date.now()) {
          this.prefetchedKey = eligibility;
          await this.artwork(value.key, AbortSignal.timeout(15_000));
        }
      }).catch(() => log("line_in_album_cache_artwork_unavailable")).finally(() => { polling = false; });
    };
    this.poller = setInterval(poll, 1000);
    poll();
  }

  private persist(): void {
    if (!this.store || !this.remembered || this.closed) return;
    this.dirty = true;
    if (this.saveRetry) clearTimeout(this.saveRetry);
    this.saveRetry = null;
    this.saveNext();
  }

  private saveNext(): void {
    if (this.saving || !this.dirty || !this.remembered || !this.store) return;
    const record = this.remembered;
    let failed = false;
    this.saving = this.store.save(record).then(() => {
      if (this.remembered === record) this.dirty = false;
      this.cacheError = null;
      this.saveBackoff = 5000;
    }, () => {
      failed = true;
      this.dirty = true;
      this.cacheError = "Last album cache could not be saved; it may not survive restart.";
      log("line_in_album_cache_save_failed");
    }).finally(() => {
      this.saving = null;
      if (!this.dirty) return;
      if (!failed) this.saveNext();
      else if (!this.closed) {
        this.saveRetry = setTimeout(() => { this.saveRetry = null; this.saveNext(); }, this.saveBackoff);
        this.saveBackoff = Math.min(60_000, this.saveBackoff * 2);
      }
    });
  }

  private async waitForSave(): Promise<void> {
    if (!this.saving) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.saving, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Album cache I/O is still retiring.")), 3500);
      })]);
    } finally { clearTimeout(timer); }
  }

  async flush(): Promise<void> {
    if (this.saveRetry) clearTimeout(this.saveRetry);
    this.saveRetry = null;
    await this.waitForSave();
    if (this.dirty) {
      if (this.saveRetry) clearTimeout(this.saveRetry);
      this.saveRetry = null;
      this.saveNext();
      await this.waitForSave();
    }
    if (this.dirty) throw new Error("Last album cache is not saved.");
  }

  private forRemembered(value: AlbumSnapshot | null): AlbumSnapshot | null {
    return value?.album_key === this.remembered?.key ? value : null;
  }

  private newerAlbum(value: AlbumSnapshot): boolean {
    if (!this.remembered) return true;
    const incoming = value.album_success, previous = this.remembered.success;
    if (!incoming) return false;
    if (!previous) return value.album_key === this.remembered.key || incoming.boot_id === value.boot_id;
    if (incoming.boot_id === previous.boot_id) return incoming.generation > previous.generation;
    // A success produced by this live boot is causal evidence even after clock rollback.
    // Restored successes have no such evidence: tied/older history never replaces the display cache.
    return incoming.boot_id === value.boot_id || incoming.at_ms > previous.at_ms;
  }

  async retry(binding: RetryBinding): Promise<void> {
    if (this.closed || this.retryPending) throw new Error("Album retry is busy.");
    this.retryPending = true;
    try {
      const current = await this.snapshot();
      if (!current || binding.source_id !== this.sourceId || binding.boot_id !== current.boot_id
        || binding.generation !== current.generation) throw new Error("Source status changed; refresh before retrying.");
      await this.requestRetry(binding, this.uid);
    } finally { this.retryPending = false; }
  }

  private async snapshot(): Promise<AlbumSnapshot | null> {
    const sequence = ++this.readSequence;
    const observed = () => this.observation && this.observation.expires_at_ms > Date.now()
      && this.observation.updated_at_ms <= Date.now() ? this.observation : null;
    try {
      let value = await this.read(this.sourceId, this.uid);
      if (this.closed) return null;
      if (sequence < this.appliedRead) return observed();
      this.appliedRead = sequence;
      this.lastError = null;
      if (value && (value.source_id !== this.sourceId || value.expires_at_ms <= Date.now()
        || value.updated_at_ms > Date.now())) value = null;
      if (value && this.latest && (value.boot_id === this.latest.boot_id
        ? value.generation < this.latest.generation || (value.generation === this.latest.generation
          && value.updated_at_ms < this.latest.updated_at_ms && this.latest.updated_at_ms <= Date.now())
        : this.retiredBoots.has(value.boot_id)
          || (value.updated_at_ms < this.latest.updated_at_ms && this.latest.updated_at_ms <= Date.now()))) {
        value = this.latest.expires_at_ms > Date.now() && this.latest.updated_at_ms <= Date.now() ? this.latest : null;
      }
      if (value) {
        if (this.latest && this.latest.boot_id !== value.boot_id) {
          this.retiredBoots.add(this.latest.boot_id);
        }
        if (this.remembered?.success && this.remembered.success.boot_id !== value.boot_id) {
          this.retiredBoots.add(this.remembered.success.boot_id);
        }
        while (this.retiredBoots.size > 8) this.retiredBoots.delete(this.retiredBoots.values().next().value!);
        this.latest = value;
        if (value.album && value.album_key && this.newerAlbum(value)) {
          const previousAlbum = this.remembered?.album;
          const sameAlbum = value.album_key === this.remembered?.key || (previousAlbum !== undefined
            && previousAlbum.title === value.album.title && previousAlbum.artist === value.album.artist
            && previousAlbum.artwork === value.album.artwork
            && JSON.stringify(previousAlbum.catalog) === JSON.stringify(value.album.catalog));
          this.remembered = {
            version: 2, sourceId: this.sourceId, uid: this.uid, key: value.album_key,
            success: value.album_success, album: value.album,
            jpeg: sameAlbum ? this.remembered!.jpeg : null,
            tracklist: sameAlbum ? this.remembered!.tracklist : unavailableTracklist(),
          };
          if (!sameAlbum) this.cached = null;
          else if (this.cached) this.cached = { ...this.cached, key: value.album_key };
          this.persist();
        } else if (value.album_key && value.album_key !== this.remembered?.key) {
          const rejected = `${value.album_key}:${value.album_success?.at_ms}`;
          if (this.rejectedAlbum !== rejected) log("line_in_album_older_cache_ignored");
          this.rejectedAlbum = rejected;
        }
      }
      this.observation = value;
      return value;
    } catch (error) {
      if (sequence < this.appliedRead) return observed();
      this.appliedRead = sequence;
      this.observation = null;
      const code = error instanceof SyntaxError ? "invalid_json"
        : error instanceof Error && "code" in error ? String(error.code) : "unexpected";
      if (code !== this.lastError) log("line_in_album_unavailable", code);
      this.lastError = code;
      return null;
    }
  }

  async view(): Promise<AlbumView> {
    const value = await this.snapshot();
    const memory = this.remembered;
    const key = memory?.key ?? null;
    const liveTracks = this.catalog.view(this.forRemembered(value), memory?.tracklist);
    const tracks = memory?.tracklist.status === "complete" ? memory.tracklist : liveTracks;
    return {
      state: value?.state ?? "offline", expiresAt: value?.expires_at_ms ?? Date.now(),
      key, tracklist: tracks, album: memory ? {
        title: memory.album.title, artist: memory.album.artist,
        artworkUrl: memory.album.artwork && (this.cached?.key === key || (!this.store
          && value?.enabled && value.active && value.album_key === key))
          ? `/api/line-in-album/artwork/${key}` : null,
      } : null,
      retry: value && value.enabled && value.active && !["sampling", "recognizing"].includes(value.state)
        ? { source_id: value.source_id, boot_id: value.boot_id, generation: value.generation } : null,
      cacheError: value?.cache_error ? "Source last-album cache could not be saved or restored." : this.cacheError,
    };
  }

  async artwork(key: string, signal: AbortSignal): Promise<Artwork | null> {
    signal.throwIfAborted();
    if (this.closed) return null;
    if (!/^[a-f0-9]{32}-[0-9]+$/.test(key)) return null;
    const current = await this.snapshot();
    signal.throwIfAborted();
    if (this.closed) return null;
    if (this.remembered?.key !== key) return null;
    if (this.cached?.key === key) return this.cached.artwork;
    if (!current?.album?.artwork || !current.enabled || !current.active || current.album_key !== key) return null;
    if (this.pending && this.pending.key !== key) {
      const previous = this.pending;
      const retired = this.waitForArtwork(previous, signal);
      previous.controller.abort();
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
        if (!value?.enabled || !value.active || value.album_key !== key) controller.abort();
      }).finally(() => { checking = false; });
    }, 250);
    try {
      const image = await this.fetch(url, combined);
      const decoded = await decodeAmbientImage(image.bytes, image.type, combined, true);
      const after = await this.snapshot();
      if (combined.aborted || !after?.enabled || !after.active || after.album_key !== key
        || this.remembered?.key !== key) return null;
      const artwork: Artwork = { bytes: decoded.data, contentType: "image/jpeg" };
      this.cached = { key, artwork };
      this.remembered = { ...this.remembered, jpeg: decoded.data.toString("base64") };
      this.persist();
      return artwork;
    } finally {
      clearInterval(timer);
    }
  }

  close() {
    this.closed = true;
    if (this.poller) clearInterval(this.poller);
    if (this.saveRetry) clearTimeout(this.saveRetry);
    this.saveRetry = null;
    this.pending?.controller.abort(); this.cached = null; this.catalog.close();
  }
}
