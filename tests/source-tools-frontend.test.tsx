// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySourceTelemetry, type CompletedRecording, type SourceHealth, type SourceTelemetry } from "../src/shared/source-tools.js";
import { useSourceTelemetry } from "../src/web/useSourceTelemetry.js";
import { StereoMeters } from "../src/web/StereoMeters.js";
import { RecordingLibrary } from "../src/web/RecordingLibrary.js";
import { SourceHealth as HealthPanel } from "../src/web/SourceHealth.js";
import { ToolsPanel } from "../src/web/ToolsPanel.js";
import { App } from "../src/web/App.js";
import { navigate } from "../src/web/navigation.js";

vi.mock("../src/web/usePlayback.js", () => ({
  usePlayback: () => ({
    snapshot: null, positionMs: 0, displayPositionMs: 0, stale: false, cleared: false, transportError: null,
  }),
}));

const response = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const active = (sequence = 1): SourceTelemetry => ({
  ...emptySourceTelemetry("active"), sequence, sampleAgeMs: 0,
  left: { rmsDbfs: -12, peakDbfs: -3, holdDbfs: -1, possibleClipping: true },
  right: { rmsDbfs: -30, peakDbfs: -20, holdDbfs: -15, possibleClipping: false },
});
const recording: CompletedRecording = {
  id: "recording-1", revision: "revision-1", label: "Evening",
  format: "flac", bytes: 12345, completedAt: "2026-09-08T12:00:00Z", album: null,
};
const health = (): SourceHealth => ({
  version: 1, source: { state: "not-configured" },
  capture: { state: "inactive", evidence: "unknown", evidenceAgeMs: null },
  sendspin: { state: "disconnected", streaming: false }, recording: { state: "unknown" },
  disk: { state: "unavailable", freeBytes: null, totalBytes: null, sampleAgeMs: null },
  versions: { source: null, installedSource: null, toolsAbi: 1, python: null, sendspin: null },
  errors: [], display: { state: "online", mode: "live", ma: "disconnected" },
  application: { version: "0.1.0", build: null, node: "22.0.0" },
});
async function flush() { await act(async () => {}); }
async function advance(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
function visibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("shared passive source telemetry", () => {
  it("shares one 15 Hz poller between consumers, and disables subscribers independently", async () => {
    let sequence = 0;
    const fetcher = vi.fn(async () => response(active(++sequence)));
    vi.stubGlobal("fetch", fetcher);
    const first = renderHook(({ enabled }) => useSourceTelemetry(enabled), { initialProps: { enabled: true } });
    const second = renderHook(() => useSourceTelemetry());
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.result.current).toBe(second.result.current);
    await advance(67);
    expect(fetcher).toHaveBeenCalledTimes(2);
    first.rerender({ enabled: false });
    expect(first.result.current.state).toBe("inactive");
    second.unmount();
    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not overlap requests and aborts hidden/unmounted requests", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((_url: string, options: RequestInit) => {
      signals.push(options.signal as AbortSignal);
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useSourceTelemetry());
    await advance(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    visibility("hidden");
    expect(signals[0]!.aborted).toBe(true);
    expect(hook.result.current.left.rmsDbfs).toBe(-60);
    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    visibility("visible");
    expect(fetcher).toHaveBeenCalledTimes(2);
    hook.unmount();
    expect(signals[1]!.aborted).toBe(true);
  });

  it("clears a good sample at the browser freshness deadline while the next request hangs", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(() => ++call === 1
      ? Promise.resolve(response(active())) : new Promise<Response>(() => {})));
    const hook = renderHook(() => useSourceTelemetry());
    await flush();
    expect(hook.result.current.left.rmsDbfs).toBe(-12);
    await advance(501);
    expect(hook.result.current.state).toBe("stale");
    expect(hook.result.current.left).toEqual(emptySourceTelemetry().left);
  });

  it.each(["offline", "inactive", "not-configured", "unavailable", "stale"] as const)(
    "floors every non-active %s response", async (state) => {
      vi.stubGlobal("fetch", vi.fn(async () => response({ ...active(), state })));
      const hook = renderHook(() => useSourceTelemetry());
      await flush();
      expect(hook.result.current.state).toBe(state);
      expect(hook.result.current.left).toEqual(emptySourceTelemetry().left);
    },
  );

  it.each([
    { description: "aged data", value: { ...active(2), sampleAgeMs: 500 } },
    { description: "missing age", value: { ...active(2), sampleAgeMs: null } },
    { description: "malformed fields", value: { ...active(2), channels: 1 } },
    { description: "nonfinite value", value: { ...active(2), left: { ...active().left, rmsDbfs: NaN } } },
  ])("clears $description instead of retaining old bars", async ({ value }) => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(active())).mockResolvedValue(response(value));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useSourceTelemetry());
    await flush();
    expect(hook.result.current.state).toBe("active");
    await advance(67);
    expect(hook.result.current.left.rmsDbfs).toBe(-60);
    expect(hook.result.current.left.possibleClipping).toBe(false);
  });

  it("keeps duplicate fresh publications until their original freshness budget expires, then recovers on advancement", async () => {
    let value: SourceTelemetry = { ...active(), sampleAgeMs: 100 };
    const fetcher = vi.fn(async () => response(value));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useSourceTelemetry());
    await flush();
    const original = hook.result.current;
    value = { ...active(), sampleAgeMs: 0 };
    await advance(399);
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
    expect(hook.result.current).toBe(original);
    expect(hook.result.current.state).toBe("active");
    await advance(2);
    expect(hook.result.current.state).toBe("stale");
    expect(hook.result.current.left).toEqual(emptySourceTelemetry().left);
    await advance(500);
    expect(hook.result.current.state).toBe("stale");
    value = active(2);
    await advance(67);
    expect(hook.result.current.state).toBe("active");
    expect(hook.result.current.sequence).toBe(2);
    expect(hook.result.current.left.rmsDbfs).toBe(-12);
  });

  it("clears a backwards sequence and recovers when the restarted publisher advances", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(active(100)))
      .mockResolvedValueOnce(response(active(1))).mockResolvedValue(response(active(2))));
    const hook = renderHook(() => useSourceTelemetry());
    await flush();
    await advance(67);
    expect(hook.result.current.state).toBe("stale");
    await advance(67);
    expect(hook.result.current.state).toBe("active");
    expect(hook.result.current.sequence).toBe(2);
  });

  it("clears a failed request and resets freshness on resume, while active silence remains active", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(active()))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(response({ ...emptySourceTelemetry("active"), sequence: 1, sampleAgeMs: 0 }));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useSourceTelemetry());
    await flush();
    await advance(67);
    expect(hook.result.current.state).toBe("unavailable");
    visibility("hidden");
    visibility("visible");
    await flush();
    expect(hook.result.current.state).toBe("active");
    expect(hook.result.current.left.rmsDbfs).toBe(-60);
  });
});

