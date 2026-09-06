import type { Snapshot } from "../shared/protocol.js";

/** A monotonic, receipt-anchored visual clock; never use wall time for playback. */
export class PlaybackClock {
  private anchorMs = 0;
  private receivedAt = 0;
  private speed: 0 | 1 = 0;
  private durationMs: number | null = null;
  private offsetMs = 0;

  anchor(snapshot: Snapshot, now = performance.now()): void {
    this.anchorMs = snapshot.positionMs;
    this.receivedAt = now;
    this.speed = snapshot.connection === "connected" && snapshot.playback === "playing"
      ? snapshot.speed : 0;
    this.durationMs = snapshot.track?.durationMs ?? null;
    this.offsetMs = snapshot.visualOffsetMs;
  }

  position(now = performance.now()): number {
    const elapsed = Math.max(0, now - this.receivedAt);
    return this.clamp(this.anchorMs + elapsed * this.speed);
  }

  displayPosition(now = performance.now()): number {
    // Keep negative positions: a negative offset must also delay the first line.
    return this.position(now) + this.offsetMs;
  }

  freeze(now = performance.now()): void {
    this.anchorMs = this.position(now);
    this.receivedAt = now;
    this.speed = 0;
  }

  private clamp(value: number): number {
    return Math.max(0, this.durationMs === null ? value : Math.min(value, this.durationMs));
  }
}

export function activeLineIndex(lines: readonly { timeMs: number }[], positionMs: number): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle]!.timeMs <= positionMs) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
