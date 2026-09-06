import type { Lyrics } from "../shared/protocol.js";

export interface TrackRequest {
  identity: string;
  uri: string;
}
export interface LyricsProvider {
  readonly capability: "available" | "unsupported";
  fetch(track: TrackRequest, signal: AbortSignal): Promise<Lyrics>;
}

/** Deliberate capability boundary, not a Sendspin protocol implementation. */
export class UnavailableSendspinLyricsProvider implements LyricsProvider {
  readonly capability = "unsupported";
  async fetch(_track: TrackRequest, signal: AbortSignal): Promise<Lyrics> {
    signal.throwIfAborted();
    return {
      status: "unsupported", lines: [], plain: null,
      message: "Native Sendspin lyrics are not supported by this release. Use the Music Assistant provider.",
    };
  }
}
