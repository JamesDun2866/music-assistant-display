// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/web/App.js";
import { DEFAULT_VINYL } from "../src/shared/vinyl.js";
import { DEFAULT_AMBIENT } from "../src/shared/ambient.js";
import { emptyLyrics, type Snapshot } from "../src/shared/protocol.js";
import { AMBIENT_IDLE_MS } from "../src/web/Ambient.js";
import type { AlbumView } from "../src/shared/line-in-album.js";
import { navigate } from "../src/web/navigation.js";

const playback = { snapshot: {} as Snapshot, positionMs: 5000, displayPositionMs: 5000,
  stale: false, cleared: false, transportError: null };
vi.mock("../src/web/usePlayback.js", () => ({ usePlayback: () => playback }));
const telemetry = vi.hoisted(() => vi.fn());
vi.mock("../src/web/useSourceTelemetry.js", () => ({ useSourceTelemetry: telemetry }));
let value: ReturnType<typeof album> & { edition?: AlbumView["edition"] };
let fail = false;
const key = `${"a".repeat(32)}-1`;
const retry = { source_id: "a".repeat(64), boot_id: "b".repeat(32), generation: 7 };
function album() {
  return { state: "identified", expiresAt: Date.now() + 4000, key, retry,
    album: { title: "Recognized record", artist: "Record artist", artworkUrl: `/api/line-in-album/artwork/${key}` },
    tracklist: { status: "complete", title: "Catalog edition", artist: "Catalog artist", message: null, discCount: 2,
      tracks: Array.from({ length: 200 }, (_, i) => ({ disc: Math.floor(i / 100) + 1, number: i % 100 + 1, title: `Track ${i + 1}` })) } };
}
const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  if (url === "/api/line-in-album") {
    if (fail) throw new Error("Offline");
    return { ok: true, json: async () => ({ ...value, expiresAt: Date.now() + 4000 }) };
  }
  if (url === "/api/session") return { ok: true, json: async () => ({ csrfToken: "vinyl-token" }) };
  if (url === "/api/settings" || url === "/api/line-in-album/retry") return { ok: true, json: async () => ({}) };
  if (url === "/api/listening-journal") return { ok: true, json: async () => ({
    entries: [], nextCursor: null, revision: "c".repeat(32), retentionDays: 90, status: "ready", message: null,
  }) };
  throw new Error(`Unexpected URL ${url}: ${init?.method}`);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  vi.clearAllMocks();
  playback.snapshot = { sequence: 1, generation: 1, demo: true, connection: "connected", playback: "playing",
    positionMs: 5000, speed: 1, visualOffsetMs: -500, viewMode: "vinyl", vinyl: { ...DEFAULT_VINYL },
    lyricFollowMode: "smooth", ambient: DEFAULT_AMBIENT, precision: "ma-queue", message: null,
    track: { identity: "ma:track", title: "MA current song", artist: "Queue artist", album: "Queue album", durationMs: 60000, artworkUrl: null },
    lyrics: { ...emptyLyrics(), status: "plain", plain: "MA lyrics" },
    cec: { enabled: true, available: true, owned: true, message: "TV available" } };
  value = album(); fail = false;
  telemetry.mockReturnValue({ state: "stale", sampleAgeMs: null,
    left: { rmsDbfs: -20, peakDbfs: -10, holdDbfs: -5, possibleClipping: false },
    right: { rmsDbfs: -20, peakDbfs: -10, holdDbfs: -5, possibleClipping: false } });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => { render(<App />); }); }
