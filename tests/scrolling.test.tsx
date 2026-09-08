// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AMBIENT } from "../src/shared/ambient.js";
import { DEFAULT_VINYL } from "../src/shared/vinyl.js";
import type { Snapshot, TimedLine } from "../src/shared/protocol.js";
import { App } from "../src/web/App.js";
import { CLEAR_AFTER_MS, usePlayback } from "../src/web/usePlayback.js";

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    sequence: 1, generation: 1, demo: false, connection: "connected",
    playback: "playing", positionMs: 250, speed: 1, visualOffsetMs: 0,
    viewMode: "split", lyricFollowMode: "smooth", ambient: DEFAULT_AMBIENT, vinyl: DEFAULT_VINYL, precision: "ma-queue", message: null,
    track: {
      identity: "synthetic-track-1", title: "Synthetic track one", artist: "Test artist",
      album: "Test album", durationMs: 120_000, artworkUrl: null,
    },
    lyrics: {
      status: "timed",
      lines: [
        { timeMs: 0, text: "Synthetic cue alpha" },
        { timeMs: 2_000, text: "Synthetic cue beta" },
        { timeMs: 4_000, text: "Synthetic cue gamma" },
      ],
      plain: null, message: null,
    },
    cec: { enabled: false, available: false, owned: false, message: "Test CEC disabled." },
    ...overrides,
  };
}

class StateEvents extends EventTarget {
  static instances: StateEvents[] = [];
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(public url: string) {
    super();
    StateEvents.instances.push(this);
  }

  send(value: unknown) {
    this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(value) }));
  }

  static latest() {
    return StateEvents.instances.at(-1)!;
  }
}

function mockService(initial: Snapshot) {
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    const body = JSON.stringify(url === "/api/state" ? initial : { csrfToken: "test-token", ok: true });
    return { ok: true, status: 200, json: async () => JSON.parse(body) } as Response;
  }));
}

async function mount(initial = snapshot()) {
  mockService(initial);
  render(<App />);
  await act(async () => {});
}

async function mountPlayback(initial: Snapshot) {
  mockService(initial);
  const hook = renderHook(() => usePlayback());
  await act(async () => {});
  return hook;
}

function send(value: unknown, source = StateEvents.latest()) {
  act(() => source.send(value));
}

function tick(milliseconds: number) {
  act(() => vi.advanceTimersByTime(milliseconds));
}

function rows() {
  return Array.from(screen.getByLabelText("Timed lyrics").querySelectorAll<HTMLParagraphElement>(".lyric-line"));
}

const scrollTo = vi.fn();
let originalScrollTo: PropertyDescriptor | undefined;

function expectFollowed(text: string) {
  expect(screen.getByText(text)).toHaveAttribute("aria-current", "true");
  expect(scrollTo).toHaveBeenCalledTimes(1);
  expect(scrollTo.mock.contexts[0]).toBe(screen.getByLabelText("Timed lyrics"));
  scrollTo.mockClear();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  StateEvents.instances = [];
  vi.stubGlobal("EventSource", StateEvents);
  originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  scrollTo.mockClear();
});

