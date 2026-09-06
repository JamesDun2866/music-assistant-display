import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { z } from "zod";
import { log } from "./log.js";

const commands = [
  "auth", "players/all", "players/get", "player_queues/all",
  "player_queues/get_active_queue", "player_queues/get", "player_queues/items",
  "music/item_by_uri", "metadata/get_track_lyrics",
] as const;
export type MaCommand = typeof commands[number];
export interface MaRpc {
  request(command: MaCommand, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
const greetingSchema = z.object({
  server_id: z.string(), server_version: z.string(),
  schema_version: z.number().int(), min_supported_schema_version: z.number().int(),
});
const eventSchema = z.object({ event: z.string(), object_id: z.string().nullable(), data: z.unknown() });
export type MaEvent = z.infer<typeof eventSchema>;
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
  partial: unknown[];
  bytes: number;
};
export function reconnectDelay(attempt: number, random = Math.random): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.75 + random() * 0.5);
}
export function maBaseUrl(raw: string, websocket = false): URL {
  const url = new URL(raw);
  url.protocol = websocket ? (["https:", "wss:"].includes(url.protocol) ? "wss:" : "ws:") :
    (["https:", "wss:"].includes(url.protocol) ? "https:" : "http:");
  url.pathname = url.pathname.replace(/\/ws\/?$/, "").replace(/\/$/, "") + "/";
  return url;
}
export class MaClient extends EventEmitter implements MaRpc {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private handshake: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private attempt = 0;
  private id = 0;
  private authenticated = false;
  constructor(private readonly url: string, private readonly token: string) { super(); }
  // MA's queue snapshot formula assumes NTP-aligned hosts; this is NOT a Sendspin clock.
  serverNowMs(): number { return Date.now(); }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  private connect(): void {
    if (this.stopped) return;
    this.emit("connection", "connecting", "Connecting to Music Assistant...");
    const base = maBaseUrl(this.url, true);
    const socket = new WebSocket(new URL("ws", base), { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 10_000, followRedirects: false });
    this.socket = socket;
    this.authenticated = false;
    let greeted = false;
    let alive = true;
    this.handshake = setTimeout(() => socket.terminate(), 15_000);
    socket.on("open", () => {
      this.heartbeat = setInterval(() => {
        if (!alive) { socket.terminate(); return; }
        alive = false;
        socket.ping();
      }, 10_000);
    });
    socket.on("pong", () => { alive = true; });
    socket.on("message", (data, binary) => {
      if (this.socket !== socket) return;
      try {
        if (binary) throw new Error("unexpected_binary");
        const text = data.toString();
        const decoded: unknown = JSON.parse(text);
        if (!greeted) {
          const info = greetingSchema.parse(decoded);
          if (info.schema_version < 65 || info.min_supported_schema_version > 65) throw new Error("unsupported_ma_schema");
          greeted = true;
          void this.request("auth", { token: this.token }).then((result) => {
            if (this.socket !== socket) return;
            if (!z.object({ authenticated: z.literal(true) }).safeParse(result).success) throw new Error("authentication_failed");
            this.authenticated = true;
            if (this.handshake) clearTimeout(this.handshake);
            this.handshake = null;
            this.emit("authenticated");
          }).catch(() => {
            log("ma_authentication_failed", "check_token_permissions_and_version");
            socket.terminate();
          });
          return;
        }
        const record = z.record(z.unknown()).parse(decoded);
        if (typeof record.message_id === "string") {
          const pending = this.pending.get(record.message_id);
          if (!pending) return;
          pending.bytes += Buffer.byteLength(text);
          if (pending.bytes > 2 * 1024 * 1024) throw new Error("rpc_result_too_large");
          if (typeof record.error_code === "number") {
            this.finish(record.message_id);
            pending.reject(new Error(`ma_error_${record.error_code}`));
          } else if ("result" in record) {
            if (record.partial === true) {
              if (!Array.isArray(record.result) || pending.partial.length + record.result.length > 5000) throw new Error("invalid_partial_result");
              pending.partial.push(...record.result);
            } else {
              this.finish(record.message_id);
              if (pending.partial.length && !Array.isArray(record.result)) pending.reject(new Error("invalid_final_result"));
              else pending.resolve(pending.partial.length ? [...pending.partial, ...record.result as unknown[]] : record.result);
            }
          } else throw new Error("invalid_rpc_response");
        } else if (this.authenticated) {
          this.emit("event", eventSchema.parse(decoded));
        }
      } catch {
        log("ma_protocol_rejected", "schema_or_payload");
        socket.terminate();
      }
    });
    socket.on("error", () => log("ma_connection_error", "transport"));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.authenticated = false;
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.handshake) clearTimeout(this.handshake);
      this.heartbeat = null;
      this.handshake = null;
      for (const [id, pending] of this.pending) {
        this.finish(id); pending.reject(new Error("ma_disconnected"));
      }
      this.emit("connection", "stale", "Music Assistant disconnected; timing frozen.");
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), reconnectDelay(this.attempt++));
    });
  }
  /** Only a validated queue read resets backoff, not a short-lived authenticated socket. */
  markHealthy(): void { this.attempt = 0; }
  request(command: MaCommand, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (!commands.includes(command)) return Promise.reject(new Error("ma_command_not_allowed"));
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || (command !== "auth" && !this.authenticated)) {
      return Promise.reject(new Error("ma_not_connected"));
    }
    if (this.pending.size >= 16) return Promise.reject(new Error("ma_request_limit"));
    if (signal?.aborted) return Promise.reject(new Error("request_aborted"));
    const id = String(++this.id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.finish(id); reject(new Error("ma_request_timeout")); }, 12_000);
      const abort = () => { this.finish(id); reject(new Error("request_aborted")); };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve, reject, partial: [], bytes: 0,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); },
      });
      this.socket!.send(JSON.stringify({ message_id: id, command, args }), (error) => {
        if (error) { this.finish(id); reject(new Error("ma_send_failed")); }
      });
    });
  }
  private finish(id: string): void { this.pending.get(id)?.cleanup(); this.pending.delete(id); }
  close(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.terminate();
  }
}
