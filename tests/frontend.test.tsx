// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../src/shared/protocol.js";
import { DEFAULT_AMBIENT } from "../src/shared/ambient.js";
import { App, LyricsStage } from "../src/web/App.js";
import { activeLineIndex, PlaybackClock } from "../src/web/clock.js";
import { localArtworkUrl, snapshotSchema } from "../src/web/schema.js";
import { reconnectDelayMs } from "../src/web/usePlayback.js";

let fixtureSequence = 0;
function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    sequence: ++fixtureSequence, generation: 1, demo: false, connection: "connected",
    playback: "playing", positionMs: 0, speed: 1, visualOffsetMs: 0, viewMode: "split", ambient: DEFAULT_AMBIENT,
    lyricFollowMode: "smooth", precision: "ma-queue", message: null,
    track: {
      identity: "song-1", title: "The open road", artist: "Demo artist", album: "Local sessions",
      durationMs: 120_000, artworkUrl: null,
    },
    lyrics: {
      status: "timed", lines: [
        { timeMs: 0, text: "First line" },
        { timeMs: 2_000, text: "Second line" },
        { timeMs: 4_000, text: "Third line" },
      ], plain: null, message: null,
    },
    cec: { enabled: false, available: false, owned: false, message: "HDMI-CEC is disabled." },
    ...overrides,
  };
}

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  send(value: unknown) {
    this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(value) }));
  }
  static latest() {
    return FakeEventSource.instances.at(-1)!;
  }
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function mockService(initial = snapshot()) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (input === "/api/session") return response({ csrfToken: "test-local-token" });
    if (input === "/api/state") return response(initial);
    return response({ ok: true });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

async function mount(initial = snapshot()) {
  const fetcher = mockService(initial);
  render(<App />);
  await act(async () => {});
  return fetcher;
}

