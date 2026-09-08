import { expect, it, vi } from "vitest";
import { appleCollectionResource, appleCollectionResources, corroborateAppleRelease, musicBrainzRelease,
  musicBrainzSearch, MusicBrainzCatalog, reverseAppleReleases } from "../src/server/musicbrainz-catalog.js";
import { ProviderNetwork } from "../src/server/album-provider-network.js";
import type { CatalogReference } from "../src/shared/line-in-album.js";

const id = "76df3287-6cda-33eb-8e9a-044b5e15ffdd";
const secondId = "99b09d02-9cc9-3fed-8431-f162165a9371";
const original: CatalogReference = { kind: "collection", id: "123", country: "gb" };
const resource = "https://music.apple.com/gb/album/123";
const relationship = "320adf26-96fa-4183-9045-1f5f32f833cb";
function release(discs = 2, perDisc = 2) {
  return { id, title: "Synthetic album", "artist-credit": [{ name: "Synthetic artist", joinphrase: "" }],
    country: "GB", date: "2020-01-01", disambiguation: "Synthetic test edition",
    media: Array.from({ length: discs }, (_, disc) => ({
      position: disc + 1, format: "12\" Vinyl", "track-count": perDisc, "track-offset": 0,
      tracks: Array.from({ length: perDisc }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(disc * perDisc + index).padStart(12, "0")}`,
        position: index + 1, number: `A${index + 1}`, title: `Song ${disc + 1}.${index + 1}`,
        recording: { id: secondId, title: "May repeat on the same album" },
      })).reverse(),
    })).reverse(),
    relations: [{ "target-type": "url", direction: "forward", "type-id": relationship, ended: false,
      attributes: [], url: { resource } }],
  };
}
function reverse(ids = [id]) {
  return { "url-count": 1, "url-offset": 0, urls: [{ resource, relations: ids.map((releaseId) => ({
    "target-type": "release", direction: "backward", "type-id": relationship, ended: false,
    attributes: [], release: { id: releaseId },
  })) }] };
}

it("parses complete numeric multidisc ordering without inferring vinyl positions or recording uniqueness", () => {
  const result = musicBrainzRelease(release(), id);
  expect(result.tracklist.tracks).toEqual([
    { disc: 1, number: 1, title: "Song 1.1" }, { disc: 1, number: 2, title: "Song 1.2" },
    { disc: 2, number: 1, title: "Song 2.1" }, { disc: 2, number: 2, title: "Song 2.2" },
  ]);
  expect(result.candidate.format).toBe('12" Vinyl');
  expect(musicBrainzRelease(release(2, 100), id).tracklist.tracks).toHaveLength(200);
  expect(() => musicBrainzRelease(release(1, 201), id)).toThrow();
  expect(() => musicBrainzRelease(release(), secondId)).toThrow();
});

it("rejects omissions, duplicate positions/IDs, pregaps, data tracks, and overlong metadata", () => {
  const cases: unknown[] = [];
  const missing = release(); missing.media[0]!.tracks.pop(); cases.push(missing);
  const gap = release(); gap.media[0]!.position = 3; cases.push(gap);
  const position = release(); position.media[0]!.tracks[0]!.position = 1; cases.push(position);
  const duplicate = release(); duplicate.media[0]!.tracks[0]!.id = duplicate.media[1]!.tracks[0]!.id; cases.push(duplicate);
  const offset = release(); offset.media[0]!["track-offset"] = 1; cases.push(offset);
  const pregap = release(); Object.assign(pregap.media[0]!, { pregap: { title: "Missing bonus" } }); cases.push(pregap);
  const data = release(); Object.assign(data.media[0]!, { "data-tracks": [{ title: "Data" }] }); cases.push(data);
  const title = release(); title.title = "x".repeat(257); cases.push(title);
  for (const raw of cases) expect(() => musicBrainzRelease(raw, id)).toThrow();
});

it("accepts only original Apple album identities and never track queries, wrong schemes or paths", () => {
  expect(appleCollectionResources(original)).toEqual([resource, "https://itunes.apple.com/gb/album/id123"]);
  expect(appleCollectionResource("https://music.apple.com/gb/album/test-album/123")).toEqual(original);
  expect(appleCollectionResource("https://itunes.apple.com/gb/album/test/id123")).toEqual(original);
  for (const value of ["http://music.apple.com/gb/album/123", `${resource}?i=999`,
    `${resource}#test`, "https://music.apple.com:443/gb/album/123", "https://music.apple.com@evil/gb/album/123",
    "https://music.apple.com/gb/album/../123", "https://music.apple.com/gb/album/%74est/123",
    "https://music.apple.com/gb/song/123", "https://itunes.apple.com/gb/album/123"]) {
    expect(appleCollectionResource(value)).toBeNull();
  }
  expect(() => appleCollectionResources({ ...original, kind: "track" })).toThrow();
});

it("requires a unique reverse mapping and corroborated release-specific relationship", () => {
  expect(reverseAppleReleases(reverse(), original)).toEqual([id]);
  expect(reverseAppleReleases(reverse([id, secondId]), original)).toEqual([id, secondId]);
  const data = musicBrainzRelease(release(), id);
  expect(corroborateAppleRelease(data, original)).toEqual({
    kind: "apple-release-url", original, resource, releaseId: id, relationshipType: relationship,
  });
  expect(corroborateAppleRelease(data, { ...original, country: "us" })).toBeNull();
  expect(corroborateAppleRelease({ ...data, links: [] }, original)).toBeNull();
  expect(corroborateAppleRelease({ ...data, links: [{ ...data.links[0]!, "target-type": "release-group" }] }, original)).toBeNull();
  expect(corroborateAppleRelease({ ...data, links: [...data.links,
    { ...data.links[0]!, url: { resource: "https://music.apple.com/gb/album/456" } }] }, original)).toBeNull();
  expect(corroborateAppleRelease({ ...data, links: Array(25).fill(data.links[0]) }, original)).toBeNull();
  const truncated = reverse(); truncated["url-count"] = 2;
  expect(() => reverseAppleReleases(truncated, original)).toThrow();
  expect(() => reverseAppleReleases(reverse(Array(25).fill(id)), original)).toThrow();
  const wrong = reverse(); wrong.urls[0]!.resource = "https://music.apple.com/us/album/123";
  expect(() => reverseAppleReleases(wrong, original)).toThrow();
});

it("search is candidate-only regardless of score and strips unrelated fields", () => {
  const data = { count: 1, offset: 0, releases: [{ ...release(), score: 100, annotation: "Do not retain" }] };
  expect(musicBrainzSearch(data)).toEqual([expect.objectContaining({ release: { provider: "musicbrainz", releaseId: id } })]);
  expect(JSON.stringify(musicBrainzSearch(data))).not.toMatch(/score|annotation|verified/);
});

it("does not fetch a guessed release when reverse mapping is absent or ambiguous", async () => {
  const network = new ProviderNetwork();
  const get = vi.spyOn(network, "get").mockResolvedValue({ bytes: Buffer.from(JSON.stringify(reverse([id, secondId]))),
    type: "application/json" });
  const catalog = new MusicBrainzCatalog(network);
  expect(await catalog.resolve(original, new AbortController().signal)).toBeNull();
  expect(get).toHaveBeenCalledOnce();
  get.mockRestore();
});

it("constructs quoted escaped text searches, never raw query injection or audio requests", async () => {
  const network = new ProviderNetwork();
  const get = vi.spyOn(network, "get").mockResolvedValue({ bytes: Buffer.from('{"count":0,"offset":0,"releases":[]}'),
    type: "application/json" });
  await new MusicBrainzCatalog(network).search('A" OR *:*', "Test", new AbortController().signal);
  const url = new URL(get.mock.calls[0]![0]);
  expect(url.origin).toBe("https://musicbrainz.org");
  expect(url.searchParams.get("query")).toBe('artist:"A\\" OR \\*\\:\\*" AND release:"Test"');
  get.mockRestore();
});
