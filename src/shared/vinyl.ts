import { z } from "zod";

export const vinylSettingsSchema = z.object({
  showTracklist: z.boolean(),
  showMeters: z.boolean(),
}).strict();
export const vinylSettingsPatchSchema = vinylSettingsSchema.partial();
export type VinylSettings = z.infer<typeof vinylSettingsSchema>;
export const DEFAULT_VINYL: VinylSettings = { showTracklist: false, showMeters: true };
