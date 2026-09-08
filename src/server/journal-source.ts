import { lstat } from "node:fs/promises";
import path from "node:path";
import { createConnection } from "node:net";
import { journalFeedSchema, type JournalFeed } from "../shared/listening-journal.js";

export type JournalRequest =
  | { command: "journal-head"; source_id: string }
  | { command: "journal-page"; source_id: string; epoch: string; after: number; limit: number }
  | { command: "journal-clear"; source_id: string; epoch: string; revision: number; confirm: true };

export async function requestJournal(request: JournalRequest, uid: number, signal: AbortSignal,
  directory = "/run/sendspin-karaoke-album"): Promise<JournalFeed> {
  signal.throwIfAborted();
  const dir = await lstat(directory);
  const socketPath = path.join(directory, "journal.sock");
  const socket = await lstat(socketPath);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o7777) !== 0o2750
    || !socket.isSocket() || socket.uid !== uid || socket.gid !== dir.gid
    || (socket.mode & 0o777) !== 0o660 || socket.nlink !== 1) throw new Error("Unsafe journal socket");
  return new Promise((resolve, reject) => {
    const client = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let bytes = 0, settled = false;
    const finish = (error?: Error, value?: JournalFeed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal.removeEventListener("abort", aborted); client.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const aborted = () => finish(new Error("Journal request cancelled"));
    const timer = setTimeout(() => finish(new Error("Journal source timed out")), 5000);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    client.once("connect", () => {
      void lstat(directory).then((after) => {
        if (after.ino !== dir.ino || after.dev !== dir.dev) throw new Error("Journal directory changed");
        if (!settled) client.end(`${JSON.stringify(request)}\n`);
      }).catch(() => finish(new Error("Journal source unavailable")));
    });
    client.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 512 * 1024) { finish(new Error("Journal response too large")); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      try {
        const parsed = journalFeedSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (parsed.source_id !== request.source_id) throw new Error("Journal source changed");
        finish(undefined, parsed);
      } catch { finish(new Error("Journal source rejected the request or returned invalid data")); }
    });
    client.once("error", () => finish(new Error("Journal source unavailable")));
    client.once("end", () => { if (!settled) finish(new Error("Journal source disconnected")); });
  });
}
