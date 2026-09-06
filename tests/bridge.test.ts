import { describe, expect, it, vi } from "vitest";
import { Bridge, type QueueAnchor } from "../src/server/bridge.js";
import { MonotonicPlaybackClock } from "../src/server/clock.js";
import { parseLyrics } from "../src/server/lrc.js";
import type { Lyrics } from "../src/shared/protocol.js";
import { DEFAULT_AMBIENT } from "../src/shared/ambient.js";

const anchor = (id: string, playback: QueueAnchor["playback"] = "playing", positionMs = 0): QueueAnchor => ({
  itemKey: id, track: { identity: id, title: id, artist: "", album: "", durationMs: 60_000, artworkUrl: null },
  request: { identity: id, uri: id }, positionMs, playback,
});
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
describe("playback state machine", () => {
  it("preserves catalog artwork on sparse external snapshots but not across tracks", async () => {
    const bridge = new Bridge({ capability: "available", fetch: async () => parseLyrics(null) },
      { get: async () => null, put: async () => {} }, { visualOffsetMs: 0 });
    const current: QueueAnchor = { ...anchor("exact:one"), precision: "ma-player" };
    bridge.accept(current);
    bridge.updateArtwork("exact:one", "/api/artwork/catalog-one");
    bridge.accept(current);
    expect(bridge.snapshot().track?.artworkUrl).toBe("/api/artwork/catalog-one");
    bridge.accept({ ...anchor("exact:two"), precision: "ma-player" });
    expect(bridge.snapshot().track?.artworkUrl).toBeNull();
    await flush();
    bridge.close();
  });
  it("cancels queued lyrics for metadata-only sources and recovers when an exact timed identity becomes available", async () => {
    let resolve: ((value: Lyrics) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    const fetch = vi.fn((_request, signal: AbortSignal) => {
      oldSignal = signal;
      return new Promise<Lyrics>((done) => { resolve = done; });
    });
    const cache = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const bridge = new Bridge({ capability: "available", fetch }, cache, { visualOffsetMs: 0 });
    bridge.accept(anchor("queued"));
    await flush();
    const external: QueueAnchor = {
      ...anchor("external:synthetic"), request: null, speed: 0, precision: "ma-player",
      lyricsUnavailable: "No exact track URI.",
    };
    bridge.accept(external);
    expect(oldSignal?.aborted).toBe(true);
    resolve!(parseLyrics("[00:00]Obsolete synthetic lyrics"));
    await flush();
    expect(bridge.snapshot()).toMatchObject({
      precision: "ma-player", speed: 0, lyrics: { status: "unsupported", lines: [], message: "No exact track URI." },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
    bridge.accept({ ...external, request: { identity: "exact:synthetic", uri: "exact:synthetic" }, speed: 1 });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    resolve!(parseLyrics("[00:00]Current synthetic lyrics"));
    await flush();
    expect(bridge.snapshot().lyrics.lines[0]?.text).toBe("Current synthetic lyrics");
    bridge.close();
  });
  it("never changes ambient preferences or view for queue changes, stale state, stop or invalidation", async () => {
    let now = 0;
    const settings = {
      visualOffsetMs: 800, viewMode: "ambient" as const,
      ambient: { ...DEFAULT_AMBIENT, selectedIds: ["builtin-lone-pine"], dwellSeconds: 120 },
    };
    const bridge = new Bridge({ capability: "available", fetch: async () => parseLyrics(null) },
      { get: async () => null, put: async () => {} }, settings, false,
      new MonotonicPlaybackClock(() => now), () => now);
    const unchanged = () => {
      expect(bridge.snapshot()).toMatchObject(settings);
      expect(settings.ambient.selectedIds).toEqual(["builtin-lone-pine"]);
    };
    bridge.accept(anchor("a")); unchanged();
    bridge.accept(anchor("b")); unchanged();
    now = 16_000; bridge.tick(); unchanged();
    expect(bridge.snapshot().connection).toBe("stale");
    now = 46_000; bridge.tick(); unchanged();
    expect(bridge.snapshot().connection).toBe("disconnected");
    bridge.accept(anchor("b", "idle")); unchanged();
    bridge.invalidate("lost queue"); unchanged();
    bridge.snapshot().ambient.selectedIds.push("builtin-golden-gate"); unchanged();
    await flush();
    bridge.close();
  });
  it("retains hydrated artwork across sparse queue snapshots without leaking to next track", async () => {
    const bridge = new Bridge({ capability: "available", fetch: async () => parseLyrics(null) },
      { get: async () => null, put: async () => {} }, { visualOffsetMs: 0 });
    bridge.accept(anchor("a"));
    bridge.updateArtwork("a", "/api/artwork/a");
    bridge.accept(anchor("a"));
    expect(bridge.snapshot().track?.artworkUrl).toBe("/api/artwork/a");
    bridge.accept(anchor("b"));
    bridge.updateArtwork("a", "/api/artwork/a");
    expect(bridge.snapshot().track?.artworkUrl).toBeNull();
    await flush();
    bridge.close();
  });
  it("cancels obsolete fetches and never displays old-track lyrics after next/stop", async () => {
    const pending = new Map<string, (value: Lyrics) => void>();
    const signals: AbortSignal[] = [];
    const provider = { capability: "available" as const, fetch: vi.fn((request: { identity: string }, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<Lyrics>((resolve) => pending.set(request.identity, resolve));
    }) };
    const bridge = new Bridge(provider, { get: async () => null, put: async () => {} }, { visualOffsetMs: 0 });
    bridge.accept(anchor("a"));
    await flush();
    bridge.accept(anchor("b"));
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    pending.get("a")!(parseLyrics("[00:01]Synthetic A"));
    await flush();
    expect(bridge.snapshot().lyrics.status).toBe("loading");
    pending.get("b")!(parseLyrics("[00:01]Synthetic B"));
    await flush();
    expect(bridge.snapshot().lyrics.lines[0]?.text).toBe("Synthetic B");
    bridge.accept(anchor("b", "idle"));
    expect(bridge.snapshot().track).toBeNull();
    expect(bridge.snapshot().lyrics.lines).toEqual([]);
    bridge.close();
  });
  it("reanchors pause/seek/repeat/reconnect and freezes then clears stale state", async () => {
    let now = 0;
    const bridge = new Bridge({ capability: "available", fetch: async () => parseLyrics(null) },
      { get: async () => null, put: async () => {} }, { visualOffsetMs: 100 }, false,
      new MonotonicPlaybackClock(() => now), () => now);
    bridge.accept(anchor("a", "playing", 1000));
    now += 1000;
    expect(bridge.snapshot().positionMs).toBe(2000);
    bridge.accept(anchor("a", "paused", 2000));
    now += 1000;
    expect(bridge.snapshot().positionMs).toBe(2000);
    bridge.accept(anchor("a", "playing", 0));
    now += 1000;
    expect(bridge.snapshot().positionMs).toBe(1000);
    bridge.setConnection("stale");
    now += 20_000;
    expect(bridge.snapshot().speed).toBe(0);
    bridge.tick();
    expect(bridge.snapshot().track?.identity).toBe("a");
    now += 30_000;
    bridge.tick();
    expect(bridge.snapshot().track).toBeNull();
    bridge.accept(anchor("a", "playing", 20_000));
    expect(bridge.snapshot().positionMs).toBe(20_000);
    expect(bridge.snapshot().connection).toBe("connected");
    await flush();
    bridge.close();
  });
});
