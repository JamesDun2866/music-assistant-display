import { mkdir, mkdtemp, rm, lstat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { JournalStore, journalWorkerFlags } from "../src/server/journal-store.js";
import { ListeningJournal } from "../src/server/listening-journal.js";
import type { JournalEvent, JournalFeed } from "../src/shared/listening-journal.js";
import type { JournalRequest } from "../src/server/journal-source.js";

const sourceId = "a".repeat(64), boot = "b".repeat(32), epoch = "c".repeat(32);
const roots: string[] = [], stores: JournalStore[] = [], services: ListeningJournal[] = [];
const now = Date.now(), day = 86_400_000;
const event = (generation = 1, date = now): JournalEvent => ({
  source_id: sourceId, sequence: generation, album_key: `${boot}-1`,
  album_success: { boot_id: boot, generation, at_ms: date }, observed_at_ms: date,
  album: { title: "An album", artist: "An artist", catalog: { kind: "collection", id: "123", country: "gb" }, artwork: null },
});
function feed(events: JournalEvent[] = [], patch: Partial<JournalFeed> = {}): JournalFeed {
  return { ok: true, source_id: sourceId, epoch, revision: 0, watermark: 0,
    high_water: events.at(-1)?.sequence ?? 0, oldest_sequence: events[0]?.sequence ?? null,
    healthy: true, error: null, events, ...patch };
}
async function root() {
  const result = await mkdtemp(path.join(process.cwd(), ".journal-test-"));
  roots.push(result); return result;
}
async function store(directory?: string) {
  const result = new JournalStore(directory ?? await root(), sourceId, 123); stores.push(result);
  await result.init(); return result;
}
afterEach(async () => {
  for (const value of services.splice(0)) await value.close();
  for (const value of stores.splice(0)) await value.close();
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});

it("deduplicates historical success, not album key, across repeated imports and restart", async () => {
  const directory = await root(), db = await store(directory);
  await Promise.all([db.import(feed([event(1), event(2)])), db.import(feed([event(1), event(2)]))]);
  expect((await db.page(100)).entries).toHaveLength(2);
  await db.close();
  const restarted = await store(directory);
  await restarted.import(feed([event(1), event(2)]));
  expect((await restarted.page(100)).entries).toHaveLength(2);
  if (process.platform !== "win32") {
    expect((await lstat(path.join(directory, "listening-journal", "journal.sqlite"))).mode & 0o777).toBe(0o600);
  }
});

it("keeps more than 1000 successes with bounded keyset pages and stable upper boundary", async () => {
  const db = await store();
  for (let offset = 0; offset < 1100; offset += 100) {
    await db.import(feed(Array.from({ length: 100 }, (_, index) => event(offset + index + 1))));
  }
  const first = await db.page(100);
  expect(first.entries).toHaveLength(100); expect(first.more).toBe(true);
  await db.import(feed([event(1101)]));
  let count = first.entries.length, page = first;
  while (page.more) {
    page = await db.page(100, { revision: page.revision, upper: first.upper, before: page.entries.at(-1)!.id });
    count += page.entries.length;
  }
  expect(count).toBe(1100);
  expect((await db.page(1)).entries[0]!.id).toBeGreaterThan(first.upper);
});

it("expires exactly at 90 days without refreshing duplicate age or resurrecting on clock rollback", async () => {
  const db = await store();
  await db.import(feed([event(1, now - 90 * day), event(2, now - 90 * day + 10_000)]), now);
  expect((await db.page(100, {}, now)).entries).toHaveLength(1);
  await db.import(feed([event(2, now - 90 * day + 10_000)]), now + 10_000);
  expect((await db.page(100, {}, now + 10_000)).entries).toHaveLength(0);
  await db.import(feed([event(2, now - 90 * day + 10_000)]), now - day);
  expect((await db.page(100, {}, now - day)).entries).toHaveLength(0);
});

it("bounds future source dates once and marks logical success-clock skew", async () => {
  const db = await store();
  const observed = Date.now();
  const future = event(1, observed + day);
  const logical = { ...event(2, observed), album_success: { ...event(2).album_success, at_ms: observed + day } };
  await db.import(feed([future, logical]), observed);
  await db.import(feed([future, logical]), observed + 1000);
  const page = await db.page(100, {}, observed);
  expect(page.entries.every((entry) => entry.clockAdjusted && entry.identifiedAt === observed)).toBe(true);
});

it("retains a genuine new logical success through wall-clock rollback without reimporting an expired old future event", async () => {
  const db = await store();
  await db.import(feed([event(1)]), now);
  const rollback = { ...event(2, now - 120 * day), album_success: { ...event(2).album_success, at_ms: now + 1 } };
  await db.import(feed([rollback]), now - 120 * day);
  const page = await db.page(100, {}, now - 120 * day);
  expect(page.entries).toHaveLength(2);
  expect(page.entries[0]!.clockAdjusted).toBe(true);
  const future = event(3, now + 1000 * day);
  await db.import(feed([future]), now);
  await db.page(100, {}, now + 91 * day);
  await db.import(feed([future]), now + 91 * day);
  expect((await db.page(100, {}, now + 91 * day)).entries).toHaveLength(0);
});

it("persists clear watermark, blocks ambiguous clear reads, removes assets and rejects stale imports", async () => {
  const directory = await root(), db = await store(directory);
  const artwork = "https://is1-ssl.mzstatic.com/image/thumb/Music/abc/400x400bb.jpg";
  await db.import(feed([{ ...event(1), album: { ...event().album, artwork } }]));
  await db.saveArtwork(1, Buffer.from([255, 216, 1, 255, 217]));
  const first = await db.page(10);
  expect(first.entries[0]!.artworkUrl).toBeTruthy();
  const hash = first.entries[0]!.artworkUrl!.split("/").at(-1)!;
  await db.markClear();
  await expect(db.page(10)).rejects.toThrow();
  await db.close();
  const restarted = await store(directory);
  await expect(restarted.page(10)).rejects.toThrow();
  await restarted.import(feed([], { revision: 1, watermark: 1, high_water: 1 }));
  expect((await restarted.page(10)).entries).toHaveLength(0);
  expect(await restarted.artwork(hash)).toBeNull();
  await expect(restarted.import(feed([event(1)]))).rejects.toThrow();
  await restarted.import(feed([event(2)], { revision: 1, watermark: 1 }));
  expect((await restarted.page(10)).entries).toHaveLength(1);
});

it("rejects foreign source storage and feed binding, and bounded mailbox overload", async () => {
  const directory = await root(), db = await store(directory);
  await expect(db.import(feed([event()], { source_id: "f".repeat(64) }))).rejects.toThrow();
  const many = await Promise.allSettled(Array.from({ length: 40 }, () => db.page(10)));
  expect(many.some((value) => value.status === "rejected")).toBe(true);
  await db.close();
  const foreign = new JournalStore(directory, "d".repeat(64), 123); stores.push(foreign);
  await expect(foreign.init()).rejects.toThrow();
});

it.skipIf(process.platform === "win32")("refuses symlink databases", async () => {
  const directory = await root(), db = await store(directory);
  await db.close();
  const target = path.join(directory, "target");
  await writeFile(target, "", { mode: 0o600 });
  const file = path.join(directory, "listening-journal", "journal.sqlite");
  await rm(file); await symlink(target, file);
  const unsafe = new JournalStore(directory, sourceId, 123); stores.push(unsafe);
  await expect(unsafe.init()).rejects.toThrow();
});

it("can close safely after refusing an invalid database path during initialization", async () => {
  const directory = await root(), db = await store(directory);
  await db.close();
  const file = path.join(directory, "listening-journal", "journal.sqlite");
  await rm(file); await mkdir(file);
  const unsafe = new JournalStore(directory, sourceId, 123); stores.push(unsafe);
  await expect(unsafe.init()).rejects.toThrow();
  await expect(unsafe.close()).resolves.toBeUndefined();
});

it("uses the experimental SQLite flag only on the supported flag-gated Node version", () => {
  expect(journalWorkerFlags("22.12.0")).toEqual(["--experimental-sqlite"]);
  expect(journalWorkerFlags("22.13.0")).toEqual([]);
  expect(journalWorkerFlags("26.8.1")).toEqual([]);
});

function fakeSource(initial: JournalEvent[]) {
  let events = initial, revision = 0, watermark = 0, high = initial.at(-1)?.sequence ?? 0;
  const request = vi.fn(async (input: JournalRequest): Promise<JournalFeed> => {
    if (input.command === "journal-clear") {
      if (input.revision !== revision) throw new Error("stale");
      events = []; revision++; watermark = high;
    }
    return feed(input.command === "journal-page" ? events.filter((value) => value.sequence > input.after).slice(0, input.limit) : [],
      { revision, watermark, high_water: high, oldest_sequence: events[0]?.sequence ?? null });
  });
  return { request, add: (value: JournalEvent) => { events.push(value); high = value.sequence; } };
}

it("catches up without any browser, restarts without duplicates, exports only safe schema and confirms clear", async () => {
  const directory = await root(), source = fakeSource(Array.from({ length: 220 }, (_, index) => event(index + 1)));
  const service = new ListeningJournal(sourceId, 123, directory, source.request); services.push(service);
  await service.init(); await service.sync();
  let page = await service.page(undefined, 100);
  expect(page.entries).toHaveLength(100); expect(page.status).toBe("ready");
  expect((await service.page(page.nextCursor!, 100)).entries).toHaveLength(100);
  let data = "";
  for await (const chunk of service.export(AbortSignal.timeout(10_000))) data += chunk;
  expect(JSON.parse(data).entries).toHaveLength(220);
  expect(data).not.toMatch(/source_id|boot_id|catalog|https|sequence|artworkUrl/);
  await service.clear(page.revision);
  expect((await service.page()).entries).toHaveLength(0);
  await expect(service.page(page.nextCursor!)).rejects.toThrow("changed");
  source.add(event(221)); await service.sync();
  expect((await service.page()).entries).toHaveLength(1);
  await service.close(); services.splice(services.indexOf(service), 1);
  const restarted = new ListeningJournal(sourceId, 123, directory, source.request); services.push(restarted);
  await restarted.init(); await restarted.sync();
  expect((await restarted.page()).entries).toHaveLength(1);
});

it("fails clear explicitly when source is offline and keeps the local journal", async () => {
  const source = fakeSource([event()]);
  const service = new ListeningJournal(sourceId, 123, await root(), source.request); services.push(service);
  await service.init(); await service.sync();
  const page = await service.page();
  source.request.mockRejectedValue(new Error("offline"));
  await expect(service.clear(page.revision)).rejects.toThrow("could not be completed");
  expect((await service.page()).entries).toHaveLength(1);
});

it("bounds concurrent exports and stops an already buffered export when history is cleared", async () => {
  const source = fakeSource([event(1), event(2)]);
  const service = new ListeningJournal(sourceId, 123, await root(), source.request); services.push(service);
  await service.init(); await service.sync();
  const first = service.export(AbortSignal.timeout(10_000));
  const second = service.export(AbortSignal.timeout(10_000));
  const third = service.export(AbortSignal.timeout(10_000));
  await first.next(); await second.next();
  await expect(third.next()).rejects.toThrow("Too many");
  await second.return(undefined);
  const page = await service.page();
  await service.clear(page.revision);
  await expect(first.next()).rejects.toThrow("changed during export");
  const next = service.export(AbortSignal.timeout(10_000));
  await expect(next.next()).resolves.toMatchObject({ done: false });
  await next.return(undefined);
});

it("recovers a source-committed clear whose response was lost without serving stale history", async () => {
  const directory = await root(), source = fakeSource([event()]);
  const request = vi.fn(async (input: JournalRequest) => {
    const result = await source.request(input);
    if (input.command === "journal-clear") throw new Error("Lost response after source commit");
    return result;
  });
  const service = new ListeningJournal(sourceId, 123, directory, request); services.push(service);
  await service.init(); await service.sync();
  await expect(service.clear((await service.page()).revision)).rejects.toThrow("could not be completed");
  await expect(service.page()).rejects.toThrow();
  await service.close(); services.splice(services.indexOf(service), 1);
  const restarted = new ListeningJournal(sourceId, 123, directory, source.request); services.push(restarted);
  await restarted.init(); await restarted.sync();
  expect((await restarted.page()).entries).toHaveLength(0);
});

it("collects expired artwork and does not resurrect assets from a delayed completion after clear", async () => {
  const db = await store();
  const artwork = "https://is1-ssl.mzstatic.com/image/thumb/Music/abc/400x400bb.jpg";
  await db.import(feed([{ ...event(), album: { ...event().album, artwork } }]), now);
  await db.saveArtwork(1, Buffer.from([255, 216, 1, 255, 217]));
  const hash = (await db.page(10, {}, now)).entries[0]!.artworkUrl!.split("/").at(-1)!;
  expect(await db.artwork(hash)).not.toBeNull();
  expect((await db.page(10, {}, now + 90 * day)).entries).toHaveLength(0);
  expect(await db.artwork(hash)).toBeNull();
  await db.saveArtwork(1, Buffer.from([255, 216, 1, 255, 217]));
  expect(await db.artwork(hash)).toBeNull();
});