async function idle() {
  await act(async () => { document.getElementById("display-content")!.focus(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 500); });
}
it("shows cached effective album without MA song/lyrics/progress or automatic selection", async () => {
  await mount();
  expect(screen.getByRole("heading", { name: "Catalog edition" })).toBeInTheDocument();
  expect(screen.queryByText("MA current song")).not.toBeInTheDocument();
  expect(screen.queryByText("MA lyrics")).not.toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Album tracklist" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Stereo source levels" })).toBeInTheDocument();
  expect(screen.getByText("Input stale")).toBeInTheDocument();
  expect(fetcher.mock.calls.some(([url]) => url === "/api/settings")).toBe(false);
});
it("retains cached title and art through failure and disabled recognition, including a fresh mount", async () => {
  await mount(); fail = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(screen.getByRole("heading", { name: "Catalog edition" })).toBeInTheDocument();
  expect(screen.getByRole("img")).toBeInTheDocument();
  expect(screen.getByText("Line-in source unavailable")).toBeInTheDocument();
  cleanup(); fail = false; value.state = "disabled";
  await mount();
  expect(screen.getByRole("heading", { name: "Catalog edition" })).toBeInTheDocument();
  fireEvent.click(screen.getByText("Line-in details"));
  expect(screen.getByRole("button", { name: "Retry identification" })).toBeDisabled();
});
it("retains all 200 multidisc tracks with a scrollable keyboard/TV reading pane", async () => {
  playback.snapshot.vinyl = { showMeters: false, showTracklist: true };
  await mount();
  const tracks = screen.getByRole("region", { name: "Album tracklist" });
  expect(within(tracks).getAllByRole("listitem")).toHaveLength(200);
  expect(within(tracks).getByText("Track 200")).toBeInTheDocument();
  expect(within(tracks).getByRole("heading", { name: "Disc 2" })).toBeInTheDocument();
  tracks.focus(); fireEvent.keyDown(tracks, { key: "ArrowDown" });
  expect(tracks.scrollTop).toBeGreaterThan(0);
  fireEvent.keyDown(tracks, { key: "ArrowLeft" });
  expect(screen.getByLabelText("Last identified album")).toHaveFocus();
  expect(telemetry).toHaveBeenCalledWith(false);
  expect(screen.queryByRole("meter")).not.toBeInTheDocument();
});
it("saves independent preferences and uses CSRF for explicit source-bound retry", async () => {
  await mount();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show tracklist" })));
  expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
    method: "POST", body: JSON.stringify({ vinyl: { showTracklist: true } }),
    headers: expect.objectContaining({ "X-CSRF-Token": "vinyl-token" }),
  }));
  fireEvent.click(screen.getByText("Line-in details"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry identification" })));
  expect(fetcher).toHaveBeenCalledWith("/api/line-in-album/retry", expect.objectContaining({
    method: "POST", body: JSON.stringify(retry), headers: expect.objectContaining({ "X-CSRF-Token": "vinyl-token" }),
  }));
});
it("fades only controls, wakes with the first key without executing it, and stays awake for focused controls", async () => {
  await mount(); await idle();
  expect(document.querySelector(".display")).toHaveClass("vinyl-quiet");
  expect(screen.getByRole("heading", { name: "Catalog edition" })).toBeInTheDocument();
  expect(screen.getByText("Input stale")).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Enter" });
  expect(document.querySelector(".display")).not.toHaveClass("vinyl-quiet");
  expect(screen.getByRole("tab", { name: "Vinyl" })).toHaveFocus();
  expect(fetcher.mock.calls.some(([url]) => url === "/api/settings")).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 500); });
  expect(document.querySelector(".display")).not.toHaveClass("vinyl-quiet");
});
it("keeps open recognition details awake, Escape closes them and restores summary focus", async () => {
  await mount();
  const summary = screen.getByText("Line-in details");
  fireEvent.click(summary);
  await idle();
  expect(summary.closest("details")).toHaveAttribute("open");
  expect(document.querySelector(".display")).not.toHaveClass("vinyl-quiet");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(summary.closest("details")).not.toHaveAttribute("open");
  expect(summary).toHaveFocus();
});
it("keeps the standby dialog awake and Escape cancels without a destructive command", async () => {
  await mount();
  fireEvent.click(screen.getByText("Display settings"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "TV standby…" })));
  await act(async () => { await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 500); });
  expect(document.querySelector(".display")).not.toHaveClass("vinyl-quiet");
  fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
  expect(screen.getByRole("button", { name: "TV standby…" })).toHaveFocus();
  expect(screen.queryByRole("button", { name: "Confirm standby" })).not.toBeInTheDocument();
  expect(fetcher.mock.calls.some(([url]) => url === "/api/cec")).toBe(false);
});

it.each(["offline", "disabled", "idle", "sampling", "recognizing"])("disables retry in %s even if an old binding is supplied", async (state) => {
  value.state = state;
  await mount();
  fireEvent.click(screen.getByText("Line-in details"));
  expect(screen.getByRole("button", { name: "Retry identification" })).toBeDisabled();
});

