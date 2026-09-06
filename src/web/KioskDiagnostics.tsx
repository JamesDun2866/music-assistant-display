import { useEffect, useRef, useState } from "react";
import { kioskDiagnosticsSchema, type KioskDiagnostics, type KioskPage } from "../shared/kiosk-diagnostics.js";
import { useLocalCommand } from "./useLocalCommand.js";
import { isExplicitKiosk, type RemoteConnection } from "./useRemoteNavigation.js";

export function sampleKioskPage(remote: RemoteConnection, pointer: { x: number; y: number } | null): KioskPage {
  const cursor = (element: Element | null): KioskPage["rootCursor"] =>
    element ? getComputedStyle(element).cursor === "none" ? "none" : "other" : "unavailable";
  const hit = (x: number, y: number) => document.elementFromPoint?.(x, y) ?? null;
  return {
    queryEnabled: isExplicitKiosk(),
    rootPath: window.location.pathname === "/",
    bootstrapEnabled: document.documentElement.dataset.kiosk === "true",
    stylesheetLoaded: Boolean(document.querySelector<HTMLLinkElement>('link[href="/kiosk-mode.css"]')?.sheet),
    visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
    focused: document.hasFocus(),
    fullscreenMedia: window.matchMedia?.("(display-mode: fullscreen)").matches ?? false,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    rootCursor: cursor(document.documentElement),
    bodyCursor: cursor(document.body),
    centerCursor: cursor(hit(window.innerWidth / 2, window.innerHeight / 2)),
    pointerCursor: pointer ? cursor(hit(pointer.x, pointer.y)) : "unavailable",
    pointerObserved: pointer !== null,
    remote,
  };
}

export function useKioskDiagnostics(enabled: boolean, remote: RemoteConnection): string | null {
  const [error, setError] = useState<string | null>(null);
  const currentRemote = useRef(remote);
  currentRemote.current = remote;
  useEffect(() => {
    if (!enabled) return;
    const pageId = crypto.randomUUID();
    let pointer: { x: number; y: number } | null = null;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let active: AbortController | undefined;
    const moved = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; };
    const left = () => { pointer = null; };
    const report = async () => {
      active = new AbortController();
      const timeout = setTimeout(() => active?.abort(), 5_000);
      try {
        const session = await fetch("/api/session", {
          credentials: "same-origin", cache: "no-store", signal: active.signal,
        });
        if (!session.ok) throw new Error("Kiosk diagnostics session unavailable.");
        const data: unknown = await session.json();
        if (!data || typeof data !== "object" || !("csrfToken" in data)
          || typeof data.csrfToken !== "string" || !/^[a-f0-9]{64}$/.test(data.csrfToken)) {
          throw new Error("Kiosk diagnostics session invalid.");
        }
        if (disposed) return;
        const response = await fetch("/api/kiosk/diagnostics/report", {
          method: "POST", credentials: "same-origin", signal: active.signal,
          headers: { "Content-Type": "application/json", "X-CSRF-Token": data.csrfToken },
          body: JSON.stringify({ pageId, page: sampleKioskPage(currentRemote.current, pointer) }),
        });
        if (!response.ok) throw new Error(`Kiosk diagnostics report failed (${response.status}).`);
        await response.body?.cancel();
        if (!disposed) setError(null);
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : "Kiosk diagnostics unavailable.");
      } finally {
        clearTimeout(timeout);
        if (!disposed) timer = setTimeout(() => void report(), 10_000);
      }
    };
    document.addEventListener("pointermove", moved, { passive: true });
    document.documentElement.addEventListener("pointerleave", left);
    window.addEventListener("blur", left);
    // Delayed first sample avoids StrictMode duplicate reports and startup layout.
    timer = setTimeout(() => void report(), 2_000);
    return () => {
      disposed = true;
      clearTimeout(timer);
      active?.abort();
      document.removeEventListener("pointermove", moved);
      document.documentElement.removeEventListener("pointerleave", left);
      window.removeEventListener("blur", left);
    };
  }, [enabled]);
  return error;
}

export function KioskDiagnosticsPanel({ reportError }: { reportError: string | null }) {
  const command = useLocalCommand();
  const [result, setResult] = useState<KioskDiagnostics | null>(null);
  return <section aria-labelledby="kiosk-diagnostics-heading">
    <h2 id="kiosk-diagnostics-heading">Kiosk pointer diagnostics</h2>
    <p>Read the TV page from an admin browser without moving its mouse. Reports expire after 45 seconds.
      Browser focus and CSS are not proof of the Wayland cursor state.</p>
    <button disabled={command.pending} onClick={() => {
      setResult(null);
      void command.execute("/api/kiosk/diagnostics", {}, "Kiosk diagnostics read.", {
        accept: (data) => setResult(kioskDiagnosticsSchema.parse(data)),
      });
    }}>Read kiosk diagnostics</button>
    {(reportError || command.error) && <p role="alert">{reportError || command.error}</p>}
    {result && <pre aria-label="Kiosk diagnostics report">{JSON.stringify(result, null, 2)}</pre>}
  </section>;
}
