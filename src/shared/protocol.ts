export type PlaybackState = "playing" | "paused" | "idle";
export type ConnectionState = "connecting" | "connected" | "stale" | "disconnected";
export type LyricsStatus = "loading" | "timed" | "plain" | "missing" | "error" | "unsupported";
export type ViewMode = "now-playing" | "lyrics" | "split" | "ambient";
export type LyricFollowMode = "smooth" | "instant";

export interface TimedLine {
  timeMs: number;
  text: string;
}
export interface Lyrics {
  status: LyricsStatus;
  lines: TimedLine[];
  plain: string | null;
  message: string | null;
}
export interface Track {
  identity: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  artworkUrl: string | null;
}
export interface CecStatus {
  enabled: boolean;
  available: boolean;
  message: string;
  owned: boolean;
  remote?: import("./remote.js").CecRemoteStatus;
}
export interface Snapshot {
  sequence: number;
  generation: number;
  demo: boolean;
  connection: ConnectionState;
  playback: PlaybackState;
  track: Track | null;
  lyrics: Lyrics;
  /** Position sampled at snapshot creation; browser reanchors on receipt. */
  positionMs: number;
  speed: 0 | 1;
  visualOffsetMs: number;
  viewMode: ViewMode;
  lyricFollowMode: LyricFollowMode;
  ambient: AmbientSettings;
  precision: "ma-queue" | "ma-player" | "demo";
  message: string | null;
  cec: CecStatus;
}
export type CecCommand = "wake" | "active-source" | "standby";
export const emptyLyrics = (): Lyrics => ({
  status: "missing", lines: [], plain: null, message: null,
});
import type { AmbientSettings } from "./ambient.js";