it("keeps possible clipping visible during idle without live-region sample announcements", async () => {
  const channel = { rmsDbfs: -1, peakDbfs: 0, holdDbfs: 0, possibleClipping: true };
  telemetry.mockReturnValue({ state: "active", sampleAgeMs: 0, left: channel, right: channel });
  await mount(); await idle();
  expect(document.querySelector(".display")).toHaveClass("vinyl-quiet");
  expect(screen.getAllByText("Possible input clipping")).toHaveLength(2);
  expect(screen.getByRole("region", { name: "Stereo source levels" }).parentElement).toHaveAttribute("aria-live", "off");
});

it("only selects saved Vinyl on explicit selection from another view", async () => {
  playback.snapshot.viewMode = "now-playing";
  await mount();
  expect(screen.getByText("MA current song")).toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Vinyl" })));
  expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
    method: "POST", body: JSON.stringify({ viewMode: "vinyl" }),
  }));
});

it("exposes edition correction in vinyl without searching automatically or fading an open editor", async () => {
  value.edition = { binding: { sourceId: retry.source_id, albumKey: key, success: null, revision: 1 },
    original: { title: "Recognized record", artist: "Record artist", country: "gb" },
    corrected: true, scope: "current-album" };
  await mount();
  expect(screen.getByText("Corrected catalog edition")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Line-in details"));
  expect(screen.getByText(/Current identification only/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Change corrected edition" }));
  expect(screen.getByRole("dialog", { name: "Correct album edition" })).toBeInTheDocument();
  expect(screen.getByLabelText("Artist")).toHaveFocus();
  await act(async () => { await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 500); });
  expect(document.querySelector(".display")).not.toHaveClass("vinyl-quiet");
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/edition/search"))).toBe(false);
});

it("integrates the journal into tools and keeps vinyl controls awake until tools close", async () => {
  await mount();
  const opener = screen.getByRole("button", { name: "Tools" });
  opener.focus();
  fireEvent.click(opener);
  const tools = screen.getByRole("dialog", { name: "Source tools" });
  await act(async () => fireEvent.click(within(tools).getByRole("tab", { name: "Journal" })));
  expect(within(tools).getByRole("link", { name: "Export JSON" })).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 500); });
  expect(document.querySelector(".display")).not.toHaveClass("vinyl-quiet");
  expect(document.getElementById("display-content")).toHaveAttribute("inert");
  await act(async () => fireEvent.click(within(tools).getByRole("button", { name: "Close tools" })));
  expect(opener).toHaveFocus();
  expect(document.getElementById("display-content")).not.toHaveAttribute("inert");
});

it("contains keyboard and remote navigation in the journal confirmation, then restores Tools", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Tools" }));
  const tools = screen.getByRole("dialog", { name: "Source tools" });
  await act(async () => fireEvent.click(within(tools).getByRole("tab", { name: "Journal" })));
  const clear = within(tools).getByRole("button", { name: "Clear journal" });
  fireEvent.click(clear);
  const confirmation = screen.getByRole("dialog", { name: "Clear all journal identifications?" });
  const cancel = within(confirmation).getByRole("button", { name: "Cancel" });
  const confirm = within(confirmation).getByRole("button", { name: "Confirm clear journal" });
  confirm.focus();
  fireEvent.keyDown(confirm, { key: "ArrowDown" });
  expect(cancel).toHaveFocus();
  fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
  expect(confirm).toHaveFocus();
  fireEvent.keyDown(confirm, { key: "Tab" });
  expect(cancel).toHaveFocus();
  await act(async () => { navigate(document.querySelector<HTMLElement>(".display")!, { key: "back", repeat: false }); });
  expect(confirmation).not.toBeInTheDocument();
  expect(tools).toBeInTheDocument();
  expect(clear).toHaveFocus();
  expect(fetcher.mock.calls.some(([url]) => url === "/api/listening-journal/clear")).toBe(false);
});

it("remote Back closes edition correction without closing the enclosing vinyl details", async () => {
  value.edition = { binding: { sourceId: retry.source_id, albumKey: key, success: null, revision: 1 },
    original: { title: "Recognized record", artist: "Record artist", country: "gb" },
    corrected: false, scope: "original" };
  await mount();
  const summary = screen.getByText("Line-in details");
  fireEvent.click(summary);
  const opener = screen.getByRole("button", { name: "Correct album edition" });
  fireEvent.click(opener);
  await act(async () => {
    navigate(document.querySelector<HTMLElement>(".display")!, { key: "back", repeat: false });
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  expect(screen.queryByRole("dialog", { name: "Correct album edition" })).not.toBeInTheDocument();
  expect(summary.closest("details")).toHaveAttribute("open");
  expect(opener).toHaveFocus();
});
