// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AlbumEditionCorrection } from "../src/web/AlbumEditionCorrection.js";
import { AlbumCatalogStatus } from "../src/web/AlbumCatalogStatus.js";
import { LineInAlbumView } from "../src/web/LineInAlbum.js";
import { VinylView } from "../src/web/VinylView.js";
import { DEFAULT_VINYL } from "../src/shared/vinyl.js";
import type { AlbumView } from "../src/shared/line-in-album.js";
import type { FallbackStatus, ProviderProvenance } from "../src/shared/album-provider.js";
import { navigate } from "../src/web/navigation.js";

vi.mock("../src/web/useSourceTelemetry.js", () => ({ useSourceTelemetry: () => null }));
const binding = { sourceId: "a".repeat(64), albumKey: `${"b".repeat(32)}-1`, success: null, revision: 1 };
const original = { title: "Synthetic original", artist: "Synthetic artist" };
const releaseId = "11111111-2222-4333-8444-555555555555";
const otherId = "11111111-2222-4333-8444-666666666666";
const provenance: ProviderProvenance = {
  release: { provider: "musicbrainz", releaseId }, origin: "automatic-catalog",
  catalogUrl: `https://musicbrainz.org/release/${releaseId}`,
  evidence: { kind: "apple-release-url", original: { kind: "collection", country: "gb", id: "123" },
    releaseId, resource: "https://music.apple.com/gb/album/123",
    relationshipType: "98e08c20-8402-4163-8970-53504bb6a1e4" },
  artwork: { provider: "cover-art-archive", releaseId, imageId: "123",
    sourceUrl: `https://coverartarchive.org/release/${releaseId}/123-1200.jpg` },
};
const result = { provider: "musicbrainz" as const, releaseId, title: "Synthetic selected", artist: "Synthetic catalog artist",
  country: null, date: "2001-02-03", format: "2×CD", disambiguation: "Synthetic expanded edition" };
const fallback: FallbackStatus = { state: "confirmation-required", message: "Choose an exact release.",
  retryAt: null, candidates: [{ release: { provider: "musicbrainz", releaseId }, title: result.title,
    artist: result.artist, country: result.country, date: result.date, format: result.format,
    disambiguation: result.disambiguation }] };
const tracks = Array.from({ length: 200 }, (_, i) => ({
  disc: Math.floor(i / 100) + 1, number: i % 100 + 1, title: `Synthetic track ${i + 1}`,
}));
const preview = { ...result, previewToken: "d".repeat(64), artworkUrl: null,
  artworkUnavailable: true, scope: "current-album", provenance: { ...provenance, origin: "manual" },
  tracklist: { status: "complete", title: result.title, artist: result.artist, message: null, discCount: 2, tracks } };
