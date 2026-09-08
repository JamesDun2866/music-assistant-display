import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { albumMetadataSchema, albumSuccessSchema, albumKeySchema, tracklistSchema,
  type AlbumSuccess, type CatalogReference, type Tracklist } from "../shared/line-in-album.js";
import { editionBindingSchema, editionSearchInputSchema, editionPreviewInputSchema,
  editionConfirmInputSchema, editionRemoveInputSchema, editionSearchResponseSchema,
  editionPreviewResponseSchema, editionMetadataRetrySchema, type EditionBinding, type EditionSearchResponse,
  type EditionPreviewResponse, type EditionMutationResponse } from "../shared/album-editions.js";
import { exactCollection, fetchCatalog, trackCollection } from "./album-catalog.js";
import { ALBUM_COVER_VERSION, ALBUM_COVER_RETRY_MS, albumCoverJpegSchema, albumCoverUrl,
  decodeAlbumCover, fetchAlbumCover, MAX_ALBUM_COVER_RECORD_BYTES } from "./album-cover.js";
import { isFsError } from "./cache.js";
import { trustedGet } from "./line-in-network.js";
import { log } from "./log.js";
import { providerProvenanceSchema, type ProviderProvenance, type FallbackStatus, type ProviderCandidate } from "../shared/album-provider.js";
import { AlbumCatalogFallback } from "./album-catalog-fallback.js";
import { MusicBrainzCatalog, type MusicBrainzRelease } from "./musicbrainz-catalog.js";
import { CoverArtArchive } from "./cover-art-archive.js";
import { ProviderError, type ProviderBudget } from "./album-provider-network.js";

export type AlbumMetadata = z.infer<typeof albumMetadataSchema>;
export interface OriginalAlbumContext {
  sourceId: string; albumKey: string; success: AlbumSuccess | null; album: AlbumMetadata;
}
const originalSchema = z.object({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/), albumKey: albumKeySchema,
  success: albumSuccessSchema.nullable(), album: albumMetadataSchema,
}).strict();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const freshToken = () => randomBytes(32).toString("hex");
const MAX_BYTES = MAX_ALBUM_COVER_RECORD_BYTES, TOKEN_TTL = 5 * 60_000, MAX_TOKENS = 24;
const MAX_TOKEN_COVER_BYTES = 8 * 1024 * 1024;
const legacyRecordSchema = z.object({
  version: z.literal(1), identity: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  original: originalSchema, scope: z.enum(["remembered", "current-album"]), removed: z.boolean(),
  album: albumMetadataSchema, tracklist: tracklistSchema.refine((value) => value.status === "complete"),
  jpeg: albumCoverJpegSchema,
  coverVersion: z.literal(ALBUM_COVER_VERSION).optional(),
}).strict();
const recordSchema = legacyRecordSchema.extend({
  version: z.literal(2), sourceUid: z.number().int().nonnegative(), provenance: providerProvenanceSchema,
}).strict().superRefine((value, ctx) => {
  const release = value.provenance.release;
  if (release.provider === "musicbrainz" ? value.album.catalog !== null || value.album.artwork !== null
    : value.album.catalog?.kind !== "collection" || value.album.catalog.id !== release.collectionId
      || value.album.catalog.country !== release.country) {
    ctx.addIssue({ code: "custom", message: "Catalog projection does not match the selected provider" });
  }
});
type RecordValue = z.infer<typeof recordSchema>;
const aliasesSchema = z.array(z.object({
  track: z.string().regex(/^[a-f0-9]{64}$/), collection: z.string().regex(/^[1-9][0-9]{0,14}$/),
}).strict()).max(256);
type Identity = { key: string; scope: "remembered" | "current-album" };
interface TokenEntry {
  session: string; binding: EditionBinding; expires: number;
  search?: EditionSearchResponse;
  preview?: EditionPreviewResponse;
  record?: Omit<RecordValue, "revision">;
}
export class EditionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface AlbumEditionsOptions {
  fetchCatalog?: typeof fetchCatalog;
  search?: (input: { artist: string; album: string; country: string }, signal: AbortSignal) => Promise<unknown>;
  fetchCover?: (url: string, signal: AbortSignal) => Promise<{ bytes: Buffer; type: string }>;
  sourceUid?: number;
  musicBrainz?: Pick<MusicBrainzCatalog, "search" | "release" | "resolve">;
  archive?: Pick<CoverArtArchive, "cover">;
}
function appleProvenance(album: AlbumMetadata): ProviderProvenance {
  const reference = album.catalog;
  if (!reference || reference.kind !== "collection") throw new Error("Selected Apple edition requires a collection");
  return { release: { provider: "apple", collectionId: reference.id, country: reference.country },
    origin: "manual", catalogUrl: `https://music.apple.com/${reference.country}/album/${reference.id}`, evidence: null,
    artwork: album.artwork ? { provider: "apple", sourceUrl: album.artwork } : null };
}
function musicBrainzResult(value: ProviderCandidate) {
  if (value.release.provider !== "musicbrainz") throw new ProviderError("invalid-response");
  const { release, ...details } = value;
  return { ...details, provider: "musicbrainz" as const, releaseId: release.releaseId };
}
export async function searchAppleEditions(input: { artist: string; album: string; country: string }, signal: AbortSignal) {
  const params = new URLSearchParams({ term: `${input.artist} ${input.album}`, country: input.country,
    media: "music", entity: "album", limit: "20" });
  const response = await trustedGet(`https://itunes.apple.com/search?${params}`,
    AbortSignal.any([signal, AbortSignal.timeout(8000)]), ["application/json", "text/javascript"], 512 * 1024);
  return JSON.parse(response.bytes.toString("utf8")) as unknown;
}
const searchEnvelope = z.object({
  resultCount: z.number().int().min(0).max(20), results: z.array(z.unknown()).max(20),
}).refine((value) => value.resultCount === value.results.length);
const searchCollection = z.object({
  wrapperType: z.literal("collection"), collectionType: z.literal("Album"),
  collectionId: z.number().int().positive().max(999_999_999_999_999),
  collectionName: z.string(), artistName: z.string(),
});

