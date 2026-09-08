import { z } from "zod";
import {
  albumArtworkReference, albumEligibility, catalogReferenceSchema, unavailableTracklist, type AlbumSnapshot, type CatalogReference, type Tracklist,
} from "../shared/line-in-album.js";
import { trustedGet } from "./line-in-network.js";
import { log } from "./log.js";
import { albumCoverUrl } from "./album-cover.js";

const MAX_TRACKS = 200;
const id = z.number().int().positive().max(999_999_999_999_999);
const count = z.number().int().min(1).max(MAX_TRACKS);
const text = z.string().min(1).max(256).refine((value) => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value));
const envelope = z.object({ resultCount: z.number().int().min(0).max(MAX_TRACKS + 1), results: z.array(z.unknown()).max(MAX_TRACKS + 1) })
  .refine((value) => value.resultCount === value.results.length);
const collectionSchema = z.object({
  wrapperType: z.literal("collection"), collectionType: z.literal("Album"), collectionId: id,
  collectionName: text, artistName: text, trackCount: count,
});
const songSchema = z.object({
  wrapperType: z.literal("track"), kind: z.literal("song"), collectionId: id, trackId: id,
  trackName: text, discCount: count, discNumber: count, trackCount: count, trackNumber: count,
});

export function catalogLookupUrl(reference: CatalogReference): string {
  const value = catalogReferenceSchema.parse(reference);
  const query = new URLSearchParams({ id: value.id, country: value.country });
  if (value.kind === "collection") { query.set("entity", "song"); query.set("limit", String(MAX_TRACKS)); }
  return `https://itunes.apple.com/lookup?${query}`;
}

export async function fetchCatalog(reference: CatalogReference, signal: AbortSignal): Promise<unknown> {
  const response = await trustedGet(catalogLookupUrl(reference),
    AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    ["application/json", "text/javascript"], 2 * 1024 * 1024);
  return JSON.parse(response.bytes.toString("utf8"));
}

export function trackCollection(raw: unknown, trackId: string): string | null {
  const parsed = envelope.safeParse(raw);
  if (!parsed.success || parsed.data.results.length !== 1) return null;
  const track = z.object({ wrapperType: z.literal("track"), kind: z.literal("song"), trackId: id, collectionId: id })
    .safeParse(parsed.data.results[0]);
  return track.success && String(track.data.trackId) === trackId ? String(track.data.collectionId) : null;
}

export function collectionTracks(raw: unknown, collectionId: string): Tracklist {
  const incomplete = () => unavailableTracklist("Complete tracklist unavailable for this catalog release.");
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) return incomplete();
  const collections = parsed.data.results.filter((item) => collectionSchema.safeParse(item).success);
  if (collections.length !== 1) return incomplete();
  const collection = collectionSchema.parse(collections[0]);
  if (String(collection.collectionId) !== collectionId) return incomplete();
  const rows = parsed.data.results.filter((item) => item !== collections[0]);
  const songs = z.array(songSchema).safeParse(rows);
  if (!songs.success || songs.data.length !== collection.trackCount) return incomplete();
  const sorted = [...songs.data].sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
  const discs = sorted[0]?.discCount;
  if (!discs || discs > sorted.length || new Set(sorted.map((song) => song.trackId)).size !== sorted.length) return incomplete();
  if (sorted.some((song) => String(song.collectionId) !== collectionId || song.discCount !== discs)) return incomplete();
  for (let disc = 1; disc <= discs; disc++) {
    const tracks = sorted.filter((song) => song.discNumber === disc);
    if (!tracks.length || tracks.some((song, index) => song.trackNumber !== index + 1
        || ![tracks.length, sorted.length].includes(song.trackCount))) return incomplete();
  }

  if (sorted.some((song) => song.discNumber > discs)) return incomplete();
  return {
    status: "complete", message: null, title: collection.collectionName, artist: collection.artistName,
    discCount: discs, tracks: sorted.map((song) => ({ disc: song.discNumber, number: song.trackNumber, title: song.trackName })),
  };
}

/** Only exact, complete collections qualify as edition corrections. */
export function exactCollection(raw: unknown, reference: CatalogReference) {
  if (reference.kind !== "collection") throw new Error("An exact collection is required");
  const tracklist = collectionTracks(raw, reference.id);
  if (tracklist.status !== "complete") throw new Error("Complete tracklist unavailable for this catalog release.");
  const rows = envelope.parse(raw).results;
  const collection = rows.find((row) => collectionSchema.safeParse(row).success)!;
  const artwork = z.object({ artworkUrl100: z.unknown().optional() }).parse(collection).artworkUrl100;
  const parsedArtwork = albumArtworkReference.safeParse(artwork);
  return {
    album: { title: tracklist.title!, artist: tracklist.artist!,
      catalog: catalogReferenceSchema.parse(reference), artwork: parsedArtwork.success ? albumCoverUrl(parsedArtwork.data) : null },
    tracklist,
  };
}

