import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  recordingAlbumRequestSchema, recordingLabelRequestSchema, recordingRevisionSchema,
  toolsIdentitySchema, type SourceHealth,
} from "../shared/source-tools.js";
import { SourceTools, SourceToolsError, parseToolsJson, type AlbumContext } from "./source-tools.js";

type Ticket = { session: string; id: string; revision: string; bootId: string; expires: number };
type Confirmation = Ticket & { context: AlbumContext };
const session = (req: Request) => /(?:^|;\s*)karaoke_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
const statuses = { "invalid-request": 400, forbidden: 403, "not-found": 404, "revision-changed": 409,
  "restart-needed": 409, "context-changed": 409, busy: 429, timeout: 504 } as const;
const transferFailure = (error: unknown) => error instanceof SourceToolsError
  || (error instanceof Error && "code" in error && typeof error.code === "string"
    && ["ABORT_ERR", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED",
      "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED"].includes(error.code));

export function downloadDisposition(label: string, format: "wav" | "flac"): string {
  const name = `${Array.from(label.replace(/[\p{C}\\/:*?"<>|]/gu, "_")).slice(0, 120).join("")}.${format}`;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (s) => `%${s.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Construct diagnostics from an explicit allowlist; never serialize the service's internal state. */
export function sourceDiagnostics(health: SourceHealth): SourceHealth {
  return {
    version: 1, source: { state: health.source.state },
    capture: { state: health.capture.state, evidence: health.capture.evidence, evidenceAgeMs: health.capture.evidenceAgeMs },
    sendspin: { state: health.sendspin.state, streaming: health.sendspin.streaming },
    recording: { state: health.recording.state },
    disk: { state: health.disk.state, freeBytes: health.disk.freeBytes, totalBytes: health.disk.totalBytes, sampleAgeMs: health.disk.sampleAgeMs },
    display: { state: health.display.state, mode: health.display.mode, ma: health.display.ma },
    versions: { source: health.versions.source, toolsAbi: 1, python: health.versions.python,
      sendspin: health.versions.sendspin, installedSource: health.versions.installedSource },
    application: { version: health.application.version, build: health.application.build, node: health.application.node },
    errors: health.errors.map((error) => ({ category: error.category, count: error.count, ageMs: error.ageMs })),
  };
}

export function sourceToolsRouter(tools = new SourceTools(), now = Date.now) {
  const router = express.Router();
  const tickets = new Map<string, Ticket>();
  const confirmations = new Map<string, Confirmation>();
  let downloads = 0;
  const prune = <T extends Ticket>(store: Map<string, T>) => {
    for (const [key, value] of store) if (value.expires <= now()) store.delete(key);
  };
  const issue = <T extends Ticket>(store: Map<string, T>, ticket: T) => {
    prune(store);
    if (store.size >= 128) throw new SourceToolsError("busy");
    const token = randomBytes(32).toString("hex");
    store.set(token, ticket); return token;
  };
  const consume = <T extends Ticket>(store: Map<string, T>, token: string, owner: string): T => {
    prune(store);
    const ticket = store.get(token);
    if (!ticket || ticket.session !== owner) throw new SourceToolsError("forbidden");
    store.delete(token); return ticket;
  };
  const owner = (req: Request) => {
    const value = session(req);
    if (!value) throw new SourceToolsError("forbidden");
    return value;
  };
  const id = (req: Request): string => parse(toolsIdentitySchema, req.params.id);
  const parse = <T>(schema: z.ZodType<T>, data: unknown): T => {
    const result = schema.safeParse(data);
    if (!result.success) throw new SourceToolsError("invalid-request");
    return result.data;
  };
  const route = (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
  router.get("/telemetry", route(async (_req, res) => { res.json(await tools.telemetry()); }));
  router.get("/health", route(async (_req, res) => { res.json(await tools.health()); }));
  router.get("/diagnostics", route(async (_req, res) => {
    res.set({ "Content-Disposition": 'attachment; filename="source-diagnostics.json"', "Cache-Control": "no-store" });
    res.json(sourceDiagnostics(await tools.health()));
  }));
  router.get("/recordings", route(async (req, res) => {
    const query = parse(z.object({
      cursor: toolsIdentitySchema.optional(), limit: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).optional(),
    }).strict(), req.query);
    res.json(await tools.recordings(query.cursor ?? null, Number(query.limit ?? 50)));
  }));
  router.use(express.json({ limit: "8kb", verify: (_req, _res, bytes) => {
    try { parseToolsJson(bytes); }
    catch (error) { if (error instanceof SourceToolsError) throw new SourceToolsError("invalid-request"); throw error; }
  } }));
  router.post("/recordings/:id/label", route(async (req, res) => {
    const body = parse(recordingLabelRequestSchema, req.body);
    res.json(await tools.label(id(req), body.revision, body.label));
  }));
  router.post("/recordings/:id/album-preview", route(async (req, res) => {
    const body = parse(recordingRevisionSchema, req.body), recordingId = id(req);
    const bound = tools.binding(recordingId, body.revision), context = await tools.context();
    const expires = now() + 60_000;
    const token = issue(confirmations, { session: owner(req), id: recordingId, revision: body.revision,
      bootId: bound.boot_id, context, expires });
    res.json({ album: context.album, confirmationToken: token, expiresAt: expires });
  }));
  router.post("/recordings/:id/album", route(async (req, res) => {
    const body = parse(recordingAlbumRequestSchema, req.body), recordingId = id(req);
    const confirmed = consume(confirmations, body.confirmationToken, owner(req));
    if (confirmed.id !== recordingId || confirmed.revision !== body.revision) throw new SourceToolsError("context-changed");
    res.json(await tools.album(recordingId, body.revision, confirmed.context, confirmed.bootId));
  }));
  router.post("/recordings/:id/download", route(async (req, res) => {
    const body = parse(recordingRevisionSchema, req.body), recordingId = id(req);
    const bound = tools.binding(recordingId, body.revision);
    const token = issue(tickets, { session: owner(req), id: recordingId, revision: body.revision,
      bootId: bound.boot_id, expires: now() + 60_000 });
    res.json({ url: `/api/source-tools/downloads/${token}` });
  }));
  router.get("/downloads/:ticket", route(async (req, res) => {
    if (req.method !== "GET") { res.sendStatus(405); return; }
    if (req.headers.range !== undefined) { res.status(416).json({ error: "invalid-request" }); return; }
    const token = parse(toolsIdentitySchema, req.params.ticket);
    const ticket = consume(tickets, token, owner(req));
    if (downloads >= 2) throw new SourceToolsError("busy");
    downloads++;
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once("close", close);
    res.setTimeout(30_000, () => controller.abort());
    try {
      const { recording, stream } = await tools.download(ticket.id, ticket.revision, ticket.bootId, controller.signal);
      res.set({
        "Content-Length": String(recording.bytes),
        "Content-Type": recording.format === "flac" ? "audio/flac" : "audio/wav",
        "Content-Disposition": downloadDisposition(recording.label, recording.format),
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "none",
      });
      let received = 0;
      // Hold the last chunk until EOF, so the declared length is not completed before source validation.
      let last: Buffer | undefined;
      const exact = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > recording.bytes) { callback(new SourceToolsError("invalid-response")); return; }
          if (last) this.push(last);
          last = chunk; callback();
        },
        flush(callback) {
          if (received !== recording.bytes) { callback(new SourceToolsError("invalid-response")); return; }
          if (last) this.push(last);
          callback();
        },
      });
      await pipeline(stream, exact, res, { signal: controller.signal });
    } catch (error) {
      if (res.headersSent || controller.signal.aborted || res.destroyed) {
        res.destroy();
        if (transferFailure(error)) {
          if (error instanceof SourceToolsError) tools.report(error);
          return;
        }
      }
      throw error;
    } finally {
      downloads--; res.off("close", close); res.setTimeout(0);
    }
  }));
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      res.destroy();
      if (!(error instanceof SourceToolsError)) next(error);
      return;
    }
    if (error instanceof SourceToolsError) {
      tools.report(error);
      res.status(error.code in statuses ? statuses[error.code as keyof typeof statuses] : 503).json({ error: error.code });
    } else if (error instanceof SyntaxError || (error instanceof Error && "type" in error
      && ["entity.too.large", "entity.verify.failed"].includes(String(error.type)))) {
      res.status(400).json({ error: "invalid-request" });
    } else next(error);
  });
  return router;
}
