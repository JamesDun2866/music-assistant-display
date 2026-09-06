// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { sampleKioskPage, useKioskDiagnostics } from "../src/web/KioskDiagnostics.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
  delete document.documentElement.dataset.kiosk;
  document.documentElement.style.cursor = "";
});

it("samples only fixed booleans, dimensions and cursor enums, never page content or URL secrets", () => {
  window.history.replaceState({}, "", "/?kiosk=1&secret=do-not-report");
  document.documentElement.dataset.kiosk = "true";
  document.documentElement.style.cursor = "none";
  const result = sampleKioskPage("connected", null);
  expect(result).toMatchObject({
    queryEnabled: true, bootstrapEnabled: true, rootPath: true, rootCursor: "none",
    stylesheetLoaded: false, pointerObserved: false, pointerCursor: "unavailable", remote: "connected",
  });
  expect(JSON.stringify(result)).not.toMatch(/secret|do-not-report/);
  delete document.documentElement.dataset.kiosk;
  expect(sampleKioskPage("waiting", null).bootstrapEnabled).toBe(false);
});

it("never reports or changes pointer styles in an ordinary admin browser", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  renderHook(() => useKioskDiagnostics(false, "disabled"));
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(fetcher).not.toHaveBeenCalled();
  expect(document.documentElement.dataset.kiosk).toBeUndefined();
  expect(document.documentElement.style.cursor).toBe("");
});

it("reports once per interval across StrictMode, samples current status and cleans up", async () => {
  vi.useFakeTimers();
  window.history.replaceState({}, "", "/?kiosk=1");
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(
    url === "/api/session" ? { csrfToken: "a".repeat(64) } : { ok: true },
  )));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(({ remote }) => useKioskDiagnostics(true, remote),
    { initialProps: { remote: "connected" as "connected" | "paused" }, wrapper: StrictMode });
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenLastCalledWith("/api/kiosk/diagnostics/report", expect.objectContaining({
    method: "POST", headers: expect.objectContaining({ "X-CSRF-Token": "a".repeat(64) }),
    body: expect.stringContaining('"remote":"connected"'),
  }));
  hook.rerender({ remote: "paused" });
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher).toHaveBeenLastCalledWith("/api/kiosk/diagnostics/report", expect.objectContaining({
    body: expect.stringContaining('"remote":"paused"'),
  }));
  expect(hook.result.current).toBeNull();
  hook.unmount();
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("surfaces failures and retries without interfering with remote transport", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => new Response("{}", { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const hook = renderHook(() => useKioskDiagnostics(true, "connected"));
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(hook.result.current).toBe("Kiosk diagnostics session unavailable.");
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(fetcher).toHaveBeenCalledTimes(2);
});