type Entry = { key: string; eligibility: string; reference: CatalogReference; result: Tracklist; started: boolean };
const keyOf = (value: AlbumSnapshot) => value.album_key!;
function active(value: AlbumSnapshot | null): value is AlbumSnapshot & { album: NonNullable<AlbumSnapshot["album"]> } {
  return value !== null && value.enabled && value.active && value.album !== null
    && value.expires_at_ms > Date.now() && value.updated_at_ms <= Date.now();
}

/** Status polling never waits for catalog I/O or attaches per-client worker listeners. */
export class AlbumCatalog {
  private entries = new Map<string, Entry>();
  private current: Entry | null = null;
  private latest: AlbumSnapshot | null = null;
  private pending: { entry: Entry; controller: AbortController } | null = null;
  private closed = false;
  constructor(private readonly read: () => Promise<AlbumSnapshot | null>, private readonly fetch = fetchCatalog,
    private readonly completed: (key: string, result: Tracklist) => void = () => {}) {}

  view(value: AlbumSnapshot | null, restored?: Tracklist): Tracklist {
    if (value && this.latest && (value.boot_id === this.latest.boot_id
      ? value.generation < this.latest.generation
      : value.updated_at_ms < this.latest.updated_at_ms && this.latest.updated_at_ms <= Date.now())) {
      return unavailableTracklist();
    }
    if (value) this.latest = value;
    if (this.closed || !active(value) || !value.album.catalog) {
      this.current = null;
      this.pending?.controller.abort();
      return unavailableTracklist(active(value) ? "Tracklist unavailable: no exact Apple catalog reference." : undefined);
    }
    const key = keyOf(value);
    const eligibility = albumEligibility(value);
    let entry = this.entries.get(key);
    const retiring = this.pending !== null && this.pending.entry === entry && this.pending.controller.signal.aborted;
    if (!entry || (entry.result.status !== "complete" && entry.eligibility !== eligibility
      && (this.pending?.entry !== entry || retiring))) {
      entry = {
        key, eligibility, reference: value.album.catalog, started: restored?.status === "complete",
        result: restored?.status === "complete" ? restored
          : { ...unavailableTracklist(), status: "loading", message: "Loading catalog tracklist…" },
      };
      this.entries.set(key, entry);
      while (this.entries.size > 4) this.entries.delete(this.entries.keys().next().value!);
    }
    this.current = entry;
    if (this.pending && this.pending.entry !== entry) this.pending.controller.abort();
    this.start();
    return entry.result;
  }

  private start(): void {
    const entry = this.current;
    if (this.closed || this.pending || !entry || entry.started) return;
    entry.started = true;
    const controller = new AbortController();
    this.pending = { entry, controller };
    void this.load(entry, controller).then((result) => {
      entry.result = result;
      if (result.status === "complete" && !controller.signal.aborted) this.completed(entry.key, result);
    }, (error: unknown) => {
      entry.result = unavailableTracklist("Tracklist unavailable from the catalog. No automatic retry this session.");
      if (!controller.signal.aborted) log("album_catalog_unavailable", error instanceof Error ? error.name : "unexpected");
    }).finally(() => {
      this.pending = null;
      this.start();
    });
  }

  private async load(entry: Entry, controller: AbortController): Promise<Tracklist> {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    const valid = async () => {
      const value = await this.read();
      return !signal.aborted && this.current === entry && active(value) && keyOf(value) === entry.key;
    };
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void valid().then((ok) => { if (!ok) controller.abort(); }, () => controller.abort())
        .finally(() => { checking = false; });
    }, 250);
    try {
      if (!await valid()) return unavailableTracklist();
      let reference = entry.reference;
      if (reference.kind === "track") {
        const collection = trackCollection(await this.fetch(reference, signal), reference.id);
        if (!collection || !await valid()) return unavailableTracklist("Tracklist unavailable: exact album lookup failed.");
        reference = { ...reference, kind: "collection", id: collection };
      }
      if (!await valid()) return unavailableTracklist();
      const result = collectionTracks(await this.fetch(reference, signal), reference.id);
      return await valid() ? result : unavailableTracklist();
    } finally { clearInterval(timer); }
  }

  close() { this.closed = true; this.current = null; this.pending?.controller.abort(); this.entries.clear(); }
}
