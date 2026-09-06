// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_BACKGROUNDS, DEFAULT_AMBIENT, type AmbientImage, type AmbientLibrary } from "../src/shared/ambient.js";
import { emptyLyrics, type Snapshot } from "../src/shared/protocol.js";
import { App } from "../src/web/App.js";
import { AMBIENT_CROSSFADE_MS, AMBIENT_IDLE_MS, AmbientScene } from "../src/web/Ambient.js";
import { ambientLibrarySchema, snapshotSchema } from "../src/web/schema.js";
import { usePlayback } from "../src/web/usePlayback.js";

let sequence = 0;
function state(patch: Partial<Snapshot> = {}): Snapshot {
  return {
    sequence: ++sequence, generation: 1, demo: false, connection: "disconnected",
    playback: "idle", track: null, lyrics: emptyLyrics(), positionMs: 0, speed: 0,
    viewMode: "ambient", visualOffsetMs: 700, ambient: { ...DEFAULT_AMBIENT, selectedIds: [...DEFAULT_AMBIENT.selectedIds] },
    lyricFollowMode: "smooth", precision: "ma-queue", message: "Music Assistant is not configured.",
    cec: { enabled: true, available: true, owned: true, message: "TV controls are available." }, ...patch,
  };
}
const uploaded: AmbientImage = {
  id: "upload-12345678-1234-1234-1234-123456789abc", title: "My quiet lake",
  source: "upload", url: "/api/backgrounds/image/upload-12345678-1234-1234-1234-123456789abc",
  thumbnailUrl: "/api/backgrounds/thumbnail/upload-12345678-1234-1234-1234-123456789abc",
  width: 3840, height: 2160, bytes: 123456,
};
const limits = { maxUploadBytes: 12 * 1024 * 1024, maxImages: 40, maxStorageBytes: 256 * 1024 * 1024, maxPixels: 24_000_000 };
const photoCatalog = () => BUILTIN_BACKGROUNDS.map((image) => ({ ...image }));
const firstPhoto = "Golden Gate Afternoon";
const secondPhoto = "Lone Pine Sunset";
const firstId = "builtin-golden-gate";
const secondId = "builtin-lone-pine";

class Events extends EventTarget {
  static all: Events[] = [];
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() { super(); Events.all.push(this); }
  send(value: unknown) { this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(value) })); }
  static get latest() { return Events.all.at(-1)!; }
}
function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function service(initial = state(), extra: AmbientImage[] = [], catalog: AmbientImage[] = photoCatalog()) {
  let current = initial;
  let images = [...catalog, ...extra];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (input === "/api/state") return response(current);
    if (input === "/api/backgrounds") return response({ images, limits });
    if (input === "/api/session") return response({ csrfToken: "ambient-token" });
    if (input === "/api/settings") {
      const patch = JSON.parse(init?.body as string);
      current = { ...current, ...patch, ambient: { ...current.ambient, ...patch.ambient }, sequence: ++sequence };
      Events.latest.send(current);
      return response({ viewMode: current.viewMode, visualOffsetMs: current.visualOffsetMs, ambient: current.ambient });
    }
    if (input === "/api/backgrounds/upload") {
      images = [...images, uploaded];
      return response({ image: uploaded }, 201);
    }
    if (input === "/api/backgrounds/delete") {
      const { ids } = JSON.parse(init?.body as string) as { ids: string[] };
      images = images.filter((image) => !ids.includes(image.id));
      return response({ deletedIds: ids });
    }
    return response({ error: "Unexpected endpoint" }, 404);
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, setImages: (value: AmbientImage[]) => { images = value; }, getState: () => current };
}
async function mount(initial = state(), extra: AmbientImage[] = [], catalog: AmbientImage[] = photoCatalog()) {
  const mock = service(initial, extra, catalog);
  render(<App />);
  await act(async () => {});
  return mock;
}
async function openLibrary() {
  const summary = screen.getByText("Scene library");
  fireEvent.click(summary);
  await act(async () => vi.advanceTimersByTime(0));
  return screen.getByRole("region", { name: "Choose your scene" });
}
function scene() { return document.querySelector(".ambient-scene")!; }
function activeImage() { return scene().querySelector(".ambient-slide-current")!; }
async function advanceWithSnapshots(ms: number, snapshot = state()) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    await act(async () => {
      vi.advanceTimersByTime(Math.min(1000, ms - elapsed));
      Events.latest.send({ ...snapshot, sequence: ++sequence });
    });
  }
}

