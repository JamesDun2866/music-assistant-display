import { z } from "zod";
import { albumKeySchema, albumMetadataSchema, albumSuccessSchema } from "./line-in-album.js";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const journalEventSchema = z.object({
  sequence: integer.positive(),
  source_id: z.string().regex(/^[a-f0-9]{64}$/),
  album_key: albumKeySchema,
  album_success: albumSuccessSchema,
  observed_at_ms: integer,
  album: albumMetadataSchema,
}).strict();
export type JournalEvent = z.infer<typeof journalEventSchema>;
export const journalFeedSchema = z.object({
  ok: z.literal(true),
  source_id: z.string().regex(/^[a-f0-9]{64}$/),
  epoch: z.string().regex(/^[a-f0-9]{32}$/),
  revision: integer,
  watermark: integer,
  high_water: integer,
  oldest_sequence: integer.positive().nullable(),
  healthy: z.boolean(),
  error: z.string().max(256).nullable(),
  events: z.array(journalEventSchema).max(100),
}).strict().refine((value) => value.watermark <= value.high_water
  && value.events.every((event, index) => event.source_id === value.source_id
    && event.sequence > value.watermark && event.sequence <= value.high_water
    && (!index || event.sequence > value.events[index - 1]!.sequence)));
export type JournalFeed = z.infer<typeof journalFeedSchema>;
export const journalEntrySchema = z.object({
  id: integer.positive(),
  identifiedAt: integer,
  clockAdjusted: z.boolean(),
  title: z.string().max(256),
  artist: z.string().max(256),
  artworkUrl: z.string().regex(/^\/api\/listening-journal\/artwork\/[a-f0-9]{64}$/).nullable(),
}).strict();
export const journalPageSchema = z.object({
  entries: z.array(journalEntrySchema).max(100),
  nextCursor: z.string().max(512).nullable(),
  revision: z.string().regex(/^[a-f0-9]{32}$/),
  retentionDays: z.literal(90),
  status: z.enum(["ready", "catching-up", "unavailable"]),
  message: z.string().max(256).nullable(),
}).strict();
export type JournalPage = z.infer<typeof journalPageSchema>;
export const journalClearSchema = z.object({
  confirm: z.literal(true), revision: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();
