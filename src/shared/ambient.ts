import { z } from "zod";
import backgroundCatalog from "./background-catalog.json" with { type: "json" };

export interface AmbientSettings {
  selectedIds: string[];
  slideshow: boolean;
  dwellSeconds: number;
}

export interface AmbientImage {
  id: string;
  title: string;
  url: string;
  thumbnailUrl?: string;
  thumbnailBytes?: number;
  source: "builtin" | "upload";
  width: number;
  height: number;
  bytes: number;
  credit?: { author: string; sourceUrl: string; license: string; licenseUrl: string };
}

export interface AmbientLibrary {
  images: AmbientImage[];
  limits: { maxUploadBytes: number; maxImages: number; maxStorageBytes: number; maxPixels: number };
}

export const BUILTIN_BACKGROUNDS: AmbientImage[] = backgroundCatalog.map((image) => ({
  ...image, source: "builtin",
}));

export const DEFAULT_AMBIENT: AmbientSettings = {
  selectedIds: BUILTIN_BACKGROUNDS.map((image) => image.id), slideshow: true, dwellSeconds: 60,
};

export const uploadIdSchema = z.string().regex(/^upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const ambientIdSchema = z.string().refine((id) =>
  BUILTIN_BACKGROUNDS.some((image) => image.id === id) || uploadIdSchema.safeParse(id).success,
);
const ambientFields = {
  selectedIds: z.array(ambientIdSchema).max(BUILTIN_BACKGROUNDS.length + 40).refine((ids) => new Set(ids).size === ids.length, "Duplicate image ids"),
  slideshow: z.boolean(),
  dwellSeconds: z.number().int().min(15).max(3600),
};
export const ambientSettingsSchema = z.object(ambientFields).strict();
export const ambientSettingsPatchSchema = ambientSettingsSchema.partial().refine((patch) =>
  patch.selectedIds !== undefined || patch.slideshow !== undefined || patch.dwellSeconds !== undefined,
  "Provide at least one ambient setting",
);