beforeEach(() => {
  sequence = 0;
  Events.all = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  vi.stubGlobal("EventSource", Events);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ambient mode independence", () => {
  it("renders persisted scenes without Music Assistant, music content, or automatic device commands", async () => {
    const { fetcher } = await mount(state({
      track: { identity: "last-song", title: "Hidden old song", artist: "Hidden artist", album: "Hidden album", durationMs: 10000, artworkUrl: null },
      lyrics: { status: "timed", lines: [{ timeMs: 0, text: "Hidden lyrics" }], plain: null, message: null },
    }));
    expect(screen.getByRole("tab", { name: "Ambient" })).toHaveAttribute("aria-selected", "true");
    expect(activeImage()).toHaveAttribute("src", BUILTIN_BACKGROUNDS[0]!.url);
    expect(screen.queryByText("Music Assistant is not configured.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Hidden (old song|artist|album|lyrics)/)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText("Connection stale")).not.toBeInTheDocument();
    expect(document.querySelector("audio, video")).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await openLibrary();
    expect(screen.getByRole("button", { name: `Show only ${firstPhoto}` })).toBeEnabled();
  });

  it("retains ambient settings when stale playback is cleared", async () => {
    const initial = state({
      track: { identity: "old", title: "Old song", artist: "", album: "", durationMs: 50000, artworkUrl: null },
      ambient: { selectedIds: [secondId], slideshow: false, dwellSeconds: 45 },
    });
    service(initial);
    const { result } = renderHook(() => usePlayback());
    await act(async () => {});
    act(() => vi.advanceTimersByTime(21_000));
    expect(result.current.cleared).toBe(true);
    expect(result.current.snapshot?.track).toBeNull();
    expect(result.current.snapshot?.lyrics).toEqual(emptyLyrics());
    expect(result.current.snapshot?.viewMode).toBe("ambient");
    expect(result.current.snapshot?.ambient).toEqual(initial.ambient);
    expect(result.current.snapshot?.visualOffsetMs).toBe(700);
  });

  it("keeps the scene through local transport errors and puts issues only in controls", async () => {
    await mount();
    act(() => Events.latest.onerror?.());
    expect(activeImage()).toHaveAttribute("alt", firstPhoto);
    expect(screen.getByText(/Local service unavailable. Your scene keeps going/)).toBeVisible();
    act(() => vi.advanceTimersByTime(21_000));
    expect(document.querySelector(".display-header")).toHaveAttribute("hidden");
    expect(document.querySelector(".display-footer")).toHaveAttribute("hidden");
    expect(activeImage()).toHaveAttribute("alt", firstPhoto);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("tab", { name: "Ambient" })).toHaveFocus();
    expect(document.querySelector(".display-footer")).not.toHaveAttribute("hidden");
    expect(document.querySelector(".display")).toHaveClass("view-ambient");
  });

  it("persists the Ambient tab through the protected settings endpoint without resetting calibration", async () => {
    const { fetcher, getState } = await mount(state({ viewMode: "split" }));
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Ambient" })));
    expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
      body: JSON.stringify({ viewMode: "ambient" }), headers: expect.objectContaining({ "X-CSRF-Token": "ambient-token" }),
    }));
    expect(screen.getByRole("tab", { name: "Ambient" })).toHaveAttribute("aria-selected", "true");
    expect(getState().visualOffsetMs).toBe(700);
    expect(getState().ambient).toEqual(DEFAULT_AMBIENT);
  });

  it("restores music controls and command feedback when leaving an open ambient library", async () => {
    await mount();
    await openLibrary();
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Split" })));
    expect(document.querySelector(".display")).toHaveClass("view-split");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByText("Display view saved.")).toBeVisible();
    expect(screen.queryByText("Scene library")).not.toBeInTheDocument();
  });

  it("uses a clearly labelled bundled fallback for an empty or deleted selection without changing settings", async () => {
    const { fetcher } = await mount(state({ ambient: { selectedIds: [], slideshow: true, dwellSeconds: 60 } }));
    expect(activeImage()).toHaveAttribute("alt", firstPhoto);
    expect(screen.getByText(/your selection is unchanged/)).toBeInTheDocument();
    act(() => Events.latest.send(state({ ambient: { selectedIds: [uploaded.id], slideshow: false, dwellSeconds: 60 } })));
    expect(activeImage()).toHaveAttribute("alt", firstPhoto);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
});

