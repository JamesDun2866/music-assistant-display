import { z } from "zod";
import { albumArtworkReference } from "../shared/line-in-album.js";
import type { JournalPage } from "../shared/listening-journal.js";
import { JournalError, JournalStore, type StoredJournalPage } from "./journal-store.js";
import { requestJournal, type JournalRequest } from "./journal-source.js";
import { trustedGet } from "./line-in-network.js";
import { decodeAmbientImage } from "./ambient-decoder.js";
import { log } from "./log.js";

const cursorSchema = z.object({
  before: z.number().int().positive(), upper: z.number().int().nonnegative(),
  revision: z.string().regex(/^[a-f0-9]{32}$/),
}).strict().refine((value) => value.before <= value.upper + 1);
type Boundary = z.infer<typeof cursorSchema>;
export class ListeningJournal {
  private store: JournalStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  private controller = new AbortController();
  private closed = false;
  private clearing = false;
  private ready = false;
  private status: JournalPage["status"] = "catching-up";
  private message: string | null = null;
  private enrichment: Promise<void> | null = null;
  private lastMaintenance = 0;
  private exports = 0;
  constructor(private readonly sourceId: string, private readonly uid: number, directory: string,
    private readonly request = requestJournal,
    private readonly cover = async (url: string, signal: AbortSignal) => {
      const response = await trustedGet(albumArtworkReference.parse(url), signal, ["image/jpeg", "image/png"], 2 * 1024 * 1024);
      return (await decodeAmbientImage(response.bytes, response.type, signal, true)).data;
    }) {
    this.store = new JournalStore(directory, sourceId, uid);
  }
  async init(): Promise<void> {
    try { await this.store.init(); this.ready = true; }
    catch {
      this.status = "unavailable"; this.message = "Journal storage unavailable; inspect local storage.";
      log("journal_storage_unavailable"); return;
    }
    this.timer = setInterval(() => { void this.sync(); }, 2000);
    void this.sync();
  }
  private async source(request: JournalRequest) {
    return this.request(request, this.uid, AbortSignal.any([this.controller.signal, AbortSignal.timeout(6000)]));
  }
  async sync(): Promise<void> {
    if (this.closed || this.clearing || !this.ready) return;
    if (this.syncing) return this.syncing;
    this.syncing = this.catchup().catch(() => {
      this.status = "unavailable"; this.message = "Journal source unavailable; retained history is still local.";
      log("journal_source_unavailable");
    }).finally(() => { this.syncing = null; });
    return this.syncing;
  }
  private async catchup() {
    this.status = "catching-up";
    let head = await this.source({ command: "journal-head", source_id: this.sourceId });
    let state = await this.store.import(head);
    // Yield between batches so large offline gaps cannot monopolize storage or IPC.
    for (let page = 0; page < 8 && state.cursor < head.high_water; page++) {
      const before = state.cursor;
      head = await this.source({
        command: "journal-page", source_id: this.sourceId, epoch: head.epoch, after: before, limit: 100,
      });
      state = await this.store.import(head);
      if (state.cursor <= before) {
        if (head.events.length === 0 && head.oldest_sequence === null) break;
        throw new JournalError(503, "Journal catchup did not advance.");
      }
    }
    this.status = !head.healthy ? "unavailable" : state.cursor < head.high_water && head.oldest_sequence !== null
      ? "catching-up" : "ready";
    this.message = !head.healthy ? "Some identifications could not be saved by the source; inspect journal storage."
      : this.status === "catching-up" ? "Catching up on retained identifications." : null;
    if (Date.now() - this.lastMaintenance > 60_000) {
      await this.store.maintain(); this.lastMaintenance = Date.now();
    }
    if (!this.enrichment && !this.closed) {
      this.enrichment = this.enrich().catch(() => log("journal_artwork_unavailable"))
        .finally(() => { this.enrichment = null; });
    }
  }
  private async enrich() {
    const entry = await this.store.missingArtwork();
    if (!entry || this.closed) return;
    try {
      const image = await this.cover(entry.artwork, AbortSignal.any([this.controller.signal, AbortSignal.timeout(12_000)]));
      await this.store.saveArtwork(entry.id, image);
    } catch {
      if (!this.closed) {
        await this.store.saveArtwork(entry.id, null);
        log("journal_cover_not_cached");
      }
    }
  }
  private available() {
    if (!this.ready || this.closed) throw new JournalError(503, this.message ?? "Journal unavailable.");
    if (this.clearing) throw new JournalError(409, "Journal clear is in progress.");
  }
  private cursor(value?: string): Boundary | undefined {
    if (value === undefined) return;
    if (value.length > 512 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new JournalError(400, "Invalid journal cursor.");
    try { return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); }
    catch { throw new JournalError(400, "Invalid journal cursor."); }
  }
  private next(page: StoredJournalPage): string | null {
    return page.more ? Buffer.from(JSON.stringify({
      before: page.entries.at(-1)!.id, upper: page.upper, revision: page.revision,
    })).toString("base64url") : null;
  }
  async page(cursor?: string, limit = 50): Promise<JournalPage> {
    this.available();
    const boundary = this.cursor(cursor);
    if (boundary && (await this.store.state()).dataset !== boundary.revision) {
      throw new JournalError(409, "Journal changed; refresh before continuing.");
    }
    const page = await this.store.page(limit, boundary);
    return { entries: page.entries, nextCursor: this.next(page), revision: page.revision,
      retentionDays: 90, status: this.status, message: this.message };
  }
  async artwork(hash: string): Promise<Buffer | null> { this.available(); return this.store.artwork(hash); }
  async clear(revision: string): Promise<void> {
    this.available();
    this.clearing = true;
    try {
      await this.syncing;
      const current = await this.store.state();
      if (current.dataset !== revision) throw new JournalError(409, "Journal changed; refresh before clearing.");
      const head = await this.source({ command: "journal-head", source_id: this.sourceId });
      // Persist knowledge of an externally completed clear before deciding whether this confirmation is stale.
      const observed = await this.store.import(head);
      if (observed.dataset !== revision) throw new JournalError(409, "Journal changed; refresh before clearing.");
      await this.store.markClear();
      const cleared = await this.source({
        command: "journal-clear", source_id: this.sourceId, epoch: head.epoch, revision: head.revision, confirm: true,
      });
      await this.store.import(cleared);
      this.status = "ready"; this.message = null;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      this.status = "unavailable";
      this.message = "Journal clear could not be completed; reconnect to the source and refresh.";
      throw new JournalError(503, this.message);
    } finally { this.clearing = false; }
  }
  async *export(signal: AbortSignal): AsyncGenerator<string> {
    this.available();
    if (this.exports >= 2) throw new JournalError(429, "Too many journal exports.");
    this.exports++;
    try {
      let boundary: Boundary | undefined, first = true;
      const initial = await this.store.page(100);
      const exportRevision = initial.revision;
      yield '{"version":1,"kind":"album-identifications","retentionDays":90,"entries":[';
      while (true) {
        signal.throwIfAborted(); this.available();
        const page = boundary ? await this.store.page(100, boundary) : initial;
        for (const entry of page.entries) {
          signal.throwIfAborted(); this.available();
          // Clear cannot leak a buffered page into a continued export.
          if ((await this.store.state()).dataset !== exportRevision) throw new JournalError(409, "Journal changed during export.");
          yield `${first ? "" : ","}${JSON.stringify({
            identifiedAt: new Date(entry.identifiedAt).toISOString(), clockAdjusted: entry.clockAdjusted,
            album: { title: entry.title, artist: entry.artist }, context: "original recognition",
          })}`;
          first = false;
        }
        if (!page.more) break;
        boundary = { before: page.entries.at(-1)!.id, upper: page.upper, revision: page.revision };
      }
      yield "]}";
    } finally { this.exports--; }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.syncing; await this.enrichment;
    await this.store.close();
  }
}