describe("meter presentation", () => {
  it("renders independent RMS/peak/hold without fetching or live-region flooding", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { container, rerender } = render(<StereoMeters telemetry={active()} />);
    expect(screen.getByRole("meter", { name: "Left RMS" })).toHaveAttribute("aria-valuenow", "-12");
    expect(screen.getByRole("meter", { name: "Right RMS" })).toHaveAttribute("aria-valuenow", "-30");
    expect(screen.getByText("Possible input clipping")).toBeInTheDocument();
    expect(container.querySelector("[aria-live], [role='status'], [role='alert']")).toBeNull();
    expect(container.querySelector(".source-meter-hold")).toHaveStyle({ left: `${59 / 60 * 100}%` });
    expect(fetcher).not.toHaveBeenCalled();
    rerender(<StereoMeters telemetry={{ ...active(), state: "offline" }} compact />);
    expect(screen.getByRole("meter", { name: "Left RMS" })).toHaveAttribute("aria-valuenow", "-60");
    expect(screen.queryByText("Possible input clipping")).not.toBeInTheDocument();
    expect(container.querySelector(".source-meters-compact")).not.toBeNull();
  });

  it("clamps malformed presentation values and never schedules animation even with reduced motion", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { container } = render(<StereoMeters telemetry={{
      ...active(), left: { rmsDbfs: Infinity, peakDbfs: 100, holdDbfs: -100, possibleClipping: false },
    }} />);
    expect(screen.getByRole("meter", { name: "Left RMS" })).toHaveAttribute("aria-valuenow", "-60");
    expect(container.querySelector(".source-meter-peak")).toHaveStyle({ left: "100%" });
    expect(container.querySelector(".source-meter-hold")).toHaveStyle({ left: "0%" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["inactive", "Input inactive"], ["stale", "Input stale"], ["offline", "Source offline"],
    ["not-configured", "Source not configured"], ["unavailable", "Input levels unavailable"],
    ["active", "Input active"],
  ] as const)("uses a user-friendly %s status", (state, label) => {
    render(<StereoMeters telemetry={{ ...active(), state }} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe("completed recording actions", () => {
  function service() {
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.startsWith("/api/source-tools/recordings?")) return response({ version: 1, items: [recording], nextCursor: null });
      if (url === "/api/session") return response({ csrfToken: "csrf-token" });
      if (url.endsWith("/label")) return response({ ...recording, revision: "revision-2", label: JSON.parse(options!.body as string).label });
      if (url.endsWith("/album-preview")) return response({
        album: {
          title: "Example album", artist: "Example artist",
          catalog: { kind: "collection", id: "123", country: "gb" },
          provenance: { kind: "recognition", revision: null },
        },
        confirmationToken: "confirmation-1", expiresAt: Date.now() + 60000,
      });
      if (url.endsWith("/album")) return response({ ...recording, revision: "revision-2", album: { title: "Example album", artist: "Example artist" } });
      if (url.endsWith("/download")) return response({ url: "/api/source-tools/downloads/ticket-1" });
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }
  it("saves a display label with revision and CSRF, without recording controls or physical rename", async () => {
    const fetcher = service();
    render(<RecordingLibrary />);
    await flush();
    expect(screen.getByText(/Changes display and download name; original audio is unchanged/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Display and download label"), { target: { value: "../unsafe" } });
    expect(screen.getByRole("button", { name: "Save label" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Display and download label"), { target: { value: "New evening" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save label" })));
    expect(fetcher).toHaveBeenCalledWith("/api/source-tools/recordings/recording-1/label", expect.objectContaining({
      method: "POST", body: JSON.stringify({ revision: "revision-1", label: "New evening" }),
      headers: expect.objectContaining({ "X-CSRF-Token": "csrf-token" }),
    }));
    expect(screen.getByRole("heading", { name: "New evening" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start|rearm|delete|stop/i })).not.toBeInTheDocument();
  });

  it("previews and confirms only the token-bound metadata, with cancel and audio-unchanged wording", async () => {
    const fetcher = service();
    render(<RecordingLibrary />);
    await flush();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Preview album attachment" })));
    expect(screen.getByRole("button", { name: "Cancel attachment" })).toHaveFocus();
    expect(screen.getByText("Catalog: collection 123 (GB) · Provenance: recognition")).toBeInTheDocument();
    expect(screen.getByText(/metadata is not proof of the recording contents/)).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/album"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel attachment" }));
    expect(screen.queryByRole("button", { name: "Confirm album attachment" })).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Preview album attachment" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm album attachment" })));
    expect(fetcher).toHaveBeenCalledWith("/api/source-tools/recordings/recording-1/album", expect.objectContaining({
      body: JSON.stringify({ revision: "revision-1", confirmationToken: "confirmation-1" }),
    }));
    expect(screen.getByText(/Attached album metadata: Example album/)).toBeInTheDocument();
  });

  it("expires an album preview and invalidates it when refreshing the list", async () => {
    service();
    render(<RecordingLibrary />);
    await flush();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Preview album attachment" })));
    await advance(60001);
    expect(screen.queryByRole("button", { name: "Confirm album attachment" })).not.toBeInTheDocument();
    expect(screen.getByText(/Album preview expired/)).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Preview album attachment" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh recordings" })));
    expect(screen.queryByRole("button", { name: "Confirm album attachment" })).not.toBeInTheDocument();
  });

  it("renders corrected album provenance with no catalog without displaying the internal revision", async () => {
    const fetcher = service();
    render(<RecordingLibrary />);
    await flush();
    fetcher.mockImplementation(async (url: string) => url === "/api/session"
      ? response({ csrfToken: "csrf-token" }) : response({
        album: {
          title: "Corrected album", artist: "Corrected artist", catalog: null,
          provenance: { kind: "correction", revision: "private-correction-revision" },
        },
        confirmationToken: "confirmation-2", expiresAt: Date.now() + 60000,
      }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Preview album attachment" })));
    expect(screen.getByText("Catalog: Unknown · Provenance: correction")).toBeInTheDocument();
    expect(screen.queryByText("private-correction-revision")).not.toBeInTheDocument();
  });

  it("uses a browser download link after a CSRF command, never fetching or buffering the audio", async () => {
    const fetcher = service();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<RecordingLibrary />);
    await flush();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Download original audio" })));
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.instances[0]).toHaveAttribute("href", "/api/source-tools/downloads/ticket-1");
    expect(fetcher).toHaveBeenCalledWith("/api/source-tools/recordings/recording-1/download", expect.objectContaining({
      method: "POST", body: JSON.stringify({ revision: "revision-1" }),
    }));
    expect(fetcher.mock.calls.some(([url]) => url.includes("/downloads/"))).toBe(false);
  });

  it("supports empty continuation pages and explicit restart-needed errors", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ version: 1, items: [], nextCursor: "cursor-1" }))
      .mockResolvedValueOnce(response({ error: "restart-needed" }, 409))
      .mockResolvedValue(response({ version: 1, items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);
    render(<RecordingLibrary />);
    await flush();
    expect(screen.queryByText("No completed recordings found.")).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more recordings" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh recordings to restart");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh recordings" })));
    expect(screen.getByText("No completed recordings found.")).toBeInTheDocument();
  });

  it("rejects changed album context without replaying confirmation or sending client album metadata", async () => {
    const fetcher = service();
    render(<RecordingLibrary />);
    await flush();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Preview album attachment" })));
    fetcher.mockImplementation(async (url: string) => url === "/api/session"
      ? response({ csrfToken: "csrf-token" }) : response({ error: "context-changed" }, 409));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm album attachment" })));
    expect(screen.getByRole("alert")).toHaveTextContent("context-changed");
    expect(screen.queryByRole("button", { name: "Confirm album attachment" })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/album"))).toHaveLength(1);
    expect(fetcher.mock.calls.find(([url]) => url.endsWith("/album"))?.[1]?.body)
      .toBe(JSON.stringify({ revision: "revision-1", confirmationToken: "confirmation-1" }));
  });

  it("rejects nonlocal download destinations", async () => {
    const fetcher = service();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<RecordingLibrary />);
    await flush();
    fetcher.mockImplementation(async (url: string) => url === "/api/session"
      ? response({ csrfToken: "csrf-token" }) : response({ url: "https://example.com/private-audio" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Download original audio" })));
    expect(screen.getByRole("alert")).toHaveTextContent("invalid download link");
    expect(click).not.toHaveBeenCalled();
  });

  it.each(["offline", "not-configured"])("handles %s completed-recording sources without fabricated entries", async (error) => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error }, 503)));
    render(<RecordingLibrary />);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(error === "offline" ? "source is offline" : "source is not configured");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByText("No completed recordings found.")).not.toBeInTheDocument();
  });
});

