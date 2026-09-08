import { lstat, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { createConnection, type Socket } from "node:net";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  completedRecordingSchema, emptySourceTelemetry, recordingAlbumSchema, recordingLabelSchema,
  recordingPageSchema, sourceHealthDataSchema, sourceHealthSchema, sourceTelemetrySchema,
  toolsErrorSchema, toolsIdentitySchema,
  type CompletedRecording, type RecordingAlbum, type RecordingPage, type SourceHealth,
  type SourceHealthData, type SourceTelemetry, type ToolsErrorCode,
} from "../shared/source-tools.js";
import type { LineInAlbum } from "./line-in-album.js";
import { albumSuccessSchema, type AlbumSuccess } from "../shared/line-in-album.js";

export const TOOLS_SOCKET = "/run/sendspin-karaoke-tools/tools.sock";
const MAX_REQUEST = 8192;
const MAX_RESPONSE = 262_144;
export class SourceToolsError extends Error {
  constructor(readonly code: ToolsErrorCode) { super(code); this.name = "SourceToolsError"; }
}
const sourceId = z.string().regex(/^[a-f0-9]{64}$/);
const base = z.object({ version: z.literal(1), source_id: sourceId });
const binding = { boot_id: toolsIdentitySchema, id: toolsIdentitySchema, revision: toolsIdentitySchema };
export const toolsRequestSchema = z.discriminatedUnion("command", [
  base.extend({ command: z.literal("telemetry") }).strict(),
  base.extend({ command: z.literal("health") }).strict(),
  base.extend({ command: z.literal("recordings-list"), cursor: toolsIdentitySchema.nullable(),
    limit: z.number().int().min(1).max(50) }).strict(),
  base.extend({ command: z.literal("recording-label"), ...binding, label: recordingLabelSchema }).strict(),
  base.extend({ command: z.literal("recording-album"), ...binding, album: recordingAlbumSchema }).strict(),
  base.extend({ command: z.literal("recording-download"), ...binding }).strict(),
]);
export type ToolsRequest = z.infer<typeof toolsRequestSchema>;
type Command<T = ToolsRequest> = T extends ToolsRequest ? Omit<T, "source_id" | "version"> : never;
const envelopeSchema = z.discriminatedUnion("ok", [
  base.extend({ boot_id: toolsIdentitySchema, ok: z.literal(true), data: z.unknown() }).strict(),
  base.extend({ boot_id: toolsIdentitySchema, ok: z.literal(false), error: toolsErrorSchema }).strict(),
]);
type ToolsEnvelope = z.infer<typeof envelopeSchema>;

/** JSON.parse accepts duplicate keys; reject them before validating the message schema. */
export function parseToolsJson(bytes: Buffer): unknown {
  if (bytes.length > MAX_RESPONSE) throw new SourceToolsError("invalid-response");
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new SourceToolsError("invalid-response");
    throw error;
  }
  const stack: { object: boolean; key: boolean; keys: Set<string> }[] = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:"]+/g)) {
    const token = match[0], frame = stack.at(-1);
    if (token === "{" || token === "[") stack.push({ object: token === "{", key: true, keys: new Set() });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === ",") { if (frame) frame.key = true; }
    else if (token.startsWith('"') && frame?.object && frame.key) {
      const key = JSON.parse(token) as string;
      if (frame.keys.has(key)) throw new SourceToolsError("invalid-response");
      frame.keys.add(key); frame.key = false;
    }
  }
  return value;
}

