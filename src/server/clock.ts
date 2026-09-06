export interface PlaybackClock {
  position(): number;
  anchor(positionMs: number, speed: 0 | 1, durationMs?: number | null): void;
  freeze(): void;
  readonly speed: 0 | 1;
}

/** Queue positions are seconds upstream, milliseconds everywhere in this service. */
export class MonotonicPlaybackClock implements PlaybackClock {
  private positionMs = 0;
  private at = 0;
  private duration: number | null = null;
  speed: 0 | 1 = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}
  position(): number {
    const position = this.positionMs + Math.max(0, this.now() - this.at) * this.speed;
    return Math.max(0, this.duration === null ? position : Math.min(position, this.duration));
  }
  anchor(positionMs: number, speed: 0 | 1, durationMs: number | null = null): void {
    if (!Number.isFinite(positionMs) || (durationMs !== null && (!Number.isFinite(durationMs) || durationMs < 0))) {
      throw new Error("invalid_clock_anchor");
    }
    this.positionMs = Math.max(0, positionMs);
    this.at = this.now();
    this.speed = speed;
    this.duration = durationMs;
  }
  freeze(): void { this.anchor(this.position(), 0, this.duration); }
}
