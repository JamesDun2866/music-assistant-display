import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { constants, lstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";

const DAY = 86_400_000, ART_BUDGET = 256 * 1024 * 1024;
const directory = path.join(workerData.directory, "listening-journal");
const file = path.join(directory, "journal.sqlite");
let db, directoryIdentity;
function check(info, isDirectory = false) {
  if (info.isSymbolicLink() || !(isDirectory ? info.isDirectory() : info.isFile())
    || (!isDirectory && info.nlink !== 1)
    || (process.platform !== "win32" && (info.uid !== process.getuid()
      || (info.mode & 0o777) !== (isDirectory ? 0o700 : 0o600)))) throw new Error("Unsafe journal storage");
}
function storage() {
  const info = lstatSync(directory);
  check(info, true);
  if (directoryIdentity && (info.dev !== directoryIdentity.dev || info.ino !== directoryIdentity.ino)) {
    throw new Error("Journal directory changed");
  }
  for (const name of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    try { check(lstatSync(name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return info;
}
function state() { return db.prepare("SELECT * FROM state WHERE id=1").get(); }
function transaction(action) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function prune(now) {
  const cutoff = Math.max(state().cutoff, now - 90 * DAY);
  db.prepare("UPDATE state SET cutoff=? WHERE id=1").run(cutoff);
  const deleted = db.prepare("DELETE FROM events WHERE identified_at<=?").run(cutoff);
  if (deleted.changes) db.exec("DELETE FROM assets WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.asset=assets.hash)");
}
function init() {
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  directoryIdentity = storage();
  try {
    const handle = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    closeSync(handle);
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  storage();
  db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1500;
    PRAGMA cache_size=-2048; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS state (
      id INTEGER PRIMARY KEY CHECK(id=1), source TEXT NOT NULL, uid INTEGER NOT NULL,
      epoch TEXT, revision INTEGER NOT NULL DEFAULT 0, watermark INTEGER NOT NULL DEFAULT 0,
      cursor INTEGER NOT NULL DEFAULT 0, dataset TEXT NOT NULL, cutoff INTEGER NOT NULL DEFAULT ${-90 * DAY},
      clear_pending INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS assets (hash TEXT PRIMARY KEY, jpeg BLOB NOT NULL, used_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, boot TEXT NOT NULL, generation INTEGER NOT NULL,
      original TEXT NOT NULL, identified_at INTEGER NOT NULL, adjusted INTEGER NOT NULL,
      title TEXT NOT NULL, artist TEXT NOT NULL, artwork TEXT, asset TEXT,
      art_attempted INTEGER NOT NULL DEFAULT 0, UNIQUE(boot,generation));
    CREATE INDEX IF NOT EXISTS events_expiry ON events(identified_at);
    CREATE INDEX IF NOT EXISTS events_asset ON events(asset);
    CREATE INDEX IF NOT EXISTS events_artwork ON events(artwork);
    CREATE INDEX IF NOT EXISTS events_missing ON events(art_attempted,id);`);
  if (!state()) db.prepare("INSERT INTO state(id,source,uid,dataset) VALUES(1,?,?,?)")
    .run(workerData.sourceId, workerData.uid, randomBytes(16).toString("hex"));
  if (state().source !== workerData.sourceId || state().uid !== workerData.uid) {
    throw new Error("Journal storage belongs to another source; use a separate state directory");
  }
  transaction(() => prune(Date.now()));
  return state();
}
function importFeed(feed, now) {
  return transaction(() => {
    let current = state();
    if (feed.source_id !== current.source) throw new Error("Journal source mismatch");
    if (feed.epoch === current.epoch && (feed.revision < current.revision || feed.watermark < current.watermark)) {
      throw new Error("Journal feed moved backwards");
    }
    if (current.epoch !== feed.epoch) {
      db.prepare("UPDATE state SET epoch=?,revision=0,watermark=0,cursor=0,dataset=? WHERE id=1")
        .run(feed.epoch, randomBytes(16).toString("hex"));
      current = state();
    }
    if (feed.revision > current.revision) {
      db.exec("DELETE FROM events; DELETE FROM assets");
      db.prepare("UPDATE state SET revision=?,watermark=?,cursor=?,dataset=? WHERE id=1")
        .run(feed.revision, feed.watermark, feed.watermark, randomBytes(16).toString("hex"));
    }
    const insert = db.prepare(`INSERT OR IGNORE INTO events
      (boot,generation,original,identified_at,adjusted,title,artist,artwork)
      VALUES(?,?,?,?,?,?,?,?)`);
    const acceptedThrough = state().cursor;
    const clockCeiling = Math.max(now, state().cutoff + 90 * DAY);
    for (const event of feed.events) {
      if (event.source_id !== current.source || event.sequence <= feed.watermark) throw new Error("Invalid journal event");
      if (event.sequence <= acceptedThrough) continue;
      // Preserve causal success time through clock rollback, but never import an unbounded future date.
      const date = Math.min(event.album_success.at_ms, clockCeiling);
      insert.run(event.album_success.boot_id, event.album_success.generation, JSON.stringify(event), date,
        Number(date !== event.observed_at_ms || Math.abs(event.album_success.at_ms - event.observed_at_ms) > 60_000),
        event.album.title, event.album.artist, event.album.artwork);
    }
    const through = feed.events.at(-1)?.sequence ?? (feed.oldest_sequence === null ? feed.high_water : state().cursor);
    db.prepare("UPDATE state SET cursor=max(cursor,?),clear_pending=0 WHERE id=1").run(through);
    prune(now);
    return state();
  });
}
function page(input) {
  transaction(() => prune(input.now));
  const current = state();
  if (current.clear_pending) throw new Error("Journal clear requires source synchronization");
  if (input.revision && current.dataset !== input.revision) throw new Error("Journal changed; refresh before continuing");
  const upper = input.upper ?? db.prepare("SELECT coalesce(max(id),0) AS n FROM events").get().n;
  const before = input.before ?? upper + 1;
  const rows = db.prepare(`SELECT id,identified_at,adjusted,title,artist,asset FROM events
    WHERE id<=? AND id<? ORDER BY id DESC LIMIT ?`).all(upper, before, input.limit + 1);
  const more = rows.length > input.limit;
  rows.length = Math.min(rows.length, input.limit);
  return { revision: current.dataset, upper, more, entries: rows.map((row) => ({
    id: row.id, identifiedAt: row.identified_at, clockAdjusted: Boolean(row.adjusted),
    title: row.title, artist: row.artist,
    artworkUrl: row.asset ? `/api/listening-journal/artwork/${row.asset}` : null,
  })) };
}
function artwork(input) {
  if (state().clear_pending) throw new Error("Journal clear requires source synchronization");
  transaction(() => prune(input.now));
  const row = db.prepare("SELECT jpeg FROM assets WHERE hash=?").get(input.hash);
  if (!row) return null;
  db.prepare("UPDATE assets SET used_at=? WHERE hash=?").run(input.now, input.hash);
  return row.jpeg;
}
function saveArtwork(input) {
  return transaction(() => {
    // An artwork fetch that finishes after clear/expiry must not resurrect an asset.
    const target = db.prepare("SELECT artwork FROM events WHERE id=?").get(input.id);
    if (!target) return;
    if (!input.jpeg) {
      db.prepare("UPDATE events SET art_attempted=1 WHERE artwork=?").run(target.artwork);
      return;
    }
    const jpeg = Buffer.from(input.jpeg);
    if (jpeg.length > 256 * 1024 || jpeg[0] !== 255 || jpeg[1] !== 216
      || jpeg.at(-2) !== 255 || jpeg.at(-1) !== 217) throw new Error("Invalid journal cover");
    const hash = createHash("sha256").update(jpeg).digest("hex");
    db.prepare("INSERT OR IGNORE INTO assets(hash,jpeg,used_at) VALUES(?,?,?)").run(hash, jpeg, input.now);
    db.prepare("UPDATE events SET asset=?,art_attempted=1 WHERE artwork=?").run(hash, target.artwork);
    let size = db.prepare("SELECT coalesce(sum(length(jpeg)),0) AS n FROM assets").get().n;
    while (size > ART_BUDGET) {
      const oldest = db.prepare("SELECT hash,length(jpeg) AS n FROM assets ORDER BY used_at,hash LIMIT 1").get();
      db.prepare("UPDATE events SET asset=NULL WHERE asset=?").run(oldest.hash);
      db.prepare("DELETE FROM assets WHERE hash=?").run(oldest.hash);
      size -= oldest.n;
    }
  });
}
parentPort.on("message", ({ id, operation, input }) => {
  try {
    if (operation !== "init" && operation !== "close") storage();
    let result;
    if (operation === "init") result = init();
    else if (operation === "state") result = state();
    else if (operation === "markClear") {
      db.prepare("UPDATE state SET clear_pending=1 WHERE id=1").run(); result = null;
    }
    else if (operation === "import") result = importFeed(input.feed, input.now);
    else if (operation === "page") result = page(input);
    else if (operation === "artwork") result = artwork(input);
    else if (operation === "saveArtwork") result = saveArtwork(input);
    else if (operation === "missingArtwork") {
      transaction(() => prune(input.now));
      result = db.prepare("SELECT id,artwork FROM events WHERE art_attempted=0 AND artwork IS NOT NULL ORDER BY id DESC LIMIT 1").get() ?? null;
      if (result) {
        const existing = db.prepare("SELECT asset FROM events WHERE artwork=? AND asset IS NOT NULL LIMIT 1").get(result.artwork);
        if (existing) {
          db.prepare("UPDATE events SET asset=?,art_attempted=1 WHERE artwork=?").run(existing.asset, result.artwork);
          result = null;
        }
      }
    } else if (operation === "maintain") {
      transaction(() => prune(input.now)); db.exec("PRAGMA incremental_vacuum(128)"); result = null;
    } else if (operation === "close") { db?.close(); result = null; }
    else throw new Error("Unknown journal operation");
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: operation === "init" ? "Journal storage could not be opened safely."
      : "Journal operation failed; refresh and inspect local storage." });
  }
});
