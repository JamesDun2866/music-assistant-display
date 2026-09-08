import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isFsError } from "./cache.js";
import type { LyricFollowMode, ViewMode } from "../shared/protocol.js";
import { DEFAULT_VINYL, vinylSettingsSchema, vinylSettingsPatchSchema, type VinylSettings } from "../shared/vinyl.js";
import { ambientIdSchema, ambientSettingsSchema, ambientSettingsPatchSchema, BUILTIN_BACKGROUNDS, DEFAULT_AMBIENT, type AmbientSettings } from "../shared/ambient.js";

const offsetSchema = z.number().int().min(-30_000).max(30_000);
const viewModeSchema = z.enum(["now-playing", "lyrics", "split", "ambient", "vinyl"]);
const lyricFollowModeSchema = z.enum(["smooth", "instant"]);
export const settingsSchema = z.object({
  visualOffsetMs: offsetSchema,
  viewMode: viewModeSchema.default("split"),
  lyricFollowMode: lyricFollowModeSchema.default("smooth"),
  ambient: ambientSettingsSchema.default(DEFAULT_AMBIENT),
  vinyl: vinylSettingsSchema.default(DEFAULT_VINYL),
}).strict();
export const settingsPatchSchema = z.object({
  visualOffsetMs: offsetSchema.optional(),
  viewMode: viewModeSchema.optional(),
  lyricFollowMode: lyricFollowModeSchema.optional(),
  ambient: ambientSettingsPatchSchema.optional(),
  vinyl: vinylSettingsPatchSchema.optional(),
}).strict().refine((patch) => patch.visualOffsetMs !== undefined || patch.viewMode !== undefined
  || patch.lyricFollowMode !== undefined || patch.ambient !== undefined || patch.vinyl !== undefined);
const legacyIds = ["builtin-alpine", "builtin-dunes", "builtin-tidal", "builtin-orbit", "builtin-forest", "builtin-paper"] as const;
const legacyIdSet = new Set<string>(legacyIds);
const storedSettingsSchema = settingsSchema.extend({
  artworkColours: z.boolean().optional(),
  ambient: ambientSettingsSchema.extend({
    selectedIds: z.array(z.union([ambientIdSchema, z.enum(legacyIds)])).max(BUILTIN_BACKGROUNDS.length + 40)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate image ids"),
  }).default(DEFAULT_AMBIENT),
});

async function regularSettingsFile(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) {
      throw new Error("Unsafe settings file or temporary file");
    }
    return true;
  } catch (error) { if (isFsError(error, "ENOENT")) return false; throw error; }
}

export class SettingsStore {
  visualOffsetMs = 0;
  viewMode: ViewMode = "split";
  lyricFollowMode: LyricFollowMode = "smooth";
  ambient: AmbientSettings = structuredClone(DEFAULT_AMBIENT);
  vinyl: VinylSettings = { ...DEFAULT_VINYL };
  private retiredArtworkColours?: boolean;
  private writes = Promise.resolve();
  constructor(private readonly directory: string) {}
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, "settings.json");
    await regularSettingsFile(file);
    if (await regularSettingsFile(`${file}.tmp`)) await unlink(`${file}.tmp`);
    let content: string;
    try { content = await readFile(file, "utf8"); }
    catch (error) { if (isFsError(error, "ENOENT")) return; throw error; }
    const { artworkColours, ...stored } = storedSettingsSchema.parse(JSON.parse(content));
    this.retiredArtworkColours = artworkColours;
    if (stored.ambient.selectedIds.some((id) => legacyIdSet.has(id))) {
      const preservedIds = new Set(stored.ambient.selectedIds.filter((id) => !legacyIdSet.has(id)));
      // Deleted uploads may still be selected: preserve every existing id before filling free slots.
      const replacements = DEFAULT_AMBIENT.selectedIds.filter((id) => !preservedIds.has(id)).slice(0, BUILTIN_BACKGROUNDS.length + 40 - preservedIds.size);
      stored.ambient.selectedIds = [...new Set(stored.ambient.selectedIds.flatMap((id) =>
        legacyIdSet.has(id) ? replacements : [id],
      ))];
      await this.set(settingsSchema.parse(stored));
      return;
    }
    this.visualOffsetMs = stored.visualOffsetMs;
    this.viewMode = stored.viewMode;
    this.lyricFollowMode = stored.lyricFollowMode;
    this.ambient = stored.ambient;
    this.vinyl = stored.vinyl;
  }
  async set(update: number | z.infer<typeof settingsPatchSchema>): Promise<void> {
    const patch = settingsPatchSchema.parse(typeof update === "number" ? { visualOffsetMs: update } : update);
    const write = this.writes.then(async () => {
      const data = {
        // Preserve the retired preference without enabling or exposing the colour feature.
        ...(this.retiredArtworkColours === undefined ? {} : { artworkColours: this.retiredArtworkColours }),
        visualOffsetMs: patch.visualOffsetMs ?? this.visualOffsetMs,
        viewMode: patch.viewMode ?? this.viewMode,
        lyricFollowMode: patch.lyricFollowMode ?? this.lyricFollowMode,
        ambient: {
          selectedIds: patch.ambient?.selectedIds ?? this.ambient.selectedIds,
          slideshow: patch.ambient?.slideshow ?? this.ambient.slideshow,
          dwellSeconds: patch.ambient?.dwellSeconds ?? this.ambient.dwellSeconds,
        },
        vinyl: {
          showTracklist: patch.vinyl?.showTracklist ?? this.vinyl.showTracklist,
          showMeters: patch.vinyl?.showMeters ?? this.vinyl.showMeters,
        },
      };
      const file = path.join(this.directory, "settings.json");
      const temporary = `${file}.tmp`;
      await regularSettingsFile(file);
      if (await regularSettingsFile(temporary)) await unlink(temporary);
      const handle = await open(temporary, "wx", 0o600);
      try {
        try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); }
        finally { await handle.close(); }
        await regularSettingsFile(temporary);
        await regularSettingsFile(file);
        await rename(temporary, file);
      } catch (error) {
        try { await unlink(temporary); } catch (cleanupError) { if (!isFsError(cleanupError, "ENOENT")) throw cleanupError; }
        throw error;
      }
      this.visualOffsetMs = data.visualOffsetMs;
      this.viewMode = data.viewMode;
      this.lyricFollowMode = data.lyricFollowMode;
      this.ambient = data.ambient;
      this.vinyl = data.vinyl;
    });
    this.writes = write.catch(() => {});
    await write;
  }
}
