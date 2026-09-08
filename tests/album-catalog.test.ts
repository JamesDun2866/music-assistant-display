import { afterEach, expect, it, vi } from "vitest";
import { AlbumCatalog, catalogLookupUrl, collectionTracks, trackCollection } from "../src/server/album-catalog.js";
import { catalogReferenceSchema, tracklistSchema, type AlbumSnapshot, type CatalogReference } from "../src/shared/line-in-album.js";

const reference: CatalogReference = { kind: "collection", id: "123", country: "gb" };
function source(generation = 1): AlbumSnapshot {
  const now = Date.now();
  return {
    version: 2, source_id: "a".repeat(64), boot_id: "b".repeat(32), generation,
    updated_at_ms: now, expires_at_ms: now + 4000, enabled: true, remembered_enabled: true,
    settings_error: null, active: true, state: "identified", silence_dbfs: -45,
    album: { title: "Recognized album", artist: "Performer", artwork: null, catalog: reference },
  };
}
function collection(discs = 1) {
  const tracks = Array.from({ length: discs * 2 }, (_, index) => ({
    wrapperType: "track", kind: "song", collectionId: 123, trackId: 1000 + index,
    trackName: `Track ${index + 1}`, discCount: discs, discNumber: Math.floor(index / 2) + 1,
    trackCount: 2, trackNumber: index % 2 + 1,
    previewUrl: "https://never-fetch/audio.m4a", lyrics: "Never export",
  }));
  return { resultCount: tracks.length + 1, results: [{
    wrapperType: "collection", collectionType: "Album", collectionId: 123,
    collectionName: "Exact catalog release", artistName: "Album artist", trackCount: tracks.length,
  }, ...tracks.reverse()] };
}
const services: AlbumCatalog[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); vi.restoreAllMocks(); });
function service(read: () => Promise<AlbumSnapshot | null>, fetch: ConstructorParameters<typeof AlbumCatalog>[1]) {
  const value = new AlbumCatalog(read, fetch); services.push(value); return value;
}

it("constructs only exact ID lookup endpoints with the source storefront", () => {
  expect(catalogLookupUrl(reference)).toBe("https://itunes.apple.com/lookup?id=123&country=gb&entity=song&limit=200");
  expect(catalogLookupUrl({ kind: "track", id: "456", country: "jp" })).toBe("https://itunes.apple.com/lookup?id=456&country=jp");
  for (const bad of [
    { ...reference, id: "1&url=http://localhost" }, { ...reference, country: "../" },
    { ...reference, kind: "artist" }, { ...reference, id: "0" }, { ...reference, id: "9".repeat(16) },
    { ...reference, url: "https://evil" },
  ]) expect(catalogReferenceSchema.safeParse(bad).success).toBe(false);
});

it("returns a complete ordered multi-disc release without preview URLs, lyrics or current-song flags", () => {
  const result = collectionTracks(collection(2), "123");
  expect(result).toEqual({
    status: "complete", message: null, title: "Exact catalog release", artist: "Album artist", discCount: 2,
    tracks: [
      { disc: 1, number: 1, title: "Track 1" }, { disc: 1, number: 2, title: "Track 2" },
      { disc: 2, number: 1, title: "Track 3" }, { disc: 2, number: 2, title: "Track 4" },
    ],
  });
  expect(tracklistSchema.safeParse(result).success).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/previewUrl|lyrics|trackId|isCurrent/);
});

it("rejects foreign IDs, missing tracks, inconsistent discs/numbers/counts and unsupported extras", () => {
  expect(collectionTracks(collection(), "999").status).toBe("unavailable");
  const cases: unknown[] = [];
  const missing = collection(); missing.results.pop(); missing.resultCount--; cases.push(missing);
  const wrongDisc = collection(2); Object.assign(wrongDisc.results[1]!, { discNumber: 3 }); cases.push(wrongDisc);
  const duplicateNumber = collection(); Object.assign(duplicateNumber.results[1]!, { trackNumber: 1 }); cases.push(duplicateNumber);
  const foreign = collection(); Object.assign(foreign.results[1]!, { collectionId: 999 }); cases.push(foreign);
  const video = collection(); Object.assign(video.results[1]!, { kind: "music-video" }); cases.push(video);
  const tooMany = collection(); Object.assign(tooMany.results[0]!, { trackCount: 201 }); cases.push(tooMany);
  const badCount = collection(); Object.assign(badCount.results[1]!, { trackCount: 99 }); cases.push(badCount);
  const badTitle = collection(); Object.assign(badTitle.results[1]!, { trackName: "x".repeat(257) }); cases.push(badTitle);
  const duplicate = collection(); Object.assign(duplicate.results[1]!, { trackId: 1000 }); cases.push(duplicate);
  cases.push({ resultCount: 4, results: [] }, { results: "bad" }, null);
  for (const raw of cases) {
    const result = collectionTracks(raw, "123");
    expect(result.status).toBe("unavailable");
    expect(result.tracks).toEqual([]);
    expect(result.message).toMatch(/Complete tracklist unavailable/);
  }
});

it("derives a collection only from an exact song lookup, never an artist or foreign match", () => {
  const track = { wrapperType: "track", kind: "song", trackId: 456, collectionId: 123, artistId: 999 };
  expect(trackCollection({ resultCount: 1, results: [track] }, "456")).toBe("123");
  expect(trackCollection({ resultCount: 1, results: [track] }, "999")).toBeNull();
  expect(trackCollection({ resultCount: 1, results: [{ ...track, kind: "artist" }] }, "456")).toBeNull();
  expect(trackCollection({ resultCount: 0, results: [] }, "456")).toBeNull();
});

