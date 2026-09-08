import { Worker } from "node:worker_threads";
import { z } from "zod";
import { journalEntrySchema, journalFeedSchema, type JournalFeed } from "../shared/listening-journal.js";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stateSchema = z.object({
  source: z.string(), uid: integer, epoch: z.string().nullable(), revision: integer,
  watermark: integer, cursor: integer, dataset: z.string(),
  cutoff: z.number().int().min(-90 * 86_400_000).max(Number.MAX_SAFE_INTEGER),
});
const storedPageSchema = z.object({
  revision: z.string(), upper: integer, more: z.boolean(), entries: z.array(journalEntrySchema).max(100),
});
export type JournalState = z.infer<typeof stateSchema>;
export type StoredJournalPage = z.infer<typeof storedPageSchema>;
export class JournalError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** node:sqlite was flag-gated in 22.12; keep the experimental flag away from the main process. */
export function journalWorkerFlags(version = process.versions.node): string[] {
  const [major, minor] = version.split(".").map(Number);
  return major === 22 && minor! < 13 ? ["--experimental-sqlite"] : [];
}

export class JournalStore {
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, {
    resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
  }>();
  private failure: Error | null = null;
  constructor(private readonly directory: string, private readonly sourceId: string, private readonly uid: number) {}

  async init(): Promise<void> {
    this.worker = new Worker(new URL("./journal-worker.mjs", import.meta.url), {
      workerData: { directory: this.directory, sourceId: this.sourceId, uid: this.uid },
      execArgv: journalWorkerFlags(), resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    this.worker.on("message", (raw: unknown) => {
      const message = z.object({ id: z.number().int(), result: z.unknown().optional(), error: z.string().optional() })
        .safeParse(raw);
      if (!message.success) { this.fail(new Error("Invalid journal worker response")); return; }
      const entry = this.pending.get(message.data.id);
      if (!entry) return;
      this.pending.delete(message.data.id); clearTimeout(entry.timer);
      if (message.data.error) entry.reject(new JournalError(503, message.data.error));
      else entry.resolve(message.data.result);
    });
    this.worker.once("error", () => this.fail(new JournalError(503, "Journal worker unavailable.")));
    this.worker.once("exit", () => this.fail(new JournalError(503, "Journal worker stopped.")));
    stateSchema.parse(await this.call("init"));
  }

  private fail(error: Error) {
    this.failure = error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  private call(operation: string, input: unknown = null): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.worker) return Promise.reject(new JournalError(503, "Journal storage unavailable."));
    if (this.pending.size >= 16) return Promise.reject(new JournalError(503, "Journal storage is busy."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new JournalError(503, "Journal storage timed out."));
        void this.worker?.terminate();
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ id, operation, input });
    });
  }
  async state(): Promise<JournalState> { return stateSchema.parse(await this.call("state")); }
  async import(feed: JournalFeed, now = Date.now()): Promise<JournalState> {
    return stateSchema.parse(await this.call("import", { feed: journalFeedSchema.parse(feed), now }));
  }
  async page(limit: number, boundary: { before?: number; upper?: number; revision?: string } = {},
    now = Date.now()): Promise<StoredJournalPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new JournalError(400, "Invalid journal page size.");
    return storedPageSchema.parse(await this.call("page", { limit, ...boundary, now }));
  }
  async artwork(hash: string): Promise<Buffer | null> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new JournalError(400, "Invalid journal artwork.");
    const value = await this.call("artwork", { hash, now: Date.now() });
    if (value === null) return null;
    if (!(value instanceof Uint8Array) || value.byteLength > 256 * 1024) throw new JournalError(503, "Invalid stored artwork.");
    return Buffer.from(value);
  }
  async missingArtwork(): Promise<{ id: number; artwork: string } | null> {
    return z.object({ id: integer.positive(), artwork: z.string() }).nullable()
      .parse(await this.call("missingArtwork", { now: Date.now() }));
  }
  async saveArtwork(id: number, jpeg: Buffer | null) {
    await this.call("saveArtwork", { id, jpeg, now: Date.now() });
  }
  async maintain() { await this.call("maintain", { now: Date.now() }); }
  async markClear() { await this.call("markClear"); }
  async close(): Promise<void> {
    try { if (this.worker && !this.failure) await this.call("close"); }
    finally { await this.worker?.terminate(); this.worker = null; }
  }
}
