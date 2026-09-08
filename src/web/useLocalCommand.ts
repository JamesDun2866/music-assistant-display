import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { focusNavigation, navigationVisible } from "./navigation.js";

interface CommandOptions {
  raw?: boolean;
  headers?: Record<string, string>;
  accept?: (data: unknown) => void;
  timeoutMs?: 15000 | 45000;
}

export function useLocalCommand() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const activeTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restoreFocus = useRef<{ control: HTMLElement; fallback: HTMLElement | null } | null>(null);
  useLayoutEffect(() => {
    if (pending) return;
    const previous = restoreFocus.current;
    restoreFocus.current = null;
    if (!previous || document.visibilityState === "hidden"
      || ![document.body, document.documentElement].includes(document.activeElement as HTMLElement)) return;
    // Chrome blurs a focused native button when pending makes it disabled.
    const available = (element: HTMLElement | null) => element?.isConnected
      && !element.matches(":disabled") && navigationVisible(element);
    if (available(previous.control)) focusNavigation(previous.control);
    else if (available(previous.fallback)) focusNavigation(previous.fallback);
  });
  useEffect(() => {
    const moved = () => {
      const active = document.activeElement;
      if (restoreFocus.current && active !== restoreFocus.current.control
        && active !== document.body && active !== document.documentElement) restoreFocus.current = null;
    };
    const hidden = () => { if (document.visibilityState === "hidden") restoreFocus.current = null; };
    document.addEventListener("focusin", moved);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      restoreFocus.current = null;
      document.removeEventListener("focusin", moved);
      document.removeEventListener("visibilitychange", hidden);
      activeRequest.current?.abort();
      clearTimeout(activeTimeout.current);
    };
  }, []);
  const execute = useCallback(async (path: string, body: unknown, success: string, options: CommandOptions = {}) => {
    if (busy.current) return false;
    busy.current = true;
    const focused = document.activeElement;
    restoreFocus.current = focused instanceof HTMLElement && focused !== document.body && focused !== document.documentElement
      ? {
        control: focused,
        fallback: focused.closest("details")?.querySelector<HTMLElement>("summary")
          ?? focused.closest(".display")?.querySelector<HTMLElement>("[role='tab'][aria-selected='true']") ?? null,
      } : null;
    setPending(true);
    setError(null);
    setNotice(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    activeRequest.current = controller;
    activeTimeout.current = timeout;
    try {
      // The backend's HMAC secret changes on restart. Refresh before a deliberate
      // mutation rather than retrying (and potentially replaying) the mutation.
      const session = await fetch("/api/session", {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      if (!session.ok) throw new Error("Could not open a local session. Try again.");
      const authorization: unknown = await session.json();
      if (!authorization || typeof authorization !== "object" || !("csrfToken" in authorization)
        || typeof authorization.csrfToken !== "string" || !authorization.csrfToken) {
        throw new Error("The local session response was invalid. Try again.");
      }
      if (controller.signal.aborted) throw new Error("Request cancelled.");
      const response = await fetch(path, {
        method: "POST", credentials: "same-origin", signal: controller.signal,
        headers: {
          "Content-Type": "application/json", ...options.headers, "X-CSRF-Token": authorization.csrfToken,
        },
        body: options.raw ? body as BodyInit : JSON.stringify(body),
      });
      const data: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) throw new Error("Request cancelled.");
      const responseMessage = data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message : null;
      if (!response.ok) {
        throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error : responseMessage || `The command failed (${response.status}). Try again.`);
      }
      options.accept?.(data);
      setNotice(path === "/api/cec" && responseMessage ? responseMessage : success);
      return true;
    } catch (failure) {
      setError(controller.signal.aborted ? "The local service took too long to respond. Try again."
        : failure instanceof Error ? failure.message : "The local service could not be reached. Try again.");
      return false;
    } finally {
      clearTimeout(timeout);
      activeRequest.current = null;
      activeTimeout.current = undefined;
      busy.current = false;
      setPending(false);
    }
  }, []);
  return { execute, pending, error, notice };
}

export type LocalCommand = ReturnType<typeof useLocalCommand>;