/** Private, bounded records are read by exact identity; there is no full-record index in memory. */
export class AlbumEditions {
  private readonly directory: string;
  private directoryIdentity: { ino: number; dev: number } | null = null;
  private tokens = new Map<string, TokenEntry>();
  private aliases: z.infer<typeof aliasesSchema> = [];
  private resolution: { track: string; promise: Promise<string> } | null = null;
  private observations = new Map<string, {
    original: OriginalAlbumContext; started: boolean; allowNetwork: boolean; lookupStarted: boolean;
    coverAfter: number; coverBackoff: number;
  }>();
  private observing = false;
  private closed = false;
  private busy = false;
  private networkBusy = false;
  private lastSearch = -Infinity;
  private controller = new AbortController();
  private readonly catalog: typeof fetchCatalog;
  private readonly searchCatalog: NonNullable<AlbumEditionsOptions["search"]>;
  private readonly cover: NonNullable<AlbumEditionsOptions["fetchCover"]>;
  private readonly sourceUid: number;
  private readonly musicBrainz: NonNullable<AlbumEditionsOptions["musicBrainz"]>;
  private readonly archive: NonNullable<AlbumEditionsOptions["archive"]>;
  private readonly fallback: AlbumCatalogFallback;
  private unresolved = new Set<string>();
  constructor(directory: string, private readonly readOriginal: () => Promise<OriginalAlbumContext | null>,
    options: AlbumEditionsOptions = {}) {
    this.directory = path.join(directory, "album-editions");
    this.catalog = options.fetchCatalog ?? fetchCatalog;
    this.searchCatalog = options.search ?? searchAppleEditions;
    this.cover = options.fetchCover ?? fetchAlbumCover;
    this.sourceUid = options.sourceUid ?? 0;
    this.musicBrainz = options.musicBrainz ?? new MusicBrainzCatalog();
    this.archive = options.archive ?? new CoverArtArchive();
    this.fallback = new AlbumCatalogFallback(this.sourceUid, {
      read: () => this.readFile("fallback.json"), save: (value) => this.saveFile("fallback.json", value),
    }, (original, signal, explicit) => this.resolveFallback(original, signal, explicit));
  }
  async init(): Promise<void> {
    try { await mkdir(this.directory, { mode: 0o700 }); }
    catch (error) { if (!isFsError(error, "EEXIST")) throw error; }
    const info = await this.checkDirectory();
    this.directoryIdentity = { ino: info.ino, dev: info.dev };
    const aliases = await this.readFile("aliases.json");
    this.aliases = aliases === null ? [] : aliasesSchema.parse(aliases);
    const directory = await opendir(this.directory);
    for await (const entry of directory) {
      if (!/^\.[a-f0-9]{64}\.next$/.test(entry.name)) continue;
      await this.checkDirectory();
      const file = path.join(this.directory, entry.name);
      this.checkFile(await lstat(file));
      await unlink(file);
    }
    try { await this.fallback.init(); }
    catch { log("album_fallback_state_unavailable", "restore"); }
  }
  close(): void { this.closed = true; this.controller.abort(); this.fallback.close(); this.tokens.clear(); this.observations.clear(); }
  observe(original: OriginalAlbumContext, allowNetwork = true): void {
    if (this.closed || !this.directoryIdentity) return;
    const value = originalSchema.parse(original);
    const key = digest([value.sourceId, value.albumKey, value.success, value.album.catalog]);
    const existing = this.observations.get(key);
    if (!existing) {
      while (this.observations.size >= 8) this.observations.delete(this.observations.keys().next().value!);
      this.observations.set(key, { original: value, started: false, allowNetwork, lookupStarted: false,
        coverAfter: 0, coverBackoff: ALBUM_COVER_RETRY_MS });
    } else {
      if (allowNetwork && !existing.allowNetwork && !existing.lookupStarted) existing.started = false;
      existing.allowNetwork = allowNetwork;
    }
    this.startObservations();
  }
  private startObservations(): void {
    if (this.closed || this.observing || this.busy || this.networkBusy || this.resolution) return;
    const entry = [...this.observations.values()].find((value) => !value.started
      || value.allowNetwork && value.coverAfter <= performance.now());
    if (!entry) return;
    entry.started = true;
    this.observing = true;
    void (async () => {
      try { await this.expireCurrentCorrections(entry.original); }
      catch { log("edition_cleanup_unavailable", "storage"); }
      if (this.closed || !entry.allowNetwork) return;
      if (this.busy) { entry.started = false; return; }
      if (!entry.lookupStarted && !this.cachedIdentity(entry.original)
        && this.fallback.view(entry.original).state === "idle") {
        entry.lookupStarted = true;
        try { await this.identity(entry.original); }
        catch { if (!this.closed) log("edition_original_lookup_unavailable", "unavailable"); }
      }
      if (entry.coverAfter > performance.now()) return;
      entry.coverAfter = performance.now() + entry.coverBackoff;
      try {
        await this.upgradeCover(entry.original, () => entry.allowNetwork);
      } catch {
        entry.coverBackoff = Math.min(60 * 60_000, entry.coverBackoff * 2);
        if (!this.closed) log("edition_cover_upgrade_unavailable");
      }
    })().finally(() => { this.observing = false; this.startObservations(); });
  }
  private async upgradeCover(original: OriginalAlbumContext, allowNetwork: () => boolean): Promise<void> {
    const { identity, record } = await this.selectedRecord(original);
    if (!record || record.removed || !record.album.artwork || record.coverVersion === ALBUM_COVER_VERSION) return;
    await this.exclusive("cover-upgrade", async () => {
      const binding = await this.binding(original);
      if (binding.revision !== record.revision || !allowNetwork()) return;
      await this.validate(binding);
      const jpeg = await this.network(this.controller.signal, async (signal) => {
        const cover = await this.cover(albumCoverUrl(record.album.artwork!), signal);
        return (await decodeAlbumCover(cover.bytes, cover.type, signal)).data;
      });
      const upgraded = recordSchema.parse({ ...record, jpeg: jpeg.toString("base64"),
        coverVersion: ALBUM_COVER_VERSION, revision: record.revision + 1 });
      await this.saveFile(`${identity.key}.json`, upgraded, async () => {
        this.controller.signal.throwIfAborted();
        if (!allowNetwork()) throw new Error("Album cover upgrade is no longer active");
        await this.validate(binding);
      });
    });
  }
  private async expireCurrentCorrections(original: OriginalAlbumContext): Promise<void> {
    await this.checkDirectory();
    const directory = await opendir(this.directory);
    let removed = false;
    for await (const entry of directory) {
      if (this.closed) return;
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const raw = await this.readFile(entry.name);
      if (raw === null) continue;
      const record = this.parseRecord(raw);
      if (record.scope !== "current-album" || record.original.sourceId !== original.sourceId
        || digest(record.original.success) === digest(original.success)) continue;
      // An older queued observation must never collect a newer success's correction.
      const latest = await this.readOriginal();
      if (!latest || latest.sourceId !== original.sourceId || digest(latest.success) !== digest(original.success)) return;
      await this.checkDirectory();
      const file = path.join(this.directory, entry.name);
      try { this.checkFile(await lstat(file)); await unlink(file); removed = true; }
      catch (error) { if (!isFsError(error, "ENOENT")) throw error; }
    }
    if (removed && process.platform !== "win32") {
      const dir = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
    }
  }
  private assertOpen() {
    if (this.closed || !this.directoryIdentity) throw new EditionError(503, "Edition storage is unavailable.");
  }
  private async checkDirectory() {
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()
      || process.platform !== "win32" && (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700)
      || this.directoryIdentity && (info.ino !== this.directoryIdentity.ino || info.dev !== this.directoryIdentity.dev)) {
      throw new Error("Unsafe edition storage directory");
    }
    return info;
  }
  private checkFile(info: Stats) {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES
      || process.platform !== "win32" && (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600)) {
      throw new Error("Unsafe edition storage file");
    }
  }
  private async readFile(name: string): Promise<unknown | null> {
    await this.checkDirectory();
    const file = path.join(this.directory, name);
    let handle;
    try {
      this.checkFile(await lstat(file));
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) { if (isFsError(error, "ENOENT")) return null; throw error; }
    try {
      this.checkFile(await handle.stat());
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_BYTES) throw new Error("Edition record exceeds limit");
      await this.checkDirectory();
      return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as unknown;
    } finally { await handle.close(); }
  }
  private async saveFile(name: string, value: unknown, beforeCommit?: () => Promise<void>) {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("Edition record exceeds limit");
    await this.checkDirectory();
    const file = path.join(this.directory, name), pending = path.join(this.directory, `.${freshToken()}.next`);
    const checkDestination = async () => {
      try { this.checkFile(await lstat(file)); } catch (error) { if (!isFsError(error, "ENOENT")) throw error; }
    };
    await checkDestination();
    const handle = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      for (let attempt = 0; ; attempt++) {
        await this.checkDirectory();
        await checkDestination();
        await beforeCommit?.();
        try { await rename(pending, file); break; }
        catch (error) {
          if (process.platform !== "win32" || attempt >= 3
            || !isFsError(error, "EPERM") && !isFsError(error, "EBUSY")) throw error;
          // Windows readers can briefly block replacement; never unlink the accepted destination.
          await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
        }
      }
      if (process.platform !== "win32") {
        const dir = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } finally {
      await unlink(pending).catch((error: unknown) => { if (!isFsError(error, "ENOENT")) throw error; });
    }
  }
  private async record(identity: Identity) {
    const raw = await this.readFile(`${identity.key}.json`);
    if (raw === null) return null;
    const value = this.parseRecord(raw);
    if (value.identity !== identity.key || value.scope !== identity.scope) throw new Error("Invalid edition identity");
    if (value.provenance.origin === "automatic-catalog") {
      const evidence = value.provenance.evidence!;
      if (value.scope !== "remembered" || digest(["collection", value.original.sourceId,
        evidence.original.country, evidence.original.id]) !== value.identity) throw new Error("Invalid exact catalog mapping");
    }
    this.jpeg(value.jpeg);
    return value;
  }
  private parseRecord(raw: unknown): RecordValue {
    const legacy = legacyRecordSchema.safeParse(raw);
    const value = recordSchema.parse(legacy.success ? {
      ...legacy.data, version: 2, sourceUid: this.sourceUid, provenance: appleProvenance(legacy.data.album),
    } : raw);
    if (value.sourceUid !== this.sourceUid) throw new Error("Edition source ownership changed");
    return value;
  }
  private jpeg(value: string | null) {
    if (value === null) return null;
    return Buffer.from(albumCoverJpegSchema.parse(value)!, "base64");
  }
  private async network<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.networkBusy) throw new EditionError(429, "Another edition request is running. Try again.");
    this.networkBusy = true;
    const combined = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(15_000)]);
    try { combined.throwIfAborted(); return await work(combined); }
    finally { this.networkBusy = false; }
  }
  private async identity(original: OriginalAlbumContext, signal = this.controller.signal, recoverRemoved = false): Promise<Identity> {
    this.assertOpen();
    const value = originalSchema.parse(original), reference = value.album.catalog;
    const current = this.currentIdentity(value);
    const currentRecord = await this.record(current);
    if (!reference || currentRecord && (!currentRecord.removed || !recoverRemoved && !this.cachedIdentity(value))
      || this.unresolved.has(current.key)) return current;
    let collection = reference.id;
    if (reference.kind === "track") {
      const track = digest([value.sourceId, reference.country, reference.id]);
      const alias = this.aliases.find((entry) => entry.track === track);
      if (alias) collection = alias.collection;
      else {
        if (this.resolution && this.resolution.track !== track) {
          throw new EditionError(429, "Another original track is being resolved. Try again.");
        }
        if (!this.resolution) {
          const promise = (async () => {
            const resolved = await this.network(signal, async (abort) => trackCollection(await this.catalog(reference, abort), reference.id));
            if (!resolved) throw new EditionError(422, "The original track could not be resolved to an exact album.");
            const aliases = [...this.aliases.filter((entry) => entry.track !== track), { track, collection: resolved }].slice(-256);
            await this.saveFile("aliases.json", aliasesSchema.parse(aliases));
            this.aliases = aliases;
            return resolved;
          })();
          this.resolution = { track, promise };
        }
        const resolution = this.resolution;
        try { collection = await resolution.promise; }
        catch (error) {
          signal.throwIfAborted();
          if (error instanceof EditionError && error.status === 429) throw error;
          while (this.unresolved.size >= 64) this.unresolved.delete(this.unresolved.values().next().value!);
          this.unresolved.add(current.key);
          log("edition_original_lookup_unavailable", "current-identification-only");
          return current;
        }
        finally { if (this.resolution === resolution) this.resolution = null; }
      }
    }
    return { key: digest(["collection", value.sourceId, reference.country, collection]), scope: "remembered" };
  }
  private cachedIdentity(original: OriginalAlbumContext): Identity | null {
    this.assertOpen();
    const value = originalSchema.parse(original), reference = value.album.catalog;
    if (!reference) return { key: digest(["current", value.sourceId, value.albumKey, value.success]), scope: "current-album" };
    const collection = reference.kind === "collection" ? reference.id : this.aliases.find((entry) =>
      entry.track === digest([value.sourceId, reference.country, reference.id]))?.collection;
    return collection ? { key: digest(["collection", value.sourceId, reference.country, collection]), scope: "remembered" } : null;
  }
  private currentIdentity(value: OriginalAlbumContext): Identity {
    return { key: digest(["current", value.sourceId, value.albumKey, value.success]), scope: "current-album" };
  }
  private async selectedRecord(original: OriginalAlbumContext): Promise<{ identity: Identity; record: RecordValue | null }> {
    const current = this.currentIdentity(original);
    const currentRecord = await this.record(current);
    const identity = this.cachedIdentity(original);
    if (currentRecord && !currentRecord.removed) return { identity: current, record: currentRecord };
    const remembered = identity && identity.key !== current.key ? await this.record(identity) : null;
    const superseded = currentRecord?.removed && remembered && !remembered.removed
      && (remembered.provenance.origin === "manual" || remembered.revision > currentRecord.revision
        && digest(remembered.original.success) === digest(original.success));
    if (currentRecord && !superseded) return { identity: current, record: currentRecord };
    return { identity: identity ?? current, record: remembered };
  }
  async binding(original: OriginalAlbumContext): Promise<EditionBinding> {
    const { record } = await this.selectedRecord(original);
    return editionBindingSchema.parse({ sourceId: original.sourceId, albumKey: original.albumKey,
      success: original.success, revision: record?.revision ?? 0 });
  }
  async effective(original: OriginalAlbumContext): Promise<{
    album: AlbumMetadata; tracklist: Tracklist; jpeg: Buffer | null; revision: number;
    scope: "remembered" | "current-album" | "original";
    provenance: ProviderProvenance;
  } | null> {
    const { record } = await this.selectedRecord(original);
    if (!record || record.removed) return null;
    return { album: record.album, tracklist: record.tracklist, jpeg: this.jpeg(record.jpeg),
      revision: record.revision, scope: record.scope, provenance: record.provenance };
  }
  private async validate(binding: EditionBinding, resolve = false): Promise<OriginalAlbumContext> {
    const original = await this.readOriginal();
    if (!original || JSON.stringify(await this.binding(original)) !== JSON.stringify(editionBindingSchema.parse(binding))) {
      throw new EditionError(409, "The album, identification, or correction changed. Reopen edition correction.");
    }
    if (resolve && !this.cachedIdentity(original)) {
      await this.identity(original);
      return this.validate(binding);
    }
    return originalSchema.parse(original);
  }
  private prune() {
    const now = performance.now();
    for (const [key, entry] of this.tokens) if (entry.expires <= now) this.tokens.delete(key);
  }
  private put(token: string, entry: TokenEntry) {
    this.prune();
    while (this.tokens.size >= MAX_TOKENS) this.tokens.delete(this.tokens.keys().next().value!);
    this.tokens.set(token, entry);
    while ([...this.tokens.values()].reduce((total, value) => total + (value.record?.jpeg?.length ?? 0), 0) > MAX_TOKEN_COVER_BYTES) {
      this.tokens.delete(this.tokens.keys().next().value!);
    }
  }
  private token(token: string, session: string, binding?: EditionBinding) {
    this.assertOpen(); this.prune();
    const entry = this.tokens.get(token);
    if (!entry || !session || entry.session !== session
      || binding && JSON.stringify(entry.binding) !== JSON.stringify(binding)) {
      throw new EditionError(409, "This edition preview expired or belongs to another session. Search again.");
    }
    return entry;
  }
  private async exclusive<T>(session: string, work: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (!session || session.length > 512) throw new EditionError(403, "A local session is required.");
    if (this.busy) throw new EditionError(429, "Another edition request is running. Try again.");
    this.busy = true;
    try { return await work(); } finally { this.busy = false; this.startObservations(); }
  }
  async search(input: unknown, session: string, signal: AbortSignal): Promise<EditionSearchResponse> {
    const value = editionSearchInputSchema.parse(input);
    return this.exclusive(session, async () => {
      await this.validate(value.binding, true);
      if (performance.now() - this.lastSearch < 1000) throw new EditionError(429, "Wait a moment before another search.");
      this.lastSearch = performance.now();
      let results: EditionSearchResponse["results"];
      if (value.provider === "musicbrainz") {
        const original = await this.validate(value.binding);
        const cached = this.fallback.view(original);
        const candidates = value.artist === original.album.artist && value.album === original.album.title
          && cached.state === "confirmation-required" ? cached.candidates
          : await this.musicBrainz.search(value.artist, value.album, AbortSignal.any([signal, this.controller.signal]), { remaining: 1 });
        results = candidates.map(musicBrainzResult);
      } else {
        const raw = await this.network(signal, (abort) => this.searchCatalog(value, AbortSignal.any([abort, AbortSignal.timeout(8000)])));
        const rows = searchEnvelope.parse(raw).results;
        results = rows.map((row) => {
          const collection = searchCollection.parse(row);
          return { collectionId: String(collection.collectionId), country: value.country,
            title: collection.collectionName, artist: collection.artistName };
        });
      }
      signal.throwIfAborted();
      if (new Set(results.map((row) => "collectionId" in row ? row.collectionId : row.releaseId)).size !== results.length) {
        throw new EditionError(502, "Invalid catalog results.");
      }
      await this.validate(value.binding);
      const response = editionSearchResponseSchema.parse({ searchToken: freshToken(), results });
      for (const [key, entry] of this.tokens) if (entry.session === session) this.tokens.delete(key);
      this.put(response.searchToken, { session, binding: value.binding, expires: performance.now() + TOKEN_TTL, search: response });
      return response;
    });
  }
  async preview(input: unknown, session: string, signal: AbortSignal): Promise<EditionPreviewResponse> {
    const value = editionPreviewInputSchema.parse(input);
    return this.exclusive(session, async () => {
      const original = await this.validate(value.binding, true);
      const search = this.token(value.searchToken, session, value.binding).search;
      if (!search?.results.some((row) => value.provider === "musicbrainz"
        ? "releaseId" in row && row.releaseId === value.releaseId
        : "collectionId" in row && row.collectionId === value.collectionId && row.country === value.country)) {
        throw new EditionError(400, "Select a result from this search.");
      }
      const identity = await this.identity(original, signal);
      if (value.provider === "musicbrainz") {
        const abort = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(45_000)]);
        const budget = { remaining: 12 };
        const release = await this.musicBrainz.release(value.releaseId, abort, budget);
        const selected = await this.loadMusicBrainz(release, abort, budget);
        abort.throwIfAborted();
        await this.validate(value.binding);
        const token = freshToken();
        const response = editionPreviewResponseSchema.parse({
          ...musicBrainzResult(release.candidate), previewToken: token, tracklist: selected.tracklist, scope: identity.scope,
          artworkUrl: selected.jpeg ? `/api/line-in-album/edition/artwork/${token}` : null,
          artworkUnavailable: selected.jpeg === null, provenance: selected.provenance,
        });
        for (const [key, entry] of this.tokens) if (entry.session === session && entry.preview) this.tokens.delete(key);
        this.put(token, { session, binding: value.binding, expires: performance.now() + TOKEN_TTL, preview: response,
          record: { version: 2, sourceUid: this.sourceUid, identity: identity.key, scope: identity.scope, original,
            album: selected.album, tracklist: selected.tracklist, provenance: selected.provenance,
            jpeg: selected.jpeg?.toString("base64") ?? null, coverVersion: ALBUM_COVER_VERSION, removed: false } });
        return response;
      }
      const reference: CatalogReference = { kind: "collection", id: value.collectionId, country: value.country };
      const { album, tracklist, jpeg } = await this.network(signal, async (abort) => {
        const exact = exactCollection(await this.catalog(reference, abort), reference);
        let jpeg: Buffer | null = null;
        if (exact.album.artwork) {
          try {
            const cover = await this.cover(albumCoverUrl(exact.album.artwork), abort);
            jpeg = (await decodeAlbumCover(cover.bytes, cover.type, abort)).data;
          } catch (error) {
            abort.throwIfAborted();
            log("edition_cover_unavailable", error instanceof Error ? error.name : "unexpected");
          }
        }
        return { ...exact, jpeg };
      });
      signal.throwIfAborted();
      await this.validate(value.binding);
      const token = freshToken();
      const response = editionPreviewResponseSchema.parse({
        previewToken: token, title: album.title, artist: album.artist, country: value.country,
        collectionId: value.collectionId, tracklist, scope: identity.scope,
        artworkUrl: jpeg ? `/api/line-in-album/edition/artwork/${token}` : null, artworkUnavailable: jpeg === null,
      });
      for (const [key, entry] of this.tokens) if (entry.session === session && entry.preview) this.tokens.delete(key);
      this.put(token, { session, binding: value.binding, expires: performance.now() + TOKEN_TTL, preview: response,
        record: { version: 2, sourceUid: this.sourceUid, provenance: appleProvenance(album),
          identity: identity.key, scope: identity.scope, original, album, tracklist,
          jpeg: jpeg?.toString("base64") ?? null, removed: false, ...(jpeg ? { coverVersion: ALBUM_COVER_VERSION } : {}) } });
      return response;
    });
  }
  async confirm(input: unknown, session: string): Promise<EditionMutationResponse> {
    const value = editionConfirmInputSchema.parse(input);
    return this.exclusive(session, async () => {
      await this.validate(value.binding, true);
      const entry = this.token(value.previewToken, session, value.binding);
      if (!entry.record || !entry.preview) throw new EditionError(400, "A complete edition preview is required.");
      const record = recordSchema.parse({ ...entry.record, revision: value.binding.revision + 1 });
      await this.saveFile(`${record.identity}.json`, record, async () => {
        await this.validate(value.binding);
        this.token(value.previewToken, session, value.binding);
      });
      await this.fallback.suppress(record.original, "The manually selected catalog edition is authoritative.");
      this.tokens.delete(value.previewToken);
      return { binding: { ...value.binding, revision: record.revision }, corrected: true, scope: record.scope };
    });
  }
  async remove(input: unknown, session: string): Promise<EditionMutationResponse> {
    const value = editionRemoveInputSchema.parse(input);
    return this.exclusive(session, async () => {
      const original = await this.validate(value.binding, true);
      const identity = await this.identity(original);
      const record = await this.record(identity);
      if (!record || record.removed || record.revision !== value.correctionRevision) {
        throw new EditionError(409, "The correction changed. Reopen edition correction.");
      }
      const removed = recordSchema.parse({ ...record, original, removed: true, jpeg: null, revision: record.revision + 1 });
      await this.saveFile(`${identity.key}.json`, removed, async () => { await this.validate(value.binding); });
      await this.fallback.suppress(original, "Showing original recognition. Retry album metadata to allow another catalog resolution.");
      for (const [key, entry] of this.tokens) if (entry.session === session) this.tokens.delete(key);
      return { binding: { ...value.binding, revision: removed.revision }, corrected: false, scope: "original" };
    });
  }
  catalogFallback(original: OriginalAlbumContext, needed: boolean, active: boolean): FallbackStatus {
    return this.fallback.observe(originalSchema.parse(original), needed, active);
  }
  async retryMetadata(input: unknown, session: string, signal: AbortSignal): Promise<FallbackStatus> {
    this.assertOpen();
    if (!session || session.length > 512) throw new EditionError(403, "A local session is required.");
    const value = editionMetadataRetrySchema.parse(input);
    const original = await this.validate(value.binding);
    signal.throwIfAborted();
    this.unresolved.delete(this.currentIdentity(original).key);
    return this.fallback.retry(original, signal);
  }
  private async loadMusicBrainz(release: Pick<MusicBrainzRelease, "candidate" | "tracklist">,
    signal: AbortSignal, budget: ProviderBudget) {
    const reference = release.candidate.release;
    if (reference.provider !== "musicbrainz") throw new ProviderError("invalid-response");
    let jpeg: Buffer | null = null;
    let artwork: ProviderProvenance["artwork"] = null;
    let retryAt: number | null = null;
    try {
      const image = await this.archive.cover(reference.releaseId, signal, budget);
      if (image) {
        jpeg = (await decodeAlbumCover(image.bytes, image.type, signal)).data;
        artwork = image.provenance;
      }
    } catch (error) {
      signal.throwIfAborted();
      retryAt = error instanceof ProviderError && error.retryAt ? error.retryAt : Date.now() + ALBUM_COVER_RETRY_MS;
      log("edition_cover_unavailable", error instanceof ProviderError ? error.code : "decode");
    }
    const provenance: ProviderProvenance = {
      release: reference, origin: "manual", catalogUrl: `https://musicbrainz.org/release/${reference.releaseId}`,
      evidence: null, artwork,
    };
    return {
      album: { title: release.candidate.title, artist: release.candidate.artist, catalog: null, artwork: null } satisfies AlbumMetadata,
      tracklist: release.tracklist, jpeg, provenance, retryAt,
    };
  }
  private async automaticCapacity(record: RecordValue): Promise<void> {
    const directory = await opendir(this.directory);
    let count = 0, bytes = Buffer.byteLength(JSON.stringify(record));
    for await (const entry of directory) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name) || entry.name === `${record.identity}.json`) continue;
      const info = await lstat(path.join(this.directory, entry.name));
      this.checkFile(info);
      count++; bytes += info.size;
      if (count >= 64 || bytes > 256 * 1024 * 1024) {
        throw new EditionError(507, "Automatic catalog cache is full. Saved choices have not been removed.");
      }
    }
  }
  private async resolveFallback(original: OriginalAlbumContext, signal: AbortSignal, explicit: boolean): Promise<FallbackStatus> {
    const binding = await this.binding(original);
    await this.validate(binding);
    const identity = await this.identity(original, signal, explicit);
    // Identity resolution can reveal an existing manual choice; never replace it.
    const currentBinding = await this.binding(original);
    const previous = await this.record(identity);
    if (previous && !previous.removed && previous.provenance.origin === "manual") return {
      state: "suppressed", message: "The manually selected edition is authoritative. Change it in album edition selection.",
      retryAt: null, candidates: [],
    };
    if (previous?.removed && !explicit && digest(previous.original.success) === digest(original.success)) return {
      state: "suppressed", message: "Showing the original recognition. Retry album metadata to allow another catalog resolution.",
      retryAt: null, candidates: [],
    };
    const resolvedStatus = (hasCover: boolean, retryAt: number | null = null): FallbackStatus => ({
      state: "resolved", message: hasCover ? "Catalog resolved via MusicBrainz; physical pressing is not verified."
        : "Catalog resolved via MusicBrainz. Cover unavailable for this release; the original cover is not used.",
      retryAt, candidates: [],
    });
    if (previous && !previous.removed && (!explicit || previous.jpeg)) return resolvedStatus(Boolean(previous.jpeg));
    const budget: ProviderBudget = { remaining: 12 };
    let selected: Awaited<ReturnType<AlbumEditions["loadMusicBrainz"]>>;
    if (previous && !previous.removed && previous.provenance.release.provider === "musicbrainz") {
      selected = await this.loadMusicBrainz({ candidate: {
        release: previous.provenance.release, title: previous.album.title, artist: previous.album.artist,
        country: null, date: null, format: null, disambiguation: null,
      }, tracklist: previous.tracklist }, signal, budget);
      selected.provenance = { ...previous.provenance, artwork: selected.provenance.artwork };
      if (!selected.jpeg) return resolvedStatus(false, selected.retryAt);
    } else {
      const reference = original.album.catalog;
      const collection = reference?.kind === "collection" ? reference : reference?.kind === "track"
        ? this.aliases.find((entry) => entry.track === digest([original.sourceId, reference.country, reference.id])) : null;
      const originalCollection: CatalogReference | null = reference && collection
        ? "collection" in collection ? { kind: "collection", id: collection.collection, country: reference.country } : collection : null;
      const match = originalCollection ? await this.musicBrainz.resolve(originalCollection, signal, budget) : null;
      if (!match) {
        const candidates = await this.musicBrainz.search(original.album.artist, original.album.title, signal, budget);
        await this.validate(currentBinding);
        return { state: candidates.length ? "confirmation-required" : "no-match",
          message: candidates.length ? "Alternate releases found. Choose MusicBrainz in album edition selection and confirm a complete preview."
            : "No matching complete release is known. Search another catalog edition or retry album metadata.",
          retryAt: null, candidates };
      }
      selected = await this.loadMusicBrainz(match.release, signal, budget);
      selected.provenance = { ...selected.provenance, origin: "automatic-catalog", evidence: match.evidence };
    }
    signal.throwIfAborted();
    await this.exclusive("automatic-catalog", async () => {
      await this.validate(currentBinding);
      const record = recordSchema.parse({
        version: 2, sourceUid: this.sourceUid, identity: identity.key, scope: identity.scope, original, removed: false,
        revision: currentBinding.revision + 1, album: selected.album, tracklist: selected.tracklist,
        provenance: selected.provenance, jpeg: selected.jpeg?.toString("base64") ?? null, coverVersion: ALBUM_COVER_VERSION,
      });
      await this.automaticCapacity(record);
      await this.saveFile(`${identity.key}.json`, record, async () => {
        signal.throwIfAborted();
        await this.validate(currentBinding);
      });
    });
    return resolvedStatus(Boolean(selected.jpeg), selected.retryAt);
  }
  async artwork(token: string, session: string, signal: AbortSignal): Promise<{ bytes: Buffer; contentType: "image/jpeg" } | null> {
    signal.throwIfAborted();
    const entry = this.token(token, session);
    await this.validate(entry.binding);
    const bytes = entry.record ? this.jpeg(entry.record.jpeg) : null;
    return bytes ? { bytes, contentType: "image/jpeg" } : null;
  }
}