describe("bounded ambient slideshow", () => {
  it("does not restart dwell on 100ms snapshots and crossfades no more than two slides", () => {
    const settings = { selectedIds: [firstId, secondId], slideshow: true, dwellSeconds: 15 };
    const onIssue = vi.fn();
    const { rerender } = render(<AmbientScene settings={settings} images={photoCatalog()} onIssue={onIssue} />);
    fireEvent.load(activeImage());
    for (let tick = 0; tick < 149; tick += 1) {
      act(() => vi.advanceTimersByTime(100));
      rerender(<AmbientScene settings={{ ...settings, selectedIds: [...settings.selectedIds] }}
        images={photoCatalog()} onIssue={onIssue} />);
    }
    expect(scene()).toHaveAttribute("data-scene-id", firstId);
    expect(scene().querySelectorAll("img")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(100));
    expect(scene()).toHaveAttribute("data-scene-id", secondId);
    expect(scene().querySelectorAll("img")).toHaveLength(2);
    expect(activeImage()).not.toHaveClass("is-ready");
    fireEvent.load(activeImage());
    expect(activeImage()).toHaveClass("is-ready");
    act(() => vi.advanceTimersByTime(AMBIENT_CROSSFADE_MS));
    expect(scene().querySelectorAll("img")).toHaveLength(1);
    expect(document.querySelector("link[rel='preload']")).toBeNull();
  });

  it("eliminates crossfade for reduced motion while allowing a slideshow", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<AmbientScene settings={{ ...DEFAULT_AMBIENT, dwellSeconds: 15 }} images={photoCatalog()} onIssue={vi.fn()} />);
    fireEvent.load(activeImage());
    act(() => vi.advanceTimersByTime(15_000));
    expect(scene()).toHaveClass("reduced-motion");
    expect(scene()).toHaveAttribute("data-scene-id", secondId);
    expect(scene().querySelectorAll("img")).toHaveLength(1);
  });

  it("uses a stable first scene in static mode and deterministically handles current-image deletion", () => {
    const onIssue = vi.fn();
    const settings = { selectedIds: [uploaded.id, secondId], slideshow: false, dwellSeconds: 15 };
    const { rerender } = render(<AmbientScene settings={settings} images={[...photoCatalog(), uploaded]} onIssue={onIssue} />);
    fireEvent.load(activeImage());
    act(() => vi.advanceTimersByTime(120_000));
    expect(scene()).toHaveAttribute("data-scene-id", uploaded.id);
    rerender(<AmbientScene settings={settings} images={photoCatalog()} onIssue={onIssue} />);
    expect(scene()).toHaveAttribute("data-scene-id", secondId);
    rerender(<AmbientScene settings={{ ...settings, selectedIds: [] }} images={photoCatalog()} onIssue={onIssue} />);
    expect(scene()).toHaveAttribute("data-scene-id", firstId);
    expect(scene().querySelectorAll("img").length).toBeLessThanOrEqual(2);
  });

  it("uses the bundled fallback after an image error, staying neutral only if that also fails", () => {
    const onIssue = vi.fn();
    render(<AmbientScene settings={{ selectedIds: [uploaded.id], slideshow: false, dwellSeconds: 60 }}
      images={[...photoCatalog(), uploaded]} onIssue={onIssue} />);
    fireEvent.error(activeImage());
    expect(scene()).toHaveAttribute("data-scene-id", firstId);
    expect(onIssue).toHaveBeenCalledWith(`Selected photos could not load. Showing ${firstPhoto} as a fallback.`);
    fireEvent.error(activeImage());
    expect(scene()).toHaveAttribute("data-scene-id", "");
    expect(scene().querySelector("img")).toBeNull();
    expect(onIssue).toHaveBeenCalledWith("Photos could not load. Open Scene library to choose another image.");
  });
});

