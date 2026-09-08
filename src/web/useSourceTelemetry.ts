import { useSyncExternalStore } from "react";
import { emptySourceTelemetry, sourceTelemetrySchema, type SourceTelemetry } from "../shared/source-tools.js";

const disabledSnapshot = emptySourceTelemetry("inactive");
let snapshot = emptySourceTelemetry("unavailable");
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let staleTimer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | null = null;
let sequence: number | null = null;
let running = false;

function publish(value: SourceTelemetry) {
  snapshot = value;
  for (const listener of listeners) listener();
}

function stop() {
  running = false;
  clearTimeout(timer);
  clearTimeout(staleTimer);
  request?.abort();
  request = null;
  sequence = null;
  publish(emptySourceTelemetry("inactive"));
}

async function poll() {
  if (!running || request) return;
  const controller = new AbortController();
  request = controller;
  const started = performance.now();
  const timeout = setTimeout(() => controller.abort(), 500);
  controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
  try {
    const response = await fetch("/api/source-tools/telemetry", {
      credentials: "same-origin", cache: "no-store", signal: controller.signal,
    });
    if (!response.ok) throw new Error("Telemetry unavailable");
    const parsed = sourceTelemetrySchema.safeParse(await response.json());
    if (!running || request !== controller) return;
    if (controller.signal.aborted || !parsed.success) throw new Error("Invalid telemetry");
    const value = parsed.data;
    const age = value.sampleAgeMs === null ? Infinity : value.sampleAgeMs + performance.now() - started;
    if (value.state !== "active") {
      clearTimeout(staleTimer);
      sequence = null;
      publish({ ...value, left: disabledSnapshot.left, right: disabledSnapshot.right });
    } else if (age >= 500 || (sequence !== null && value.sequence < sequence)) {
      clearTimeout(staleTimer);
      sequence = value.sequence;
      publish(emptySourceTelemetry("stale"));
    } else if (value.sequence === sequence) {
      // Adjacent polls can observe the same publication; keep its original freshness deadline.
      return;
    } else {
      sequence = value.sequence;
      publish(value);
      clearTimeout(staleTimer);
      staleTimer = setTimeout(() => publish(emptySourceTelemetry("stale")), Math.max(0, 500 - age));
    }
  } catch {
    if (running && request === controller) {
      clearTimeout(staleTimer);
      publish(emptySourceTelemetry("unavailable"));
    }
  } finally {
    clearTimeout(timeout);
    if (request === controller) {
      request = null;
      if (running) timer = setTimeout(() => void poll(), Math.max(0, Math.ceil(1000 / 15 - (performance.now() - started))));
    }
  }
}

function visibilityChanged() {
  if (document.visibilityState === "hidden" || !listeners.size) stop();
  else if (!running) {
    running = true;
    publish(emptySourceTelemetry("unavailable"));
    void poll();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", visibilityChanged);
    visibilityChanged();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      document.removeEventListener("visibilitychange", visibilityChanged);
      stop();
    }
  };
}
const noSubscribe = () => () => {};
const getSnapshot = () => snapshot;
const getDisabledSnapshot = () => disabledSnapshot;

export function useSourceTelemetry(enabled = true): SourceTelemetry {
  return useSyncExternalStore(enabled ? subscribe : noSubscribe,
    enabled ? getSnapshot : getDisabledSnapshot, getDisabledSnapshot);
}
