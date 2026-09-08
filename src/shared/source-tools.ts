import { z } from "zod";
import { catalogReferenceSchema } from "./line-in-album.js";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const age = integer.max(86_400_000).nullable();
const text = z.string().trim().min(1).max(512).transform((s) => s.normalize("NFC"))
  .refine((s) => Array.from(s).length <= 256 && !/\p{C}/u.test(s));
export const toolsIdentitySchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const recordingLabelSchema = text.refine((s) => Array.from(s).length <= 120 && !/[\\/:*?"<>|]/.test(s) && s !== "." && s !== "..");
export const meterChannelSchema = z.object({
  rmsDbfs: z.number().finite().min(-60).max(0),
  peakDbfs: z.number().finite().min(-60).max(0),
  holdDbfs: z.number().finite().min(-60).max(0),
  possibleClipping: z.boolean(),
}).strict();
export type MeterChannel = z.infer<typeof meterChannelSchema>;
export const sourceTelemetrySchema = z.object({
  version: z.literal(1),
  state: z.enum(["not-configured", "offline", "inactive", "active", "stale", "unavailable"]),
  sequence: integer, sampleAgeMs: age, staleAfterMs: z.literal(500),
  sampleRate: z.literal(48000), channels: z.literal(2),
  left: meterChannelSchema, right: meterChannelSchema,
}).strict();
export type SourceTelemetry = z.infer<typeof sourceTelemetrySchema>;
export function emptySourceTelemetry(state: SourceTelemetry["state"] = "not-configured"): SourceTelemetry {
  const channel = (): MeterChannel => ({ rmsDbfs: -60, peakDbfs: -60, holdDbfs: -60, possibleClipping: false });
  return { version: 1, state, sequence: 0, sampleAgeMs: null, staleAfterMs: 500,
    sampleRate: 48000, channels: 2, left: channel(), right: channel() };
}
export const recordingAlbumSchema = z.object({
  title: text, artist: text, catalog: catalogReferenceSchema.nullable(),
  provenance: z.object({
    kind: z.enum(["recognition", "correction"]), revision: toolsIdentitySchema.nullable(),
  }).strict(),
}).strict();
export type RecordingAlbum = z.infer<typeof recordingAlbumSchema>;
export const completedRecordingSchema = z.object({
  id: toolsIdentitySchema, revision: toolsIdentitySchema, label: recordingLabelSchema,
  format: z.enum(["flac", "wav"]), bytes: integer.min(1).max(2 ** 32),
  completedAt: z.string().datetime({ offset: true }),
  album: z.object({ title: text, artist: text }).strict().nullable(),
}).strict();
export type CompletedRecording = z.infer<typeof completedRecordingSchema>;
export const recordingPageSchema = z.object({
  version: z.literal(1), items: z.array(completedRecordingSchema).max(50),
  nextCursor: toolsIdentitySchema.nullable(),
}).strict();
export type RecordingPage = z.infer<typeof recordingPageSchema>;
export const toolsErrorSchema = z.enum([
  "not-configured", "offline", "incompatible", "unsafe-socket", "invalid-request",
  "invalid-response", "busy", "timeout", "not-found", "revision-changed",
  "restart-needed", "context-changed", "unavailable", "forbidden",
]);
export type ToolsErrorCode = z.infer<typeof toolsErrorSchema>;
const runtimeVersion = z.string().max(64).regex(/^\d+\.\d+(?:\.\d+)?(?:[-+.][A-Za-z0-9.-]+)?$/).nullable();
export const sourceHealthDataSchema = z.object({
  capture: z.object({
    state: z.enum(["inactive", "active", "stale", "unavailable"]),
    evidence: z.enum(["unknown", "receiving", "capture-error"]), evidenceAgeMs: age,
  }).strict(),
  sendspin: z.object({
    state: z.enum(["unknown", "connecting", "connected", "disconnected"]), streaming: z.boolean(),
  }).strict(),
  recording: z.object({ state: z.enum(["unknown", "idle", "recording", "finalizing", "error"]) }).strict(),
  disk: z.object({ state: z.enum(["available", "unavailable"]), freeBytes: integer.nullable(),
    totalBytes: integer.nullable(), sampleAgeMs: age }).strict(),
  versions: z.object({
    source: runtimeVersion, toolsAbi: z.literal(1), python: runtimeVersion,
    sendspin: runtimeVersion, installedSource: runtimeVersion,
  }).strict(),
  errors: z.array(z.object({ category: toolsErrorSchema, count: integer, ageMs: age }).strict()).max(20),
}).strict();
export type SourceHealthData = z.infer<typeof sourceHealthDataSchema>;
export const sourceHealthSchema = sourceHealthDataSchema.extend({
  version: z.literal(1),
  source: z.object({ state: z.enum(["not-configured", "offline", "online", "incompatible"]) }).strict(),
  display: z.object({
    state: z.literal("online"), mode: z.enum(["demo", "live"]),
    ma: z.enum(["unknown", "connecting", "connected", "disconnected", "demo"]),
  }).strict(),
  application: z.object({ version: runtimeVersion, build: z.string().regex(/^[a-f0-9]{7,64}$/).nullable(), node: runtimeVersion }).strict(),
}).strict();
export type SourceHealth = z.infer<typeof sourceHealthSchema>;
export const albumPreviewSchema = z.object({
  album: recordingAlbumSchema, confirmationToken: toolsIdentitySchema,
  expiresAt: integer,
}).strict();
export type AlbumPreview = z.infer<typeof albumPreviewSchema>;
export const recordingRevisionSchema = z.object({ revision: toolsIdentitySchema }).strict();
export const recordingLabelRequestSchema = recordingRevisionSchema.extend({ label: recordingLabelSchema }).strict();
export const recordingAlbumRequestSchema = recordingRevisionSchema.extend({ confirmationToken: toolsIdentitySchema }).strict();
