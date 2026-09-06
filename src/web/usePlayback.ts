import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/protocol.js";
import { emptyLyrics } from "../shared/protocol.js";
import { PlaybackClock } from "./clock.js";
import { snapshotSchema } from "./schema.js";

export const STALE_AFTER_MS = 5_000;
export const CLEAR_AFTER_MS = 20_000;

export function reconnectDelayMs(baseDelayMs: number, random = Math.random): number {
  const capped = Math.min(15_000, Math.max(1_000, baseDelayMs));
  return Math.round(capped * (0.5 + random() * 0.5));
}

export interface PlaybackView {
  snapshot: Snapshot | null;
  positionMs: number;
  displayPositionMs: number;
  stale: boolean;
  cleared: boolean;
  transportError: string | null;
}

export function usePlayback(): PlaybackView {
  const clock = useRef(new PlaybackClock());
  const [view, setView] = useState<PlaybackView>({
    snapshot: null, positionMs: 0, displayPositionMs: 0,
    stale: false, cleared: false, transportError: null,
  });

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1_000;
    let receivedAt = performance.now();
    let attemptedAt = receivedAt;
    let staleSince: number | null = null;
    let stale = false;
    let current: Snapshot | null = null;
    let transportError: string | null = null;
    let acceptedEvents = 0;
    let connectionAttempt = 0;
    let latestSequence = -1;
    let latestGeneration = -1;
    const abort = new AbortController();

    const publish = () => {
      if (disposed) return;
      const now = performance.now();
      const cleared = stale && now - (staleSince ?? receivedAt) >= CLEAR_AFTER_MS;
      setView({
        snapshot: cleared && current
          ? { ...current, track: null, lyrics: emptyLyrics(), positionMs: 0, speed: 0 }
          : current,
        positionMs: clock.current.position(now),
        displayPositionMs: clock.current.displayPosition(now),
        stale, cleared, transportError,
      });
    };

    const markStale = (message: string, since = performance.now()) => {
      if (!stale) clock.current.freeze(Math.min(performance.now(), receivedAt + STALE_AFTER_MS));
      stale = true;
      staleSince ??= since;
      transportError = message;
      publish();
    };

    const scheduleRetry = () => {
      source?.close();
      source = null;
      if (disposed || retry !== undefined) return;
      retry = setTimeout(() => {
        retry = undefined;
        connect();
      }, reconnectDelayMs(retryDelay));
      retryDelay = Math.min(retryDelay * 2, 15_000);
    };

    const accept = (input: unknown) => {
      const result = snapshotSchema.safeParse(input);
      if (!result.success) {
        markStale("The display received an invalid update. Reconnecting…");
        scheduleRetry();
        return;
      }
      const next = result.data;
      // A seek may rewind position, but a duplicate or older snapshot must not.
      if (next.sequence <= latestSequence || next.generation < latestGeneration) return;
      latestSequence = next.sequence;
      latestGeneration = next.generation;
      const now = performance.now();
      // JSON/schema parsing creates new arrays even for unchanged heartbeats.
      // Compare only accepted snapshots (bounded by the schema), not clock ticks.
      const previous = current;
      current = previous?.track && next.track?.identity === previous.track.identity
        && next.generation === previous.generation && next.lyrics.status === previous.lyrics.status
        && next.lyrics.lines.length === previous.lyrics.lines.length
        && next.lyrics.lines.every((line, index) => {
          const previousLine = previous.lyrics.lines[index]!;
          return line.timeMs === previousLine.timeMs && line.text === previousLine.text;
        })
        ? { ...next, lyrics: { ...next.lyrics, lines: previous.lyrics.lines } }
        : next;
      receivedAt = now;
      const upstreamStale = current.connection !== "connected";
      if (upstreamStale) {
        if (!stale) clock.current.freeze(now);
        staleSince ??= now;
      } else {
        staleSince = null;
      }
      stale = upstreamStale;
      transportError = null;
      clock.current.anchor(current, now);
      retryDelay = 1_000;
      publish();
    };

    const connect = () => {
      if (disposed) return;
      attemptedAt = performance.now();
      connectionAttempt += 1;
      // A newly established stream may belong to a restarted server.
      latestSequence = -1;
      latestGeneration = -1;
      try {
        source = new EventSource("/api/events");
        const activeSource = source;
        source.addEventListener("state", (event) => {
          if (disposed || source !== activeSource) return;
          acceptedEvents += 1;
          try {
            accept(JSON.parse((event as MessageEvent<string>).data));
          } catch {
            markStale("The display received an unreadable update. Reconnecting…");
            scheduleRetry();
          }
        });
        source.onerror = () => {
          if (disposed || source !== activeSource) return;
          markStale("Connection interrupted. Reconnecting automatically…");
          scheduleRetry();
        };
      } catch {
        markStale("Live updates are unavailable. Reconnecting…");
        scheduleRetry();
      }
    };

    connect();
    const eventCountAtFetch = acceptedEvents;
    const attemptAtFetch = connectionAttempt;
    void fetch("/api/state", { signal: abort.signal, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("State request failed");
        const data: unknown = await response.json();
        if (!disposed && acceptedEvents === eventCountAtFetch && connectionAttempt === attemptAtFetch) accept(data);
      })
      .catch(() => {
        if (!disposed && acceptedEvents === eventCountAtFetch && connectionAttempt === attemptAtFetch) {
          markStale("Waiting for the local service. Reconnecting automatically…");
        }
      });

    const timer = setInterval(() => {
      const now = performance.now();
      if (now - receivedAt >= STALE_AFTER_MS) {
        // Freeze at the deadline even if the browser throttled this timer.
        markStale("No recent updates. Lyrics are frozen until the connection returns.", receivedAt);
        if (source && now - attemptedAt >= STALE_AFTER_MS) scheduleRetry();
      }
      publish();
    }, 100);
    return () => {
      disposed = true;
      abort.abort();
      source?.close();
      clearInterval(timer);
      if (retry !== undefined) clearTimeout(retry);
    };
  }, []);

  return view;
}
