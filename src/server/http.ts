import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { CecCommand, CecStatus } from "../shared/protocol.js";
import type { Bridge } from "./bridge.js";
import type { LineInAlbum } from "./line-in-album.js";
import { retryBindingSchema, unavailableTracklist } from "../shared/line-in-album.js";
import type { DemoPlayer } from "./demo.js";
import type { SettingsStore } from "./settings.js";
import { settingsPatchSchema } from "./settings.js";
import { log } from "./log.js";
import { AmbientError, AMBIENT_LIMITS, deleteImagesSchema, imageTitle, UPLOAD_TIMEOUT_MS, type AmbientStore } from "./ambient.js";
import type { RemoteSource } from "../shared/remote.js";
import { KioskRemote, type LeaseTiming } from "./kiosk-remote.js";
import { BUILTIN_BACKGROUNDS } from "../shared/ambient.js";
import { KioskDiagnostics } from "./kiosk-diagnostics.js";
import { journalRoutes, type JournalHttpService } from "./journal-http.js";
import { JournalError } from "./journal-store.js";
import { editionRoutes, type EditionHttpService } from "./edition-http.js";
import { EditionError } from "./album-editions.js";
import { sourceToolsRouter } from "./source-tools-http.js";
import type { SourceTools } from "./source-tools.js";

const versionedBackgrounds = new Set(BUILTIN_BACKGROUNDS.flatMap((image) => [image.url, image.thumbnailUrl])
  .filter((url): url is string => Boolean(url && /\?v=[a-f0-9]{12}$/.test(url))));

export interface CecService {
  status(): CecStatus;
  execute(command: CecCommand): Promise<CecStatus>;
}
export interface Artwork {
  bytes: Buffer;
  contentType: "image/jpeg" | "image/png" | "image/webp";
}
export interface HttpOptions {
  bridge: Bridge;
  settings: SettingsStore;
  ambient?: AmbientStore;
  cec: CecService;
  remote?: RemoteSource;
  remoteTiming?: LeaseTiming;
  demo?: DemoPlayer;
  webDirectory?: string;
  artwork?: (identity: string, signal: AbortSignal) => Promise<Artwork | null>;
  lineInAlbum?: Pick<LineInAlbum, "view" | "artwork"> & Partial<Pick<LineInAlbum, "retry">>;
  journal?: JournalHttpService;
  editions?: EditionHttpService;
  sourceTools?: SourceTools;
}
const demoSchema = z.object({
  action: z.enum(["play", "pause", "stop", "next", "seek"]),
  positionMs: z.number().finite().min(0).max(86_400_000).optional(),
}).strict().refine((data) => data.action !== "seek" || data.positionMs !== undefined);
const cecSchema = z.object({ command: z.enum(["wake", "active-source", "standby"]) }).strict();
const loopback = (value: string | undefined) => value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
function equal(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function readImageBody(req: Request, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", data); req.off("end", end); req.off("error", failed); req.off("aborted", cancelled);
      signal.removeEventListener("abort", cancelled);
    };
    const failed = (error: Error) => { cleanup(); req.pause(); reject(error); };
    const cancelled = () => failed(new AmbientError(408, "Image upload timed out or was cancelled"));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > AMBIENT_LIMITS.maxUploadBytes) { failed(new AmbientError(413, "Image exceeds the 12 MiB upload limit")); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    req.on("data", data); req.once("end", end); req.once("error", failed); req.once("aborted", cancelled);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}