beforeEach(() => {
  fixtureSequence = 0;
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("receipt-anchored playback clock", () => {
  it("jitters capped exponential retries within the upper half of each delay", () => {
    expect(reconnectDelayMs(1_000, () => 0)).toBe(500);
    expect(reconnectDelayMs(1_000, () => 0.5)).toBe(750);
    expect(reconnectDelayMs(2_000, () => 0.5)).toBe(1_500);
    expect(reconnectDelayMs(30_000, () => 0)).toBe(7_500);
    expect(reconnectDelayMs(30_000, () => 0.99999)).toBe(15_000);
  });

  it("advances with monotonic time and freezes when paused", () => {
    const clock = new PlaybackClock();
    clock.anchor(snapshot({ positionMs: 1_000 }), 100);
    expect(clock.position(1_100)).toBe(2_000);
    clock.anchor(snapshot({ positionMs: 2_000, playback: "paused", speed: 0 }), 1_100);
    expect(clock.position(9_000)).toBe(2_000);
  });

  it("reanchors forward and backward seeks and track changes", () => {
    const clock = new PlaybackClock();
    clock.anchor(snapshot({ positionMs: 40_000 }), 0);
    clock.anchor(snapshot({ positionMs: 2_000 }), 1_000);
    expect(clock.position(2_000)).toBe(3_000);
    clock.anchor(snapshot({ positionMs: 80_000 }), 2_000);
    expect(clock.position(2_500)).toBe(80_500);
    clock.anchor(snapshot({ positionMs: 0, generation: 2 }), 3_000);
    expect(clock.position(3_000)).toBe(0);
  });

  it("applies positive offset earlier and negative offset later, including the first line", () => {
    const clock = new PlaybackClock();
    clock.anchor(snapshot({ visualOffsetMs: 500 }), 0);
    expect(clock.displayPosition(1_500)).toBe(2_000);
    expect(activeLineIndex(snapshot().lyrics.lines, clock.displayPosition(1_500))).toBe(1);
    clock.anchor(snapshot({ visualOffsetMs: -500 }), 0);
    expect(clock.displayPosition(0)).toBe(-500);
    expect(activeLineIndex(snapshot().lyrics.lines, clock.displayPosition(0))).toBe(-1);
  });

  it("honors zero speed, clamps duration, and does not rewind on freeze", () => {
    const clock = new PlaybackClock();
    clock.anchor(snapshot({ positionMs: 1_000, speed: 0 }), 0);
    expect(clock.position(3_000)).toBe(1_000);
    clock.anchor(snapshot({ positionMs: 119_000 }), 0);
    expect(clock.position(5_000)).toBe(120_000);
    clock.freeze(5_000);
    expect(clock.position(50_000)).toBe(120_000);
    clock.anchor(snapshot({ connection: "stale", positionMs: 4_000 }), 0);
    expect(clock.position(5_000)).toBe(4_000);
  });

  it("finds boundary timestamps, duplicate timestamps, intro, and empty lyrics", () => {
    expect(activeLineIndex([], 0)).toBe(-1);
    expect(activeLineIndex([{ timeMs: 1_000 }], 999)).toBe(-1);
    expect(activeLineIndex([{ timeMs: 1_000 }, { timeMs: 1_000 }], 1_000)).toBe(1);
  });
});

describe("lyrics rendering", () => {
  it("accepts external player snapshots and explains missing exact identity without showing old lyrics", () => {
    const external = snapshotSchema.parse(snapshot({
      precision: "ma-player", speed: 0,
      lyrics: { status: "unsupported", lines: [], plain: null, message: "Music Assistant does not yet support lyrics via Connect." },
    }));
    render(<LyricsStage snapshot={external} displayPositionMs={0} stale={false} cleared={false} />);
    expect(screen.getByText("Lyrics unavailable")).toBeInTheDocument();
    expect(screen.getByText("Music Assistant does not yet support lyrics via Connect.")).toBeInTheDocument();
    expect(screen.queryByText("First line")).not.toBeInTheDocument();
  });
  it("marks the current timed line and retains its neighbors", () => {
    render(<LyricsStage snapshot={snapshot()} displayPositionMs={2_000} stale={false} cleared={false} />);
    expect(screen.getByText("Second line")).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("First line")).not.toHaveAttribute("aria-current");
    expect(screen.getByText("Third line")).toBeInTheDocument();
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
  });

  it("shows plain lyrics as unsynced, preserving text without interpreting markup", () => {
    render(<LyricsStage snapshot={snapshot({
      lyrics: { status: "plain", lines: [], plain: "<img src=x onerror=alert(1)>\nAnother line", message: null },
    })} displayPositionMs={0} stale={false} cleared={false} />);
    expect(screen.getByLabelText("Unsynced lyrics")).toHaveAttribute("tabindex", "0");
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[aria-current]")).toBeNull();
  });

  it.each([
    ["missing", "Just the music, for now"],
    ["loading", "Finding the words"],
    ["error", "Lyrics couldn’t load"],
    ["unsupported", "Lyrics unavailable"],
  ] as const)("distinguishes the %s state", (status, heading) => {
    render(<LyricsStage snapshot={snapshot({
      lyrics: { status, lines: [], plain: null, message: null },
    })} displayPositionMs={0} stale={false} cleared={false} />);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  });

  it("shows an explicit clear state instead of old lyrics", () => {
    render(<LyricsStage snapshot={snapshot()} displayPositionMs={0} stale cleared />);
    expect(screen.getByRole("heading", { name: "Waiting to reconnect" })).toBeInTheDocument();
    expect(screen.queryByText("First line")).not.toBeInTheDocument();
  });
});

describe("live display and local controls", () => {
  it.each(["now-playing", "lyrics", "split", "ambient"] as const)("removes visible branding but retains navigation in %s", async (viewMode) => {
    await mount(snapshot({ viewMode }));
    expect(document.querySelector(".wordmark, .brand-mark, .wordmark-detail")).toBeNull();
    expect(screen.queryByText(/^sendspin$/i)).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Display view" })).toBeInTheDocument();
    expect(screen.getByText("Display settings")).toBeInTheDocument();
  });

  it("saves instant follow from the admin UI and waits for server confirmation without changing timing", async () => {
    const initial = snapshot({ visualOffsetMs: 500 });
    const fetcher = await mount(initial);
    fireEvent.click(screen.getByText("Display settings"));
    const instant = screen.getByRole("button", { name: "Instant (low-cost)" });
    expect(instant).toHaveAttribute("aria-pressed", "false");
    await act(async () => fireEvent.click(instant));
    expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
      body: JSON.stringify({ lyricFollowMode: "instant" }),
      headers: expect.objectContaining({ "X-CSRF-Token": "test-local-token" }),
    }));
    expect(instant).toHaveAttribute("aria-pressed", "false");
    act(() => FakeEventSource.latest().send(snapshot({ visualOffsetMs: 500, lyricFollowMode: "instant" })));
    expect(instant).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Visual offset")).toHaveTextContent("+500 ms");
  });

  it("does not pretend a failed follow setting save succeeded", async () => {
    const fetcher = await mount();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input) => input === "/api/settings"
      ? response({ error: "Settings could not be saved." }, 500) : original(input));
    fireEvent.click(screen.getByText("Display settings"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Instant (low-cost)" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Settings could not be saved.");
    expect(screen.getByRole("button", { name: "Smooth" })).toHaveAttribute("aria-pressed", "true");
  });
  it("advances timed lines, pauses, seeks, and reanchors incoming offsets", async () => {
    await mount();
    act(() => vi.advanceTimersByTime(2_100));
    expect(screen.getByText("Second line")).toHaveAttribute("aria-current", "true");
    act(() => FakeEventSource.latest().send(snapshot({ positionMs: 2_100, playback: "paused", speed: 0 })));
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText("Second line")).toHaveAttribute("aria-current", "true");
    act(() => FakeEventSource.latest().send(snapshot({ positionMs: 0, visualOffsetMs: 4_000 })));
    expect(screen.getByText("Third line")).toHaveAttribute("aria-current", "true");
  });

  it("freezes after five seconds without data, clears at twenty, and recovers", async () => {
    await mount();
    act(() => vi.advanceTimersByTime(5_100));
    expect(screen.getByText("Connection stale")).toBeInTheDocument();
    expect(screen.getByText("Lyrics frozen")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "5000");
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "5000");
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("heading", { name: "Waiting to reconnect" })).toBeInTheDocument();
    expect(screen.queryByText("The open road")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_000));
    expect(FakeEventSource.latest().close).not.toHaveBeenCalled();
    act(() => FakeEventSource.latest().send(snapshot({ positionMs: 2_000 })));
    expect(screen.getByText("Second line")).toHaveAttribute("aria-current", "true");
    expect(screen.queryByText("Connection stale")).not.toBeInTheDocument();
  });

  it("freezes immediately on SSE error and retries with a new EventSource", async () => {
    await mount();
    act(() => vi.advanceTimersByTime(1_000));
    const first = FakeEventSource.latest();
    act(() => first.onerror?.());
    expect(first.close).toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_200));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.latest().close).not.toHaveBeenCalled();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1000");
    act(() => FakeEventSource.latest().send(snapshot({ positionMs: 4_000 })));
    expect(screen.getByText("Third line")).toHaveAttribute("aria-current", "true");
  });

  it("rejects malformed snapshots while retaining the last valid frozen frame", async () => {
    await mount();
    act(() => FakeEventSource.latest().send({ ...snapshot(), speed: 99 }));
    expect(screen.getByText("Connection stale")).toBeInTheDocument();
    expect(screen.getByText(/invalid update/)).toBeInTheDocument();
    expect(screen.getByText("The open road")).toBeInTheDocument();
  });

  it("rejects old-track, duplicate, and older-generation snapshots on the same stream", async () => {
    await mount(snapshot({ sequence: 10, generation: 2 }));
    const current = snapshot({
      sequence: 20, generation: 3, positionMs: 4_000,
      track: { ...snapshot().track!, identity: "song-2", title: "The new song" },
    });
    act(() => FakeEventSource.latest().send(current));
    act(() => FakeEventSource.latest().send(snapshot({ sequence: 19, generation: 2, positionMs: 0 })));
    act(() => FakeEventSource.latest().send({ ...current, positionMs: 0 }));
    act(() => FakeEventSource.latest().send(snapshot({ sequence: 21, generation: 2, positionMs: 0 })));
    expect(screen.getByText("The new song")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4000");
    // A newer snapshot within the current generation can represent a real seek.
    act(() => FakeEventSource.latest().send({ ...current, sequence: 22, positionMs: 0 }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("accepts reset counters after reconnect but ignores callbacks from the closed stream", async () => {
    await mount(snapshot({ sequence: 100, generation: 10 }));
    const oldStream = FakeEventSource.latest();
    act(() => oldStream.onerror?.());
    act(() => vi.advanceTimersByTime(750));
    act(() => FakeEventSource.latest().send(snapshot({ sequence: 1, generation: 0, positionMs: 4_000 })));
    act(() => oldStream.send(snapshot({ sequence: 101, generation: 11, positionMs: 0 })));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4000");
    expect(screen.queryByText("Connection stale")).not.toBeInTheDocument();
  });

  it("keeps upstream zero-speed stale snapshots frozen while state events continue", async () => {
    await mount();
    act(() => FakeEventSource.latest().send(snapshot({ connection: "stale", positionMs: 2_000, speed: 0 })));
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2000");
    act(() => FakeEventSource.latest().send(snapshot({ connection: "stale", positionMs: 2_000, speed: 0 })));
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2000");
    expect(screen.getByText("Connection stale")).toBeInTheDocument();
  });

  it("does not let an old HTTP snapshot replace a newer SSE update", async () => {
    let resolveState: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveState = resolve; })));
    render(<App />);
    act(() => FakeEventSource.latest().send(snapshot({ positionMs: 4_000 })));
    await act(async () => resolveState(response(snapshot())));
    expect(screen.getByText("Third line")).toHaveAttribute("aria-current", "true");
  });

  it("refreshes authorization before each deliberate mutation without replay after a backend restart", async () => {
    const fetcher = await mount();
    let epoch = 1;
    const sentTokens: (string | null)[] = [];
    fetcher.mockImplementation(async (input, init?: RequestInit) => {
      if (input === "/api/session") return response({ csrfToken: `epoch-${epoch}` });
      const token = new Headers(init?.headers).get("X-CSRF-Token");
      sentTokens.push(token);
      return token === `epoch-${epoch}` ? response({ ok: true }) : response({ error: "Stale session" }, 403);
    });
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Now Playing" })));
    epoch++;
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Lyrics" })));
    expect(sentTokens).toEqual(["epoch-1", "epoch-2"]);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/settings")).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("saves timing through the CSRF-protected local endpoint", async () => {
    const fetcher = await mount();
    fireEvent.click(screen.getByText("Display settings"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show lyrics 100 milliseconds earlier" })));
    expect(fetcher).toHaveBeenCalledWith("/api/session", expect.objectContaining({ credentials: "same-origin" }));
    expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
      method: "POST", body: JSON.stringify({ visualOffsetMs: 100 }),
      headers: expect.objectContaining({ "X-CSRF-Token": "test-local-token" }),
    }));
    expect(screen.getByText("Timing offset saved.")).toBeInTheDocument();
  });

  it.each([
    [29_900, "Show lyrics 100 milliseconds earlier", 30_000],
    [-29_900, "Show lyrics 100 milliseconds later", -30_000],
  ] as const)("supports offsets out to the backend limit from %i ms", async (initial, button, expected) => {
    const fetcher = await mount(snapshot({ visualOffsetMs: initial }));
    fireEvent.click(screen.getByText("Display settings"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: button })));
    expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
      body: JSON.stringify({ visualOffsetMs: expected }),
    }));
    act(() => FakeEventSource.latest().send(snapshot({ visualOffsetMs: expected })));
    expect(screen.getByRole("button", { name: button })).toBeDisabled();
  });

  it("only shows playback controls for demo mode and sends real demo actions", async () => {
    const fetcher = await mount(snapshot({ demo: true, precision: "demo" }));
    expect(screen.getByText("Demo mode · no audio")).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pause demo" })));
    expect(fetcher).toHaveBeenCalledWith("/api/demo", expect.objectContaining({
      body: JSON.stringify({ action: "pause" }),
    }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "+10 sec" })));
    expect(fetcher).toHaveBeenCalledWith("/api/demo", expect.objectContaining({
      body: JSON.stringify({ action: "seek", positionMs: 10_000 }),
    }));
  });

  it("does not expose Music Assistant playback mutations or CEC when off", async () => {
    await mount();
    expect(screen.queryByRole("button", { name: /demo/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Display settings"));
    expect(screen.queryByRole("button", { name: "Wake TV" })).not.toBeInTheDocument();
    expect(screen.getByText("HDMI-CEC is disabled.")).toBeInTheDocument();
  });

  it("requires explicit standby confirmation and displays CEC failures", async () => {
    const fetcher = await mount(snapshot({
      cec: { enabled: true, available: true, owned: true, message: "HDMI-CEC available." },
    }));
    fireEvent.click(screen.getByText("Display settings"));
    fireEvent.click(screen.getByRole("button", { name: "TV standby…" }));
    expect(fetcher).not.toHaveBeenCalledWith("/api/cec", expect.anything());
    fetcher.mockImplementation(async (input) => input === "/api/session"
      ? response({ csrfToken: "test-local-token" }) : response({ error: "TV did not respond." }, 502));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm standby" })));
    expect(fetcher).toHaveBeenCalledWith("/api/cec", expect.objectContaining({
      body: JSON.stringify({ command: "standby" }),
    }));
    expect(screen.getByRole("alert")).toHaveTextContent("TV did not respond.");
  });

  it("never sends automatic CEC on startup or playback and disables unowned standby", async () => {
    const state = snapshot({
      cec: { enabled: true, available: true, owned: false, message: "Adapter available." },
    });
    const fetcher = await mount(state);
    act(() => FakeEventSource.latest().send({ ...state, playback: "paused", speed: 0 }));
    act(() => FakeEventSource.latest().send(state));
    fireEvent.click(screen.getByText("Display settings"));
    expect(screen.getByRole("button", { name: "TV standby…" })).toBeDisabled();
    expect(screen.getByText(/cannot verify active-source ownership/)).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalledWith("/api/cec", expect.anything());
  });

  it("allows the first CEC probe and retries despite adapter unavailability and stale MA", async () => {
    const fetcher = await mount(snapshot({
      connection: "stale", speed: 0,
      cec: { enabled: true, available: false, owned: false, message: "Not probed yet." },
    }));
    fireEvent.click(screen.getByText("Display settings"));
    expect(screen.getByRole("button", { name: "Wake TV" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Use this input" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "TV standby…" })).toBeDisabled();
    fetcher.mockImplementation(async (input) => input === "/api/session"
      ? response({ csrfToken: "test-local-token" })
      : response({ enabled: true, available: false, owned: false, message: "Adapter unplugged." }, 503));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Wake TV" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Adapter unplugged.");
    expect(screen.getByRole("button", { name: "Wake TV" })).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use this input" })));
    expect(fetcher).toHaveBeenCalledWith("/api/cec", expect.objectContaining({
      body: JSON.stringify({ command: "active-source" }),
    }));
    act(() => FakeEventSource.latest().onerror?.());
    expect(screen.getByRole("button", { name: "Wake TV" })).toBeDisabled();
  });

  it("retains local TV settings after clearing stale track and lyrics", async () => {
    const staleSnapshot = () => snapshot({
      connection: "stale", speed: 0,
      cec: { enabled: true, available: false, owned: false, message: "Not probed yet." },
    });
    await mount(staleSnapshot());
    fireEvent.click(screen.getByText("Display settings"));
    for (let second = 0; second < 21; second += 1) {
      act(() => {
        vi.advanceTimersByTime(1_000);
        FakeEventSource.latest().send(staleSnapshot());
      });
    }
    expect(screen.getByRole("heading", { name: "Waiting to reconnect" })).toBeInTheDocument();
    expect(screen.queryByText("The open road")).not.toBeInTheDocument();
    expect(screen.queryByText("First line")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wake TV" })).toBeEnabled();
  });

  it("waits longer than the backend twelve-second CEC timeout", async () => {
    const fetcher = await mount(snapshot({
      cec: { enabled: true, available: false, owned: false, message: "Not probed yet." },
    }));
    let commandSignal: AbortSignal | null | undefined;
    fetcher.mockImplementation(async (input, init?: RequestInit) => {
      if (input === "/api/session") return response({ csrfToken: "test-local-token" });
      commandSignal = init?.signal;
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(response({ message: "CEC adapter timed out." }, 503)), 12_000);
      });
    });
    fireEvent.click(screen.getByText("Display settings"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Wake TV" })));
    await act(async () => vi.advanceTimersByTime(12_000));
    expect(commandSignal?.aborted).toBe(false);
    expect(screen.getByRole("alert")).toHaveTextContent("CEC adapter timed out.");
  });

  it("handles missing fullscreen support accessibly", async () => {
    await mount();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Fullscreen" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Fullscreen is unavailable");
  });

  it("displays the backend CEC message for unavailable commands and successful responses", async () => {
    const fetcher = await mount(snapshot({
      cec: { enabled: true, available: true, owned: false, message: "HDMI-CEC available." },
    }));
    fireEvent.click(screen.getByText("Display settings"));
    fetcher.mockImplementation(async (input) => input === "/api/session"
      ? response({ csrfToken: "test-local-token" })
      : response({ enabled: true, available: false, owned: false, message: "libCEC adapter unavailable." }, 503));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Wake TV" })));
    expect(screen.getByRole("alert")).toHaveTextContent("libCEC adapter unavailable.");
    fetcher.mockImplementation(async (input) => input === "/api/session"
      ? response({ csrfToken: "test-local-token" }) : response({
      enabled: true, available: true, owned: true, message: "TV wake command completed.",
    }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Wake TV" })));
    expect(screen.getByText("TV wake command completed.")).toBeInTheDocument();
  });

  it("renders progress without inline styles under the local service CSP", async () => {
    await mount(snapshot({ positionMs: 30_000 }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "30000");
    expect(screen.getByRole("progressbar")).toHaveAttribute("max", "120000");
    expect(document.querySelector("[style]")).toBeNull();
    expect(screen.getByText("Approximate queue-event sync")).toBeInTheDocument();
  });

  it("supports timing shortcuts and closes settings from a focused control", async () => {
    const fetcher = await mount();
    await act(async () => fireEvent.keyDown(window, { key: "]" }));
    expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
      body: JSON.stringify({ visualOffsetMs: 100 }),
    }));
    const summary = screen.getByText("Display settings");
    fireEvent.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    fireEvent.keyDown(screen.getByRole("button", { name: "Reset offset" }), { key: "Escape" });
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });

  it("times out unresponsive commands and makes controls available again", async () => {
    const fetcher = await mount();
    fetcher.mockImplementation((_input, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
    }));
    fireEvent.click(screen.getByText("Display settings"));
    fireEvent.click(screen.getByRole("button", { name: "Show lyrics 100 milliseconds earlier" }));
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(screen.getByRole("alert")).toHaveTextContent("took too long");
    act(() => FakeEventSource.latest().send(snapshot()));
    expect(screen.getByRole("button", { name: "Show lyrics 100 milliseconds earlier" })).toBeEnabled();
  });

  it("closes the stream and timers on unmount", async () => {
    await mount();
    const source = FakeEventSource.latest();
    cleanup();
    expect(source.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("snapshot and asset validation", () => {
  it("defaults older snapshots to split and rejects unknown display modes", () => {
    const { viewMode: _viewMode, ...legacy } = snapshot();
    expect(snapshotSchema.parse(legacy).viewMode).toBe("split");
    expect(snapshotSchema.safeParse({ ...legacy, viewMode: "gallery" }).success).toBe(false);
  });
  it("defaults snapshots without follow settings to smooth and rejects invalid follow values", () => {
    const { lyricFollowMode: _follow, ...legacy } = snapshot();
    expect(snapshotSchema.parse(legacy).lyricFollowMode).toBe("smooth");
    expect(snapshotSchema.parse({ ...legacy, lyricFollowMode: "instant" }).lyricFollowMode).toBe("instant");
    for (const lyricFollowMode of ["auto", null, true]) {
      expect(snapshotSchema.safeParse({ ...legacy, lyricFollowMode }).success).toBe(false);
    }
  });
  it("accepts valid plain lyrics beyond 100k characters without marking the stream stale", async () => {
    const plain = "a".repeat(100_001);
    await mount(snapshot({
      lyrics: { status: "plain", lines: [], plain, message: null },
    }));
    expect(screen.getByLabelText("Unsynced lyrics")).toHaveTextContent(plain);
    expect(screen.queryByText("Connection stale")).not.toBeInTheDocument();
  });

  describe("TV-first listening views", () => {
    it.each([
      ["now-playing", "Now Playing", false],
      ["lyrics", "Lyrics", true],
      ["split", "Split", true],
    ] as const)("renders persisted %s mode with the right content", async (viewMode, label, lyricsVisible) => {
      await mount(snapshot({ viewMode }));
      expect(screen.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("heading", { name: "The open road" })).toBeInTheDocument();
      expect(Boolean(screen.queryByText("First line"))).toBe(lyricsVisible);
      expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", `tab-${viewMode}`);
    });

    it("saves view selection with CSRF and renders the server-confirmed selection", async () => {
      const fetcher = await mount();
      await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Now Playing" })));
      expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
        method: "POST", body: JSON.stringify({ viewMode: "now-playing" }),
        headers: expect.objectContaining({ "X-CSRF-Token": "test-local-token" }),
      }));
      expect(screen.getByRole("tab", { name: "Split" })).toHaveAttribute("aria-selected", "true");
      act(() => FakeEventSource.latest().send(snapshot({ viewMode: "now-playing" })));
      expect(screen.getByRole("tab", { name: "Now Playing" })).toHaveAttribute("aria-selected", "true");
      expect(screen.queryByText("First line")).not.toBeInTheDocument();
      expect(screen.getByText("Display view saved.")).toBeInTheDocument();
    });

    it("preserves the previous view and surfaces failed persistence", async () => {
      const fetcher = await mount();
      fetcher.mockImplementation(async (input) => input === "/api/session"
        ? response({ csrfToken: "test-local-token" }) : response({ error: "Settings could not be saved." }, 500));
      await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Lyrics" })));
      expect(screen.getByRole("tab", { name: "Split" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("alert")).toHaveTextContent("Settings could not be saved.");
    });

    it("keeps remote tab focus while saving and never steals focus after completion", async () => {
      const fetcher = await mount();
      let finish: (value: Response) => void = () => {};
      fetcher.mockImplementation(async (input) => input === "/api/session"
        ? response({ csrfToken: "test-local-token" })
        : new Promise<Response>((resolve) => { finish = resolve; }));
      const lyrics = screen.getByRole("tab", { name: "Lyrics" });
      lyrics.focus();
      await act(async () => fireEvent.click(lyrics));
      expect(lyrics).toHaveFocus();
      expect(lyrics).toBeEnabled();
      expect(lyrics).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("tablist")).toHaveAttribute("aria-busy", "true");
      await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Now Playing" })));
      expect(fetcher.mock.calls.filter(([path]) => path === "/api/settings")).toHaveLength(1);
      const fullscreen = screen.getByRole("button", { name: "Fullscreen" });
      fullscreen.focus();
      await act(async () => finish(response({ viewMode: "lyrics", visualOffsetMs: 0 })));
      act(() => FakeEventSource.latest().send(snapshot({ viewMode: "lyrics" })));
      expect(fullscreen).toHaveFocus();
      expect(lyrics).toHaveAttribute("aria-disabled", "false");
    });

    it("retains the selected view for missing lyrics and server reconnects", async () => {
      await mount(snapshot({ sequence: 100, viewMode: "lyrics",
        lyrics: { status: "missing", lines: [], plain: null, message: null } }));
      expect(screen.getByRole("heading", { name: "Just the music, for now" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Lyrics" })).toHaveAttribute("aria-selected", "true");
      act(() => FakeEventSource.latest().onerror?.());
      act(() => vi.advanceTimersByTime(750));
      act(() => FakeEventSource.latest().send(snapshot({ sequence: 1, viewMode: "now-playing" })));
      expect(screen.getByRole("tab", { name: "Now Playing" })).toHaveAttribute("aria-selected", "true");
    });

    it("remounts artwork across identities and ignores late errors from the old cover", async () => {
      const initial = snapshot();
      const track = { ...initial.track!, artworkUrl: "/api/artwork/first" };
      await mount({ ...initial, track });
      const oldImage = screen.getByRole("img", { name: "Cover art for Local sessions" });
      act(() => FakeEventSource.latest().send(snapshot({
        generation: 2, track: { ...track, identity: "song-2", title: "New song", album: "Second album", artworkUrl: "/api/artwork/second" },
      })));
      const image = screen.getByRole("img", { name: "Cover art for Second album" });
      expect(image).not.toBe(oldImage);
      expect(image).toHaveAttribute("src", "/api/artwork/second");
      fireEvent.error(oldImage);
      fireEvent.load(oldImage);
      expect(screen.getByRole("img", { name: "Cover art for Second album" })).toBe(image);
      fireEvent.error(image);
      expect(screen.queryByAltText("Cover art for Second album")).not.toBeInTheDocument();
      expect(screen.getByRole("img", { name: "No cover art for New song" })).toBeInTheDocument();
      act(() => FakeEventSource.latest().send(snapshot({
        generation: 3, track: { ...track, identity: "song-3", artworkUrl: "/api/artwork/third" },
      })));
      expect(screen.getByRole("img", { name: "Cover art for Local sessions" })).toHaveAttribute("src", "/api/artwork/third");
    });

    it("remounts a changed URL within one identity and immediately removes art for a no-art song", async () => {
      const track = { ...snapshot().track!, artworkUrl: "/api/artwork/first?v=1" };
      await mount(snapshot({ track }));
      const oldImage = screen.getByAltText("Cover art for Local sessions");
      fireEvent.error(oldImage);
      act(() => FakeEventSource.latest().send(snapshot({ track: { ...track, artworkUrl: "/api/artwork/first?v=2" } })));
      expect(screen.getByAltText("Cover art for Local sessions")).toHaveAttribute("src", "/api/artwork/first?v=2");
      act(() => FakeEventSource.latest().send(snapshot({ generation: 2, track: { ...track, identity: "without-art", artworkUrl: null } })));
      expect(document.querySelector("img")).toBeNull();
      expect(screen.getByRole("img", { name: "No cover art for The open road" })).toBeInTheDocument();
      fireEvent.load(oldImage);
      expect(document.querySelector("img")).toBeNull();
    });

    it("keeps Unicode metadata complete and treats strings as text", async () => {
      const title = "夜の歌 — النور في الطريق — A long title about finding our way home together ".repeat(3);
      await mount(snapshot({ track: { ...snapshot().track!, title, artist: "Björk & 宇多田ヒカル", album: "<script>not executable</script>" } }));
      expect(screen.getByRole("heading", { name: title.trim() })).toHaveTextContent(title.trim());
      expect(screen.getByText("Björk & 宇多田ヒカル")).toBeInTheDocument();
      expect(screen.getByText("<script>not executable</script>")).toBeInTheDocument();
      expect(document.querySelector("script")).toBeNull();
      const metadata = screen.getByRole("region", { name: "Current song" });
      expect(metadata).toHaveAttribute("tabindex", "0");
      metadata.focus();
      const scrollEvent = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      fireEvent(metadata, scrollEvent);
      expect(scrollEvent.defaultPrevented).toBe(true);
      expect(metadata.scrollTop).toBeGreaterThan(0);
      expect(metadata).toHaveFocus();
    });

    it("keeps all metadata keyboard-reachable and lets directional remotes leave reading panes", async () => {
      await mount(snapshot({ lyrics: { status: "plain", lines: [], plain: "Original synthetic lines", message: null } }));
      const metadata = screen.getByRole("region", { name: "Current song" });
      expect(metadata).toHaveAttribute("tabindex", "0");
      metadata.focus();
      fireEvent.keyDown(metadata, { key: "ArrowRight" });
      const plain = screen.getByLabelText("Unsynced lyrics");
      expect(plain).toHaveFocus();
      fireEvent.keyDown(plain, { key: "ArrowLeft" });
      expect(metadata).toHaveFocus();
      fireEvent.keyDown(metadata, { key: "ArrowLeft" });
      expect(screen.getByRole("tab", { name: "Line-in album" })).toHaveFocus();
    });

    it("shows elapsed, remaining, and paused status without advancing", async () => {
      await mount(snapshot({ viewMode: "now-playing", positionMs: 30_000, playback: "paused", speed: 0 }));
      expect(screen.getByText("Paused")).toBeInTheDocument();
      expect(screen.getByText("0:30")).toBeInTheDocument();
      expect(screen.getByLabelText("1:30 remaining")).toHaveTextContent("−1:30");
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "0:30 of 2:00");
      act(() => vi.advanceTimersByTime(2_000));
      expect(screen.getByRole("progressbar")).toHaveAttribute("value", "30000");
      expect(screen.getByLabelText("1:30 remaining")).toBeInTheDocument();
      expect(document.querySelector("[style]")).toBeNull();
    });

    it("clears old metadata and artwork without leaving Now Playing on reconnect", async () => {
      await mount(snapshot({ viewMode: "now-playing", track: { ...snapshot().track!, artworkUrl: "/api/artwork/old" } }));
      act(() => vi.advanceTimersByTime(20_100));
      expect(screen.getByRole("heading", { name: "Waiting to reconnect" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Now Playing" })).toHaveAttribute("aria-selected", "true");
      expect(document.querySelector("img")).toBeNull();
      expect(screen.queryByText("The open road")).not.toBeInTheDocument();
      expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
    });

    it("moves tab focus with remote arrows without changing selection until activation", async () => {
      const fetcher = await mount();
      const split = screen.getByRole("tab", { name: "Split" });
      split.focus();
      fireEvent.keyDown(split, { key: "ArrowLeft" });
      const lyrics = screen.getByRole("tab", { name: "Lyrics" });
      expect(lyrics).toHaveFocus();
      expect(split).toHaveAttribute("aria-selected", "true");
      expect(fetcher).not.toHaveBeenCalledWith("/api/settings", expect.anything());
      await act(async () => fireEvent.click(lyrics));
      expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
        body: JSON.stringify({ viewMode: "lyrics" }),
      }));
      act(() => FakeEventSource.latest().send(snapshot({ viewMode: "lyrics" })));
      fireEvent.keyDown(lyrics, { key: "ArrowDown" });
      expect(screen.getByRole("tab", { name: "Split" })).toHaveFocus();
    });

    it("supports numeric view shortcuts but leaves editable controls and plain lyrics alone", async () => {
      const fetcher = await mount(snapshot({ lyrics: { status: "plain", lines: [], plain: "One\nTwo\nThree", message: null } }));
      const plain = screen.getByLabelText("Unsynced lyrics");
      plain.focus();
      const scrollEvent = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      fireEvent(plain, scrollEvent);
      expect(scrollEvent.defaultPrevented).toBe(true);
      expect(plain.scrollTop).toBeGreaterThan(0);
      expect(plain).toHaveFocus();
      await act(async () => fireEvent.keyDown(plain, { key: "1" }));
      expect(fetcher).not.toHaveBeenCalledWith("/api/settings", expect.anything());
      const input = document.createElement("input");
      document.body.append(input);
      await act(async () => fireEvent.keyDown(input, { key: "1" }));
      expect(fetcher).not.toHaveBeenCalledWith("/api/settings", expect.anything());
      input.remove();
      await act(async () => fireEvent.keyDown(window, { key: "1" }));
      expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
        body: JSON.stringify({ viewMode: "now-playing" }),
      }));
    });

    it("uses instant lyric scrolling for reduced motion and smooth scrolling otherwise", () => {
      const query = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
      vi.stubGlobal("matchMedia", vi.fn(() => query));
      const state = snapshot();
      const { rerender } = render(<LyricsStage snapshot={state} displayPositionMs={0} stale={false} cleared={false} />);
      expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "instant" }));
      query.matches = false;
      act(() => query.addEventListener.mock.calls[0]![1]());
      rerender(<LyricsStage snapshot={state} displayPositionMs={2_000} stale={false} cleared={false} />);
      expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "smooth" }));
    });
  });

  it("aligns lyric limits with 256 KiB strings and 4000 timed lines", () => {
    const state = snapshot({
      lyrics: { status: "plain", lines: [], plain: "a".repeat(256 * 1024), message: null },
    });
    expect(snapshotSchema.safeParse(state).success).toBe(true);
    expect(snapshotSchema.safeParse({
      ...state, lyrics: { ...state.lyrics, plain: `${state.lyrics.plain}a` },
    }).success).toBe(false);
    const lines = Array.from({ length: 4_000 }, (_, timeMs) => ({ timeMs, text: "line" }));
    expect(snapshotSchema.safeParse({
      ...state, lyrics: { ...state.lyrics, status: "timed", plain: null, lines },
    }).success).toBe(true);
    expect(snapshotSchema.safeParse({
      ...state, lyrics: { ...state.lyrics, status: "timed", plain: null, lines: [...lines, { timeMs: 4_000, text: "extra" }] },
    }).success).toBe(false);
  });

  it("rejects invalid clocks and unsorted lyrics", () => {
    expect(snapshotSchema.safeParse(snapshot({ positionMs: Infinity })).success).toBe(false);
    expect(snapshotSchema.safeParse(snapshot({ positionMs: -1 })).success).toBe(false);
    expect(snapshotSchema.safeParse(snapshot({
      lyrics: { status: "timed", lines: [{ timeMs: 2, text: "two" }, { timeMs: 1, text: "one" }], plain: null, message: null },
    })).success).toBe(false);
  });

  it("allows only same-origin local artwork paths", () => {
    expect(localArtworkUrl("/api/artwork/track?id=1")).toBe("/api/artwork/track?id=1");
    expect(localArtworkUrl("https://remote.example/cover.jpg")).toBeUndefined();
    expect(localArtworkUrl("//remote.example/cover.jpg")).toBeUndefined();
    expect(localArtworkUrl("/\\remote.example/cover.jpg")).toBeUndefined();
    expect(localArtworkUrl("javascript:alert(1)")).toBeUndefined();
  });
});
