import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MonotonicPlaybackClock } from "../src/server/clock.js";
import { parseLyrics } from "../src/server/lrc.js";
import { LyricsCache } from "../src/server/cache.js";
import { SettingsStore, settingsPatchSchema } from "../src/server/settings.js";
import { loadConfig } from "../src/server/config.js";
import { DEFAULT_AMBIENT } from "../src/shared/ambient.js";

describe("LRC", () => {
  it("orders repeated timestamps, offsets and Unicode without markup interpretation", () => {
    const result = parseLyrics("\uFEFF[offset:-500]\r\n[00:03.12][00:01.2]Synthetic café 世界\r\n[00:00.100]<00:00.100><script>synthetic</script>");
    expect(result.lines).toEqual([
      { timeMs: 0, text: "<script>synthetic</script>" },
      { timeMs: 700, text: "Synthetic café 世界" },
      { timeMs: 2620, text: "Synthetic café 世界" },
    ]);
  });
  it("preserves blank timed lines and rejects malformed timestamps as plain", () => {
    expect(parseLyrics("[00:01]\n[00:02.001]Synthetic").lines[0]?.text).toBe("");
    expect(parseLyrics("[00:99]Synthetic").status).toBe("plain");
    expect(parseLyrics(null).status).toBe("missing");
    expect(parseLyrics("Synthetic plain line").plain).toBe("Synthetic plain line");
  });
  it("bounds untrusted content", () => {
    expect(() => parseLyrics("x".repeat(256 * 1024 + 1))).toThrow("lyrics_too_large");
    expect(() => parseLyrics("[offset:99999999999999999999]")).toThrow();
    expect(() => parseLyrics("[00:00]x\n".repeat(4001))).toThrow();
  });
});
describe("monotonic clock", () => {
  it("handles pause, resume, seek, duration, and freezing on network loss", () => {
    let now = 100;
    const clock = new MonotonicPlaybackClock(() => now);
    clock.anchor(2000, 1, 10_000);
    now += 1000;
    expect(clock.position()).toBe(3000);
    clock.freeze();
    now += 5000;
    expect(clock.position()).toBe(3000);
    clock.anchor(1000, 1, 10_000);
    now += 100;
    expect(clock.position()).toBe(1100);
    clock.anchor(9500, 1, 10_000);
    now += 1000;
    expect(clock.position()).toBe(10_000);
  });
});
const directories: string[] = [];
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), "karaoke-")); directories.push(dir); return dir; }
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
it("bounds cache entries, persists stable identities and expires missing results", async () => {
  const dir = await temp();
  let now = 1000;
  const cache = new LyricsCache(dir, 2, () => now);
  await cache.init();
  for (const key of ["provider://1", "provider://2", "provider://3"]) await cache.put(key, parseLyrics(null));
  expect(cache.size).toBe(2);
  const restored = new LyricsCache(dir, 2, () => now);
  await restored.init();
  expect((await restored.get("provider://3"))?.status).toBe("missing");
  now += 300_001;
  expect(await restored.get("provider://3")).toBeNull();
});
it("persists validated visual offset", async () => {
  const dir = await temp();
  const settings = new SettingsStore(dir);
  await settings.init();
  await settings.set(-1500);
  const restored = new SettingsStore(dir);
  await restored.init();
  expect(restored.visualOffsetMs).toBe(-1500);
  await expect(restored.set(30_001)).rejects.toThrow();
});
it("migrates legacy offsets and atomically merges concurrent view and offset changes", async () => {
  const dir = await temp();
  await writeFile(path.join(dir, "settings.json"), '{"visualOffsetMs":500}');
  const settings = new SettingsStore(dir);
  await settings.init();
  expect(settings.viewMode).toBe("split");
  expect(settings.ambient).toEqual(DEFAULT_AMBIENT);
  await Promise.all([settings.set({ viewMode: "now-playing" }), settings.set({ visualOffsetMs: -300 })]);
  const restored = new SettingsStore(dir);
  await restored.init();
  expect(restored.viewMode).toBe("now-playing");
  expect(restored.visualOffsetMs).toBe(-300);
  await restored.set({ viewMode: "lyrics" });
  expect(restored.visualOffsetMs).toBe(-300);
  await expect(restored.set({})).rejects.toThrow();
  await expect(restored.set({ viewMode: "invalid" as "lyrics" })).rejects.toThrow();
});
it("merges concurrent ambient patches inside serialized writes and keeps numeric overloads", async () => {
  const dir = await temp();
  await writeFile(path.join(dir, "settings.json"), '{"visualOffsetMs":250,"viewMode":"lyrics"}');
  const settings = new SettingsStore(dir);
  await settings.init();
  expect(settings.ambient).toEqual(DEFAULT_AMBIENT);
  await Promise.all([
    settings.set({ ambient: { selectedIds: ["builtin-golden-gate"] } }),
    settings.set({ ambient: { slideshow: false } }),
    settings.set({ viewMode: "ambient", ambient: { dwellSeconds: 180 } }),
    settings.set(-500),
  ]);
  const restored = new SettingsStore(dir);
  await restored.init();
  expect(restored.visualOffsetMs).toBe(-500);
  expect(restored.viewMode).toBe("ambient");
  expect(restored.ambient).toEqual({ selectedIds: ["builtin-golden-gate"], slideshow: false, dwellSeconds: 180 });
  for (const ambient of [
    {}, { selectedIds: undefined }, { selectedIds: ["builtin-golden-gate", "builtin-golden-gate"] }, { selectedIds: ["builtin-nope"] },
    { selectedIds: ["../image.jpg"] }, { selectedIds: ["upload-not-a-uuid"] }, { dwellSeconds: 14 },
    { dwellSeconds: 3601 }, { dwellSeconds: 15.5 }, { slideshow: "true" }, { extra: true },
  ]) {
    await expect(settings.set({ ambient } as Parameters<SettingsStore["set"]>[0])).rejects.toThrow();
  }
  await settings.set({ ambient: { selectedIds: [] } });
  expect(settings.ambient.selectedIds).toEqual([]);
  await settings.set({ ambient: { selectedIds: undefined, slideshow: true } });
  expect(settings.ambient).toEqual({ selectedIds: [], slideshow: true, dwellSeconds: 180 });
});
it("defaults legacy lyric follow to smooth and persists independent concurrent instant settings", async () => {
  const dir = await temp();
  await writeFile(path.join(dir, "settings.json"), '{"visualOffsetMs":500,"viewMode":"lyrics"}');
  const settings = new SettingsStore(dir);
  await settings.init();
  expect(settings.lyricFollowMode).toBe("smooth");
  await Promise.all([
    settings.set({ lyricFollowMode: "instant" }),
    settings.set({ visualOffsetMs: -300 }),
    settings.set({ ambient: { slideshow: false } }),
  ]);
  const restored = new SettingsStore(dir);
  await restored.init();
  expect(restored).toMatchObject({ lyricFollowMode: "instant", visualOffsetMs: -300, viewMode: "lyrics" });
  expect(restored.ambient).toEqual({ ...DEFAULT_AMBIENT, slideshow: false });
  for (const value of ["auto", "fast", null, 0, true]) {
    expect(settingsPatchSchema.safeParse({ lyricFollowMode: value }).success).toBe(false);
  }
  await restored.set({ lyricFollowMode: "smooth" });
  expect(restored.visualOffsetMs).toBe(-300);
});
it("rejects exposed binds, invalid booleans, credentials in URLs and incomplete live mode", () => {
  expect(() => loadConfig({ HOST: "0.0.0.0", DEMO_MODE: "true" })).toThrow();
  expect(() => loadConfig({ DEMO_MODE: "yes" })).toThrow();
  expect(() => loadConfig({})).toThrow("requires");
  expect(loadConfig({ DEMO_MODE: "true" }).PORT).toBe(8787);
});
