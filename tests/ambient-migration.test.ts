import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../src/server/settings.js";
import { BUILTIN_BACKGROUNDS, DEFAULT_AMBIENT } from "../src/shared/ambient.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const dir = path.resolve(`.test-ambient-migration-${randomUUID()}`);
  await fs.mkdir(dir);
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("bundled photo catalog and legacy ambient preference migration", () => {
  it("preserves the original photo ids in the expanded native 4K catalog with local previews", () => {
    expect(BUILTIN_BACKGROUNDS.length).toBeGreaterThanOrEqual(30);
    expect(BUILTIN_BACKGROUNDS.slice(0, 4).map((image) => image.id)).toEqual([
      "builtin-golden-gate", "builtin-lone-pine", "builtin-rockaway", "builtin-bonzai",
    ]);
    for (const image of BUILTIN_BACKGROUNDS) {
      expect([image.width, image.height]).toEqual([3840, 2160]);
      expect(image.url).toMatch(/^\/backgrounds\/[^/]+\.jpg(?:\?v=[a-f0-9]+)?$/);
      expect(image.thumbnailUrl).toMatch(/^\/backgrounds\/thumbnails\/[^/]+\.jpg(?:\?v=[a-f0-9]+)?$/);
      expect(image).not.toHaveProperty("cached");
      expect(image.source).toBe("builtin");
      expect(image.credit).toMatchObject({
        author: "Romain Guy", license: "CC0 1.0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      });
      expect(image.credit?.sourceUrl).toMatch(/^https:\/\/www\.flickr\.com\/photos\/romainguy\/\d+\/?$/);
    }
    expect(DEFAULT_AMBIENT).toEqual({
      selectedIds: BUILTIN_BACKGROUNDS.map((image) => image.id), slideshow: true, dwellSeconds: 60,
    });
  });

  it("replaces any of six old builtin selections with the reviewed photos and persists all other preferences", async () => {
    const legacy = ["alpine", "dunes", "tidal", "orbit", "forest", "paper"].map((name) => `builtin-${name}`);
    for (const old of legacy) {
      const dir = await directory();
      const upload = `upload-${randomUUID()}`;
      const stored = {
        visualOffsetMs: -975, viewMode: "ambient",
        ambient: { selectedIds: [upload, old], slideshow: false, dwellSeconds: 315 },
      };
      await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(stored));
      const settings = new SettingsStore(dir); await settings.init();
      const expected = { ...stored, lyricFollowMode: "smooth", ambient: { ...stored.ambient, selectedIds: [upload, ...DEFAULT_AMBIENT.selectedIds] } };
      expect(settings).toMatchObject(expected);
      expect(JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8"))).toEqual(expected);
      const restored = new SettingsStore(dir); await restored.init();
      expect(restored).toMatchObject(expected);
      await expect(settings.set({ ambient: { selectedIds: [old] } })).rejects.toThrow();
    }
  });

  it("does not expand existing four-photo selections or rewrite valid preferences during the 4K upgrade", async () => {
    const dir = await directory();
    const selectedIds = ["builtin-golden-gate", "builtin-lone-pine", "builtin-rockaway", "builtin-bonzai", `upload-${randomUUID()}`];
    const preferences = JSON.stringify({
      visualOffsetMs: -975, viewMode: "ambient", ambient: { selectedIds, slideshow: false, dwellSeconds: 315 },
    });
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, preferences);
    const settings = new SettingsStore(dir);
    await settings.init();
    expect(settings.ambient.selectedIds).toEqual(selectedIds);
    expect(settings.visualOffsetMs).toBe(-975);
    expect(settings.ambient).toMatchObject({ slideshow: false, dwellSeconds: 315 });
    expect(settings.viewMode).toBe("ambient");
    expect(await fs.readFile(file, "utf8")).toBe(preferences);
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it("preserves empty selections, upload-only selections and old pre-ambient defaults; deduplicates the migrated catalog", async () => {
    for (const selectedIds of [[], [`upload-${randomUUID()}`], ["builtin-golden-gate", "builtin-paper", "builtin-lone-pine"]]) {
      const dir = await directory();
      const stored = { visualOffsetMs: 200, viewMode: "lyrics", ambient: { selectedIds, slideshow: true, dwellSeconds: 60 } };
      await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(stored));
      const settings = new SettingsStore(dir); await settings.init();
      expect(settings.ambient.selectedIds).toEqual(selectedIds.includes("builtin-paper") ?
        ["builtin-golden-gate", ...DEFAULT_AMBIENT.selectedIds.filter((id) =>
          id !== "builtin-golden-gate" && id !== "builtin-lone-pine"), "builtin-lone-pine"] : selectedIds);
      expect(settings.visualOffsetMs).toBe(200);
      expect(settings.viewMode).toBe("lyrics");
    }
    const dir = await directory();
    await fs.writeFile(path.join(dir, "settings.json"), '{"visualOffsetMs":-100}');
    const settings = new SettingsStore(dir); await settings.init();
    expect(settings.ambient).toEqual(DEFAULT_AMBIENT);
    expect(settings.viewMode).toBe("split");
  });

  it("fills only free selection slots while preserving all retained or deleted upload ids in valid full legacy settings", async () => {
    const legacy = ["alpine", "dunes", "tidal", "orbit", "forest", "paper"].map((name) => `builtin-${name}`);
    for (const oldCount of [1, 2, 3, 6]) {
      const dir = await directory();
      const maximum = BUILTIN_BACKGROUNDS.length + 40;
      const uploadIds = Array.from({ length: maximum - oldCount }, () => `upload-${randomUUID()}`);
      const stored = {
        visualOffsetMs: -1250, viewMode: "ambient",
        ambient: {
          selectedIds: [...uploadIds.slice(0, 10), ...legacy.slice(0, oldCount), ...uploadIds.slice(10)],
          slideshow: false, dwellSeconds: 315,
        },
      };
      const file = path.join(dir, "settings.json");
      await fs.writeFile(file, JSON.stringify(stored));
      const expectedIds = [
        ...uploadIds.slice(0, 10), ...DEFAULT_AMBIENT.selectedIds.slice(0, oldCount), ...uploadIds.slice(10),
      ];
      const expected = { ...stored, lyricFollowMode: "smooth", ambient: { ...stored.ambient, selectedIds: expectedIds } };
      const settings = new SettingsStore(dir); await settings.init();
      expect(settings).toMatchObject(expected);
      expect(settings.ambient.selectedIds.length).toBeLessThanOrEqual(maximum);
      expect(settings.ambient.selectedIds.filter((id) => id.startsWith("upload-"))).toEqual(uploadIds);
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(expected);
      const restored = new SettingsStore(dir); await restored.init();
      expect(restored).toMatchObject(expected);
    }
  });

  it("reserves space for already selected photos before adding replacements at the legacy position", async () => {
    const dir = await directory();
    const uploads = Array.from({ length: BUILTIN_BACKGROUNDS.length + 38 }, () => `upload-${randomUUID()}`);
    const selectedIds = ["builtin-paper", ...uploads, "builtin-golden-gate"];
    await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({
      visualOffsetMs: 0, ambient: { ...DEFAULT_AMBIENT, selectedIds },
    }));
    const settings = new SettingsStore(dir); await settings.init();
    expect(settings.ambient.selectedIds).toEqual(["builtin-lone-pine", ...uploads, "builtin-golden-gate"]);
    expect(settings.ambient.selectedIds).toHaveLength(BUILTIN_BACKGROUNDS.length + 40);
  });

  it("fails closed for malformed legacy settings and failed migration writes without losing the original", async () => {
    const dir = await directory();
    const file = path.join(dir, "settings.json");
    for (const selectedIds of [["builtin-paper", "builtin-paper"], ["builtin-paper", "builtin-unknown"]]) {
      await fs.writeFile(file, JSON.stringify({ visualOffsetMs: 200, ambient: { ...DEFAULT_AMBIENT, selectedIds } }));
      await expect(new SettingsStore(dir).init()).rejects.toThrow();
    }
    const original = JSON.stringify({
      visualOffsetMs: 200, viewMode: "split", ambient: { ...DEFAULT_AMBIENT, selectedIds: ["builtin-paper"] },
    });
    await fs.writeFile(file, original);
    for (const error of [new Error("cannot persist migration"), Object.assign(new Error("cannot persist: temporary file vanished"), { code: "ENOENT" })]) {
      vi.mocked(fs.rename).mockRejectedValueOnce(error);
      await expect(new SettingsStore(dir).init()).rejects.toThrow("cannot persist");
      expect(await fs.readFile(file, "utf8")).toBe(original);
    }
    const restored = new SettingsStore(dir); await restored.init();
    expect(restored.ambient).toEqual(DEFAULT_AMBIENT);
  });
});