export function createApp(options: HttpOptions) {
  const app = express();
  app.disable("x-powered-by");
  const secret = randomBytes(32);
  const csrf = (session: string) => createHmac("sha256", secret).update(session).digest("hex");
  let streams = 0;
  let lastCecCommand = -Infinity;
  const kioskDiagnostics = new KioskDiagnostics();
  const remote = new KioskRemote(options.remote, () => options.cec.status(), () => options.bridge.changed(), options.remoteTiming);
  const snapshot = () => {
    const status = { ...options.cec.status() };
    if (status.remote) status.remote = { ...status.remote, kioskConnected: remote.connected() };
    return options.bridge.snapshot(status);
  };
  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
    });
    // Loopback binding plus Host/Origin checks also protects against DNS rebinding.
    const host = req.headers.host ?? "";
    if (!loopback(req.socket.remoteAddress) || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) {
      res.status(403).json({ error: "Local kiosk access only" }); return;
    }
    if (req.headers.origin && req.headers.origin !== `http://${host}`) {
      res.status(403).json({ error: "Cross-origin access denied" }); return;
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ error: "Cross-site access denied" }); return;
    }
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ status: "alive" }));
  app.get("/readyz", (_req, res) => {
    const state = snapshot();
    const ready = state.connection === "connected";
    res.status(ready ? 200 : 503).json({ ready, mode: state.demo ? "demo" : "live", connection: state.connection, precision: state.precision });
  });
  app.get("/api/session", (req, res) => {
    const existing = /(?:^|;\s*)karaoke_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
    const session = existing ?? randomBytes(32).toString("hex");
    res.setHeader("Set-Cookie", `karaoke_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
    res.json({ csrfToken: csrf(session) });
  });
  app.use("/api", (req, res, next) => {
    if (req.method === "GET") { next(); return; }
    const session = /(?:^|;\s*)karaoke_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
    const token = req.headers["x-csrf-token"];
    if (!session || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !equal(token, csrf(session))) {
      res.status(403).json({ error: "Valid local session and CSRF token required" }); return;
    }
    next();
  });
  app.get("/api/backgrounds", (_req, res) => {
    if (!options.ambient) { res.status(503).json({ error: "Ambient storage is unavailable" }); return; }
    res.json(options.ambient.library());
  });
  app.use("/api/source-tools", sourceToolsRouter(options.sourceTools));
  app.get("/api/line-in-album", async (_req, res) => {
    res.json(options.lineInAlbum ? await options.lineInAlbum.view()
      : { state: "not-configured", expiresAt: Date.now(), key: null, album: null, tracklist: unavailableTracklist() });
  });
  app.post("/api/line-in-album/retry", express.json({ limit: "1kb" }), async (req, res) => {
    if (!options.lineInAlbum?.retry) { res.status(503).json({ error: "Album retry is not configured." }); return; }
    const binding = retryBindingSchema.safeParse(req.body);
    if (!binding.success) { res.status(400).json({ error: "A fresh source status is required for retry." }); return; }
    try {
      await options.lineInAlbum.retry(binding.data);
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Album retry failed." });
    }
  });
  app.get("/api/line-in-album/artwork/:key", async (req, res) => {
    if (!options.lineInAlbum) { res.sendStatus(404); return; }
    const revision = req.query.edition;
    const cover = req.query.cover;
    if (Object.keys(req.query).some((name) => name !== "edition" && name !== "cover")
      || cover !== undefined && (typeof cover !== "string" || !/^[a-f0-9]{64}$/.test(cover) || revision !== undefined)
      || revision !== undefined
      && (typeof revision !== "string" || !/^[1-9][0-9]{0,15}$/.test(revision) || !Number.isSafeInteger(Number(revision)))) {
      res.status(400).json({ error: "Invalid album artwork revision." }); return;
    }
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once("close", close);
    try {
      const image = await options.lineInAlbum.artwork(req.params.key, controller.signal,
        revision === undefined ? undefined : Number(revision));
      if (!image) { res.sendStatus(404); return; }
      res.type(image.contentType).send(image.bytes);
    } catch {
      log("line_in_album_artwork_unavailable");
      if (!res.destroyed) res.sendStatus(502);
    } finally { res.off("close", close); }
  });
  app.get("/api/backgrounds/image/:id", async (req, res) => {
    if (!options.ambient) { res.status(503).json({ error: "Ambient storage is unavailable" }); return; }
    const data = await options.ambient.read(req.params.id);
    if (!data) { res.status(404).json({ error: "Uploaded image not found" }); return; }
    res.type("image/jpeg").send(data);
  });
  app.get("/api/backgrounds/thumbnail/:id", async (req, res) => {
    if (!options.ambient) { res.status(503).json({ error: "Ambient storage is unavailable" }); return; }
    const data = await options.ambient.thumbnail(req.params.id);
    if (!data) { res.status(404).json({ error: "Uploaded image not found" }); return; }
    res.setHeader("Cache-Control", "private, no-cache");
    res.type("image/jpeg").send(data);
  });
  app.post("/api/backgrounds/upload", async (req, res) => {
    if (!options.ambient) { res.status(503).json({ error: "Ambient storage is unavailable" }); return; }
    res.setHeader("Connection", "close");
    const contentType = req.headers["content-type"];
    if (contentType !== "image/jpeg" && contentType !== "image/png") {
      res.status(415).json({ error: "Only exact image/jpeg or image/png content types are supported" }); return;
    }
    if (req.headers["content-encoding"]) { res.status(415).json({ error: "Encoded upload bodies are not supported" }); return; }
    const length = req.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) < 1 || Number(length) > AMBIENT_LIMITS.maxUploadBytes)) {
      res.status(413).json({ error: "Image exceeds the 12 MiB upload limit or is empty" }); return;
    }
    const encodedTitle = req.headers["x-image-title"];
    if (Array.isArray(encodedTitle)) { res.status(400).json({ error: "Provide only one image title" }); return; }
    const title = imageTitle(encodedTitle);
    // Admission precedes data listeners: competing requests cannot each buffer a full image.
    const release = options.ambient.reserveUpload();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    const closed = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", closed);
    try {
      const input = await readImageBody(req, controller.signal);
      const image = await options.ambient.upload(input, contentType, title, controller.signal);
      options.bridge.changed();
      res.status(201).json({ image });
    } finally {
      clearTimeout(timer);
      res.off("close", closed);
      release();
    }
  });
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && !req.is("application/json")) { res.status(415).json({ error: "JSON required" }); return; }
    next();
  });
  app.use(express.json({ limit: "4kb", strict: true }));
  journalRoutes(app, options.journal);
  editionRoutes(app, options.editions);
  app.post("/api/kiosk/remote", remote.register);
  app.post("/api/kiosk/remote/renew", remote.renew);
  app.post("/api/kiosk/diagnostics/report", kioskDiagnostics.report);
  app.post("/api/kiosk/diagnostics", kioskDiagnostics.read);
  app.post("/api/backgrounds/delete", async (req, res) => {
    if (!options.ambient) { res.status(503).json({ error: "Ambient storage is unavailable" }); return; }
    const parsed = deleteImagesSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Provide unique uploaded image ids; built-in images cannot be deleted" }); return; }
    const revision = options.ambient.revision;
    try { res.json({ deletedIds: await options.ambient.delete(parsed.data.ids) }); }
    finally { if (options.ambient.revision !== revision) options.bridge.changed(); }
  });
  app.get("/api/state", (_req, res) => res.json(snapshot()));
  app.get("/api/settings", (_req, res) => res.json({
    visualOffsetMs: options.settings.visualOffsetMs, viewMode: options.settings.viewMode, ambient: options.settings.ambient,
    lyricFollowMode: options.settings.lyricFollowMode,
    vinyl: options.settings.vinyl,
  }));
  app.get("/api/events", (req, res) => {
    if (streams >= 8) { res.status(503).json({ error: "Too many kiosk connections" }); return; }
    streams++;
    res.set({ "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const send = () => {
      if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    };
    send();
    options.bridge.on("change", send);
    const timer = setInterval(send, 1000);
    res.on("close", () => { streams--; clearInterval(timer); options.bridge.off("change", send); });
  });
  app.post("/api/settings", async (req, res) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Provide valid view, lyric follow (smooth or instant), offset, vinyl (showTracklist/showMeters booleans) or ambient settings (unique image ids and a dwell time of 15–3600 seconds)" }); return; }
    await options.settings.set(parsed.data);
    options.bridge.changed();
    res.json({ visualOffsetMs: options.settings.visualOffsetMs, viewMode: options.settings.viewMode,
      lyricFollowMode: options.settings.lyricFollowMode, ambient: options.settings.ambient, vinyl: options.settings.vinyl });
  });
  app.post("/api/demo", (req, res) => {
    if (!options.demo) { res.status(404).json({ error: "Demo is not enabled" }); return; }
    const parsed = demoSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid demo action or seek position" }); return; }
    options.demo.action(parsed.data.action, parsed.data.positionMs);
    res.json(snapshot());
  });
  app.post("/api/cec", async (req, res) => {
    const parsed = cecSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Unsupported CEC command" }); return; }
    if (performance.now() - lastCecCommand < 1500) { res.status(429).json({ error: "Wait before sending another TV command" }); return; }
    lastCecCommand = performance.now();
    const status = await options.cec.execute(parsed.data.command);
    options.bridge.changed();
    res.status(status.available ? 200 : 503).json(status);
  });
  app.get("/api/artwork/:identity", async (req, res) => {
    const before = snapshot();
    const track = before.track;
    if (!track || track.identity !== req.params.identity || !options.artwork) { res.sendStatus(404); return; }
    const controller = new AbortController();
    let obsolete = false;
    const changed = () => {
      const state = snapshot();
      if (state.generation !== before.generation || state.track?.identity !== track.identity || state.track.artworkUrl !== track.artworkUrl) {
        obsolete = true;
        controller.abort();
      }
    };
    options.bridge.on("change", changed);
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      const image = await options.artwork(track.identity, controller.signal);
      if (!image) { res.sendStatus(404); return; }
      const after = snapshot();
      if (after.generation !== before.generation || after.track?.identity !== track.identity || after.track.artworkUrl !== track.artworkUrl) {
        res.sendStatus(404); return;
      }
      res.type(image.contentType).send(image.bytes);
    } catch {
      if (!controller.signal.aborted) log("artwork_unavailable", "upstream");
      if (!res.destroyed) res.sendStatus(obsolete ? 404 : 502);
    } finally { options.bridge.off("change", changed); }
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "Unknown endpoint" }));
  const web = options.webDirectory ?? path.resolve("dist/web");
  app.use(express.static(web, {
    index: "index.html", dotfiles: "deny", redirect: false,
    setHeaders: (res) => {
      if (versionedBackgrounds.has(res.req.url ?? "")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof AmbientError || error instanceof JournalError || error instanceof EditionError ? error.status : error instanceof SyntaxError ? 400 :
      typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large" ? 413 : 500;
    log("http_request_failed", String(status));
    if (res.destroyed || res.headersSent) return;
    res.status(status).json({ error: error instanceof AmbientError || error instanceof JournalError || error instanceof EditionError ? error.message :
      status === 500 ? "Operation failed; inspect service status/logs" : "Invalid request body" });
  });
  return app;
}
