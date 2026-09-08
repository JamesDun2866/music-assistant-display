import { createHash } from "node:crypto";
import { z } from "zod";
import { fallbackStatusSchema, type FallbackStatus } from "../shared/album-provider.js";
import type { OriginalAlbumContext } from "./album-editions.js";
import { ProviderError } from "./album-provider-network.js";
import { log } from "./log.js";

const entrySchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/), attempts: z.number().int().min(1).max(1000),
  status: fallbackStatusSchema, updatedAt: z.number().int().nonnegative(),
}).strict();
const stateSchema = z.object({
  version: z.literal(1), sourceUid: z.number().int().nonnegative(), entries: z.array(entrySchema).max(64),
}).strict();
type Entry = z.infer<typeof entrySchema>;
export interface FallbackStorage {
  read(): Promise<unknown | null>;
  save(value: unknown): Promise<void>;
}
export const idleFallback = (): FallbackStatus => ({ state: "idle", message: "", retryAt: null, candidates: [] });
export function fallbackEligibility(original: OriginalAlbumContext, uid: number): string {
  return createHash("sha256").update(JSON.stringify([original.sourceId, uid, original.albumKey, original.success, original.album.catalog])).digest("hex");
}

/** A daemon-owned, persisted attempt ledger; view calls never wait for provider requests. */
export class AlbumCatalogFallback {
  private entries = new Map<string, Entry>();
  private current: { original: OriginalAlbumContext; key: string; needed: boolean; active: boolean } | null = null;
  private pending: { key: string; controller: AbortController; promise: Promise<void>; explicit: boolean } | null = null;
  private closed = false;
  private ready = false;
  private storageFailed = false;
  private saving: Promise<void> = Promise.resolve();
  constructor(private readonly uid: number, private readonly storage: FallbackStorage,
    private readonly resolve: (original: OriginalAlbumContext, signal: AbortSignal, explicit: boolean) => Promise<FallbackStatus>) {}

  async init(): Promise<void> {
    const raw = await this.storage.read();
    if (raw !== null) {
      const value = stateSchema.parse(raw);
      if (value.sourceUid !== this.uid) throw new Error("Catalog fallback source ownership changed.");
      if (new Set(value.entries.map((entry) => entry.key)).size !== value.entries.length) throw new Error("Invalid catalog fallback state.");
      for (const entry of value.entries) {
        if (entry.status.state === "loading") entry.status = {
          state: "unavailable", message: "Catalog lookup was interrupted. Retry album metadata to recover.",
          retryAt: Math.max(entry.updatedAt + 5 * 60_000, entry.status.retryAt ?? 0), candidates: [],
        };
        this.entries.set(entry.key, entry);
      }
    }
    this.ready = true;
  }
  observe(original: OriginalAlbumContext, needed: boolean, active: boolean): FallbackStatus {
    const key = fallbackEligibility(original, this.uid);
    this.current = { original, key, needed, active };
    if (this.pending && (this.pending.key !== key || !this.pending.explicit && (!needed || !active))) this.pending.controller.abort();
    this.start();
    return this.view(original);
  }
  view(original: OriginalAlbumContext): FallbackStatus {
    if (this.storageFailed || !this.ready) return {
      state: "unavailable", message: "Catalog fallback storage is unavailable. Saved album data is unchanged.", retryAt: null, candidates: [],
    };
    return this.entries.get(fallbackEligibility(original, this.uid))?.status ?? idleFallback();
  }
  private async persist(): Promise<void> {
    const next = this.saving.then(async () => {
      const entries = [...this.entries.values()];
      await this.storage.save(stateSchema.parse({ version: 1, sourceUid: this.uid, entries }));
    });
    this.saving = next.then(() => {}, () => {});
    await next;
    this.storageFailed = false;
  }
  private start(): void {
    const current = this.current;
    if (!this.ready || this.storageFailed || this.closed || this.pending || !current?.needed || !current.active
      || this.entries.has(current.key)) return;
    this.launch(current.original, current.key);
  }
  private launch(original: OriginalAlbumContext, key: string, explicit = false, signal?: AbortSignal): Promise<void> {
    const previous = this.entries.get(key);
    while (this.entries.size >= 64 && !this.entries.has(key)) this.entries.delete(this.entries.keys().next().value!);
    const entry: Entry = { key, attempts: Math.min(1000, (previous?.attempts ?? 0) + 1), updatedAt: Date.now(),
      status: { state: "loading", message: "Looking up album metadata...", retryAt: null, candidates: previous?.status.candidates ?? [] } };
    this.entries.set(key, entry);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const operation = { key, controller, promise: Promise.resolve(), explicit };
    this.pending = operation;
    operation.promise = this.run(original, entry, controller, explicit).finally(() => {
      signal?.removeEventListener("abort", abort);
      if (this.pending === operation) this.pending = null;
      this.start();
    });
    return operation.promise;
  }
  private async run(original: OriginalAlbumContext, entry: Entry, controller: AbortController, explicit: boolean): Promise<void> {
    try {
      // A crash after dispatch must not make status polling dispatch the same request again.
      await this.persist();
    } catch {
      this.storageFailed = true;
      log("album_fallback_state_unavailable", "save");
      return;
    }
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
    try {
      signal.throwIfAborted();
      entry.status = fallbackStatusSchema.parse(await this.resolve(original, signal, explicit));
      signal.throwIfAborted();
    } catch (error) {
      const backoff = Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.min(entry.attempts - 1, 7));
      const retryAt = error instanceof ProviderError && error.retryAt ? error.retryAt : Date.now() + backoff;
      entry.status = {
        state: "unavailable", candidates: entry.status.candidates,
        message: controller.signal.aborted ? "Catalog lookup stopped. Retry album metadata when ready."
          : error instanceof ProviderError && error.code === "invalid-response" ? "Complete catalog metadata is unavailable. Choose another release or retry."
          : error instanceof Error && "status" in error && error.status === 507 ? "Automatic catalog cache is full. Saved choices have not been removed."
          : error instanceof ProviderError ? "Catalog provider unavailable. Saved album data is unchanged."
          : "Catalog lookup or local persistence unavailable. Saved album data is unchanged.",
        retryAt,
      };
      if (!controller.signal.aborted) log("album_fallback_unavailable", error instanceof ProviderError ? error.code : "unavailable");
    }
    entry.updatedAt = Date.now();
    try { await this.persist(); }
    catch { this.storageFailed = true; log("album_fallback_state_unavailable", "save"); }
  }
  async retry(original: OriginalAlbumContext, signal?: AbortSignal): Promise<FallbackStatus> {
    if (this.closed) throw new ProviderError("unavailable");
    if (!this.ready) await this.init();
    if (this.pending) throw new ProviderError("busy");
    const key = fallbackEligibility(original, this.uid);
    const previous = this.entries.get(key);
    if (previous?.status.retryAt && previous.status.retryAt > Date.now()) throw new ProviderError("rate-limited", previous.status.retryAt);
    await this.launch(original, key, true, signal);
    return this.view(original);
  }
  async suppress(original: OriginalAlbumContext, message: string): Promise<void> {
    const key = fallbackEligibility(original, this.uid);
    const previous = this.entries.get(key);
    if (!previous) return;
    if (this.pending?.key === key) this.pending.controller.abort();
    this.entries.set(key, { ...previous, updatedAt: Date.now(),
      status: { state: "suppressed", message, candidates: [], retryAt: null } });
    try { await this.persist(); }
    catch { this.storageFailed = true; log("album_fallback_state_unavailable", "save"); }
  }
  close(): void { this.closed = true; this.pending?.controller.abort(); }
}
