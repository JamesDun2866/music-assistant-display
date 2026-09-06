import { z } from "zod";

const cursor = z.enum(["none", "other", "unavailable"]);
const dimension = z.number().int().min(0).max(32768);
export const kioskPageSchema = z.object({
  queryEnabled: z.boolean(),
  rootPath: z.boolean(),
  bootstrapEnabled: z.boolean(),
  stylesheetLoaded: z.boolean(),
  visibility: z.enum(["visible", "hidden"]),
  focused: z.boolean(),
  fullscreenMedia: z.boolean(),
  viewportWidth: dimension,
  viewportHeight: dimension,
  rootCursor: cursor,
  bodyCursor: cursor,
  centerCursor: cursor,
  pointerCursor: cursor,
  pointerObserved: z.boolean(),
  remote: z.enum(["disabled", "connecting", "connected", "waiting", "reconnecting", "paused"]),
}).strict();

export const kioskReportSchema = z.object({
  pageId: z.string().uuid(),
  page: kioskPageSchema,
}).strict();

export const kioskDiagnosticsSchema = z.object({
  pages: z.array(z.object({
    ageMs: z.number().int().min(0).max(45000),
    page: kioskPageSchema,
  }).strict()).max(4),
}).strict();

export type KioskPage = z.infer<typeof kioskPageSchema>;
export type KioskDiagnostics = z.infer<typeof kioskDiagnosticsSchema>;
