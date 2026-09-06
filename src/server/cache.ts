import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Lyrics } from "../shared/protocol.js";
import { MAX_LYRICS_BYTES, MAX_LINES } from "./lrc.js";

const recordSchema = z.object({
  identity: z.string(),
  expires: z.number(),
  value: z.object({
    status: z.enum(["timed", "plain", "missing"]),
    lines: z.array(z.object({ timeMs: z.number().finite().nonnegative(), text: z.string() })).max(MAX_LINES),
    plain: z.string().nullable(),
    message: z.string().nullable(),
  }),
});
export class LyricsCache {
  private readonly entries = new Map<string, { expires: number; value: Lyrics }>();
  private writes = Promise.resolve();
  constructor(private readonly directory: string, private readonly limit = 32, private readonly now = Date.now) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid_cache_limit");
  }
  private file(identity: string): string {
    return path.join(this.directory, `${createHash("sha256").update(identity).digest("hex")}.json`);
  }
  async init(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await this.prune(); }
  get size(): number { return this.entries.size; }
  async get(identity: string): Promise<Lyrics | null> {
    let entry = this.entries.get(identity);
    if (!entry) {
      try {
        const file = this.file(identity);
        if ((await stat(file)).size > MAX_LYRICS_BYTES * 4) throw new Error("cache_record_too_large");
        const parsed = recordSchema.parse(JSON.parse(await readFile(file, "utf8")));
        if (parsed.identity !== identity) throw new Error("cache_identity_mismatch");
        entry = { expires: parsed.expires, value: parsed.value };
      } catch (error) {
        if (isFsError(error, "ENOENT")) return null;
        throw error;
      }
    }
    if (entry.expires <= this.now()) {
      this.entries.delete(identity);
      await rm(this.file(identity), { force: true });
      return null;
    }
    this.remember(identity, entry);
    return entry.value;
  }
  async put(identity: string, value: Lyrics): Promise<void> {
    if (!["timed", "plain", "missing"].includes(value.status)) return;
    const entry = { expires: this.now() + (value.status === "missing" ? 300_000 : 86_400_000), value };
    this.remember(identity, entry);
    const write = this.writes.then(async () => {
      const file = this.file(identity);
      await writeFile(`${file}.tmp`, JSON.stringify({ identity, ...entry }), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      await this.prune(path.basename(file));
    });
    // Keep serialization usable after a failed write; callers still receive the rejection.
    this.writes = write.catch(() => {});
    await write;
  }
  private remember(identity: string, entry: { expires: number; value: Lyrics }): void {
    this.entries.delete(identity);
    this.entries.set(identity, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
  private async prune(protect?: string): Promise<void> {
    const files = await readdir(this.directory);
    const records = await Promise.all(files.filter((f) => /^[a-f0-9]{64}\.json$/.test(f)).map(async (name) => ({
      name, modified: (await stat(path.join(this.directory, name))).mtimeMs,
    })));
    records.sort((a, b) => a.name === protect ? -1 : b.name === protect ? 1 : b.modified - a.modified);
    for (const record of records.slice(this.limit)) await rm(path.join(this.directory, record.name), { force: true });
    for (const file of files.filter((f) => /^[a-f0-9]{64}\.json\.tmp$/.test(f))) await rm(path.join(this.directory, file), { force: true });
  }
}
export function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
