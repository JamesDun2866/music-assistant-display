import { z } from "zod";
import type { Bridge, QueueAnchor } from "./bridge.js";
import type { MaClient, MaEvent } from "./ma-client.js";
import { imageId, imageSchema, mediaSchema } from "./ma-provider.js";
import type { ArtworkStore } from "./artwork.js";
import { log } from "./log.js";
import { playerAnchor, playerEventSchema } from "./ma-player.js";

const itemSchema = z.object({
  queue_item_id: z.string().max(4096),
  name: z.string().max(4096),
  duration: z.number().finite().nonnegative().nullable().optional(),
  media_item: mediaSchema.nullable().optional(),
  image: imageSchema.nullable().optional(),
});
export const queueSchema = z.object({
  queue_id: z.string(),
  available: z.boolean(),
  active: z.boolean(),
  state: z.enum(["playing", "paused", "idle"]),
  elapsed_time: z.number().finite().nonnegative(),
  elapsed_time_last_updated: z.number().finite().nonnegative(),
  playback_speed: z.number().finite().positive().default(1),
  current_item: itemSchema.nullable().optional(),
  next_item: itemSchema.nullable().optional(),
});
export function queueAnchor(raw: unknown, queueId: string, serverNowMs: number, artwork?: ArtworkStore): QueueAnchor {
  const queue = queueSchema.parse(raw);
  if (queue.queue_id !== queueId) throw new Error("target_queue_mismatch");
  if (!queue.available) throw new Error("target_queue_unavailable");
  if (queue.state !== "idle" && !queue.active) throw new Error("target_queue_inactive");
  if (queue.playback_speed !== 1) throw new Error("unsupported_playback_speed");
  const item = queue.current_item;
  const media = item?.media_item;
  if (!item || !media || queue.state === "idle") {
    return { track: null, itemKey: null, request: null, playback: "idle", positionMs: 0 };
  }
  if (media.media_type !== "track") throw new Error("unsupported_media_type");
  const elapsedAge = queue.state === "playing" ? (serverNowMs - queue.elapsed_time_last_updated * 1000) : 0;
  if (elapsedAge > 120_000 || elapsedAge < -5000) throw new Error("stale_or_invalid_queue_timestamp");
  const proxyId = item.image?.proxy_id ?? imageId(media);
  const next = queue.next_item?.media_item;
  return {
    track: {
      identity: media.uri, title: media.name || item.name,
      artist: media.artists?.map((artist) => artist.name).join(", ") ?? "",
      album: media.album?.name ?? "", durationMs: (item.duration ?? media.duration) == null ? null : (item.duration ?? media.duration)! * 1000,
      artworkUrl: proxyId && artwork ? artwork.set(media.uri, proxyId) : null,
    },
    itemKey: `${queueId}:${item.queue_item_id}`,
    request: { identity: media.uri, uri: media.uri },
    playback: queue.state, positionMs: queue.elapsed_time * 1000 + Math.max(0, elapsedAge),
    next: next?.media_type === "track" ? { identity: next.uri, uri: next.uri } : null,
  };
}
export class MaMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private authenticated = false;
  private revision = 0;
  private abort: AbortController | null = null;
  private current: QueueAnchor | null = null;
  private routing = new Map<string, string>();
  private structure: string | null = null;
  private timingSequence = 0;
  private latestTime: { positionMs: number; at: number; revision: number; sequence: number } | null = null;
  constructor(private readonly client: MaClient, private readonly bridge: Bridge,
    private readonly playerId: string, private readonly queueId: string, private readonly artwork: ArtworkStore) {}
  start(): void {
    this.client.on("authenticated", this.onAuthenticated);
    this.client.on("connection", this.onConnection);
    this.client.on("event", this.onEvent);
    this.timer = setInterval(() => this.schedule(), 10_000);
    this.client.start();
  }
  private onAuthenticated = () => { this.authenticated = true; this.revision++; void this.refresh(); };
  private onConnection = (state: "connecting" | "stale", message: string) => {
    this.authenticated = false;
    this.current = null;
    this.structure = null;
    this.latestTime = null;
    this.revision++;
    this.abort?.abort();
    this.bridge.setConnection(state, message);
  };
  private onEvent = (event: MaEvent) => {
    if (event.object_id !== this.queueId && event.object_id !== this.playerId) return;
    if (!["queue_updated", "queue_items_updated", "queue_time_updated", "player_updated", "player_added", "player_removed"].includes(event.event)) return;
    if (event.event.startsWith("queue_") && this.current?.precision === "ma-player") {
      this.schedule();
      return;
    }
    if (event.event === "queue_time_updated" && event.object_id === this.queueId &&
      typeof event.data === "number" && Number.isFinite(event.data) && event.data >= 0) {
      // The scalar seek anchor has no timestamp: apply at receipt, then reconcile the binding.
      this.recordTime(event.data * 1000);
      if (this.current) {
        this.current = { ...this.current, positionMs: event.data * 1000 };
        this.bridge.accept(this.current);
      }
    } else if (event.event === "queue_updated" || event.event === "queue_items_updated") {
      try {
        const anchor = queueAnchor(event.data, this.queueId, this.client.serverNowMs(), this.artwork);
        const structure = this.fingerprint(anchor);
        if (this.structure !== structure) this.revision++;
        this.structure = structure;
        this.recordTime(anchor.positionMs);
        if (this.current) {
          this.current = anchor;
          this.bridge.accept(anchor);
        }
      } catch {
        this.revision++;
        this.current = null;
        this.latestTime = null;
        this.bridge.invalidate("Queue changed; refreshing exact target.");
      }
    } else if (event.event.startsWith("player_")) {
      const route = playerEventSchema.safeParse(event.data);
      const fingerprint = route.success ? JSON.stringify(route.data) : "unavailable";
      if (event.event === "player_removed" || this.routing.get(event.object_id!) !== fingerprint) {
        this.revision++;
        this.current = null;
        this.latestTime = null;
        this.bridge.invalidate("Player routing changed; refreshing exact target.");
      }
      this.routing.set(event.object_id!, fingerprint);
    } else if (this.current) {
      this.revision++;
      this.current = null;
      this.latestTime = null;
      this.bridge.invalidate("Queue changed; refreshing exact target.");
    }
    this.schedule();
  };
  private fingerprint(anchor: QueueAnchor): string {
    return JSON.stringify([anchor.itemKey, anchor.track?.identity, anchor.playback]);
  }
  private recordTime(positionMs: number): void {
    this.latestTime = { positionMs, at: performance.now(), revision: this.revision, sequence: ++this.timingSequence };
  }
  private schedule(): void {
    if (!this.authenticated || this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = null; void this.refresh(); }, 250);
  }
  private async refresh(): Promise<void> {
    if (this.running || !this.authenticated) { if (this.authenticated) this.schedule(); return; }
    this.running = true;
    const revision = this.revision;
    const timingSequence = this.timingSequence;
    const abort = new AbortController();
    this.abort = abort;
    try {
      const raw = await this.client.request("player_queues/get_active_queue", { player_id: this.playerId }, abort.signal);
      if (revision !== this.revision || abort.signal.aborted) { this.schedule(); return; }
      const player = raw === null
        ? await this.client.request("players/get", { player_id: this.playerId }, abort.signal) : null;
      if (revision !== this.revision || abort.signal.aborted) { this.schedule(); return; }
      const anchor = raw === null
        ? playerAnchor(player, this.playerId, this.queueId, this.client.serverNowMs(), this.artwork)
        : queueAnchor(raw, this.queueId, this.client.serverNowMs(), this.artwork);
      // Time events must not starve acquisition, but an older in-flight snapshot must not undo a seek.
      if (anchor.precision !== "ma-player" && this.latestTime && this.latestTime.sequence > timingSequence && this.latestTime.revision === revision &&
        (!this.structure || this.fingerprint(anchor) === this.structure)) {
        anchor.positionMs = this.latestTime.positionMs + (anchor.playback === "playing" ? performance.now() - this.latestTime.at : 0);
      }
      this.current = anchor;
      this.structure = this.fingerprint(anchor);
      this.bridge.accept(anchor);
      this.client.markHealthy();
    } catch (error) {
      if (abort.signal.aborted || revision !== this.revision) return;
      this.current = null;
      const known = error instanceof Error && [
        "target_queue_mismatch", "target_queue_unavailable", "target_queue_inactive",
        "unsupported_playback_speed", "unsupported_media_type", "stale_or_invalid_queue_timestamp",
        "target_player_mismatch", "target_player_unavailable", "external_source_unconfirmed", "external_metadata_unavailable",
      ].includes(error.message) ? error.message : "queue_read_failed";
      this.bridge.invalidate(`Music Assistant: ${known.replaceAll("_", " ")}. Check target IDs, version and permissions.`);
      log("ma_queue_unavailable", known);
    } finally { this.running = false; if (this.abort === abort) this.abort = null; }
  }
  close(): void {
    this.authenticated = false;
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearTimeout(this.scheduled);
    this.abort?.abort();
    this.client.off("authenticated", this.onAuthenticated);
    this.client.off("connection", this.onConnection);
    this.client.off("event", this.onEvent);
    this.client.close();
  }
}