afterEach(() => {
  cleanup();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("timed lyrics follow scrolling through real playback snapshots", () => {
  it.each(["smooth", "instant"] as const)("follows cues, seeks, revisions and track changes in %s mode", async (lyricFollowMode) => {
    const initial = snapshot({ lyricFollowMode, positionMs: 1_900 });
    await mount(initial);
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: lyricFollowMode }));
    scrollTo.mockClear();
    tick(100);
    expectFollowed("Synthetic cue beta");
    send({ ...initial, sequence: 2, positionMs: 4_100 });
    expectFollowed("Synthetic cue gamma");
    send({ ...initial, sequence: 3, positionMs: 100 });
    expectFollowed("Synthetic cue alpha");
    send({ ...initial, sequence: 4, generation: 2 });
    expectFollowed("Synthetic cue alpha");
    expect(screen.getByLabelText("Timed lyrics").classList.contains("instant-follow")).toBe(lyricFollowMode === "instant");
  });

  it.each(["focus", "wheel", "pointerDown", "touchStart"] as const)(
    "pauses %s reading through cues, seeks, heartbeats and resize until one explicit resume",
    async (interaction) => {
      const initial = snapshot({ lyricFollowMode: "instant" });
      await mount(initial);
      const viewport = screen.getByLabelText("Timed lyrics");
      scrollTo.mockClear();
      fireEvent[interaction](viewport);
      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "instant" });
      viewport.scrollTop = 200;
      scrollTo.mockClear();
      send({ ...initial, sequence: 2, positionMs: 4_100 });
      send({ ...initial, sequence: 3, positionMs: 2_100 });
      act(() => window.dispatchEvent(new Event("resize")));
      expect(scrollTo).not.toHaveBeenCalled();
      expect(viewport.scrollTop).toBe(200);
      expect(screen.getByText("Synthetic cue beta")).toHaveAttribute("aria-current", "true");
      fireEvent.click(screen.getByRole("button", { name: "Resume lyric follow" }));
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "instant" }));
      expect(screen.queryByText("Follow paused for reading.")).not.toBeInTheDocument();
    },
  );

  it("resets a manual reading pause on track changes and never carries old observers forward", async () => {
    const initial = snapshot();
    await mount(initial);
    fireEvent.wheel(screen.getByLabelText("Timed lyrics"));
    scrollTo.mockClear();
    send({ ...initial, sequence: 2, generation: 2, track: { ...initial.track!, identity: "replacement" } });
    expectFollowed("Synthetic cue alpha");
    expect(screen.queryByRole("button", { name: "Resume lyric follow" })).not.toBeInTheDocument();
  });

  it("does not apply view or timing shortcuts while focused on timed lyrics", async () => {
    await mount();
    const viewport = screen.getByLabelText("Timed lyrics");
    act(() => viewport.focus());
    const fetcher = vi.mocked(fetch);
    fetcher.mockClear();
    for (const key of ["1", "2", "3", "4", "[", "]", "f"]) fireEvent.keyDown(viewport, { key });
    expect(fetcher).not.toHaveBeenCalled();
    expect(viewport).toHaveFocus();
  });

  it("applies a saved instant setting during an active smooth follow without waiting for the next cue", async () => {
    const initial = snapshot();
    await mount(initial);
    scrollTo.mockClear();
    send({ ...initial, sequence: 2, lyricFollowMode: "instant" });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "instant" });
    scrollTo.mockClear();
    send({ ...initial, sequence: 3, lyricFollowMode: "instant" });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("reacts to live reduced motion changes and removes the media listener on unmount", async () => {
    const query = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", vi.fn(() => query));
    await mount();
    const changed = query.addEventListener.mock.calls[0]![1] as () => void;
    scrollTo.mockClear();
    query.matches = true;
    act(changed);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "instant" });
    expect(screen.getByLabelText("Timed lyrics")).toHaveClass("instant-follow");
    query.matches = false;
    act(changed);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" });
    cleanup();
    expect(query.removeEventListener).toHaveBeenCalledWith("change", changed);
  });

  it("does not restart scrolling for JSON-deserialized identical lyric heartbeats at the same cue", async () => {
    const initial = snapshot();
    await mount(initial);
    const originalRows = rows();
    expectFollowed("Synthetic cue alpha");

    for (let sequence = 2; sequence <= 5; sequence += 1) {
      tick(100);
      send({ ...initial, sequence, positionMs: initial.positionMs + (sequence - 1) * 100 });
      rows().forEach((row, index) => expect(row).toBe(originalRows[index]));
    }

    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "650");
    expect(screen.getByText("Synthetic cue alpha")).toHaveAttribute("aria-current", "true");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does not scroll or replace keyed rows on the 100 ms clock ticks within one cue", async () => {
    await mount();
    const originalRows = rows();
    expectFollowed("Synthetic cue alpha");

    for (let count = 0; count < 12; count += 1) tick(100);

    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1450");
    rows().forEach((row, index) => expect(row).toBe(originalRows[index]));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("still follows an actual next cue and accepted backward and forward seeks", async () => {
    const initial = snapshot({ positionMs: 1_900 });
    await mount(initial);
    expectFollowed("Synthetic cue alpha");

    tick(100);
    expectFollowed("Synthetic cue beta");
    send({ ...initial, sequence: 2, positionMs: 100 });
    expectFollowed("Synthetic cue alpha");
    send({ ...initial, sequence: 3, positionMs: 4_100 });
    expectFollowed("Synthetic cue gamma");
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "4100");
  });

  it("renders a same-timestamp text revision in the existing keyed node and follows it", async () => {
    const initial = snapshot({ positionMs: 2_100 });
    await mount(initial);
    const originalRows = rows();
    expectFollowed("Synthetic cue beta");
    const lines = initial.lyrics.lines.map((line, index) => index === 1
      ? { ...line, text: "Synthetic revised cue <text>" } : line);

    send({ ...initial, sequence: 2, lyrics: { ...initial.lyrics, lines } });

    expectFollowed("Synthetic revised cue <text>");
    expect(screen.queryByText("Synthetic cue beta")).not.toBeInTheDocument();
    rows().forEach((row, index) => expect(row).toBe(originalRows[index]));
  });

  it("follows timestamp-only revisions even before their active index changes", async () => {
    const initial = snapshot({ positionMs: 2_100 });
    await mount(initial);
    expectFollowed("Synthetic cue beta");

    for (const [sequence, timeMs, active] of [
      [2, 1_900, "Synthetic cue beta"],
      [3, 2_500, "Synthetic cue alpha"],
    ] as const) {
      const lines = initial.lyrics.lines.map((line, index) => index === 1 ? { ...line, timeMs } : line);
      send({ ...initial, sequence, lyrics: { ...initial.lyrics, lines } });
      expectFollowed(active);
    }
  });

  it("follows appended and removed lines without losing unchanged keyed rows", async () => {
    const initial = snapshot({ positionMs: 2_100 });
    await mount(initial);
    const originalRows = rows();
    expectFollowed("Synthetic cue beta");

    send({ ...initial, sequence: 2, lyrics: {
      ...initial.lyrics, lines: [...initial.lyrics.lines, { timeMs: 6_000, text: "Synthetic cue delta" }],
    } });
    expectFollowed("Synthetic cue beta");
    expect(rows()).toHaveLength(4);
    expect(rows()[1]).toBe(originalRows[1]);

    send({ ...initial, sequence: 3, lyrics: { ...initial.lyrics, lines: initial.lyrics.lines.slice(0, 2) } });
    expectFollowed("Synthetic cue beta");
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText("Synthetic cue delta")).not.toBeInTheDocument();
    expect(screen.queryByText("Synthetic cue gamma")).not.toBeInTheDocument();
    expect(rows()[1]).toBe(originalRows[1]);
  });

  it.each(["generation", "identity"] as const)("follows identical text across a new %s boundary", async (boundary) => {
    const initial = snapshot({ positionMs: 2_100 });
    await mount(initial);
    expectFollowed("Synthetic cue beta");
    send({
      ...initial, sequence: 2,
      generation: boundary === "generation" ? 2 : 1,
      track: { ...initial.track!, identity: boundary === "identity" ? "synthetic-track-2" : initial.track!.identity,
        title: "Synthetic replacement track" },
    });

    expectFollowed("Synthetic cue beta");
    expect(screen.getByRole("heading", { name: "Synthetic replacement track" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: initial.track!.title })).not.toBeInTheDocument();
  });

  it("renders status and plain-text changes rather than reusing the entire lyrics object", async () => {
    const initial = snapshot({ positionMs: 2_100 });
    await mount(initial);
    expectFollowed("Synthetic cue beta");

    for (const [sequence, plain] of [[2, "Synthetic unsynced text"], [3, "Synthetic revised unsynced text"]] as const) {
      send({ ...initial, sequence, lyrics: { ...initial.lyrics, status: "plain", plain } });
      expect(screen.getByLabelText("Unsynced lyrics")).toHaveTextContent(plain);
      expect(screen.queryByLabelText("Timed lyrics")).not.toBeInTheDocument();
      expect(scrollTo).not.toHaveBeenCalled();
    }
    expect(screen.queryByText("Synthetic unsynced text")).not.toBeInTheDocument();

    send({ ...initial, sequence: 4, lyrics: { ...initial.lyrics, status: "loading" } });
    expect(screen.getByRole("heading", { name: "Finding the words" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Unsynced lyrics")).not.toBeInTheDocument();
    send({ ...initial, sequence: 5 });
    expectFollowed("Synthetic cue beta");
  });

  it("leaves paused clock ticks stationary and follows a seek while still paused", async () => {
    const initial = snapshot({ playback: "paused", speed: 0, positionMs: 2_100 });
    await mount(initial);
    expectFollowed("Synthetic cue beta");

    for (let count = 0; count < 20; count += 1) tick(100);
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "2100");
    expect(screen.getByText("Synthetic cue beta")).toHaveAttribute("aria-current", "true");
    expect(scrollTo).not.toHaveBeenCalled();
    send({ ...initial, sequence: 2, positionMs: 100 });
    expectFollowed("Synthetic cue alpha");
  });

  it("keeps the negative-offset intro and instrumental cue semantics while following boundaries", async () => {
    const initial = snapshot({ positionMs: 0, visualOffsetMs: -500, lyrics: {
      status: "timed", plain: null, message: null,
      lines: [{ timeMs: 0, text: "Synthetic opening cue" }, { timeMs: 1_000, text: " " },
        { timeMs: 2_000, text: "Synthetic closing cue" }],
    } });
    await mount(initial);
    expect(screen.getByText("Listen for your cue…")).toBeInTheDocument();
    expect(rows().every((row) => !row.hasAttribute("aria-current"))).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    scrollTo.mockClear();

    tick(400);
    expect(scrollTo).not.toHaveBeenCalled();
    tick(100);
    expectFollowed("Synthetic opening cue");
    expect(screen.queryByText("Listen for your cue…")).not.toBeInTheDocument();
    tick(1_000);
    expect(screen.getByLabelText("Instrumental break").closest("p")).toHaveAttribute("aria-current", "true");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    scrollTo.mockClear();

    send({ ...initial, sequence: 2, positionMs: 0 });
    expect(screen.getByText("Listen for your cue…")).toBeInTheDocument();
    expect(rows().every((row) => !row.hasAttribute("aria-current"))).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("does not scroll or render rejected sequence/generation revisions, but still accepts the next valid seek", async () => {
    const initial = snapshot({ sequence: 20, generation: 3, positionMs: 2_100 });
    await mount(initial);
    const originalRows = rows();
    expectFollowed("Synthetic cue beta");

    for (const [sequence, generation] of [[19, 4], [20, 3], [100, 2]]) {
      send({ ...initial, sequence, generation, positionMs: 4_100, lyrics: {
        ...initial.lyrics, lines: [{ timeMs: 0, text: "Synthetic rejected cue" }],
      } });
    }
    expect(screen.queryByText("Synthetic rejected cue")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "2100");
    rows().forEach((row, index) => expect(row).toBe(originalRows[index]));
    expect(scrollTo).not.toHaveBeenCalled();

    send({ ...initial, sequence: 21, positionMs: 100 });
    expectFollowed("Synthetic cue alpha");
  });

  it("freezes, clears, and reconnects without reviving old-track nodes or closed-stream events", async () => {
    const initial = snapshot({ sequence: 100, generation: 10, positionMs: 2_100 });
    await mount(initial);
    const oldRows = rows();
    const oldStream = StateEvents.latest();
    expectFollowed("Synthetic cue beta");

    act(() => oldStream.onerror?.());
    tick(1_000);
    expect(oldStream.close).toHaveBeenCalled();
    expect(screen.getByText("Lyrics frozen")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "2100");
    expect(scrollTo).not.toHaveBeenCalled();
    tick(CLEAR_AFTER_MS);
    expect(screen.getByRole("heading", { name: "Waiting to reconnect" })).toBeInTheDocument();
    oldRows.forEach((row) => expect(row).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: initial.track!.title })).not.toBeInTheDocument();

    // Recovery must arrive on an open retry stream, not a closed source waiting for backoff.
    for (let waited = 0; StateEvents.latest().close.mock.calls.length && waited < 15_000; waited += 100) tick(100);
    expect(StateEvents.latest().close).not.toHaveBeenCalled();
    const replacement = snapshot({
      sequence: 1, generation: 0, positionMs: 0,
      track: { ...initial.track!, identity: "synthetic-reconnected", title: "Synthetic reconnect track" },
      lyrics: { ...initial.lyrics, lines: [{ timeMs: 0, text: "Synthetic reconnect cue" }] },
    });
    send(replacement);
    expectFollowed("Synthetic reconnect cue");
    send({ ...initial, sequence: 101, generation: 11 }, oldStream);
    act(() => oldStream.onerror?.());
    expect(screen.getByRole("heading", { name: replacement.track!.title })).toBeInTheDocument();
    expect(screen.queryByText("Synthetic cue beta")).not.toBeInTheDocument();
    expect(screen.queryByText("Lyrics frozen")).not.toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("accepts a sub-256 KiB 4000-line JSON fixture without repeated heartbeat scrolling", async () => {
    const lines = Array.from({ length: 4_000 }, (_, index) => ({
      timeMs: index * 1_000, text: `Synthetic cue ${String(index).padStart(4, "0")}`,
    }));
    const initial = snapshot({ positionMs: 2_000_100, lyrics: { status: "timed", lines, plain: null, message: null } });
    initial.track = { ...initial.track!, durationMs: 4_000_000 };
    expect(Buffer.byteLength(JSON.stringify(initial), "utf8")).toBeLessThan(256 * 1024);
    await mount(initial);
    const originalRows = rows();
    expect(originalRows).toHaveLength(4_000);
    expect(originalRows[2_000]).toHaveAttribute("aria-current", "true");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    scrollTo.mockClear();

    for (let sequence = 2; sequence <= 4; sequence += 1) {
      tick(100);
      send({ ...initial, sequence, positionMs: initial.positionMs + (sequence - 1) * 100 });
    }
    const nextRows = rows();
    expect(nextRows).toHaveLength(4_000);
    for (const index of [0, 2_000, 3_999]) expect(nextRows[index]).toBe(originalRows[index]);
    expect(nextRows[2_000]).toHaveAttribute("aria-current", "true");
    expect(screen.queryByText("Connection stale")).not.toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("accepted playback lyric reference sharing", () => {
  it("shares only equal parsed lines while retaining fresh metadata and receipt-based clock anchors", async () => {
    const initial = snapshot({ positionMs: 1_000 });
    const { result } = await mountPlayback(initial);
    const original = result.current.snapshot!;
    expect(original.lyrics.lines).not.toBe(initial.lyrics.lines);
    tick(500);
    expect(result.current.positionMs).toBe(1_500);

    const paused = {
      ...initial, sequence: 2, playback: "paused" as const, speed: 0 as const, positionMs: 1_800,
      visualOffsetMs: -200, viewMode: "lyrics" as const, demo: true, precision: "demo" as const,
      message: "Synthetic updated service message",
      track: { ...initial.track!, title: "Synthetic updated title", artist: "Updated test artist",
        album: "Updated test album", durationMs: 2_000, artworkUrl: "/api/artwork/synthetic-updated" },
      lyrics: { ...initial.lyrics, plain: "Synthetic fallback text", message: "Synthetic lyric message" },
      cec: { enabled: true, available: true, owned: true, message: "Synthetic updated CEC status" },
    };
    send(paused);
    const acceptedPaused = result.current.snapshot!;
    expect(acceptedPaused).toEqual(paused);
    expect(acceptedPaused).not.toBe(original);
    expect(acceptedPaused.lyrics).not.toBe(original.lyrics);
    tick(500);
    expect(result.current.positionMs).toBe(1_800);
    expect(result.current.displayPositionMs).toBe(1_600);

    const resumed = { ...paused, sequence: 3, playback: "playing" as const, speed: 1 as const,
      positionMs: 1_950, visualOffsetMs: 100 };
    send(resumed);
    expect(result.current.snapshot).toEqual(resumed);
    tick(200);
    expect(result.current.positionMs).toBe(2_000);
    expect(result.current.displayPositionMs).toBe(2_100);
    expect(original).toEqual(initial);
    expect(acceptedPaused.lyrics.lines === original.lyrics.lines).toBe(true);
    expect(result.current.snapshot!.lyrics.lines === original.lyrics.lines).toBe(true);
  });

  it("replaces revised arrays without mutating any previously accepted line objects", async () => {
    const initial = snapshot();
    const { result } = await mountPlayback(initial);
    const history: { lines: TimedLine[]; value: TimedLine[] }[] = [];
    const revisions = [
      initial.lyrics.lines.map((line, index) => index === 1 ? { ...line, text: "Synthetic revision" } : line),
      initial.lyrics.lines.map((line, index) => index === 1 ? { ...line, timeMs: 2_500 } : line),
      [...initial.lyrics.lines, { timeMs: 6_000, text: "Synthetic appended cue" }],
      initial.lyrics.lines.slice(0, 2),
    ];
    for (const [index, lines] of revisions.entries()) {
      const previous = result.current.snapshot!.lyrics.lines;
      history.push({ lines: previous, value: previous.map((line) => ({ ...line })) });
      send({ ...initial, sequence: index + 2, lyrics: { ...initial.lyrics, lines } });
      expect(result.current.snapshot!.lyrics.lines).toEqual(lines);
      expect(result.current.snapshot!.lyrics.lines).not.toBe(previous);
      history.forEach((entry) => expect(entry.lines).toEqual(entry.value));
    }
  });

  it.each(["generation", "identity", "status"] as const)("does not share equal lines across a %s boundary", async (boundary) => {
    const initial = snapshot();
    const { result } = await mountPlayback(initial);
    const originalLines = result.current.snapshot!.lyrics.lines;
    send({
      ...initial, sequence: 2,
      generation: boundary === "generation" ? 2 : 1,
      track: { ...initial.track!, identity: boundary === "identity" ? "synthetic-track-2" : initial.track!.identity },
      lyrics: { ...initial.lyrics, status: boundary === "status" ? "plain" : "timed", plain: "Synthetic fallback" },
    });

    expect(result.current.snapshot!.lyrics.lines).toEqual(originalLines);
    expect(result.current.snapshot!.lyrics.lines).not.toBe(originalLines);
  });
});

describe("timed lyrics follow geometry", () => {
  class LayoutObserver implements ResizeObserver {
    static instances: LayoutObserver[] = [];
    observe = vi.fn<ResizeObserver["observe"]>();
    unobserve = vi.fn<ResizeObserver["unobserve"]>();
    disconnect = vi.fn<ResizeObserver["disconnect"]>();

    constructor(readonly callback: ResizeObserverCallback) {
      LayoutObserver.instances.push(this);
    }

    deliver(...targets: Element[]) {
      const entries = targets.map((target) => ({
        target, contentRect: target.getBoundingClientRect(),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
      }));
      act(() => this.callback(entries, this));
    }
  }

  function mockGeometry() {
    const geometry = { viewportTop: 180, viewportHeight: 300, lineTop: 720, lineHeight: 60, scrollTop: 80 };
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("timed-viewport")) {
        return new DOMRect(0, geometry.viewportTop, 600, geometry.viewportHeight);
      }
      if (this.classList.contains("lyric-line")) {
        const index = Array.from(this.parentElement!.children).indexOf(this);
        return new DOMRect(0, geometry.viewportTop + geometry.lineTop + index * 180 - geometry.scrollTop,
          600, geometry.lineHeight);
      }
      if (this.classList.contains("timed-lines")) {
        return new DOMRect(0, geometry.viewportTop - geometry.scrollTop,
          600, geometry.lineTop + this.childElementCount * 180 + geometry.lineHeight);
      }
      return originalRect.call(this);
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timed-viewport") ? geometry.viewportHeight
        : this.classList.contains("lyric-line") ? geometry.lineHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timed-viewport") ? geometry.scrollTop : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timed-viewport") ? geometry.viewportTop
        : this.classList.contains("lyric-line") ? geometry.lineTop : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("lyric-line") ? this.parentElement : document.body;
    });
    return geometry;
  }

  beforeEach(() => {
    LayoutObserver.instances = [];
    vi.stubGlobal("ResizeObserver", LayoutObserver);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  });

  it.each([[false, "smooth"], [true, "instant"]] as const)(
    "centers using shared rectangle coordinates with reduced motion %s",
    async (reducedMotion, behavior) => {
      mockGeometry();
      const matchMedia = vi.fn(() => ({ matches: reducedMotion }));
      vi.stubGlobal("matchMedia", matchMedia);
      await mount();
      const viewport = screen.getByLabelText("Timed lyrics");
      const line = screen.getByText("Synthetic cue alpha");

      expect(line.offsetParent).not.toBe(viewport.offsetParent);
      expect(line).toHaveAttribute("aria-current", "true");
      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 600, behavior });
      expect(scrollTo.mock.contexts[0]).toBe(viewport);
      expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
      const observer = LayoutObserver.instances[0]!;
      expect(observer.observe.mock.calls.map(([element]) => element)).toEqual([viewport, viewport.firstElementChild]);
    },
  );

  it("ignores initial, unchanged, and subpixel observer deliveries during a smooth scroll", async () => {
    const geometry = mockGeometry();
    await mount();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 600, behavior: "smooth" });
    const viewport = screen.getByLabelText("Timed lyrics");
    const observer = LayoutObserver.instances[0]!;
    scrollTo.mockClear();

    observer.deliver(viewport, viewport.firstElementChild!);
    geometry.scrollTop = 300;
    observer.deliver(viewport);
    geometry.lineTop += 0.5;
    observer.deliver(viewport.firstElementChild!);
    geometry.scrollTop = 600;
    observer.deliver(viewport, viewport.firstElementChild!);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it.each(["container", "content"] as const)("recenters once when %s geometry changes", async (change) => {
    const geometry = mockGeometry();
    await mount();
    const viewport = screen.getByLabelText("Timed lyrics");
    const observer = LayoutObserver.instances[0]!;
    const originalLine = screen.getByText("Synthetic cue alpha");
    scrollTo.mockClear();
    geometry.scrollTop = 300;

    if (change === "container") geometry.viewportHeight = 420;
    else {
      geometry.lineTop = 810;
      geometry.lineHeight = 100;
    }
    const target = change === "container" ? viewport : viewport.firstElementChild!;
    const expectedTop = change === "container" ? 540 : 710;
    observer.deliver(target);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: expectedTop, behavior: "smooth" });
    expect(screen.getByText("Synthetic cue alpha")).toBe(originalLine);

    geometry.scrollTop = expectedTop;
    observer.deliver(target);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("disconnects superseded observers and removes resize listeners when the cue changes or unmounts", async () => {
    const geometry = mockGeometry();
    const removeListener = vi.spyOn(window, "removeEventListener");
    const initial = snapshot();
    await mount(initial);
    const first = LayoutObserver.instances[0]!;
    expect(first.disconnect).not.toHaveBeenCalled();

    send({ ...initial, sequence: 2, positionMs: 2_100 });
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("resize", first.callback);
    expect(LayoutObserver.instances).toHaveLength(2);
    const second = LayoutObserver.instances[1]!;
    expect(second.disconnect).not.toHaveBeenCalled();
    scrollTo.mockClear();

    cleanup();
    expect(second.disconnect).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("resize", second.callback);
    geometry.viewportHeight = 420;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("recenters on window resize without ResizeObserver and deduplicates repeated resize events", async () => {
    const geometry = mockGeometry();
    vi.stubGlobal("ResizeObserver", undefined);
    await mount();
    expect(LayoutObserver.instances).toHaveLength(0);
    scrollTo.mockClear();
    geometry.viewportHeight = 420;

    act(() => window.dispatchEvent(new Event("resize")));
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 540, behavior: "smooth" });
    geometry.scrollTop = 540;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});
