import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsStore, settingsPatchSchema } from "../src/server/settings.js";
import { DEFAULT_AMBIENT } from "../src/shared/ambient.js";
import { DEFAULT_VINYL } from "../src/shared/vinyl.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const result = await mkdtemp(path.join(os.tmpdir(), "settings-rollback-"));
  directories.push(result);
  return result;
}
const preferences = {
  visualOffsetMs: -950, viewMode: "vinyl", lyricFollowMode: "instant",
  ambient: { ...DEFAULT_AMBIENT, selectedIds: [], slideshow: false, dwellSeconds: 315 },
  vinyl: { showTracklist: true, showMeters: false },
};

it.each([true, false])("preserves the retired %s colour preference without restoring the feature", async (artworkColours) => {
  const dir = await directory(), file = path.join(dir, "settings.json");
  const stored = { ...preferences, artworkColours };
  const original = JSON.stringify(stored);
  await writeFile(file, original);
  const settings = new SettingsStore(dir); await settings.init();
  expect(settings).toMatchObject(preferences);
  expect(settings).not.toHaveProperty("artworkColours");
  expect(await readFile(file, "utf8")).toBe(original);
  expect(settingsPatchSchema.safeParse({ artworkColours: !artworkColours }).success).toBe(false);
  await Promise.all([settings.set({ visualOffsetMs: 600 }), settings.set({ viewMode: "ambient" })]);
  const expected = { ...stored, visualOffsetMs: 600, viewMode: "ambient" };
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(expected);
  const restored = new SettingsStore(dir); await restored.init();
  expect(restored).toMatchObject({ ...preferences, visualOffsetMs: 600, viewMode: "ambient" });
  await restored.set({ vinyl: { showMeters: true } });
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    ...expected, vinyl: { ...preferences.vinyl, showMeters: true },
  });
});

it("preserves the retired preference through existing legacy-photo migration", async () => {
  const dir = await directory(), file = path.join(dir, "settings.json");
  await writeFile(file, JSON.stringify({
    ...preferences, artworkColours: true, ambient: { ...preferences.ambient, selectedIds: ["builtin-alpine"] },
  }));
  const settings = new SettingsStore(dir); await settings.init();
  expect(settings.ambient.selectedIds).toEqual(DEFAULT_AMBIENT.selectedIds);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    ...preferences, artworkColours: true,
    ambient: { ...preferences.ambient, selectedIds: DEFAULT_AMBIENT.selectedIds },
  });
});

it("does not add retired preferences to old files or relax other validation", async () => {
  const dir = await directory(), file = path.join(dir, "settings.json");
  const settings = new SettingsStore(dir); await settings.init();
  await settings.set({ visualOffsetMs: 100 });
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    visualOffsetMs: 100, viewMode: "split", lyricFollowMode: "smooth",
    ambient: DEFAULT_AMBIENT, vinyl: DEFAULT_VINYL,
  });
  for (const patch of [{ artworkColours: "true" }, { unexpected: true }]) {
    await writeFile(file, JSON.stringify({ ...preferences, ...patch }));
    await expect(new SettingsStore(dir).init()).rejects.toThrow();
  }
});
