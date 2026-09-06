import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import type { CecStatus } from "../shared/protocol.js";
import { REMOTE_KEYS, type RemoteSource } from "../shared/remote.js";

const registration = z.object({ role: z.literal("kiosk"), pageId: z.string().uuid() }).strict();
const renewal = z.object({ pageId: z.string().uuid(), epoch: z.string().uuid() }).strict();
const sessionCookie = (req: Request) =>
  /(?:^|;\s*)karaoke_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];

export interface LeaseTiming {
  now: () => number;
  leaseMs: number;
  pingMs: number;
}

interface Lease {
  pageId: string;
  session: string;
  epoch: string;
  sequence: number;
  expires: number;
  response: Response;
  dispose: () => void;
}

/** A CSRF-authorized POST is the registration AND the exclusive live connection. */
export class KioskRemote {
  private lease: Lease | undefined;
  constructor(
    private readonly source: RemoteSource | undefined,
    private readonly status: () => CecStatus,
    private readonly changed: () => void,
    private readonly timing: LeaseTiming = { now: () => performance.now(), leaseMs: 30_000, pingMs: 5_000 },
  ) {}

  connected(): boolean { return this.lease !== undefined; }

  register = (req: Request, res: Response): void => {
    const parsed = registration.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Explicit kiosk role and a per-page UUID are required" }); return; }
    const session = sessionCookie(req);
    if (!session) { res.status(403).json({ error: "A local session is required" }); return; }
    if (!this.source || !this.status().remote?.enabled) {
      res.status(404).json({ error: "CEC remote navigation is disabled" }); return;
    }
    if (this.lease && this.timing.now() >= this.lease.expires) this.lease.dispose();
    if (this.lease) { res.status(409).json({ error: "Another kiosk page holds the remote lease; close it or wait for its lease to expire" }); return; }
    if (!this.status().remote?.listening) {
      res.status(503).json({ error: "CEC remote transport is not listening; inspect CEC status" }); return;
    }
    this.source.resetRemote();
    res.set({ "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const lease: Lease = {
      pageId: parsed.data.pageId, session, epoch: randomUUID(), sequence: 0,
      expires: this.timing.now() + this.timing.leaseMs, response: res, dispose: () => {},
    };
    this.lease = lease;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    lease.dispose = () => {
      if (this.lease !== lease) return;
      this.lease = undefined;
      clearInterval(timer);
      unsubscribe();
      this.source?.resetRemote();
      if (!res.destroyed) res.end();
      this.changed();
    };
    const send = (event: string, data: object) => {
      if (this.lease !== lease) return;
      if (res.destroyed || res.writableLength > 8192 || this.timing.now() >= lease.expires) {
        lease.dispose(); return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.once("close", lease.dispose);
    send("ready", { epoch: lease.epoch, sequence: 0 });
    unsubscribe = this.source.onRemote((signal) => {
      if (signal.type === "reset") { lease.dispose(); return; }
      // Keep the HTTP boundary allowlisted even for a faulty injected transport.
      if (!REMOTE_KEYS.includes(signal.action.key) || typeof signal.action.repeat !== "boolean"
        || (signal.action.repeat && ["select", "back"].includes(signal.action.key))) return;
      if (lease.sequence >= Number.MAX_SAFE_INTEGER) { lease.dispose(); return; }
      send("key", { epoch: lease.epoch, sequence: ++lease.sequence, ...signal.action, at: Date.now() });
    });
    if (this.lease !== lease) { unsubscribe(); return; }
    timer = setInterval(() => send("ping", { epoch: lease.epoch, sequence: lease.sequence }), this.timing.pingMs);
    timer.unref();
    this.changed();
  };

  renew = (req: Request, res: Response): void => {
    const parsed = renewal.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "A page UUID and current lease epoch are required" }); return; }
    const lease = this.lease;
    if (lease && this.timing.now() >= lease.expires) lease.dispose();
    if (!lease || this.lease !== lease || lease.session !== sessionCookie(req)
      || lease.pageId !== parsed.data.pageId || lease.epoch !== parsed.data.epoch) {
      res.status(409).json({ error: "Kiosk lease is absent, expired, or belongs to another page" }); return;
    }
    lease.expires = this.timing.now() + this.timing.leaseMs;
    res.json({ epoch: lease.epoch });
  };
}