describe("truthful source health", () => {
  it("distinguishes offline optional source, idle device, transport and actual browser connectivity", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(health())).mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    render(<HealthPanel />);
    expect(screen.getByRole("status")).toHaveTextContent("checking");
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("health request succeeded");
    expect(screen.getByText("not-configured")).toBeInTheDocument();
    expect(screen.getByText(/does not verify device health/)).toBeInTheDocument();
    expect(screen.getByText("Unavailable — not a zero-space reading")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download health diagnostics" })).toHaveAttribute("href", "/api/source-tools/diagnostics");
    await advance(2000);
    expect(screen.getByRole("status")).toHaveTextContent("health request failed");
    expect(screen.queryByText("not-configured")).not.toBeInTheDocument();
  });

  it("pauses health polling while hidden and clears invalid snapshots", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(health())).mockResolvedValue(response({ ...health(), secret: "not allowed" }));
    vi.stubGlobal("fetch", fetcher);
    const mounted = render(<HealthPanel />);
    await flush();
    visibility("hidden");
    await advance(10000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("paused while hidden");
    visibility("visible");
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("health request failed");
    expect(screen.queryByText("not allowed")).not.toBeInTheDocument();
    mounted.unmount();
    await advance(5000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("Tools shell integration", () => {
  it("mounts only the selected section, reserves builtin IDs, and accepts the journal extension", async () => {
    const fetcher = vi.fn(async (url: string) => response(url.endsWith("/telemetry") ? active() : health()));
    vi.stubGlobal("fetch", fetcher);
    render(<ToolsPanel onClose={vi.fn()} extraSections={[{ id: "journal", title: "Journal", content: <p>Journal extension</p> }]} />);
    await flush();
    expect(screen.queryByText("Journal extension")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Journal" }));
    expect(screen.getByText("Journal extension")).toBeInTheDocument();
    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "Health" }));
    await flush();
    expect(screen.queryByText("Journal extension")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate builtin or extension IDs", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<ToolsPanel onClose={vi.fn()}
      extraSections={[{ id: "health", title: "Other", content: null }]} />)).toThrow("must be unique");
  });

  it("provides an explicit entry outside display tabs, traps focus and restores it on Escape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(active())));
    render(<App />);
    const trigger = screen.getByRole("button", { name: "Tools" });
    expect(within(screen.getByRole("tablist", { name: "Display view" })).queryByText("Tools")).not.toBeInTheDocument();
    trigger.focus();
    fireEvent.click(trigger);
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Source tools" });
    const close = within(dialog).getByRole("button", { name: "Close tools" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(within(dialog).getByRole("tabpanel")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("uses the existing TV navigation contract for section arrows, select and Back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(active())));
    const close = vi.fn();
    const { container } = render(<ToolsPanel onClose={close} />);
    await flush();
    const meters = screen.getByRole("tab", { name: "Meters" });
    meters.focus();
    act(() => { navigate(container, { key: "right", repeat: false }); });
    expect(screen.getByRole("tab", { name: "Recordings" })).toHaveFocus();
    act(() => { navigate(container, { key: "select", repeat: false }); });
    await flush();
    expect(screen.getByRole("tab", { name: "Recordings" })).toHaveAttribute("aria-selected", "true");
    act(() => { navigate(container, { key: "back", repeat: false }); });
    expect(close).toHaveBeenCalledOnce();
  });
});