function service(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    "/search": { searchToken: "c".repeat(64), results: [result, { ...result, releaseId: otherId, country: "US",
      date: "1999", format: "Vinyl", disambiguation: "Synthetic original edition" }] },
    "/preview": preview,
    "/confirm": { binding: { ...binding, revision: 2 }, corrected: true, scope: "current-album" },
    "/remove": { binding: { ...binding, revision: 2 }, corrected: false, scope: "original" },
    "/retry-metadata": { ...fallback, state: "no-match", candidates: [], message: "No exact matches." },
    ...overrides,
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/session") return { ok: true, json: async () => ({ csrfToken: "synthetic-token" }) };
    const suffix = url.slice(url.lastIndexOf("/"));
    if (suffix !== "/line-in-album") {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "X-CSRF-Token": "synthetic-token" });
    }
    if (!(suffix in responses)) throw new Error(`Unexpected local request: ${url}`);
    if (responses[suffix] instanceof Error) return { ok: false,
      json: async () => ({ error: (responses[suffix] as Error).message }) };
    return { ok: true, json: async () => responses[suffix] };
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("defaults fallback candidates to MusicBrainz, sends no country, distinguishes editions and previews all 200 tracks", async () => {
  const fetcher = service();
  const changed = vi.fn();
  render(<AlbumEditionCorrection binding={binding} original={original} corrected={false}
    fallback={fallback} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Correct album edition" }));
  expect(screen.getByRole("button", { name: "MusicBrainz", pressed: true })).toBeInTheDocument();
  expect(screen.queryByLabelText(/storefront/)).not.toBeInTheDocument();
  expect(screen.getByText(/1 cached candidate edition/)).toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Search MusicBrainz" }));
  const results = await screen.findByRole("region", { name: "Search results" });
  expect(within(results).getByText(/1999.*Vinyl.*Synthetic original edition/)).toBeInTheDocument();
  expect(within(results).getByText(/2001-02-03.*2×CD.*Synthetic expanded edition/)).toBeInTheDocument();
  expect(JSON.parse(fetcher.mock.calls.find(([url]) => url.endsWith("/search"))![1]!.body as string))
    .toEqual({ binding, artist: original.artist, album: original.title, provider: "musicbrainz" });
  fireEvent.click(within(results).getAllByRole("button", { name: "Preview Synthetic selected" })[0]!);
  const selected = await screen.findByRole("region", { name: "Exact edition preview" });
  expect(within(selected).getAllByRole("listitem")).toHaveLength(200);
  expect(within(selected).getAllByRole("listitem")[199]).toHaveTextContent("Disc 2, track 100: Synthetic track 200");
  expect(within(selected).getByText(/Cover unavailable/)).toBeInTheDocument();
  expect(within(selected).queryByRole("img")).not.toBeInTheDocument();
  expect(within(selected).getByRole("link", { name: "Exact catalog edition" })).toHaveAttribute("href", provenance.catalogUrl);
  expect(JSON.parse(fetcher.mock.calls.find(([url]) => url.endsWith("/preview"))![1]!.body as string))
    .toEqual({ binding, searchToken: "c".repeat(64), releaseId, provider: "musicbrainz" });
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/confirm"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm this edition" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
});

it("allows MusicBrainz without original Apple identity and resets preview when switching providers", async () => {
  const fetcher = service({ "/preview": { ...preview, artworkUrl: `/api/line-in-album/edition/artwork/${"d".repeat(64)}`,
    artworkUnavailable: false } });
  render(<AlbumEditionCorrection binding={binding} original={original} corrected={false} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Correct album edition" }));
  expect(screen.getByRole("button", { name: "Search Apple" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "MusicBrainz" }));
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Search MusicBrainz" }));
  fireEvent.click((await screen.findAllByRole("button", { name: "Preview Synthetic selected" }))[0]!);
  const image = await screen.findByRole("img");
  expect(image).toHaveAttribute("src", `/api/line-in-album/edition/artwork/${"d".repeat(64)}`);
  fireEvent.error(image);
  expect(screen.getByText(/Cover unavailable/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Apple" }));
  expect(screen.queryByRole("region", { name: "Exact edition preview" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Search results" })).not.toBeInTheDocument();
});

it("restores automatic catalog resolution without calling it corrected and preserves dialog keyboard navigation", async () => {
  const fetcher = service();
  const changed = vi.fn();
  render(<AlbumEditionCorrection binding={binding} original={original} corrected={false}
    provenance={provenance} onChanged={changed} />);
  const opener = screen.getByRole("button", { name: "Correct album edition" });
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveAttribute("data-navigation-dialog");
  expect(screen.getByLabelText("Artist")).toHaveFocus();
  expect(screen.getByText(/not a manual correction/)).toBeInTheDocument();
  const close = screen.getByRole("button", { name: "Close" });
  expect(close).toHaveAttribute("data-navigation-cancel");
  close.focus();
  fireEvent.keyDown(close, { key: "Tab" });
  expect(screen.getByRole("region", { name: "Restore original album" })).toBeInTheDocument();
  expect(document.activeElement).toHaveAttribute("data-navigation-scroll");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(opener).toHaveFocus());
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(opener);
  fireEvent.click(screen.getByRole("button", { name: "Restore original album" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(JSON.parse(fetcher.mock.calls.find(([url]) => url.endsWith("/remove"))![1]!.body as string))
    .toEqual({ binding, correctionRevision: 1, confirm: true });
});

it("rejects incomplete MusicBrainz previews instead of allowing confirmation", async () => {
  service({ "/preview": { ...preview, tracklist: { ...preview.tracklist, tracks: tracks.slice(1) } } });
  render(<AlbumEditionCorrection binding={binding} original={original} corrected={false}
    fallback={{ ...fallback, state: "no-match", candidates: [] }} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Correct album edition" }));
  fireEvent.click(screen.getByRole("button", { name: "Search MusicBrainz" }));
  fireEvent.click((await screen.findAllByRole("button", { name: "Preview Synthetic selected" }))[0]!);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Confirm this edition" })).not.toBeInTheDocument();
});

it("lets remote users navigate and select either catalog provider without submitting a search", async () => {
  const fetcher = service();
  render(<AlbumEditionCorrection binding={binding} original={original} corrected={false} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Correct album edition" }));
  const dialog = screen.getByRole("dialog");
  const apple = screen.getByRole("button", { name: "Apple" });
  const musicbrainz = screen.getByRole("button", { name: "MusicBrainz" });
  apple.focus();
  act(() => { navigate(dialog, { key: "right", repeat: false }); });
  expect(musicbrainz).toHaveFocus();
  act(() => { navigate(dialog, { key: "select", repeat: false }); });
  expect(musicbrainz).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Search MusicBrainz" })).toBeEnabled();
  act(() => { navigate(dialog, { key: "left", repeat: false }); });
  expect(apple).toHaveFocus();
  act(() => { navigate(dialog, { key: "select", repeat: false }); });
  expect(apple).toHaveAttribute("aria-pressed", "true");
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["line-in", "vinyl"])("exposes first metadata retry for a cached offline album with an idle ledger in %s", async (surface) => {
  const view: AlbumView = { state: "offline", expiresAt: Date.now() + 4000, key: binding.albumKey,
    retry: null, cacheError: null,
    album: { title: original.title, artist: original.artist, artworkUrl: null },
    tracklist: { status: "unavailable", title: null, artist: null, message: null, discCount: null, tracks: [] },
    edition: { binding, original, corrected: false, scope: "original",
      fallback: { state: "idle", message: "", retryAt: null, candidates: [] } } };
  const fetcher = service({ "/line-in-album": view });
  if (surface === "line-in") render(<LineInAlbumView />);
  else render(<VinylView settings={{ ...DEFAULT_VINYL, showMeters: false }} controlsVisible disabled={false} onSettings={vi.fn()} />);
  if (surface === "vinyl") fireEvent.click(await screen.findByText("Line-in details"));
  const retry = await screen.findByRole("button", { name: "Retry album metadata" });
  expect(retry).toBeEnabled();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/retry-metadata"))).toBe(false);
  fireEvent.click(retry);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/retry-metadata"))).toBe(true));
  expect(fetcher.mock.calls.some(([url]) => url === "/api/line-in-album/retry")).toBe(false);
});

it.each(["line-in", "vinyl"])("shows honest automatic provenance and enables cached offline metadata retry in %s", async (surface) => {
  const view: AlbumView = { state: "offline", expiresAt: Date.now() + 4000, key: binding.albumKey,
    album: { title: result.title, artist: result.artist, artworkUrl: null }, tracklist: {
      ...preview.tracklist, status: "complete",
    }, retry: null, cacheError: null,
    edition: { binding, original, corrected: false, scope: "remembered", provenance,
      fallback: { ...fallback, state: "resolved", candidates: [], message: "Resolved exact catalog edition." } } };
  const fetcher = service({ "/line-in-album": view });
  render(surface === "line-in" ? <LineInAlbumView /> : <VinylView settings={{ ...DEFAULT_VINYL, showMeters: false }}
    controlsVisible disabled={false} onSettings={vi.fn()} />);
  expect(await screen.findByText("Automatically resolved catalog edition")).toBeInTheDocument();
  if (surface === "vinyl") fireEvent.click(screen.getByText("Line-in details"));
  expect(screen.getByRole("button", { name: "Retry identification" })).toBeDisabled();
  expect(screen.getByText(/Originally recognized: Synthetic original/)).toHaveTextContent("Synthetic artist");
  expect(screen.queryByText("Corrected catalog edition")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "MusicBrainz release" })).toHaveAttribute("href", provenance.catalogUrl);
  expect(screen.getByRole("link", { name: "Cover Art Archive" })).toHaveAttribute("href",
    `https://musicbrainz.org/release/${releaseId}/cover-art`);
  const retry = screen.getByRole("button", { name: "Retry album metadata" });
  expect(retry).toBeEnabled();
  fireEvent.click(retry);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith("/retry-metadata"))).toBe(true));
  expect(JSON.parse(fetcher.mock.calls.find(([url]) => url.endsWith("/retry-metadata"))![1]!.body as string))
    .toEqual({ binding });
  expect(fetcher.mock.calls.some(([url]) => url === "/api/line-in-album/retry")).toBe(false);
});

it("honors metadata cooldown without automatic requests, then enables explicit retry", async () => {
  vi.useFakeTimers();
  const fetcher = service();
  render(<AlbumCatalogStatus binding={binding} status={{ ...fallback, state: "unavailable", retryAt: Date.now() + 2000 }}
    onChanged={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Retry album metadata" })).toBeDisabled();
  expect(screen.getByText(/Catalog rate limits apply/)).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(2001); });
  expect(screen.getByRole("button", { name: "Retry album metadata" })).toBeEnabled();
  expect(fetcher).not.toHaveBeenCalled();
});

it("leaves the MusicBrainz workflow usable after an Apple lookup failure", async () => {
  const responses = { "/search": new Error("Original Apple identity unavailable") as unknown };
  const fetcher = service(responses);
  render(<AlbumEditionCorrection binding={binding} original={{ ...original, country: "gb" }}
    corrected={false} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Correct album edition" }));
  fireEvent.click(screen.getByRole("button", { name: "Search Apple" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Original Apple identity unavailable");
  fireEvent.click(screen.getByRole("button", { name: "MusicBrainz" }));
  expect(screen.getByRole("button", { name: "Search MusicBrainz" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Search MusicBrainz" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/search"))).toHaveLength(2));
  const request = fetcher.mock.calls.filter(([url]) => url.endsWith("/search"))[1]!;
  expect(JSON.parse(request[1]!.body as string)).toEqual({
    binding, artist: original.artist, album: original.title, provider: "musicbrainz",
  });
});

it("reports metadata retry failure without claiming success or refreshing the album", async () => {
  service({ "/retry-metadata": new Error("Catalog temporarily unavailable. Try later.") });
  const changed = vi.fn();
  render(<AlbumCatalogStatus binding={binding} status={{ ...fallback, state: "unavailable" }} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry album metadata" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Catalog temporarily unavailable");
  expect(changed).not.toHaveBeenCalled();
  expect(screen.queryByText(/Metadata lookup finished/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry album metadata" })).toBeEnabled();
});

it.each(["musicbrainz-search", "musicbrainz-preview", "retry-metadata", "apple-search"])(
  "uses the bounded provider deadline for %s without changing Apple's default", async (operation) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/session") return { ok: true, json: async () => ({ csrfToken: "synthetic-token" }) };
      if (operation === "musicbrainz-preview" && url.endsWith("/search")) return {
        ok: true, json: async () => ({ searchToken: "c".repeat(64), results: [result] }),
      };
      signal = init?.signal;
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }));
    if (operation === "retry-metadata") {
      render(<AlbumCatalogStatus binding={binding} status={fallback} onChanged={vi.fn()} />);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry album metadata" })); });
    } else {
      render(<AlbumEditionCorrection binding={binding} original={{ ...original, country: "gb" }}
        corrected={false} fallback={operation === "apple-search" ? undefined : fallback} onChanged={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Correct album edition" }));
      await act(async () => { fireEvent.click(screen.getByRole("button", {
        name: operation === "apple-search" ? "Search Apple" : "Search MusicBrainz",
      })); });
      if (operation === "musicbrainz-preview") {
        await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview Synthetic selected" })); });
      }
    }
    expect(signal).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    if (operation !== "apple-search") {
      expect(signal!.aborted).toBe(false);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    }
    expect(signal!.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("took too long");
  });