describe("ambient library editing and requests", () => {
  it("keeps edits during snapshots, patches only ambient fields, and retains view and calibration", async () => {
    const { fetcher, getState } = await mount();
    await openLibrary();
    fireEvent.click(screen.getByRole("checkbox", { name: firstPhoto }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Seconds per scene" }), { target: { value: "95" } });
    act(() => Events.latest.send(state({ visualOffsetMs: 800 })));
    expect(screen.getByRole("checkbox", { name: firstPhoto })).not.toBeChecked();
    expect(screen.getByRole("spinbutton")).toHaveValue(95);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save selection" })));
    expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
      body: JSON.stringify({ ambient: { selectedIds: DEFAULT_AMBIENT.selectedIds.slice(1), dwellSeconds: 95 } }),
    }));
    expect(getState().viewMode).toBe("ambient");
    expect(getState().visualOffsetMs).toBe(700);
    expect(screen.getByRole("spinbutton")).toHaveValue(95);
    expect(screen.getByText("Ambient settings saved.")).toBeInTheDocument();
  });

  it("supports photo/upload/all collections, individual static selection, and bounded dwell", async () => {
    const { fetcher } = await mount(state(), [uploaded]);
    const library = await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Uploads" }));
    expect(screen.getByRole("checkbox", { name: uploaded.title })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: firstPhoto })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "All scenes" }));
    expect(screen.getByRole("checkbox", { name: firstPhoto })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Collection photos" }));
    expect(screen.getByRole("checkbox", { name: uploaded.title })).not.toBeChecked();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "14" } });
    expect(screen.getByRole("button", { name: "Save selection" })).toBeDisabled();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "3601" } });
    expect(screen.getByRole("spinbutton")).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show only My quiet lake" })));
    expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
      body: JSON.stringify({ ambient: { selectedIds: [uploaded.id], slideshow: false } }),
    }));
    expect(activeImage()).toHaveAttribute("alt", uploaded.title);
    for (const thumbnail of library.querySelectorAll("img")) expect(thumbnail).toHaveAttribute("loading", "lazy");
  });

  it("uploads raw JPEG with session credentials, CSRF and an encoded Unicode filename", async () => {
    const { fetcher } = await mount();
    await openLibrary();
    const file = new File(["jpeg contents"], "湖 & sky.jpg", { type: "image/jpeg" });
    await act(async () => fireEvent.change(screen.getByLabelText("Upload an image"), { target: { files: [file] } }));
    expect(fetcher).toHaveBeenCalledWith("/api/backgrounds/upload", expect.objectContaining({
      method: "POST", body: file, credentials: "same-origin",
      headers: { "Content-Type": "image/jpeg", "X-Image-Title": encodeURIComponent(file.name), "X-CSRF-Token": "ambient-token" },
    }));
    expect(screen.getByRole("checkbox", { name: uploaded.title })).not.toBeChecked();
    expect(screen.getByText(/Image uploaded. Include it/)).toBeInTheDocument();
    expect(activeImage()).toHaveAttribute("alt", firstPhoto);
    expect(screen.getByText(/40 uploads/)).toHaveTextContent("256 MiB");
    expect(screen.getByLabelText("Upload an image")).toHaveAttribute("accept", "image/jpeg,image/png");
  });

  it("validates format and maximum size before uploading and displays backend upload errors", async () => {
    const { fetcher } = await mount();
    await openLibrary();
    const input = screen.getByLabelText("Upload an image");
    await act(async () => fireEvent.change(input, { target: { files: [new File(["gif"], "wrong.gif", { type: "image/gif" })] } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a JPEG or PNG");
    const oversized = new File(["png"], "large.png", { type: "image/png" });
    Object.defineProperty(oversized, "size", { value: 12 * 1024 * 1024 + 1 });
    await act(async () => fireEvent.change(input, { target: { files: [oversized] } }));
    expect(screen.getByRole("alert")).toHaveTextContent("no larger than 12 MiB");
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/backgrounds/upload")).toHaveLength(0);
    const previous = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, init) => path === "/api/backgrounds/upload"
      ? response({ error: "Storage quota reached. Delete an upload first." }, 413) : previous(path, init));
    await act(async () => fireEvent.change(input, { target: { files: [new File(["png"], "small.png", { type: "image/png" })] } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Storage quota reached");
    expect(screen.queryByText(/Image uploaded. Include it/)).not.toBeInTheDocument();
  });

  it("requires explicit confirmation and deletes only marked uploads, never collection photos", async () => {
    const { fetcher } = await mount(state({ ambient: { selectedIds: [uploaded.id], slideshow: false, dwellSeconds: 60 } }), [uploaded]);
    await openLibrary();
    expect(screen.queryByRole("checkbox", { name: `Delete ${firstPhoto}` })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Delete My quiet lake" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 upload…" }));
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/backgrounds/delete")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel deletion" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 upload…" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm delete" })));
    expect(fetcher).toHaveBeenCalledWith("/api/backgrounds/delete", expect.objectContaining({
      body: JSON.stringify({ ids: [uploaded.id] }),
      headers: expect.objectContaining({ "X-CSRF-Token": "ambient-token" }),
    }));
    expect(screen.queryByRole("checkbox", { name: uploaded.title })).not.toBeInTheDocument();
    expect(activeImage()).toHaveAttribute("alt", firstPhoto);
    expect(screen.getByText(/your selection is unchanged/)).toBeInTheDocument();
  });

  it("retains uploaded images on deletion failure and rejects malformed success responses", async () => {
    const { fetcher } = await mount(state(), [uploaded]);
    await openLibrary();
    fireEvent.click(screen.getByRole("checkbox", { name: "Delete My quiet lake" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 upload…" }));
    const previous = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, init) => path === "/api/backgrounds/delete"
      ? response({ error: "Image is busy. Try again." }, 500) : previous(path, init));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm delete" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Image is busy");
    expect(screen.getByRole("checkbox", { name: uploaded.title })).toBeInTheDocument();
    fetcher.mockImplementation(async (path, init) => path === "/api/backgrounds/delete"
      ? response({ deletedIds: [firstId] }) : previous(path, init));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm delete" })));
    expect(screen.getByRole("alert")).toHaveTextContent("deletion response was invalid");
    expect(screen.queryByText("Selected uploaded images deleted.")).not.toBeInTheDocument();
  });

  it("refetches on opening and every fifteen seconds, retaining known images on errors", async () => {
    const { fetcher, setImages } = await mount(state(), [uploaded]);
    const initialRequests = fetcher.mock.calls.filter(([path]) => path === "/api/backgrounds").length;
    await openLibrary();
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/backgrounds").length).toBeGreaterThan(initialRequests);
    setImages(photoCatalog());
    await advanceWithSnapshots(15_000);
    expect(screen.queryByRole("checkbox", { name: uploaded.title })).not.toBeInTheDocument();
    const previous = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, init) => path === "/api/backgrounds"
      ? response({ error: "Library unavailable" }, 503) : previous(path, init));
    await advanceWithSnapshots(15_000);
    expect(screen.getByRole("alert")).toHaveTextContent("Keeping known scenes");
    expect(screen.getByRole("checkbox", { name: firstPhoto })).toBeInTheDocument();
  });

  it("keeps upload pending honestly and opens a new session after a rejected CSRF token", async () => {
    const { fetcher } = await mount();
    await openLibrary();
    const previous = fetcher.getMockImplementation()!;
    let finish: (value: Response) => void = () => {};
    fetcher.mockImplementation(async (path, init) => path === "/api/backgrounds/upload"
      ? new Promise<Response>((resolve) => { finish = resolve; }) : previous(path, init));
    const input = screen.getByLabelText("Upload an image");
    const file = new File(["png"], "lake.png", { type: "image/png" });
    await act(async () => fireEvent.change(input, { target: { files: [file] } }));
    expect(input).toBeDisabled();
    expect(screen.getByText("Sending to local service…")).toBeInTheDocument();
    await act(async () => finish(response({ error: "Refresh your session." }, 403)));
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh your session.");
    expect(input).toBeEnabled();
    fetcher.mockImplementation(previous);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry upload" })));
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/session")).toHaveLength(2);
    expect(screen.getByText(/Image uploaded. Include it/)).toBeInTheDocument();
  });

  it("preserves unsaved preferences on a failed settings request and does not report success", async () => {
    const { fetcher } = await mount();
    await openLibrary();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "90" } });
    const previous = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, init) => path === "/api/settings"
      ? response({ error: "Settings could not be saved." }, 500) : previous(path, init));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save selection" })));
    expect(screen.getByRole("spinbutton")).toHaveValue(90);
    expect(screen.getByRole("alert")).toHaveTextContent("Settings could not be saved.");
    expect(screen.queryByText("Ambient settings saved.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save selection" })).toBeEnabled();
  });

  it("cleans up polling, idle, scene, and in-flight request timers on unmount", async () => {
    const { fetcher } = await mount();
    await openLibrary();
    const previous = fetcher.getMockImplementation()!;
    let signal: AbortSignal | null | undefined;
    fetcher.mockImplementation(async (path, init) => {
      if (path !== "/api/backgrounds/upload") return previous(path, init);
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Aborted")));
      });
    });
    await act(async () => fireEvent.change(screen.getByLabelText("Upload an image"), {
      target: { files: [new File(["png"], "lake.png", { type: "image/png" })] },
    }));
    await act(async () => cleanup());
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ambient remote, touch and idle controls", () => {
  it("wakes from the focused scene and retains remote focus when native listeners flush independently", async () => {
    const addListener = window.addEventListener.bind(window);
    const removeListener = window.removeEventListener.bind(window);
    const wrappedListeners = new Map<EventListener, EventListener>();
    // Native browser events can flush React between listeners, unlike a batched fireEvent.
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "keydown" && typeof listener === "function") {
        const wrapped: EventListener = (event) => flushSync(() => listener.call(window, event));
        wrappedListeners.set(listener, wrapped);
        addListener(type, wrapped, options);
      } else addListener(type, listener, options);
    });
    vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, options) => {
      removeListener(type, typeof listener === "function" ? wrappedListeners.get(listener) ?? listener : listener, options);
    });
    const initial = state();
    const { fetcher } = await mount(initial);
    const stage = screen.getByRole("tabpanel");
    fireEvent.pointerDown(stage);
    expect(stage).toHaveFocus();
    await advanceWithSnapshots(AMBIENT_IDLE_MS, initial);
    expect(document.querySelector(".display-header")).toHaveAttribute("hidden");
    fireEvent.keyDown(stage, { key: "ArrowRight" });
    fireEvent.keyUp(stage, { key: "ArrowRight" });
    const ambientTab = screen.getByRole("tab", { name: "Ambient" });
    expect(ambientTab).toHaveFocus();
    expect(ambientTab).toHaveAttribute("aria-selected", "true");
    await advanceWithSnapshots(AMBIENT_IDLE_MS + 1000, initial);
    expect(ambientTab).toHaveFocus();
    expect(document.querySelector(".display-header")).not.toHaveAttribute("hidden");
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/settings")).toHaveLength(0);
  });

  it("hides after idle, wakes with pointer/touch/keyboard, and never switches mode on Escape", async () => {
    const initial = state();
    await mount(initial);
    await advanceWithSnapshots(AMBIENT_IDLE_MS, initial);
    expect(document.querySelector(".display-header")).toHaveAttribute("hidden");
    fireEvent.pointerMove(window);
    expect(document.querySelector(".display-header")).not.toHaveAttribute("hidden");
    await advanceWithSnapshots(AMBIENT_IDLE_MS, initial);
    fireEvent.touchStart(window);
    expect(document.querySelector(".display-footer")).not.toHaveAttribute("hidden");
    await advanceWithSnapshots(AMBIENT_IDLE_MS, initial);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("tab", { name: "Ambient" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Ambient" })).toHaveAttribute("aria-selected", "true");
  });

  it("does not hide an open library, edited field, or focused control", async () => {
    await mount();
    await openLibrary();
    const dwell = screen.getByRole("spinbutton");
    act(() => dwell.focus());
    fireEvent.change(dwell, { target: { value: "125" } });
    await advanceWithSnapshots(20_000);
    expect(document.querySelector(".display-footer")).not.toHaveAttribute("hidden");
    expect(dwell).toHaveFocus();
    expect(dwell).toHaveValue(125);
    fireEvent.keyDown(dwell, { key: "Escape" });
    expect(screen.getByText("Scene library").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Scene library")).toHaveFocus();
    fireEvent.keyDown(screen.getByText("Scene library"), { key: "Escape" });
    expect(screen.getByRole("tab", { name: "Ambient" })).toHaveFocus();
    await advanceWithSnapshots(10_000);
    expect(document.querySelector(".display-header")).not.toHaveAttribute("hidden");
    await openLibrary();
    expect(screen.getByRole("spinbutton")).toHaveValue(125);
  });

  it("closes settings first and returns to controls on the next Escape", async () => {
    await mount();
    const summary = screen.getByText("Display settings");
    fireEvent.click(summary);
    await act(async () => fireEvent(summary.closest("details")!, new Event("toggle")));
    const wake = screen.getByRole("button", { name: "Wake TV" });
    act(() => wake.focus());
    await advanceWithSnapshots(10_000);
    expect(summary.closest("details")).toHaveAttribute("open");
    fireEvent.keyDown(wake, { key: "Escape" });
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(summary).toHaveFocus();
    fireEvent.keyDown(summary, { key: "Escape" });
    expect(screen.getByRole("tab", { name: "Ambient" })).toHaveFocus();
    expect(document.querySelector(".display")).toHaveClass("view-ambient");
  });

  it("shares directional navigation and checkbox activation while keeping numeric text editing available", async () => {
    const { fetcher } = await mount();
    const tab = screen.getByRole("tab", { name: "Ambient" });
    act(() => tab.focus());
    fireEvent.keyDown(tab, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Split" })).toHaveFocus();
    expect(tab).toHaveAttribute("aria-selected", "true");
    await openLibrary();
    const checkbox = screen.getByRole("checkbox", { name: "Slideshow" });
    act(() => checkbox.focus());
    fireEvent.keyDown(checkbox, { key: "Enter" });
    expect(checkbox).not.toBeChecked();
    fireEvent.keyDown(checkbox, { key: "ArrowRight" });
    const dwell = screen.getByRole("spinbutton");
    expect(dwell).toHaveFocus();
    const numericArrow = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    fireEvent(dwell, numericArrow);
    expect(numericArrow.defaultPrevented).toBe(true);
    expect(dwell).not.toHaveFocus();
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/settings")).toHaveLength(0);
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    fireEvent(checkbox, space);
    expect(space.defaultPrevented).toBe(true);
    expect(checkbox).toBeChecked();
  });
});

describe("reviewed photo collection", () => {
  it("loads only bounded local previews in the library, never original images or legacy-upload originals", async () => {
    const oldUpload = { ...uploaded, id: "upload-12345678-1234-1234-1234-123456789abd", title: "Old upload", thumbnailUrl: undefined };
    await mount(state(), [uploaded, oldUpload]);
    const panel = await openLibrary();
    const images = Array.from(panel.querySelectorAll("img"));
    expect(images).toHaveLength(BUILTIN_BACKGROUNDS.length + 1);
    BUILTIN_BACKGROUNDS.forEach((image, index) => expect(images[index]).toHaveAttribute("src", image.thumbnailUrl));
    expect(images.at(-1)).toHaveAttribute("src", uploaded.thumbnailUrl);
    expect(screen.getByText(/Refresh the library after updating the service/)).toBeVisible();
    for (const image of images) {
      expect(image).toHaveAttribute("loading", "lazy");
      expect(image).toHaveAttribute("width", "480");
      expect(image).toHaveAttribute("height", "270");
      expect([...BUILTIN_BACKGROUNDS, uploaded].some((original) => original.url === image.getAttribute("src"))).toBe(false);
    }
    fireEvent.error(images.at(-1)!);
    expect(images.at(-1)).not.toBeInTheDocument();
    expect(screen.getByText(/Retry or refresh the library/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: `Retry preview for ${uploaded.title}` }));
    expect(Array.from(panel.querySelectorAll("img")).at(-1)).toHaveAttribute("src", uploaded.thumbnailUrl);
    expect(activeImage()).toHaveAttribute("src", BUILTIN_BACKGROUNDS[0]!.url);
  });

  it("shows included offline photos and explains the rights and external-link boundaries", async () => {
    const { fetcher } = await mount();
    expect(activeImage()).toHaveAttribute("src", BUILTIN_BACKGROUNDS[0]!.url);
    const panel = await openLibrary();
    expect(panel.querySelectorAll("img")).toHaveLength(BUILTIN_BACKGROUNDS.length);
    expect(screen.getByText(/individually rights-cleared photos by Romain Guy/)).toHaveTextContent("702-photo archive is not licensed as one collection");
    expect(screen.getByText(/individually rights-cleared photos by Romain Guy/)).toHaveTextContent("original four Chromecast archive photos and more from his portfolio");
    expect(screen.getByText(/photos are included with this display/)).toHaveTextContent("work offline");
    expect(screen.getByText(/photos are included with this display/)).toHaveTextContent("only when you choose to visit");
    expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: `View ${firstPhoto} on Flickr (opens a new tab)` }))
      .toHaveAttribute("href", BUILTIN_BACKGROUNDS[0]!.credit!.sourceUrl);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(document.querySelector('img[src^="http"], img[src^="//"]')).toBeNull();
    for (const thumbnail of panel.querySelectorAll("img")) expect(thumbnail).toHaveAttribute("loading", "lazy");
  });

  it("selects bundled photos with only a settings command and never downloads a collection", async () => {
    const { fetcher, getState } = await mount(state(), [uploaded]);
    await openLibrary();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: `Show only ${secondPhoto}` })));
    expect(fetcher).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
      method: "POST", credentials: "same-origin", body: JSON.stringify({ ambient: { selectedIds: [secondId], slideshow: false } }),
      headers: expect.objectContaining({ "X-CSRF-Token": "ambient-token" }),
    }));
    expect(activeImage()).toHaveAttribute("src", BUILTIN_BACKGROUNDS[1]!.url);
    expect(screen.getByRole("checkbox", { name: uploaded.title })).toBeInTheDocument();
    expect(getState().ambient.selectedIds).toEqual([secondId]);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([path]) => path)).toEqual(["/api/settings"]);
    expect(fetcher.mock.calls.every(([path]) => typeof path === "string" && path.startsWith("/api/"))).toBe(true);
  });

  it("retains the bundled photo when local library metadata cannot refresh", async () => {
    const { fetcher } = await mount();
    const previous = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, init) => path === "/api/backgrounds"
      ? response({}, 503) : previous(path, init));
    await openLibrary();
    expect(screen.getByRole("alert")).toHaveTextContent("Keeping known scenes");
    expect(activeImage()).toHaveAttribute("alt", firstPhoto);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
});