it("coalesces all status clients into one lookup, caches completion and never blocks status polling", async () => {
  const value = source();
  let finish!: (result: unknown) => void;
  const fetcher = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  const catalog = service(async () => value, fetcher);
  for (let n = 0; n < 100; n++) expect(catalog.view(value).status).toBe("loading");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  finish(collection(2));
  await vi.waitFor(() => expect(catalog.view(value).status).toBe("complete"));
  for (let n = 0; n < 100; n++) expect(catalog.view(value).tracks).toHaveLength(4);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(reference, expect.any(AbortSignal));
});

it("does at most one track-to-collection lookup followed by one complete-album lookup", async () => {
  const value = source();
  value.album!.catalog = { kind: "track", id: "456", country: "jp" };
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ resultCount: 1, results: [{ wrapperType: "track", kind: "song", trackId: 456, collectionId: 123 }] })
    .mockResolvedValueOnce(collection());
  const catalog = service(async () => value, fetcher);
  catalog.view(value);
  await vi.waitFor(() => expect(catalog.view(value).status).toBe("complete"));
  expect(fetcher).toHaveBeenNthCalledWith(1, { kind: "track", id: "456", country: "jp" }, expect.any(AbortSignal));
  expect(fetcher).toHaveBeenNthCalledWith(2, { kind: "collection", id: "123", country: "jp" }, expect.any(AbortSignal));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("keeps lookup errors unavailable without retrying every status poll", async () => {
  const value = source();
  const fetcher = vi.fn().mockRejectedValue(new Error("network"));
  const catalog = service(async () => value, fetcher);
  catalog.view(value);
  await vi.waitFor(() => expect(catalog.view(value).status).toBe("unavailable"));
  for (let n = 0; n < 50; n++) catalog.view(value);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(value.album!.title).toBe("Recognized album");
});

it("does no catalog I/O without an active, fresh identified album and exact reference", async () => {
  const fetcher = vi.fn();
  const catalog = service(async () => null, fetcher);
  const value = source();
  const noId = source(); noId.album!.catalog = null;
  for (const state of [
    null, noId, { ...value, enabled: false }, { ...value, active: false },
    { ...value, expires_at_ms: Date.now() - 1 }, { ...value, album: null },
  ]) expect(catalog.view(state).status).toBe("unavailable");
  expect(fetcher).not.toHaveBeenCalled();
});

it("cancels a superseded generation and waits for retirement before starting the new lookup", async () => {
  let value = source();
  let finishOld!: (result: unknown) => void;
  let oldSignal!: AbortSignal;
  const fetcher = vi.fn((_reference: CatalogReference, signal: AbortSignal) => {
    if (fetcher.mock.calls.length === 1) {
      oldSignal = signal; return new Promise((resolve) => { finishOld = resolve; });
    }
    return Promise.resolve(collection());
  });
  const catalog = service(async () => value, fetcher);
  catalog.view(value);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  value = source(2);
  expect(catalog.view(value).status).toBe("loading");
  expect(oldSignal.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledOnce();
  finishOld(collection(2));
  await vi.waitFor(() => expect(catalog.view(value).status).toBe("complete"));
  expect(catalog.view(value).tracks).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(catalog.view(source(1)).status).toBe("unavailable");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("silence/disable aborts in-flight lookup and forbids the second GET or late list", async () => {
  let value: AlbumSnapshot | null = source();
  value.album!.catalog = { kind: "track", id: "456", country: "gb" };
  let finish!: (result: unknown) => void;
  let signal!: AbortSignal;
  const fetcher = vi.fn((_ref: CatalogReference, requestSignal: AbortSignal) => {
    signal = requestSignal; return new Promise((resolve) => { finish = resolve; });
  });
  const catalog = service(async () => value, fetcher);
  catalog.view(value);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  value = null;
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  finish({ resultCount: 1, results: [{ wrapperType: "track", kind: "song", trackId: 456, collectionId: 123 }] });
  await Promise.resolve();
  expect(catalog.view(null).tracks).toEqual([]);
  expect(fetcher).toHaveBeenCalledOnce();
});

it("the overall deadline retires a lookup without allowing polling to retry it", async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const value = source();
  const fetcher = vi.fn((_ref: CatalogReference, signal: AbortSignal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
    }));
  const catalog = service(async () => value, fetcher);
  catalog.view(value);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(timeout).toHaveBeenCalledWith(15_000);
  deadline.abort();
  await vi.waitFor(() => expect(catalog.view(value).status).toBe("unavailable"));
  for (let n = 0; n < 50; n++) catalog.view(value);
  expect(fetcher).toHaveBeenCalledOnce();
});

it("shutdown aborts the shared request and never exposes a late response or starts another", async () => {
  const value = source();
  let finish!: (result: unknown) => void;
  let signal!: AbortSignal;
  const fetcher = vi.fn((_ref: CatalogReference, requestSignal: AbortSignal) => {
    signal = requestSignal;
    return new Promise((resolve) => { finish = resolve; });
  });
  const catalog = service(async () => value, fetcher);
  catalog.view(value);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  catalog.close();
  expect(signal.aborted).toBe(true);
  finish(collection());
  await Promise.resolve();
  expect(catalog.view(source(2)).status).toBe("unavailable");
  expect(fetcher).toHaveBeenCalledOnce();
});
