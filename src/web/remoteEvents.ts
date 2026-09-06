import { z } from "zod";
import type { RemoteKey } from "../shared/remote.js";

export const remoteKeySchema = z.enum(["up", "down", "left", "right", "select", "back"]);
const epochSchema = z.string().uuid();
const sequenceSchema = z.number().int().nonnegative().safe();
export const remoteReadySchema = z.object({ epoch: epochSchema, sequence: z.literal(0) }).strict();
export const remoteInputSchema = z.object({
  epoch: epochSchema, sequence: sequenceSchema.refine((value) => value > 0),
  key: remoteKeySchema, repeat: z.boolean(), at: z.number().int().nonnegative().safe(),
}).strict();
export const remotePingSchema = z.object({ epoch: epochSchema, sequence: sequenceSchema }).strict();
export type RemoteInput = z.infer<typeof remoteInputSchema>;
export interface NavigationAction { key: RemoteKey; repeat: boolean }
export const REMOTE_EVENT_LIMIT = 4 * 1024;
export const REMOTE_BUFFER_LIMIT = 16 * 1024;

/** A connection owns its decoder and epoch; neither survives a reconnect. */
export class RemoteEventConsumer {
  private frame: number[] = [];
  private lineBytes = 0;
  private epoch: string | null = null;
  private sequence = 0;
  private decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(
    private readonly onAction: (action: NavigationAction) => void,
    private readonly onReady: (epoch: string) => void = () => {},
    private readonly onActivity: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  push(chunk: Uint8Array) {
    if (chunk.byteLength > REMOTE_BUFFER_LIMIT) throw new Error("Remote input buffer exceeded.");
    for (const byte of chunk) {
      this.frame.push(byte);
      if (this.frame.length > REMOTE_EVENT_LIMIT) throw new Error("Remote event exceeded.");
      if (byte === 10) {
        if (this.lineBytes === 0) {
          const frame = this.decoder.decode(new Uint8Array(this.frame));
          this.frame = [];
          this.accept(frame);
        }
        this.lineBytes = 0;
      } else if (byte !== 13) {
        this.lineBytes += 1;
      }
    }
  }

  private accept(frame: string) {
    let event = "";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event" && !event) event = value;
      else if (field === "data") data.push(value);
      else throw new Error("Unexpected remote event field.");
    }
    if (!["ready", "key", "ping"].includes(event)) return;
    const input: unknown = JSON.parse(data.join("\n"));
    if (event === "ready") {
      const ready = remoteReadySchema.parse(input);
      if (this.epoch) throw new Error("Unexpected remote epoch reset.");
      this.epoch = ready.epoch;
      this.onReady(ready.epoch);
      this.onActivity();
      return;
    }
    const parsed = event === "key" ? remoteInputSchema.parse(input) : remotePingSchema.parse(input);
    if (!this.epoch || parsed.epoch !== this.epoch || parsed.sequence < this.sequence) return;
    this.onActivity();
    if (event === "ping") { this.sequence = parsed.sequence; return; }
    if (parsed.sequence === this.sequence) return;
    this.sequence = parsed.sequence;
    const key = parsed as RemoteInput;
    if (Math.abs(this.now() - key.at) > 2_000) return;
    if (key.repeat && (key.key === "select" || key.key === "back")) return;
    this.onAction({ key: key.key, repeat: key.repeat });
  }
}