describe("ambient wire migration", () => {
  it("migrates legacy snapshots and validates all ambient settings", () => {
    const { ambient: _ambient, viewMode: _viewMode, ...legacy } = state();
    expect(snapshotSchema.parse(legacy)).toMatchObject({ viewMode: "split", ambient: DEFAULT_AMBIENT });
    expect(snapshotSchema.parse({ ...legacy, viewMode: "ambient" }).ambient).toEqual(DEFAULT_AMBIENT);
    for (const ambient of [
      { ...DEFAULT_AMBIENT, dwellSeconds: 14 }, { ...DEFAULT_AMBIENT, dwellSeconds: 3601 },
      { ...DEFAULT_AMBIENT, slideshow: "yes" }, { ...DEFAULT_AMBIENT, selectedIds: ["../escape"] },
    ]) expect(snapshotSchema.safeParse({ ...legacy, ambient }).success).toBe(false);
  });

  it("rejects external or malformed library image URLs", () => {
    const library: AmbientLibrary = { images: [uploaded], limits };
    expect(ambientLibrarySchema.safeParse(library).success).toBe(true);
    for (const url of ["https://example.com/image.png", "//elsewhere/image.png", "/\\elsewhere/image.png"]) {
      expect(ambientLibrarySchema.safeParse({ ...library, images: [{ ...uploaded, url }] }).success).toBe(false);
      expect(ambientLibrarySchema.safeParse({ ...library, images: [{ ...uploaded, thumbnailUrl: url }] }).success).toBe(false);
    }
    expect(ambientLibrarySchema.safeParse({ ...library, images: [{ ...uploaded, thumbnailUrl: uploaded.url }] }).success).toBe(false);
    expect(ambientLibrarySchema.safeParse({ ...library, images: [{ ...uploaded, width: 3841 }] }).success).toBe(false);
    expect(ambientLibrarySchema.safeParse({ ...library, images: [{ ...uploaded, height: 2161 }] }).success).toBe(false);
    expect(ambientLibrarySchema.safeParse({ ...library, images: [{ ...uploaded, thumbnailBytes: 256 * 1024 + 1 }] }).success).toBe(false);
  });

  it("restricts attribution links to the reviewed HTTPS sources", () => {
    const photo = photoCatalog()[0]!;
    expect(ambientLibrarySchema.safeParse({ images: [photo], limits }).success).toBe(true);
    for (const sourceUrl of ["https://attacker.example/photo", "javascript:alert(1)", "https://www.flickr.com/not-reviewed", "http://www.flickr.com/photo"]) {
      expect(ambientLibrarySchema.safeParse({ images: [{ ...photo, credit: { ...photo.credit, sourceUrl } }], limits }).success).toBe(false);
    }
    expect(ambientLibrarySchema.safeParse({
      images: [{ ...photo, credit: { ...photo.credit, licenseUrl: "https://creativecommons.org/anything" } }], limits,
    }).success).toBe(false);
  });

  it("accepts only the exact trusted versioned catalog URLs for each builtin and its preview", () => {
    const photo = photoCatalog()[0]!;
    expect(ambientLibrarySchema.safeParse({ images: photoCatalog(), limits }).success).toBe(true);
    for (const url of [
      photo.url.split("?")[0], photo.url.replace(/\?v=.*/, "?v=000000000000"),
      `${photo.url}&extra=1`, BUILTIN_BACKGROUNDS[1]!.url, "/api/state",
      `https://attacker.example${photo.url}`, `//attacker.example${photo.url}`,
    ]) {
      expect(ambientLibrarySchema.safeParse({ images: [{ ...photo, url }], limits }).success).toBe(false);
    }
    for (const thumbnailUrl of [
      photo.thumbnailUrl!.split("?")[0], photo.thumbnailUrl!.replace(/\?v=.*/, "?v=000000000000"),
      `${photo.thumbnailUrl}&extra=1`, photo.url, BUILTIN_BACKGROUNDS[1]!.thumbnailUrl,
      `https://attacker.example${photo.thumbnailUrl}`, `//attacker.example${photo.thumbnailUrl}`,
    ]) {
      expect(ambientLibrarySchema.safeParse({ images: [{ ...photo, thumbnailUrl }], limits }).success).toBe(false);
    }
  });
});
