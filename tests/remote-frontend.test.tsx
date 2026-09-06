// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_BACKGROUNDS, DEFAULT_AMBIENT } from "../src/shared/ambient.js";
import { emptyLyrics, type Snapshot } from "../src/shared/protocol.js";
import type { RemoteKey } from "../src/shared/remote.js";
import { App } from "../src/web/App.js";
import { navigate, navigationVisible, useNavigationAdjustment } from "../src/web/navigation.js";
import { REMOTE_BUFFER_LIMIT, REMOTE_EVENT_LIMIT, RemoteEventConsumer, remoteInputSchema } from "../src/web/remoteEvents.js";
import { isExplicitKiosk, useRemoteNavigation } from "../src/web/useRemoteNavigation.js";
import { snapshotSchema } from "../src/web/schema.js";

const epoch = "11111111-1111-4111-8111-111111111111";
const otherEpoch = "22222222-2222-4222-8222-222222222222";
const pageId = "33333333-3333-4333-8333-333333333333";
const encoder = new TextEncoder();
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const keyData = (sequence = 1, key: RemoteKey = "right", patch = {}) => ({
  epoch, sequence, key, repeat: false, at: Date.now(), ...patch,
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});

function streaming(signal?: AbortSignal | null) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const cancel = vi.fn(() => { closed = true; });
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel,
  });
  const end = () => { if (!closed) { closed = true; controller.close(); } };
  signal?.addEventListener("abort", end, { once: true });
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    send(event: string, value: unknown) { if (!closed) controller.enqueue(encoder.encode(frame(event, value))); },
    raw(value: string) { if (!closed) controller.enqueue(encoder.encode(value)); },
    end, cancel, signal,
    get closed() { return closed; },
  };
}

class StateEvents extends EventTarget {
  static all: StateEvents[] = [];
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() { super(); StateEvents.all.push(this); }
  send(snapshot: unknown) { this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(snapshot) })); }
  static get latest() { return StateEvents.all.at(-1)!; }
}

function snapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return {
    sequence: 1, generation: 1, demo: false, connection: "disconnected", playback: "idle",
    track: null, lyrics: emptyLyrics(), positionMs: 0, speed: 0, visualOffsetMs: 700,
    viewMode: "ambient", lyricFollowMode: "smooth", ambient: DEFAULT_AMBIENT, precision: "ma-queue", message: "No Music Assistant",
    cec: {
      enabled: true, available: true, owned: true, message: "CEC ready",
      remote: {
        enabled: true, listening: true, device: "auto", logicalAddress: 4, physicalAddress: 0x1000,
        lastEvent: null, kioskConnected: false,
      },
    }, ...patch,
  };
}

function service(initial = snapshot()) {
  let current = initial;
  const streams: ReturnType<typeof streaming>[] = [];
  let sessions = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (input === "/api/session") return json({ csrfToken: `token-${++sessions}` });
    if (input === "/api/kiosk/remote") {
      const stream = streaming(init?.signal);
      streams.push(stream);
      return stream.response;
    }
    if (input === "/api/kiosk/remote/renew") return json({ ok: true });
    if (input === "/api/state") return json(current);
    if (input === "/api/backgrounds") return json({
      images: [...BUILTIN_BACKGROUNDS, {
        id: "upload-12345678-1234-1234-1234-123456789abc", title: "Uploaded lake", source: "upload",
        url: "/api/backgrounds/image/upload-12345678-1234-1234-1234-123456789abc",
        width: 1920, height: 1080, bytes: 10000,
      }],
      limits: { maxUploadBytes: 12000000, maxImages: 40, maxStorageBytes: 256000000, maxPixels: 24000000 },
    });
    if (input === "/api/settings") {
      const patch = JSON.parse(init?.body as string);
      current = { ...current, ...patch, ambient: { ...current.ambient, ...patch.ambient }, sequence: current.sequence + 1 };
      StateEvents.latest.send(current);
      return json(current);
    }
    return json({ ok: true });
  });
  return { streams, fetcher, getState: () => current };
}

function visibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}

