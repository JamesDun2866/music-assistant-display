import type { Bridge, QueueAnchor } from "./bridge.js";
import type { LyricsProvider, TrackRequest } from "./provider.js";
import { parseLyrics } from "./lrc.js";
import { DemoArtwork } from "./demo-artwork.js";

const demos = [
  { title: "Synthetic Signal", album: "Chromatic Rooms", text: "[00:00]A little square of morning light\n[00:04]A paper moon above the screen\n[00:08]We count the colors passing by\n[00:12]And name a place we have not been\n[00:16]\n[00:20]The tiny clock begins again", duration: 26 },
  { title: "Soft Geometry", album: "Studies in Amber", text: "This is an original synthetic demonstration.\nPlain lyrics are readable but cannot follow playback.", duration: 15 },
  { title: "A Room Without Words", album: "The Quiet Collection", text: null, duration: 10 },
];
export class DemoProvider implements LyricsProvider {
  readonly capability = "available";
  async fetch(track: TrackRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    return parseLyrics(demos[Number(track.uri.slice("demo:".length))]?.text ?? null);
  }
}
export class DemoPlayer {
  readonly artwork = new DemoArtwork();
  private index = 0;
  private iteration = 0;
  constructor(private readonly bridge: Bridge) {}
  private anchor(positionMs: number, playback: QueueAnchor["playback"]): void {
    const demo = demos[this.index]!;
    this.bridge.accept({
      track: {
        identity: `demo:${this.index}`, title: demo.title, artist: "Local synthetic simulator", album: demo.album,
        durationMs: demo.duration * 1000, artworkUrl: this.index < 2 ? `/api/artwork/demo%3A${this.index}` : null,
      },
      itemKey: `demo:${this.index}:${this.iteration}`, request: { identity: `demo:${this.index}`, uri: `demo:${this.index}` },
      playback, positionMs,
    });
  }
  action(action: "play" | "pause" | "stop" | "next" | "seek", positionMs?: number): void {
    const state = this.bridge.snapshot();
    if (action === "next") { this.index = (this.index + 1) % demos.length; this.iteration++; this.anchor(0, "playing"); }
    else if (action === "stop") this.anchor(0, "idle");
    else if (action === "pause") this.anchor(state.positionMs, "paused");
    else if (action === "play") this.anchor(state.positionMs, "playing");
    else this.anchor(positionMs ?? 0, state.playback === "playing" ? "playing" : "paused");
  }
  tick(): void {
    const state = this.bridge.snapshot();
    if (state.playback === "playing" && state.track?.durationMs && state.positionMs >= state.track.durationMs) this.action("next");
  }
}
