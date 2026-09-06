import { EventEmitter } from "node:events";
import type { ConnectionState, Lyrics, PlaybackState, Snapshot, Track } from "../shared/protocol.js";
import { emptyLyrics } from "../shared/protocol.js";
import { DEFAULT_AMBIENT } from "../shared/ambient.js";
import type { LyricsProvider, TrackRequest } from "./provider.js";
import { MonotonicPlaybackClock, type PlaybackClock } from "./clock.js";
import type { LyricsCache } from "./cache.js";
import type { SettingsStore } from "./settings.js";
import { log } from "./log.js";

export interface QueueAnchor {
  track: Track | null;
  itemKey: string | null;
  request: TrackRequest | null;
  playback: PlaybackState;
  positionMs: number;
  next?: TrackRequest | null;
  precision?: "ma-queue" | "ma-player";
  speed?: 0 | 1;
  lyricsUnavailable?: string;
}
export class Bridge extends EventEmitter {
  private generation = 0;
  private sequence = 0;
  private track: Track | null = null;
  private hydratedArtwork: string | null = null;
  private itemKey: string | null = null;
  private lyrics: Lyrics = emptyLyrics();
  private connection: ConnectionState = "connecting";
  private playback: PlaybackState = "idle";
  private message: string | null = null;
  private abort: AbortController | null = null;
  private preloadAbort: AbortController | null = null;
  private lastAnchor = 0;
  private lastPreload: string | null = null;
  private request: TrackRequest | null = null;
  private retryAt = 0;
  private precision: "ma-queue" | "ma-player" = "ma-queue";
  constructor(
    private readonly provider: LyricsProvider,
    private readonly cache: Pick<LyricsCache, "get" | "put">,
    private readonly settings: Pick<SettingsStore, "visualOffsetMs"> & Partial<Pick<SettingsStore, "viewMode" | "ambient" | "lyricFollowMode">>,
    readonly demo = false,
    private readonly clock: PlaybackClock = new MonotonicPlaybackClock(),
    private readonly now = () => performance.now(),
  ) { super(); }

  snapshot(cec: Snapshot["cec"] = { enabled: false, available: false, message: "CEC disabled", owned: false }): Snapshot {
    return {
      sequence: ++this.sequence, generation: this.generation, demo: this.demo,
      connection: this.connection, playback: this.playback, track: this.track,
      lyrics: this.lyrics, positionMs: this.clock.position(), speed: this.clock.speed,
      visualOffsetMs: this.settings.visualOffsetMs, precision: this.demo ? "demo" : this.precision,
      viewMode: this.settings.viewMode ?? "split",
      lyricFollowMode: this.settings.lyricFollowMode ?? "smooth",
      ambient: structuredClone(this.settings.ambient ?? DEFAULT_AMBIENT),
      message: this.message, cec,
    };
  }
  setConnection(state: ConnectionState, message: string | null = null): void {
    this.connection = state;
    this.message = message;
    if (state !== "connected") this.clock.freeze();
    this.changed();
  }
  invalidate(message: string): void {
    this.generation++;
    this.abort?.abort();
    this.preloadAbort?.abort();
    this.itemKey = null;
    this.track = null;
    this.request = null;
    this.lyrics = emptyLyrics();
    this.clock.anchor(0, 0);
    this.playback = "idle";
    this.setConnection("stale", message);
  }
  updateArtwork(identity: string, artworkUrl: string): void {
    if (this.track?.identity !== identity) return;
    this.hydratedArtwork = artworkUrl;
    this.track = { ...this.track, artworkUrl };
    this.changed();
  }
  accept(anchor: QueueAnchor): void {
    this.lastAnchor = this.now();
    this.connection = "connected";
    this.message = null;
    this.playback = anchor.playback;
    this.precision = anchor.precision ?? "ma-queue";
    const nextTrack = anchor.playback === "idle" ? null : anchor.track;
    const key = nextTrack ? `${anchor.itemKey}\0${nextTrack.identity}\0${anchor.request?.identity ?? ""}` : null;
    if (key !== this.itemKey) {
      this.itemKey = key;
      this.generation++;
      this.abort?.abort();
      this.preloadAbort?.abort();
      this.lastPreload = null;
      this.request = nextTrack ? anchor.request : null;
      this.hydratedArtwork = null;
      this.track = nextTrack;
      this.lyrics = nextTrack ? this.request
        ? { ...emptyLyrics(), status: "loading", message: "Loading lyrics..." }
        : { ...emptyLyrics(), status: "unsupported", message: anchor.lyricsUnavailable ?? "No exact lyrics identity is available." }
        : emptyLyrics();
      if (this.request) void this.load(this.request, this.generation);
    } else {
      this.track = nextTrack ? { ...nextTrack, artworkUrl: nextTrack.artworkUrl
        ?? this.hydratedArtwork
        ?? (anchor.precision === "ma-player" ? null : this.track?.artworkUrl ?? null) } : null;
      if (this.request && this.lyrics.status === "error" && this.now() >= this.retryAt && !this.abort) {
        void this.load(this.request, this.generation);
      }
    }
    this.clock.anchor(nextTrack ? anchor.positionMs : 0,
      nextTrack && anchor.playback === "playing" ? anchor.speed ?? 1 : 0, nextTrack?.durationMs);
    if (anchor.next && nextTrack && this.lyrics.status !== "loading" && anchor.next.identity !== this.lastPreload && anchor.next.identity !== nextTrack.identity) {
      this.lastPreload = anchor.next.identity;
      void this.preload(anchor.next);
    }
    this.changed();
  }
  tick(): void {
    if (!this.demo && this.now() - this.lastAnchor > 15_000 && this.connection === "connected") {
      this.setConnection("stale", "Music Assistant queue updates are stale; timing frozen.");
    }
    if (!this.demo && this.now() - this.lastAnchor > 45_000 && this.track) {
      this.generation++;
      this.abort?.abort();
      this.preloadAbort?.abort();
      this.itemKey = null;
      this.track = null;
      this.request = null;
      this.lyrics = emptyLyrics();
      this.clock.anchor(0, 0);
      this.playback = "idle";
      this.connection = "disconnected";
      this.message = "Music Assistant unavailable; waiting to reanchor.";
      this.changed();
    }
  }
  private async load(request: TrackRequest, generation: number): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    try {
      const lyrics = await this.cache.get(request.identity) ?? await this.provider.fetch(request, controller.signal);
      if (generation !== this.generation || controller.signal.aborted) return;
      this.lyrics = lyrics;
      this.changed();
      await this.cache.put(request.identity, lyrics);
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.retryAt = this.now() + 60_000;
      this.lyrics = { ...emptyLyrics(), status: "error", message: "Lyrics unavailable: upstream or local cache error. Retrying in one minute." };
      log("lyrics_load_failed", error instanceof Error && error.message === "lyrics_too_large" ? "payload_limit" : "provider_or_cache");
      this.changed();
    } finally {
      if (this.abort === controller) this.abort = null;
    }
  }
  private async preload(request: TrackRequest): Promise<void> {
    this.preloadAbort?.abort();
    const controller = new AbortController();
    this.preloadAbort = controller;
    try {
      if (await this.cache.get(request.identity) || controller.signal.aborted) return;
      const value = await this.provider.fetch(request, controller.signal);
      if (!controller.signal.aborted) await this.cache.put(request.identity, value);
    } catch {
      if (!controller.signal.aborted) log("lyrics_preload_failed", "provider_or_cache");
    }
  }
  changed(): void { this.emit("change"); }
  close(): void { this.abort?.abort(); this.preloadAbort?.abort(); this.removeAllListeners(); }
}