function chromeDisabledBlur(control: HTMLElement) {
  // jsdom also makes blur() a no-op on disabled controls, unlike Chrome's disable transition.
  control.removeAttribute("disabled");
  control.blur();
  control.setAttribute("disabled", "");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T20:00:00Z"));
  window.history.replaceState(null, "", "/");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  StateEvents.all = [];
  vi.stubGlobal("EventSource", StateEvents);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(async () => {
  await act(async () => cleanup());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("strict ephemeral input decoder", () => {
  it("accepts optional bounded routing diagnostics but rejects arbitrary fields and outcomes", () => {
    const state = snapshot();
    expect(snapshotSchema.safeParse(state).success).toBe(true);
    const route = {
      id: 1, opcode: 0x86, source: 0, target: 15, physicalAddress: 0x1000,
      decision: "matched", acknowledgement: "sent", at: Date.now(),
    };
    const withRoute = (patch = {}) => ({
      ...state, cec: { ...state.cec, remote: { ...state.cec.remote!, lastRouting: { ...route, ...patch } } },
    });
    expect(snapshotSchema.safeParse(withRoute()).success).toBe(true);
    for (const patch of [{ source: 16 }, { id: 0 }, { acknowledgement: "owned" }, { raw: "packet" }, { at: Infinity }]) {
      expect(snapshotSchema.safeParse(withRoute(patch)).success).toBe(false);
    }
  });

  it("shows actual Display routing diagnostics independently of the last navigation key", async () => {
    const initial = snapshot();
    const mock = service(initial);
    vi.stubGlobal("fetch", mock.fetcher);
    render(<App />);
    await act(async () => {});
    fireEvent.click(document.querySelector(".settings > summary")!);
    expect(screen.getByText(/Last routing event: none observed/)).toBeInTheDocument();
    expect(screen.getByText(/Last accepted navigation key: none/)).toBeInTheDocument();
    const lastRouting = {
      id: 1, opcode: 0x86, source: 5, target: 15, physicalAddress: 0x1000,
      decision: "wrong-source" as const, acknowledgement: "none" as const, at: Date.now(),
    };
    await act(async () => StateEvents.latest.send({
      ...initial, sequence: 2, cec: { ...initial.cec, remote: { ...initial.cec.remote!, lastRouting } },
    }));
    expect(screen.getByText(/Not from the TV \(logical 0\)/)).toBeInTheDocument();
    expect(screen.getByText(/Last accepted navigation key: none/)).toBeInTheDocument();
    await act(async () => StateEvents.latest.send({
      ...initial, sequence: 3, cec: { ...initial.cec, remote: {
        ...initial.cec.remote!, lastEvent: { key: "right", at: Date.now() },
        lastRouting: { ...lastRouting, id: 2, source: 0, decision: "matched", acknowledgement: "sent" },
      } },
    }));
    expect(screen.getByText(/Active Source acknowledgement: sent/)).toBeInTheDocument();
    expect(screen.getByText(/Last accepted navigation key: right/)).toBeInTheDocument();
    expect(screen.getByText(/does not prove TV routing or key forwarding/)).toBeInTheDocument();
    expect(mock.streams).toHaveLength(0);
  });

  it("requires ready, accepts split CRLF frames, and never interprets state snapshots as actions", () => {
    const action = vi.fn();
    const ready = vi.fn();
    const input = new RemoteEventConsumer(action, ready);
    input.push(encoder.encode(frame("key", keyData())));
    input.push(encoder.encode(frame("state", { ...snapshot(), key: "select" })));
    expect(action).not.toHaveBeenCalled();
    const bytes = encoder.encode(frame("ready", { epoch, sequence: 0 }).replaceAll("\n", "\r\n"));
    for (const byte of bytes) input.push(new Uint8Array([byte]));
    input.push(encoder.encode(frame("key", keyData())));
    expect(ready).toHaveBeenCalledExactlyOnceWith(epoch);
    expect(action).toHaveBeenCalledExactlyOnceWith({ key: "right", repeat: false });
  });

  it("deduplicates increasing sequences, enforces epoch and uses ping as a high-water mark", () => {
    const action = vi.fn();
    const input = new RemoteEventConsumer(action);
    input.push(encoder.encode(frame("ready", { epoch, sequence: 0 })));
    for (const data of [keyData(2), keyData(2), keyData(1), keyData(3, "select", { epoch: otherEpoch })]) {
      input.push(encoder.encode(frame("key", data)));
    }
    input.push(encoder.encode(frame("ping", { epoch, sequence: 5 })));
    input.push(encoder.encode(frame("key", keyData(5))));
    input.push(encoder.encode(frame("key", keyData(6, "left", { repeat: true }))));
    expect(action.mock.calls).toEqual([[{ key: "right", repeat: false }], [{ key: "left", repeat: true }]]);
  });

  it("drops stale/future events and repeated select/back without replaying their sequence", () => {
    const action = vi.fn();
    const input = new RemoteEventConsumer(action);
    input.push(encoder.encode(frame("ready", { epoch, sequence: 0 })));
    for (const data of [
      keyData(1, "down", { at: Date.now() - 2001 }), keyData(1), keyData(2, "up", { at: Date.now() + 2001 }),
      keyData(3, "select", { repeat: true }), keyData(4, "back", { repeat: true }), keyData(5, "down", { repeat: true }),
    ]) input.push(encoder.encode(frame("key", data)));
    expect(action).toHaveBeenCalledExactlyOnceWith({ key: "down", repeat: true });
  });

  it.each([
    { key: "power" }, { key: "Enter" }, { repeat: "false" }, { sequence: 0 }, { sequence: 1.2 },
    { epoch: "not-a-uuid" }, { at: Infinity }, { action: "select" },
  ])("rejects invalid input %j", (patch) => {
    expect(remoteInputSchema.safeParse(keyData(1, "right", patch)).success).toBe(false);
    const input = new RemoteEventConsumer(vi.fn());
    input.push(encoder.encode(frame("ready", { epoch, sequence: 0 })));
    expect(() => input.push(encoder.encode(frame("key", keyData(1, "right", patch))))).toThrow();
  });

  it("bounds partial events and chunks, rejects malformed data and in-stream epoch resets", () => {
    expect(() => new RemoteEventConsumer(vi.fn()).push(new Uint8Array(REMOTE_BUFFER_LIMIT + 1))).toThrow(/buffer/);
    const input = new RemoteEventConsumer(vi.fn());
    input.push(encoder.encode("data: "));
    expect(() => input.push(encoder.encode("x".repeat(REMOTE_EVENT_LIMIT)))).toThrow(/event exceeded/);
    expect(() => new RemoteEventConsumer(vi.fn()).push(encoder.encode("event: key\ndata: {\n\n"))).toThrow();
    const reset = new RemoteEventConsumer(vi.fn());
    reset.push(encoder.encode(frame("ready", { epoch, sequence: 0 })));
    expect(() => reset.push(encoder.encode(frame("ready", { epoch: otherEpoch, sequence: 0 })))).toThrow(/epoch reset/);
  });
});

describe("kiosk input lease lifecycle", () => {
  it("recognizes only the existing explicit kiosk URL and never registers an admin hook", async () => {
    expect(isExplicitKiosk("?kiosk=1")).toBe(true);
    for (const search of ["", "?mode=kiosk", "?kiosk=true", "?kiosk=0"]) expect(isExplicitKiosk(search)).toBe(false);
    const fetcher = vi.fn();
    const { result } = renderHook(() => useRemoteNavigation(false, vi.fn(), { fetch: fetcher }));
    await act(async () => {});
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current).toBe("disabled");
  });

  it("registers with CSRF, renews its epoch, updates callbacks without reconnecting, and aborts cleanly", async () => {
    const mock = service();
    const transport = { fetch: mock.fetcher, randomUUID: () => pageId };
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender, unmount } = renderHook(({ action }) => useRemoteNavigation(true, action, transport), {
      initialProps: { action: first },
    });
    await act(async () => {});
    expect(mock.fetcher).toHaveBeenCalledWith("/api/kiosk/remote", expect.objectContaining({
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": "token-1" },
      body: JSON.stringify({ pageId, role: "kiosk" }),
    }));
    await act(async () => mock.streams[0]!.send("ready", { epoch, sequence: 0 }));
    expect(result.current).toBe("connected");
    rerender({ action: second });
    await act(async () => mock.streams[0]!.send("key", keyData()));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith({ key: "right", repeat: false });
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(mock.fetcher).toHaveBeenCalledWith("/api/kiosk/remote/renew", expect.objectContaining({
      body: JSON.stringify({ pageId, epoch }), credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "token-1" },
    }));
    expect(mock.streams).toHaveLength(1);
    await act(async () => unmount());
    expect(mock.streams[0]!.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts hidden streams and in-flight renewal then re-registers without replay", async () => {
    const mock = service();
    const implementation = mock.fetcher.getMockImplementation()!;
    let renewSignal: AbortSignal | null | undefined;
    mock.fetcher.mockImplementation(async (path, init) => {
      if (path !== "/api/kiosk/remote/renew") return implementation(path, init);
      renewSignal = init?.signal;
      return new Promise((_resolve, reject) => renewSignal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const action = vi.fn();
    const transport = { fetch: mock.fetcher };
    const { result } = renderHook(() => useRemoteNavigation(true, action, transport));
    await act(async () => {});
    await act(async () => mock.streams[0]!.send("ready", { epoch, sequence: 0 }));
    await act(async () => vi.advanceTimersByTime(10_000));
    await act(async () => visibility("hidden"));
    expect(result.current).toBe("paused");
    expect(mock.streams[0]!.signal?.aborted).toBe(true);
    expect(renewSignal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(mock.streams).toHaveLength(1);
    await act(async () => visibility("visible"));
    expect(mock.streams).toHaveLength(2);
    await act(async () => {
      mock.streams[1]!.send("key", keyData());
      mock.streams[1]!.send("ready", { epoch: otherEpoch, sequence: 0 });
      mock.streams[1]!.send("key", keyData(1, "select", { epoch: otherEpoch }));
    });
    expect(action).toHaveBeenCalledExactlyOnceWith({ key: "select", repeat: false });
  });

  it("serializes StrictMode setup and rapid visibility changes to one consumer", async () => {
    const mock = service();
    const transport = { fetch: mock.fetcher };
    const { unmount } = renderHook(() => useRemoteNavigation(true, vi.fn(), transport), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    await act(async () => {});
    expect(mock.streams).toHaveLength(1);
    await act(async () => {
      visibility("hidden"); visibility("visible"); visibility("hidden"); visibility("visible");
    });
    expect(mock.streams.filter((stream) => !stream.closed)).toHaveLength(1);
    await act(async () => unmount());
    expect(mock.streams.every((stream) => stream.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not request a session while hidden and does not register after an aborted session response", async () => {
    visibility("hidden");
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn((_path: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { finish = resolve; }));
    const transport = { fetch: fetcher };
    const { result } = renderHook(() => useRemoteNavigation(true, vi.fn(), transport));
    await act(async () => {});
    expect(result.current).toBe("paused");
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => visibility("visible"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => visibility("hidden"));
    await act(async () => finish(json({ csrfToken: "late" })));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("creates a different page ID for each actual mount", async () => {
    const mock = service();
    const randomUUID = vi.fn().mockReturnValueOnce(pageId).mockReturnValueOnce(otherEpoch);
    const transport = { fetch: mock.fetcher, randomUUID };
    const first = renderHook(() => useRemoteNavigation(true, vi.fn(), transport));
    await act(async () => {});
    await act(async () => first.unmount());
    renderHook(() => useRemoteNavigation(true, vi.fn(), transport));
    await act(async () => {});
    const ids = mock.fetcher.mock.calls.filter(([path]) => path === "/api/kiosk/remote")
      .map(([, init]) => JSON.parse(init?.body as string).pageId);
    expect(ids).toEqual([pageId, otherEpoch]);
  });

  it("uses bounded exponential 409 backoff and fresh CSRF rather than stealing another tab's lease", async () => {
    let sessionCount = 0;
    const fetcher = vi.fn(async (path: RequestInfo | URL) => path === "/api/session"
      ? json({ csrfToken: `session-${++sessionCount}` }) : json({ error: "Occupied" }, 409));
    const transport = { fetch: fetcher, randomUUID: () => pageId };
    const { result } = renderHook(() => useRemoteNavigation(true, vi.fn(), transport));
    await act(async () => {});
    expect(result.current).toBe("waiting");
    for (const [index, delay] of [1000, 2000, 4000, 8000, 15000, 15000].entries()) {
      await act(async () => vi.advanceTimersByTime(delay - 1));
      expect(sessionCount).toBe(index + 1);
      await act(async () => vi.advanceTimersByTime(1));
      expect(sessionCount).toBe(index + 2);
    }
    const registrations = fetcher.mock.calls.filter(([path]) => path === "/api/kiosk/remote");
    expect(registrations).toHaveLength(7);
    expect(fetcher.mock.calls.every(([path]) => ["/api/session", "/api/kiosk/remote"].includes(String(path)))).toBe(true);
  });

  it("reconnects on EOF with a fresh epoch and ignores keys from the previous connection", async () => {
    const mock = service();
    const transport = { fetch: mock.fetcher };
    const action = vi.fn();
    renderHook(() => useRemoteNavigation(true, action, transport));
    await act(async () => {});
    await act(async () => {
      mock.streams[0]!.send("ready", { epoch, sequence: 0 });
      mock.streams[0]!.send("key", keyData(100));
    });
    await act(async () => mock.streams[0]!.end());
    await act(async () => vi.advanceTimersByTime(1000));
    expect(mock.streams).toHaveLength(2);
    await act(async () => {
      mock.streams[1]!.send("ready", { epoch: otherEpoch, sequence: 0 });
      mock.streams[1]!.send("key", keyData(101));
      mock.streams[1]!.send("key", keyData(1, "left", { epoch: otherEpoch }));
    });
    expect(action.mock.calls).toEqual([[{ key: "right", repeat: false }], [{ key: "left", repeat: false }]]);
    expect(mock.fetcher.mock.calls.filter(([path]) => path === "/api/session")).toHaveLength(2);
  });

  it("times out missing ready and reconnects after invalid frames or rejected renewal", async () => {
    const mock = service();
    const transport = { fetch: mock.fetcher };
    renderHook(() => useRemoteNavigation(true, vi.fn(), transport));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(mock.streams[0]!.signal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () => mock.streams[1]!.raw("event: key\ndata: invalid\n\n"));
    expect(mock.streams[1]!.signal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTime(2000));
    const implementation = mock.fetcher.getMockImplementation()!;
    mock.fetcher.mockImplementation(async (path, init) => path === "/api/kiosk/remote/renew"
      ? json({ error: "Expired" }, 403) : implementation(path, init));
    await act(async () => mock.streams[2]!.send("ready", { epoch, sequence: 0 }));
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(mock.streams[2]!.signal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(mock.streams).toHaveLength(4);
  });
});

describe("shared real navigation", () => {
  it("selects by geometry, falls back predictably, and excludes hidden nested details and disabled controls", () => {
    render(<div data-testid="root">
      <button>Origin</button><button>Right</button><button>Below</button>
      <button disabled>Disabled</button><div hidden><button>Hidden</button></div>
      <details><summary>Closed</summary><details><summary>Nested hidden</summary></details></details>
    </div>);
    const root = screen.getByTestId("root");
    const origin = screen.getByText("Origin");
    const right = screen.getByText("Right");
    const below = screen.getByText("Below");
    for (const [element, left, top] of [[origin, 0, 0], [right, 100, 0], [below, 0, 100]] as const) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left, top, width: 50, height: 50 } as DOMRect);
    }
    origin.focus();
    navigate(root, { key: "right", repeat: false });
    expect(right).toHaveFocus();
    origin.focus();
    navigate(root, { key: "down", repeat: true });
    expect(below).toHaveFocus();
    expect(navigationVisible(screen.getByText("Nested hidden"))).toBe(false);
    expect(navigationVisible(screen.getByText("Hidden"))).toBe(false);
    screen.getByText("Closed").focus();
    navigate(root, { key: "right", repeat: false });
    expect(origin).toHaveFocus();
  });

  it("adjusts controlled range values via explicit state handlers and allows escape", () => {
    function Range() {
      const [value, setValue] = useState(4);
      const ref = useNavigationAdjustment((direction) => setValue((before) => Math.max(0, Math.min(10, before + direction))));
      return <div data-testid="root"><input ref={ref} type="range" aria-label="Value" value={value}
        onChange={(event) => setValue(Number(event.target.value))} /><button>Outside</button></div>;
    }
    render(<Range />);
    const root = screen.getByTestId("root");
    const range = screen.getByRole("slider");
    const syntheticInput = vi.fn();
    range.addEventListener("input", syntheticInput);
    range.focus();
    act(() => navigate(root, { key: "right", repeat: true }));
    expect(range).toHaveValue("5");
    expect(syntheticInput).not.toHaveBeenCalled();
    act(() => navigate(root, { key: "down", repeat: false }));
    expect(screen.getByText("Outside")).toHaveFocus();
  });

  it("scrolls focused reading panes up/down and leaves with left/right without a focus trap", () => {
    render(<div data-testid="root"><section tabIndex={0} data-navigation-scroll aria-label="Read">Long text</section><button>Exit pane</button></div>);
    const root = screen.getByTestId("root");
    const pane = screen.getByLabelText("Read");
    pane.focus();
    navigate(root, { key: "down", repeat: false });
    expect(pane.scrollTop).toBe(80);
    navigate(root, { key: "up", repeat: true });
    expect(pane.scrollTop).toBe(0);
    navigate(root, { key: "right", repeat: false });
    expect(screen.getByText("Exit pane")).toHaveFocus();
  });
});

describe("real kiosk display actions", () => {
  async function mount(initial = snapshot(), kiosk = true) {
    window.history.replaceState(null, "", kiosk ? "/?kiosk=1" : "/");
    const mock = service(initial);
    vi.stubGlobal("fetch", mock.fetcher);
    render(<App />);
    await act(async () => {});
    let sequence = 0;
    if (kiosk) await act(async () => mock.streams[0]!.send("ready", { epoch, sequence: 0 }));
    const press = async (key: RemoteKey, repeat = false) => {
      await act(async () => mock.streams.at(-1)!.send("key", keyData(++sequence, key, { repeat })));
      await act(async () => vi.advanceTimersByTime(0));
    };
    return { ...mock, press };
  }

  it("never registers admin or turns CEC lastEvent snapshots into navigation", async () => {
    const mock = await mount(snapshot(), false);
    const ambient = screen.getByRole("tab", { name: "Ambient" });
    act(() => ambient.focus());
    await act(async () => StateEvents.latest.send(snapshot({
      sequence: 2, cec: { ...snapshot().cec, remote: { ...snapshot().cec.remote!, lastEvent: { key: "select", at: Date.now() } } },
    })));
    expect(ambient).toHaveFocus();
    expect(mock.streams).toHaveLength(0);
    expect(mock.fetcher.mock.calls.filter(([path]) => path === "/api/settings")).toHaveLength(0);
    fireEvent.click(screen.getByText("Scene library"));
    expect(screen.getByLabelText("Upload an image")).toBeEnabled();
    fireEvent.click(screen.getByText("Display settings"));
    expect(screen.getByText(/This admin browser does not receive remote keys/)).toBeVisible();
  });

  it("selects instant follow using real remote OK even in Ambient and ignores held OK", async () => {
    const mock = await mount();
    act(() => screen.getByText("Display settings").focus());
    await mock.press("select");
    const instant = screen.getByRole("button", { name: "Instant (low-cost)" });
    act(() => instant.focus());
    await mock.press("select");
    expect(mock.getState().lyricFollowMode).toBe("instant");
    expect(mock.getState().visualOffsetMs).toBe(700);
    expect(mock.getState().viewMode).toBe("ambient");
    expect(instant).toHaveAttribute("aria-pressed", "true");
    await mock.press("select", true);
    expect(mock.fetcher.mock.calls.filter(([path]) => path === "/api/settings")).toHaveLength(1);
  });

  it("allows held remote reading through cues and resumes once without replaying held OK", async () => {
    const initial = snapshot({
      viewMode: "lyrics", lyricFollowMode: "instant", playback: "paused", connection: "connected",
      track: { identity: "remote-lyrics", title: "Test track", artist: "Test", album: "", durationMs: 10000, artworkUrl: null },
      lyrics: { status: "timed", plain: null, message: null,
        lines: [{ timeMs: 0, text: "First cue" }, { timeMs: 2000, text: "Second cue" }] },
    });
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scroll });
    const mock = await mount(initial);
    const pane = screen.getByLabelText("Timed lyrics");
    act(() => pane.focus());
    scroll.mockClear();
    await mock.press("down");
    await mock.press("down", true);
    const top = pane.scrollTop;
    expect(top).toBe(160);
    await act(async () => StateEvents.latest.send({ ...initial, sequence: 2, positionMs: 2000 }));
    expect(scroll).not.toHaveBeenCalled();
    expect(pane.scrollTop).toBe(top);
    await mock.press("right");
    expect(pane).not.toHaveFocus();
    act(() => screen.getByRole("button", { name: "Resume lyric follow" }).focus());
    await mock.press("select");
    expect(scroll).toHaveBeenCalledTimes(1);
    await mock.press("select", true);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Pause lyric follow" })).toBeInTheDocument();
  });

  it("consumes hidden Ambient's first allowed key, ignores repeated select/back, then navigates without synthetic key events", async () => {
    const mock = await mount();
    const keyboard = vi.fn();
    window.addEventListener("keydown", keyboard);
    fireEvent.click(screen.getByRole("button", { name: "Hide controls" }));
    expect(document.querySelector(".display-header")).toHaveAttribute("hidden");
    await mock.press("select", true);
    await mock.press("back", true);
    expect(document.querySelector(".display-header")).toHaveAttribute("hidden");
    await mock.press("right");
    const ambient = screen.getByRole("tab", { name: "Ambient" });
    expect(ambient).toHaveFocus();
    expect(mock.fetcher.mock.calls.filter(([path]) => path === "/api/settings")).toHaveLength(0);
    await mock.press("left");
    expect(screen.getByRole("tab", { name: "Split" })).toHaveFocus();
    await mock.press("select");
    expect(screen.getByRole("tab", { name: "Split" })).toHaveAttribute("aria-selected", "true");
    expect(mock.getState().visualOffsetMs).toBe(700);
    expect(mock.getState().ambient).toEqual(DEFAULT_AMBIENT);
    expect(keyboard).not.toHaveBeenCalled();
    window.removeEventListener("keydown", keyboard);
  });

  it("shares tab traversal and OK activation with the physical keyboard", async () => {
    const mock = await mount();
    act(() => screen.getByRole("tab", { name: "Ambient" }).focus());
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Split" })).toHaveFocus();
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "Enter" }));
    expect(mock.getState().viewMode).toBe("split");
    await mock.press("left");
    expect(screen.getByRole("tab", { name: "Lyrics" })).toHaveFocus();
    await mock.press("select");
    expect(mock.getState().viewMode).toBe("lyrics");
  });

  it("reveals and focuses only the current Ambient tab even when playback transport has failed", async () => {
    const mock = await mount();
    act(() => StateEvents.latest.onerror?.());
    fireEvent.click(screen.getByRole("button", { name: "Hide controls" }));
    await mock.press("select");
    expect(screen.getByRole("tab", { name: "Ambient" })).toHaveFocus();
    expect(mock.fetcher.mock.calls.filter(([path]) => path === "/api/settings")).toHaveLength(0);
  });

  it("operates scene checkboxes, numeric settings and Back through nested panels without MA or file pickers", async () => {
    const mock = await mount();
    const library = screen.getByText("Scene library");
    act(() => library.focus());
    await mock.press("select");
    expect(library.closest("details")).toHaveAttribute("open");
    const checkbox = screen.getByRole("checkbox", { name: "Slideshow" });
    act(() => checkbox.focus());
    await mock.press("select");
    expect(checkbox).not.toBeChecked();
    await mock.press("right");
    const dwell = screen.getByRole("spinbutton");
    expect(dwell).toHaveFocus();
    await mock.press("right");
    expect(dwell).toHaveValue(61);
    await mock.press("down");
    expect(screen.getByRole("button", { name: "Save selection" })).toHaveFocus();
    await mock.press("select");
    expect(mock.getState().ambient).toMatchObject({ slideshow: false, dwellSeconds: 61 });
    const about = screen.getByText(/About the photo collection/);
    act(() => about.focus());
    await mock.press("select");
    expect(about.closest("details")).toHaveAttribute("open");
    await mock.press("back");
    expect(about).toHaveFocus();
    expect(about.closest("details")).not.toHaveAttribute("open");
    expect(library.closest("details")).toHaveAttribute("open");
    await mock.press("back");
    expect(library).toHaveFocus();
    expect(library.closest("details")).not.toHaveAttribute("open");
    await mock.press("select");
    expect(document.querySelector("input[type='file']")).toBeNull();
    expect(screen.getByText(/Use admin browser to choose files/)).toBeVisible();
  });

  it("cancels the deepest deletion confirmation and restores its trigger before closing the library", async () => {
    const mock = await mount();
    act(() => screen.getByText("Scene library").focus());
    await mock.press("select");
    act(() => screen.getByRole("checkbox", { name: "Delete Uploaded lake" }).focus());
    await mock.press("select");
    act(() => screen.getByRole("button", { name: "Delete 1 upload…" }).focus());
    await mock.press("select");
    expect(screen.getByRole("button", { name: "Cancel deletion" })).toHaveFocus();
    await mock.press("right");
    expect(screen.getByRole("button", { name: "Confirm delete" })).toHaveFocus();
    await mock.press("back");
    expect(screen.getByRole("button", { name: "Delete 1 upload…" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Confirm delete" })).not.toBeInTheDocument();
    expect(screen.getByText("Scene library").closest("details")).toHaveAttribute("open");
    expect(mock.fetcher.mock.calls.filter(([path]) => path === "/api/backgrounds/delete")).toHaveLength(0);
  });

  it("skips outbound photo credits for CEC and blocks OK on a mouse-focused link while retaining keyboard activation", async () => {
    const mock = await mount();
    act(() => screen.getByText("Scene library").focus());
    await mock.press("select");
    const showOnly = screen.getByRole("button", { name: `Show only ${BUILTIN_BACKGROUNDS[0]!.title}` });
    act(() => showOnly.focus());
    await mock.press("right");
    expect(screen.getByRole("checkbox", { name: BUILTIN_BACKGROUNDS[1]!.title })).toHaveFocus();
    const link = screen.getByRole("link", { name: `View ${BUILTIN_BACKGROUNDS[0]!.title} on Flickr (opens a new tab)` });
    const clicked = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener("click", clicked);
    act(() => link.focus());
    await mock.press("select");
    expect(clicked).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(link, { key: "Enter" }));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(link).toHaveAttribute("target", "_blank");
    expect(mock.streams).toHaveLength(1);
  });

  it("keeps standby confirmation safe and returns focus through settings to the current tab", async () => {
    const mock = await mount(snapshot({ viewMode: "split" }));
    const settings = screen.getByText("Display settings");
    act(() => settings.focus());
    await mock.press("select");
    act(() => screen.getByRole("button", { name: "TV standby…" }).focus());
    await mock.press("select");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await mock.press("back");
    expect(screen.getByRole("button", { name: "TV standby…" })).toHaveFocus();
    await mock.press("back");
    expect(settings).toHaveFocus();
    expect(settings.closest("details")).not.toHaveAttribute("open");
    await mock.press("back");
    expect(screen.getByRole("tab", { name: "Split" })).toHaveFocus();
    expect(mock.fetcher.mock.calls.filter(([path]) => path === "/api/cec")).toHaveLength(0);
  });

  it.each([200, 500])("restores a temporarily disabled command button after Chrome blur and a %i response", async (status) => {
    const mock = await mount(snapshot({ viewMode: "split" }));
    const implementation = mock.fetcher.getMockImplementation()!;
    let finish: () => void = () => {};
    mock.fetcher.mockImplementation(async (path, init) => path === "/api/settings"
      ? new Promise<Response>((resolve) => {
        finish = () => resolve(status === 200 ? implementation(path, init) : json({ error: "Save failed" }, status));
      }) : implementation(path, init));
    act(() => screen.getByText("Display settings").focus());
    await mock.press("select");
    const earlier = screen.getByRole("button", { name: "Show lyrics 100 milliseconds earlier" });
    act(() => earlier.focus());
    await mock.press("select");
    expect(earlier).toBeDisabled();
    // jsdom retains focus on disabled buttons; Chrome does not.
    act(() => chromeDisabledBlur(earlier));
    expect(document.body).toHaveFocus();
    await act(async () => finish());
    expect(earlier).toBeEnabled();
    expect(earlier).toHaveFocus();
    await mock.press("right");
    expect(screen.getByRole("button", { name: "Reset offset" })).toHaveFocus();
    await mock.press("back");
    expect(screen.getByText("Display settings")).toHaveFocus();
  });

  it("does not restore the command target after the user deliberately moves focus during pending", async () => {
    const mock = await mount(snapshot({ viewMode: "split" }));
    const implementation = mock.fetcher.getMockImplementation()!;
    let finish: () => void = () => {};
    mock.fetcher.mockImplementation(async (path, init) => path === "/api/settings"
      ? new Promise<Response>((resolve) => { finish = () => resolve(implementation(path, init)); })
      : implementation(path, init));
    act(() => screen.getByText("Display settings").focus());
    await mock.press("select");
    const earlier = screen.getByRole("button", { name: "Show lyrics 100 milliseconds earlier" });
    act(() => earlier.focus());
    await mock.press("select");
    act(() => chromeDisabledBlur(earlier));
    const fullscreen = screen.getByRole("button", { name: "Fullscreen" });
    act(() => { fullscreen.focus(); fullscreen.blur(); });
    await act(async () => finish());
    expect(document.body).toHaveFocus();
    expect(earlier).not.toHaveFocus();
  });

  it("returns focus to the panel summary if saving reaches a boundary that keeps the control disabled", async () => {
    const mock = await mount(snapshot({ viewMode: "split", visualOffsetMs: 29_900 }));
    const implementation = mock.fetcher.getMockImplementation()!;
    let finish: () => void = () => {};
    mock.fetcher.mockImplementation(async (path, init) => path === "/api/settings"
      ? new Promise<Response>((resolve) => { finish = () => resolve(implementation(path, init)); })
      : implementation(path, init));
    const settings = screen.getByText("Display settings");
    act(() => settings.focus());
    await mock.press("select");
    const earlier = screen.getByRole("button", { name: "Show lyrics 100 milliseconds earlier" });
    act(() => earlier.focus());
    await mock.press("select");
    act(() => chromeDisabledBlur(earlier));
    await act(async () => finish());
    expect(earlier).toBeDisabled();
    expect(settings).toHaveFocus();
    await mock.press("back");
    expect(settings.closest("details")).not.toHaveAttribute("open");
  });

  it("explains rejected fullscreen instead of claiming trusted user activation", async () => {
    const mock = await mount();
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true, value: vi.fn().mockRejectedValue(new Error("User activation required")),
    });
    act(() => screen.getByRole("button", { name: "Fullscreen" }).focus());
    await mock.press("select");
    expect(screen.getByRole("alert")).toHaveTextContent("kiosk mode already handles fullscreen");
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeInTheDocument();
  });
});
