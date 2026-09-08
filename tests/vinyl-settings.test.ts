import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsStore, settingsPatchSchema } from "../src/server/settings.js";
import { DEFAULT_VINYL } from "../src/shared/vinyl.js";
import { DEFAULT_AMBIENT } from "../src/shared/ambient.js";
import { snapshotSchema } from "../src/web/schema.js";
import { emptyLyrics } from "../src/shared/protocol.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
it.each(["now-playing", "lyrics", "split", "ambient"])("preserves saved %s and every existing preference when adding vinyl", async (viewMode) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vinyl-settings-")); directories.push(dir);
  const original = { visualOffsetMs: -950, viewMode, lyricFollowMode: "instant",
    ambient: { ...DEFAULT_AMBIENT, selectedIds: [], slideshow: false, dwellSeconds: 315 } };
  await writeFile(path.join(dir, "settings.json"), JSON.stringify(original));
  const settings = new SettingsStore(dir); await settings.init();
  expect(settings).toMatchObject({ ...original, vinyl: DEFAULT_VINYL });
  await Promise.all([
    settings.set({ vinyl: { showTracklist: true } }), settings.set({ vinyl: { showMeters: false } }),
    settings.set({ viewMode: "vinyl" }),
  ]);
  const restored = new SettingsStore(dir); await restored.init();
  expect(restored).toMatchObject({ ...original, viewMode: "vinyl", vinyl: { showTracklist: true, showMeters: false } });
  expect(JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"))).toEqual({
    ...original, viewMode: "vinyl", vinyl: { showTracklist: true, showMeters: false },
  });
});
it("validates vinyl patches without coercion or unexpected settings", () => {
  for (const vinyl of [{ showMeters: "false" }, { showTracklist: 1 }, { spinning: true }, null]) {
    expect(settingsPatchSchema.safeParse({ vinyl }).success).toBe(false);
  }
  expect(settingsPatchSchema.parse({ vinyl: { showMeters: false } })).toEqual({ vinyl: { showMeters: false } });
});
it("accepts vinyl snapshots and defaults legacy snapshots without changing their selected view", () => {
  const state = { sequence: 1, generation: 1, demo: false, connection: "disconnected", playback: "idle",
    track: null, lyrics: emptyLyrics(), positionMs: 0, speed: 0, visualOffsetMs: 500, precision: "ma-queue",
    message: null, cec: { enabled: false, available: false, owned: false, message: "Off" } };
  expect(snapshotSchema.parse({ ...state, viewMode: "lyrics" })).toMatchObject({ viewMode: "lyrics", vinyl: DEFAULT_VINYL });
  expect(snapshotSchema.parse({ ...state, viewMode: "vinyl", vinyl: { showMeters: false, showTracklist: true } }))
    .toMatchObject({ viewMode: "vinyl", vinyl: { showMeters: false, showTracklist: true } });
  expect(snapshotSchema.safeParse({ ...state, vinyl: { showMeters: "yes" } }).success).toBe(false);
});
