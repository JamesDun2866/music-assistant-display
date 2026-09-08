import { z } from "zod";
import type { Snapshot } from "../shared/protocol.js";
import { DEFAULT_VINYL, vinylSettingsSchema } from "../shared/vinyl.js";
import { ambientIdSchema, ambientSettingsSchema, BUILTIN_BACKGROUNDS, DEFAULT_AMBIENT, uploadIdSchema, type AmbientLibrary } from "../shared/ambient.js";
import { remoteKeySchema } from "./remoteEvents.js";
import { CEC_ROUTE_ACKNOWLEDGEMENTS, CEC_ROUTE_DECISIONS } from "../shared/remote.js";

const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const text = z.string().max(256 * 1024);
const lineSchema = z.object({ timeMs: nonnegative, text });

export const snapshotSchema: z.ZodType<Snapshot, z.ZodTypeDef, unknown> = z.object({
  sequence: nonnegative.int(),
  generation: nonnegative.int(),
  demo: z.boolean(),
  connection: z.enum(["connecting", "connected", "stale", "disconnected"]),
  playback: z.enum(["playing", "paused", "idle"]),
  track: z.object({
    identity: text,
    title: text,
    artist: text,
    album: text,
    durationMs: nonnegative.nullable(),
    artworkUrl: text.nullable(),
  }).nullable(),
  lyrics: z.object({
    status: z.enum(["loading", "timed", "plain", "missing", "error", "unsupported"]),
    lines: z.array(lineSchema).max(4_000).refine(
      (lines) => lines.every((line, index) => index === 0 || line.timeMs >= lines[index - 1]!.timeMs),
      "Lyrics must be in time order",
    ),
    plain: text.nullable(),
    message: text.nullable(),
  }),
  positionMs: nonnegative,
  speed: z.union([z.literal(0), z.literal(1)]),
  visualOffsetMs: finite,
  viewMode: z.enum(["now-playing", "lyrics", "split", "ambient", "vinyl"]).default("split"),
  lyricFollowMode: z.enum(["smooth", "instant"]).default("smooth"),
  ambient: ambientSettingsSchema.default(DEFAULT_AMBIENT),
  vinyl: vinylSettingsSchema.default(DEFAULT_VINYL),
  precision: z.enum(["ma-queue", "ma-player", "demo"]),
  message: text.nullable(),
  cec: z.object({
    enabled: z.boolean(),
    available: z.boolean(),
    message: text,
    owned: z.boolean(),
    remote: z.object({
      enabled: z.boolean(), listening: z.boolean(), device: z.string().max(4096),
      logicalAddress: z.number().int().min(0).max(15).nullable(),
      physicalAddress: z.number().int().min(0).max(65535).nullable(),
      lastEvent: z.object({ key: remoteKeySchema, at: nonnegative.int().safe() }).nullable(),
      lastRouting: z.object({
        id: nonnegative.int().safe().min(1),
        opcode: z.number().int().min(0).max(255),
        source: z.number().int().min(0).max(15),
        target: z.number().int().min(0).max(15),
        physicalAddress: z.number().int().min(0).max(65535).nullable(),
        decision: z.enum(CEC_ROUTE_DECISIONS),
        acknowledgement: z.enum(CEC_ROUTE_ACKNOWLEDGEMENTS),
        at: nonnegative.int().safe(),
      }).strict().nullable().optional(),
      kioskConnected: z.boolean(),
    }).optional(),
  }),
});

export const ambientImageSchema = z.object({
  id: ambientIdSchema,
  title: z.string().max(1024),
  url: z.string().refine((value) => Boolean(localArtworkUrl(value)), "Image must be served locally"),
  thumbnailUrl: z.string().refine((value) => Boolean(localArtworkUrl(value)), "Thumbnail must be served locally").optional(),
  thumbnailBytes: nonnegative.int().max(256 * 1024).optional(),
  source: z.enum(["builtin", "upload"]),
  width: nonnegative.int().max(3840),
  height: nonnegative.int().max(2160),
  bytes: nonnegative.int(),
  credit: z.object({
    author: z.literal("Romain Guy"),
    sourceUrl: z.string().refine((value) => reviewedCreditUrl(value, "sourceUrl"), "Unreviewed photo source"),
    license: z.literal("CC0 1.0"),
    licenseUrl: z.string().refine((value) => reviewedCreditUrl(value, "licenseUrl"), "Unreviewed photo license"),
  }).optional(),
}).refine((image) => image.source === "upload" ? uploadIdSchema.safeParse(image.id).success
  && image.credit === undefined
  : BUILTIN_BACKGROUNDS.some((builtin) => builtin.id === image.id && builtin.url === image.url),
  "Image source or catalog URL does not match its id")
  .refine((image) => image.thumbnailUrl === undefined || (image.source === "upload"
    ? image.thumbnailUrl === `/api/backgrounds/thumbnail/${image.id}`
    : BUILTIN_BACKGROUNDS.some((builtin) => builtin.id === image.id && builtin.thumbnailUrl === image.thumbnailUrl)),
  "Thumbnail must use the bounded local preview");

function reviewedCreditUrl(value: string, field: "sourceUrl" | "licenseUrl"): boolean {
  try {
    const url = new URL(value);
    const hosts = field === "sourceUrl" ? ["www.flickr.com", "flickr.com"] : ["creativecommons.org"];
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && hosts.includes(url.hostname) && BUILTIN_BACKGROUNDS.some((image) => image.credit?.[field] === value);
  } catch { return false; }
}

export const ambientLibrarySchema: z.ZodType<AmbientLibrary> = z.object({
  images: z.array(ambientImageSchema).max(256),
  limits: z.object({
    maxUploadBytes: nonnegative.int(),
    maxImages: nonnegative.int(),
    maxStorageBytes: nonnegative.int(),
    maxPixels: nonnegative.int(),
  }),
});

export function localArtworkUrl(value: string | null): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin === window.location.origin) return `${url.pathname}${url.search}`;
  } catch {
    return;
  }
}