function fsFailure(error: unknown): never {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    throw new SourceToolsError(error.code === "ENOENT" ? "offline" : "unsafe-socket");
  }
  throw error;
}
export async function verifyToolsSocket(uid: number, socketPath = TOOLS_SOCKET,
  stat: (name: string) => Promise<Stats> = lstat): Promise<string> {
  // Node has no SO_PEERCRED API: only the configured source can replace this socket
  // behind root-owned, non-writable ancestors; the source separately authenticates us.
  try {
    const directory = path.dirname(socketPath);
    const ancestors: string[] = [];
    let ancestor = path.dirname(directory);
    for (;;) {
      ancestors.push(ancestor);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const trusted = await Promise.all(ancestors.map((name) => stat(name)));
    const dir = await stat(directory), socket = await stat(socketPath);
    if (trusted.some((s) => !s.isDirectory() || s.uid !== 0 || (s.mode & 0o022) !== 0)
      || !dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o7777) !== 0o2750
      || !socket.isSocket() || socket.uid !== uid || socket.gid !== dir.gid
      || (socket.mode & 0o7777) !== 0o660 || socket.nlink !== 1) throw new SourceToolsError("unsafe-socket");
    return [...trusted, dir, socket].map((s) => `${s.dev}:${s.ino}:${s.uid}:${s.gid}:${s.mode}`).join(";");
  } catch (error) { if (error instanceof SourceToolsError) throw error; return fsFailure(error); }
}
export interface ToolsReply { bootId: string; data: unknown; stream?: Socket }
export interface ToolsTransport { request(request: ToolsRequest, signal?: AbortSignal): Promise<ToolsReply> }
export class ToolsSocketClient implements ToolsTransport {
  private controls = 0;
  private downloads = 0;
  constructor(private readonly uid: number, private readonly socketPath = TOOLS_SOCKET,
    private readonly verify = verifyToolsSocket) {}
  async request(request: ToolsRequest, signal?: AbortSignal): Promise<ToolsReply> {
    const parsed = toolsRequestSchema.safeParse(request);
    if (!parsed.success) throw new SourceToolsError("invalid-request");
    const encoded = Buffer.from(`${JSON.stringify(parsed.data)}\n`);
    if (encoded.length > MAX_REQUEST) throw new SourceToolsError("invalid-request");
    const download = request.command === "recording-download";
    if (download ? this.downloads >= 2 : this.controls >= 4) throw new SourceToolsError("busy");
    if (download) this.downloads++; else this.controls++;
    let owned = true;
    const release = () => { if (!owned) return; owned = false; if (download) this.downloads--; else this.controls--; };
    try {
      if (signal?.aborted) throw new SourceToolsError("unavailable");
      const identity = await this.verify(this.uid, this.socketPath);
      return await new Promise<ToolsReply>((resolve, reject) => {
        const socket = createConnection({ path: this.socketPath });
        let chunks: Buffer[] = [], length = 0, envelope: ToolsEnvelope | undefined;
        let settled = false;
        const total = setTimeout(() => fail(new SourceToolsError("timeout")), download ? 7_200_000 : 4000);
        const abort = () => fail(new SourceToolsError("unavailable"));
        const fail = (error: Error) => {
          if (!settled) { settled = true; reject(error); }
          socket.destroy(error);
        };
        socket.setTimeout(download ? 30_000 : 4000, () => fail(new SourceToolsError("timeout")));
        socket.once("close", () => {
          clearTimeout(total); signal?.removeEventListener("abort", abort); release();
          if (!settled) { settled = true; reject(new SourceToolsError("offline")); }
        });
        socket.on("error", (error) => {
          if (!settled) { settled = true; reject(error instanceof SourceToolsError ? error : new SourceToolsError("offline")); }
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        socket.once("connect", () => {
          void this.verify(this.uid, this.socketPath).then((after) => {
            if (after !== identity) throw new SourceToolsError("unsafe-socket");
            if (!socket.destroyed) socket.write(encoded);
          }).catch((error: unknown) => fail(error instanceof Error ? error : new SourceToolsError("unavailable")));
        });
        const receive = (chunk: Buffer) => {
          if (envelope) { fail(new SourceToolsError("invalid-response")); return; }
          const newline = chunk.indexOf(10);
          const header = newline === -1 ? chunk : chunk.subarray(0, newline);
          length += header.length;
          if (length + 1 > MAX_RESPONSE) { fail(new SourceToolsError("invalid-response")); return; }
          chunks.push(header);
          if (newline === -1) return;
          try {
            const result = envelopeSchema.safeParse(parseToolsJson(Buffer.concat(chunks, length)));
            chunks = [];
            if (!result.success) throw new SourceToolsError("invalid-response");
            envelope = result.data;
            if (envelope.source_id !== request.source_id) throw new SourceToolsError("incompatible");
            if ("boot_id" in request && request.boot_id !== envelope.boot_id) throw new SourceToolsError("revision-changed");
            if (!envelope.ok) throw new SourceToolsError(envelope.error);
            if (download) {
              socket.pause(); socket.off("data", receive);
              const rest = chunk.subarray(newline + 1);
              if (rest.length) socket.unshift(rest);
              settled = true;
              resolve({ bootId: envelope.boot_id, data: envelope.data, stream: socket });
            } else if (newline + 1 !== chunk.length) throw new SourceToolsError("invalid-response");
          } catch (error) {
            fail(error instanceof Error ? error : new SourceToolsError("invalid-response"));
          }
        };
        socket.on("data", receive);
        socket.once("end", () => {
          if (settled) return;
          if (!envelope?.ok) { fail(new SourceToolsError("invalid-response")); return; }
          settled = true; resolve({ bootId: envelope.boot_id, data: envelope.data }); socket.destroy();
        });
      });
    } catch (error) { release(); throw error; }
  }
}

export interface AlbumContext {
  sourceId: string; sourceUid: number; key: string; revision: string; album: RecordingAlbum;
  success?: AlbumSuccess;
}
export type AlbumContextProvider = () => Promise<AlbumContext | null>;
export function recordingAlbumContext(album: Pick<LineInAlbum, "currentAlbumContext">, uid: number): AlbumContextProvider {
  return async () => {
    const context = await album.currentAlbumContext();
    if (!context) return null;
    return structuredClone({
      sourceId: context.sourceId, sourceUid: uid, key: context.original.albumKey,
      revision: context.effective.revision,
      album: { title: context.effective.title, artist: context.effective.artist, catalog: context.effective.catalog,
        provenance: { kind: context.correction.applied ? "correction" : "recognition", revision: context.effective.revision } },
      ...(context.original.success ? { success: context.original.success } : {}),
    });
  };
}
export interface SourceToolsOptions {
  sourceId?: string; sourceUid?: number; transport?: ToolsTransport; albumContext?: AlbumContextProvider;
  display?: () => SourceHealth["display"];
  application?: SourceHealth["application"];
  now?: () => number;
}
export async function sourceToolsApplication(): Promise<SourceHealth["application"]> {
  for (const relative of ["../../package.json", "../../../package.json"]) {
    let contents: string;
    try { contents = await readFile(new URL(relative, import.meta.url), "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      if (error instanceof Error && "code" in error) break;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(contents); }
    catch (error) { if (error instanceof SyntaxError) break; throw error; }
    const info = z.object({ name: z.literal("music-assistant-display"), version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/) }).safeParse(value);
    if (info.success) return { version: info.data.version, build: null, node: process.versions.node };
  }
  return { version: null, build: null, node: process.versions.node };
}
function unavailableHealth(): SourceHealthData {
  return {
    capture: { state: "unavailable", evidence: "unknown", evidenceAgeMs: null },
    sendspin: { state: "unknown", streaming: false }, recording: { state: "unknown" },
    disk: { state: "unavailable", freeBytes: null, totalBytes: null, sampleAgeMs: null },
    versions: { source: null, toolsAbi: 1, python: null, sendspin: null, installedSource: null }, errors: [],
  };
}
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SourceToolsError("invalid-response");
  return parsed.data;
}
export class SourceTools {
  private readonly transport?: ToolsTransport;
  private readonly now: () => number;
  private telemetryPending?: Promise<SourceTelemetry>;
  private healthPending?: Promise<SourceHealth>;
  private telemetryCache?: { at: number; value: SourceTelemetry };
  private healthCache?: { at: number; value: SourceHealth };
  private sequence?: { boot: string; value: number; at: number };
  private readonly revisionKey = randomBytes(32);
  private errors = new Map<ToolsErrorCode, { count: number; at: number }>();
  private reported = new WeakSet<SourceToolsError>();
  constructor(readonly options: SourceToolsOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.transport = options.transport ?? (options.sourceUid !== undefined ? new ToolsSocketClient(options.sourceUid) : undefined);
  }
  private async request(command: Command, signal?: AbortSignal): Promise<ToolsReply> {
    if (!this.options.sourceId || this.options.sourceUid === undefined || !this.transport) throw new SourceToolsError("not-configured");
    try {
      return await this.transport.request({ version: 1, source_id: this.options.sourceId, ...command } as ToolsRequest, signal);
    } catch (error) {
      if (error instanceof SourceToolsError) this.report(error);
      throw error;
    }
  }
  report(error: SourceToolsError): void {
    if (this.reported.has(error)) return;
    this.reported.add(error);
    const code = error.code;
    const previous = this.errors.get(code);
    this.errors.delete(code);
    this.errors.set(code, { count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1), at: this.now() });
    if (this.errors.size > 20) this.errors.delete(this.errors.keys().next().value!);
  }
  async telemetry(): Promise<SourceTelemetry> {
    if (this.telemetryPending) return this.telemetryPending;
    if (this.telemetryCache && this.now() - this.telemetryCache.at < 66) {
      const { value, at } = this.telemetryCache;
      return value.sampleAgeMs === null ? value : { ...value,
        sampleAgeMs: Math.min(86_400_000, value.sampleAgeMs + Math.max(0, Math.round(this.now() - at))) };
    }
    this.telemetryPending = this.readTelemetry().then((value) => {
      this.telemetryCache = { at: this.now(), value }; return value;
    }).finally(() => { this.telemetryPending = undefined; });
    return this.telemetryPending;
  }
  private async readTelemetry(): Promise<SourceTelemetry> {
    try {
      const started = this.now();
      const reply = await this.request({ command: "telemetry" });
      let value = checked(sourceTelemetrySchema, reply.data);
      if (value.sampleAgeMs !== null) value = { ...value,
        sampleAgeMs: Math.min(86_400_000, value.sampleAgeMs + Math.max(0, Math.round(this.now() - started))) };
      const prior = this.sequence;
      if (!prior || prior.boot !== reply.bootId || value.sequence > prior.value) {
        this.sequence = { boot: reply.bootId, value: value.sequence, at: this.now() };
      }
      if (value.state === "active" && (value.sampleAgeMs === null || value.sampleAgeMs >= 500
        || (prior?.boot === reply.bootId && (value.sequence < prior.value || this.now() - this.sequence!.at >= 500)))) {
        value = { ...value, state: "stale" };
      }
      return value.state === "active" ? value : { ...emptySourceTelemetry(value.state),
        sequence: value.sequence, sampleAgeMs: value.sampleAgeMs };
    } catch (error) {
      if (!(error instanceof SourceToolsError)) throw error;
      this.report(error);
      return emptySourceTelemetry(error.code === "not-configured" ? "not-configured" : error.code === "offline" ? "offline" : "unavailable");
    }
  }
  async health(): Promise<SourceHealth> {
    if (this.healthPending) return this.healthPending;
    if (this.healthCache && this.now() - this.healthCache.at < 2000) return this.healthCache.value;
    this.healthPending = this.readHealth().then((value) => {
      this.healthCache = { at: this.now(), value }; return value;
    }).finally(() => { this.healthPending = undefined; });
    return this.healthPending;
  }
  private async readHealth(): Promise<SourceHealth> {
    let data = unavailableHealth(), state: SourceHealth["source"]["state"] = "online";
    try { data = checked(sourceHealthDataSchema, (await this.request({ command: "health" })).data); }
    catch (error) {
      if (!(error instanceof SourceToolsError)) throw error;
      this.report(error);
      state = error.code === "not-configured" ? "not-configured"
        : ["incompatible", "invalid-response", "unsafe-socket"].includes(error.code) ? "incompatible" : "offline";
      data.errors = [{ category: error.code, count: 1, ageMs: 0 }];
    }
    const events = new Map(data.errors.map((event) => [event.category, event]));
    for (const [category, event] of this.errors) events.set(category, {
      category, count: event.count, ageMs: Math.min(86_400_000, Math.max(0, Math.round(this.now() - event.at))),
    });
    data.errors = [...events.values()].slice(-20);
    return checked(sourceHealthSchema, { ...data, version: 1, source: { state },
      display: this.options.display?.() ?? { state: "online", mode: "live", ma: "unknown" },
      application: this.options.application ?? { version: null, build: null, node: process.versions.node } });
  }
  private remember(recording: CompletedRecording, bootId: string): CompletedRecording {
    if (!/^[a-f0-9]{64}$/.test(recording.revision) || !/^[a-f0-9]{32}$/.test(bootId)) {
      throw new SourceToolsError("invalid-response");
    }
    // Authenticate the file/boot binding in the opaque public revision rather
    // than evicting still-visible library entries from a per-file memory cache.
    const revision = recording.revision + bootId;
    const signature = this.revisionSignature(recording.id, revision);
    return { ...recording, revision: revision + signature };
  }
  private revisionSignature(id: string, revision: string): string {
    return createHmac("sha256", this.revisionKey).update(id).update("\0").update(revision).digest("hex").slice(0, 32);
  }
  async recordings(cursor: string | null, limit: number): Promise<RecordingPage> {
    const reply = await this.request({ command: "recordings-list", cursor, limit });
    const page = checked(recordingPageSchema, reply.data);
    return { ...page, items: page.items.map((recording) => this.remember(recording, reply.bootId)) };
  }
  binding(id: string, revision: string): { id: string; revision: string; boot_id: string } {
    if (!/^[a-f0-9]{128}$/.test(revision)) throw new SourceToolsError("revision-changed");
    const bound = revision.slice(0, 96);
    if (!timingSafeEqual(Buffer.from(revision.slice(96), "hex"), Buffer.from(this.revisionSignature(id, bound), "hex"))) {
      throw new SourceToolsError("revision-changed");
    }
    return { id, revision: bound.slice(0, 64), boot_id: bound.slice(64) };
  }
  async label(id: string, revision: string, label: string): Promise<CompletedRecording> {
    const reply = await this.request({ command: "recording-label", ...this.binding(id, revision), label });
    const recording = checked(completedRecordingSchema, reply.data);
    if (recording.id !== id) throw new SourceToolsError("invalid-response");
    return this.remember(recording, reply.bootId);
  }
  async context(): Promise<AlbumContext> {
    const value = await this.options.albumContext?.();
    if (!value || value.sourceId !== this.options.sourceId || value.sourceUid !== this.options.sourceUid) {
      throw new SourceToolsError("context-changed");
    }
    return { sourceId: value.sourceId, sourceUid: value.sourceUid, key: value.key, revision: value.revision,
      album: checked(recordingAlbumSchema, value.album),
      ...(value.success ? { success: checked(albumSuccessSchema, value.success) } : {}) };
  }
  async album(id: string, revision: string, context: AlbumContext, bootId: string): Promise<CompletedRecording> {
    const current = await this.context();
    if (JSON.stringify(current) !== JSON.stringify(context)) throw new SourceToolsError("context-changed");
    const bound = this.binding(id, revision);
    if (bound.boot_id !== bootId) throw new SourceToolsError("revision-changed");
    const reply = await this.request({ command: "recording-album", ...bound, album: context.album });
    const recording = checked(completedRecordingSchema, reply.data);
    if (recording.id !== id) throw new SourceToolsError("invalid-response");
    return this.remember(recording, reply.bootId);
  }
  async download(id: string, revision: string, bootId: string, signal: AbortSignal): Promise<{
    recording: Pick<CompletedRecording, "bytes" | "format" | "label">; stream: Socket;
  }> {
    const bound = this.binding(id, revision);
    if (bound.boot_id !== bootId) throw new SourceToolsError("revision-changed");
    const reply = await this.request({ command: "recording-download", ...bound }, signal);
    try {
      const recording = checked(completedRecordingSchema.pick({ bytes: true, format: true, label: true }).strict(), reply.data);
      if (!reply.stream) throw new SourceToolsError("invalid-response");
      return { recording, stream: reply.stream };
    } catch (error) { reply.stream?.destroy(); throw error; }
  }
}
