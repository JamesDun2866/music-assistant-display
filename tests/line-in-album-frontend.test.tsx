// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/web/App.js";
import { LineInAlbumView } from "../src/web/LineInAlbum.js";
import { DEFAULT_AMBIENT } from "../src/shared/ambient.js";

const playback = {
  snapshot: {
    sequence: 1, generation: 1, demo: false, connection: "connected", playback: "playing",
    positionMs: 5000, speed: 1, visualOffsetMs: 0, viewMode: "now-playing", lyricFollowMode: "smooth",
    ambient: DEFAULT_AMBIENT, precision: "ma-queue", message: null,
    track: { identity: "spotify:track:ordinary", title: "Ordinary Spotify song", artist: "Queue artist",
      album: "Queue album", durationMs: 60_000, artworkUrl: null },
    lyrics: { status: "plain", lines: [], plain: "Ordinary queue lyric", message: null },
    cec: { enabled: false, available: false, owned: false, message: "Off" },
  },
  positionMs: 5000, displayPositionMs: 5000, stale: false, cleared: false, transportError: null,
};
vi.mock("../src/web/usePlayback.js", () => ({ usePlayback: () => playback }));
const execute = vi.hoisted(() => vi.fn());
vi.mock("../src/web/useLocalCommand.js", () => ({
  useLocalCommand: () => ({ execute, pending: false, error: null, notice: null }),
}));
const key = `${"a".repeat(32)}-1`;
function album() {
  return { state: "identified", expiresAt: Date.now() + 4000, key,
    album: { title: "Recognized album", artist: "Recognized artist", artworkUrl: `/api/line-in-album/artwork/${key}` } };
}
function fullAlbum() {
  return { ...album(), tracklist: {
    status: "complete", message: null, title: "Exact catalog edition", artist: "Catalog album artist", discCount: 2,
    tracks: Array.from({ length: 200 }, (_, index) => ({
      disc: Math.floor(index / 100) + 1, number: index % 100 + 1,
      title: index === 199 ? "The final track — 完整曲目" : `Album track ${index + 1}`,
    })),
  } };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function service(value: unknown = album()) {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => value }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("never replaces ordinary Now Playing until independent line-in view is explicitly selected", async () => {
  const fetcher = service();
  render(<App />);
  expect(screen.getByText("Ordinary Spotify song")).toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Line-in album" })));
  expect(screen.queryByText("Ordinary Spotify song")).not.toBeInTheDocument();
  expect(screen.getByText("Recognized album")).toBeInTheDocument();
  expect(screen.queryByText("Ordinary queue lyric")).not.toBeInTheDocument();
  expect(screen.queryByRole("progressbar", { name: "Song position" })).not.toBeInTheDocument();
  expect(screen.getByText(/Independent local line-in view/)).toBeInTheDocument();
  expect(screen.getByRole("img")).toHaveAttribute("src", `/api/line-in-album/artwork/${key}`);
  await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Now Playing" })));
  expect(screen.getByText("Ordinary Spotify song")).toBeInTheDocument();
  const requests = fetcher.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(fetcher).toHaveBeenCalledTimes(requests);
});

it("keeps last album on disabled status and never renders lyrics or timing", async () => {
  const fetcher = service();
  await act(async () => { render(<LineInAlbumView />); });
  expect(screen.getByText("Recognized album")).toBeInTheDocument();
  fetcher.mockResolvedValue({ ok: true, json: async () => ({
    ...album(), state: "disabled",
  }) });
  await act(async () => vi.advanceTimersByTimeAsync(800));
  expect(screen.getByText("Recognized album")).toBeInTheDocument();
  expect(screen.getByRole("img")).toBeInTheDocument();
  expect(screen.getByText("Last identified album")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry identification" })).toBeDisabled();
  expect(screen.getAllByText("Album recognition is off").length).toBeGreaterThan(0);
});

it("expires live status but keeps cached album if the next status request never completes", async () => {
  const fetcher = service();
  await act(async () => { render(<LineInAlbumView />); });
  fetcher.mockImplementation(() => new Promise(() => {}));
  await act(async () => vi.advanceTimersByTimeAsync(4100));
  expect(screen.getByText("Recognized album")).toBeInTheDocument();
  expect(screen.getByRole("img")).toBeInTheDocument();
  expect(screen.getByText("Line-in source unavailable")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry identification" })).toBeDisabled();
});

it("rejects remote browser artwork and unrecognized fields rather than rendering provider data", async () => {
  service({ ...album(), album: { title: "Untrusted", artist: "Artist", artworkUrl: "https://evil/image" }, lyrics: "Secret" });
  await act(async () => { render(<LineInAlbumView />); });
  expect(screen.queryByText("Untrusted")).not.toBeInTheDocument();
  expect(screen.queryByText("Secret")).not.toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("puts the cover before the complete right-hand multi-disc tracklist with no playback claims", async () => {
  service(fullAlbum());
  await act(async () => { render(<LineInAlbumView />); });
  const pane = screen.getByRole("region", { name: "Album tracklist" });
  const cover = screen.getByRole("img");
  expect(cover.closest(".album-cover")).not.toBeNull();
  expect(cover.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(pane).toHaveAttribute("data-navigation-scroll");
  expect(pane).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("heading", { name: "Exact catalog edition" })).toBeInTheDocument();
  expect(screen.getByText("Catalog album artist")).toBeInTheDocument();
  expect(within(pane).getAllByRole("listitem")).toHaveLength(200);
  expect(within(pane).getByRole("heading", { name: "Disc 1" })).toBeInTheDocument();
  expect(within(pane).getByRole("heading", { name: "Disc 2" })).toBeInTheDocument();
  expect(within(pane).getByText("The final track — 完整曲目")).toBeInTheDocument();
  expect(pane.querySelector("[aria-current]")).toBeNull();
  expect(within(pane).queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

it("lets TV directional navigation scroll the full tracklist and leave the pane", async () => {
  service(fullAlbum());
  render(<App />);
  await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Line-in album" })));
  const pane = screen.getByRole("region", { name: "Album tracklist" });
  pane.focus();
  fireEvent.keyDown(pane, { key: "ArrowDown" });
  expect(pane.scrollTop).toBeGreaterThan(0);
  expect(pane).toHaveFocus();
  fireEvent.keyDown(pane, { key: "ArrowLeft" });
  expect(screen.getByRole("tab", { name: "Line-in album" })).toHaveFocus();
});

it("keeps identified album artwork/name when the catalog is incomplete and recognition is disabled", async () => {
  const fetcher = service({ ...album(), tracklist: {
    status: "unavailable", message: "Complete tracklist unavailable for this catalog release.",
    title: null, artist: null, discCount: null, tracks: [],
  } });
  await act(async () => { render(<LineInAlbumView />); });
  expect(screen.getByText("Recognized album")).toBeInTheDocument();
  expect(screen.getByRole("img")).toBeInTheDocument();
  expect(screen.getByText("Complete tracklist unavailable for this catalog release.")).toBeInTheDocument();
  expect(screen.queryByText("Full catalog tracklist")).not.toBeInTheDocument();
  fetcher.mockResolvedValue({ ok: true, json: async () => ({
    ...album(), state: "disabled",
  }) });
  await act(async () => vi.advanceTimersByTimeAsync(800));
  expect(screen.getByRole("img")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Album tracklist" })).toBeInTheDocument();
  expect(screen.getByText("Recognized album")).toBeInTheDocument();
});

it("sends a source-bound retry through the local command helper, never consent or recording", async () => {
  const retry = { source_id: "a".repeat(64), boot_id: "b".repeat(32), generation: 7 };
  service({ ...fullAlbum(), state: "unavailable", retry });
  await act(async () => { render(<LineInAlbumView />); });
  fireEvent.click(screen.getByRole("button", { name: "Retry identification" }));
  expect(execute).toHaveBeenCalledWith("/api/line-in-album/retry", retry,
    "Retry requested. Listening for a fresh 12-second sample.");
  expect(screen.getByText("Exact catalog edition")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /enable|record|start/i })).not.toBeInTheDocument();
});

it("keeps one compact label/status caption and positions retry beside the title block", async () => {
  service(fullAlbum());
  await act(async () => { render(<LineInAlbumView />); });
  const title = screen.getByRole("heading", { name: "Exact catalog edition" });
  const block = title.closest(".album-title-block")!;
  const header = block.parentElement!;
  const button = screen.getByRole("button", { name: "Retry identification" });
  expect(button.parentElement).toBe(header);
  expect(block.contains(button)).toBe(false);
  expect(header.querySelectorAll(".stage-caption")).toHaveLength(1);
  expect(within(block as HTMLElement).getByRole("status")).toHaveTextContent("Last identified album · Recognition succeeded");
  expect(header.querySelectorAll(":scope > p")).toHaveLength(0);
});
