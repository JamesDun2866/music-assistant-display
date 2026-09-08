import { z } from "zod";

export const catalogReferenceSchema = z.object({
  kind: z.enum(["collection", "track"]),
  id: z.string().regex(/^[1-9][0-9]{0,14}$/),
  country: z.string().regex(/^[a-z]{2}$/),
}).strict();
export type CatalogReference = z.infer<typeof catalogReferenceSchema>;
export const albumArtworkReference = z.string().max(1024).regex(
  /^https:\/\/is[1-5]-ssl\.mzstatic\.com\/image\/thumb\/[A-Za-z0-9_./-]{1,800}\/[1-9][0-9]{1,3}x[1-9][0-9]{1,3}(?:bb|cc)\.(?:jpg|png)$/,
).refine((value) => !value.includes(".."));
