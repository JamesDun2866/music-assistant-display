import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RemoteEventConsumer, type NavigationAction } from "./remoteEvents.js";

export type RemoteConnection = "disabled" | "connecting" | "connected" | "waiting" | "reconnecting" | "paused";
export interface RemoteTransport {
  fetch?: typeof fetch;
  now?: () => number;
  randomUUID?: () => string;
}
const defaultTransport: RemoteTransport = {};

export function isExplicitKiosk(search = window.location.search): boolean {
  return new URLSearchParams(search).get("kiosk") === "1";
}

export function useRemoteNavigation(
  enabled: boolean, onAction: (action: NavigationAction) => void, transport: RemoteTransport = defaultTransport,
): RemoteConnection {
  const [status, setStatus] = useState<RemoteConnection>(enabled ? "connecting" : "disabled");
  const callback = useRef(onAction);
  const pageId = useRef<string | null>(null);
  const inFlight = useRef<Promise<void>>(Promise.resolve());
  useLayoutEffect(() => { callback.current = onAction; }, [onAction]);

  useEffect(() => {
    if (!enabled) { setStatus("disabled"); return; }
    const request = transport.fetch ?? fetch;
    pageId.current ??= transport.randomUUID?.() ?? crypto.randomUUID();
    let disposed = false;
    let active: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1_000;

    const connect = () => {
      if (disposed || document.visibilityState === "hidden" || active) return;
      const controller = new AbortController();
      active = controller;
      setStatus("connecting");
      // Serialize even across StrictMode effect cleanup and visibility changes.
      inFlight.current = inFlight.current.catch(() => {}).then(async () => {
        if (controller.signal.aborted) return;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let renewTimer: ReturnType<typeof setTimeout> | undefined;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        let renewRequest: AbortController | undefined;
        let renewTimeout: ReturnType<typeof setTimeout> | undefined;
        let occupied = false;
        const valid = () => !disposed && active === controller && !controller.signal.aborted;
        const deadline = (ms: number) => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => controller.abort(), ms);
        };
        const abort = () => {
          clearTimeout(watchdog);
          clearTimeout(renewTimer);
          clearTimeout(renewTimeout);
          renewRequest?.abort();
          void reader?.cancel().catch(() => {});
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        deadline(10_000);
        try {
          const session = await request("/api/session", {
            credentials: "same-origin", cache: "no-store", signal: controller.signal,
          });
          if (!session.ok) throw new Error("Local session unavailable.");
          const data: unknown = await session.json();
          if (!data || typeof data !== "object" || !("csrfToken" in data)
            || typeof data.csrfToken !== "string" || !data.csrfToken || data.csrfToken.length > 4096) {
            throw new Error("Invalid local session.");
          }
          if (!valid()) return;
          const headers = { "Content-Type": "application/json", "X-CSRF-Token": data.csrfToken };
          const renew = async (epoch: string) => {
            if (!valid()) return;
            renewRequest = new AbortController();
            renewTimeout = setTimeout(() => renewRequest?.abort(), 5_000);
            try {
              const response = await request("/api/kiosk/remote/renew", {
                method: "POST", credentials: "same-origin", headers, signal: renewRequest.signal,
                body: JSON.stringify({ pageId: pageId.current, epoch }),
              });
              if (!response.ok) throw new Error("Remote lease expired.");
              await response.body?.cancel();
              if (valid()) renewTimer = setTimeout(() => void renew(epoch), 10_000);
            } catch {
              controller.abort();
            } finally {
              clearTimeout(renewTimeout);
              renewRequest = undefined;
            }
          };
          const response = await request("/api/kiosk/remote", {
            method: "POST", credentials: "same-origin", cache: "no-store", headers,
            signal: controller.signal, body: JSON.stringify({ pageId: pageId.current, role: "kiosk" }),
          });
          occupied = response.status === 409;
          if (!response.ok || !/^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "")
            || !response.body) {
            await response.body?.cancel();
            throw new Error("Remote stream unavailable.");
          }
          if (!valid()) { await response.body.cancel(); return; }
          const consumer = new RemoteEventConsumer(
            (action) => { if (valid() && document.visibilityState !== "hidden") callback.current(action); },
            (epoch) => {
              if (!valid()) return;
              setStatus("connected");
              delay = 1_000;
              renewTimer = setTimeout(() => void renew(epoch), 10_000);
            },
            () => deadline(20_000),
            transport.now,
          );
          reader = response.body.getReader();
          while (valid()) {
            const { done, value } = await reader.read();
            if (done || !valid()) break;
            consumer.push(value);
          }
        } catch {
          // Input is ephemeral: reconnect with a fresh session and a fresh decoder, never replay.
        } finally {
          abort();
          controller.signal.removeEventListener("abort", abort);
          controller.abort();
          if (active === controller) {
            active = null;
            if (!disposed && document.visibilityState !== "hidden") {
              setStatus(occupied ? "waiting" : "reconnecting");
              retry = setTimeout(() => { retry = undefined; connect(); }, delay);
              delay = Math.min(15_000, delay * 2);
            }
          }
        }
      });
    };
    const visibility = () => {
      clearTimeout(retry);
      retry = undefined;
      active?.abort();
      active = null;
      if (document.visibilityState === "hidden") setStatus("paused");
      else { delay = 1_000; connect(); }
    };
    document.addEventListener("visibilitychange", visibility);
    if (document.visibilityState === "hidden") setStatus("paused");
    else connect();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", visibility);
      clearTimeout(retry);
      active?.abort();
      active = null;
    };
  }, [enabled, transport]);
  return status;
}
