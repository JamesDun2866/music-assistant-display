import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  SourceTools, SourceToolsError, ToolsSocketClient, recordingAlbumContext, parseToolsJson,
  sourceToolsApplication, toolsRequestSchema, verifyToolsSocket, type ToolsRequest,
} from "../src/server/source-tools.js";
import {
  completedRecordingSchema, emptySourceTelemetry, sourceHealthSchema, sourceTelemetrySchema,
  type CompletedRecording,
} from "../src/shared/source-tools.js";
import { unavailableTracklist } from "../src/shared/line-in-album.js";
import type { CurrentAlbumContext } from "../src/shared/current-album-context.js";

const sourceId = "a".repeat(64), bootId = "b".repeat(32);
const recording: CompletedRecording = {
  id: "recording", revision: "c".repeat(64), label: "Test", format: "wav", bytes: 4,
  completedAt: "2026-09-08T12:00:00Z", album: null,
};
const request: ToolsRequest = { version: 1, source_id: sourceId, command: "telemetry" };
const reply = (data: unknown) => ({ version: 1, source_id: sourceId, boot_id: bootId, ok: true, data });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function socketFixture(output: Buffer | string, verify = vi.fn(async () => "identity")) {
  // Unix socket paths must fit sockaddr_un even when the checkout path is long.
  const directory = process.platform === "win32" ? undefined : await mkdtemp(path.join(tmpdir(), "tools-"));
  const socketPath = directory ? path.join(directory, "tools.sock")
    : `\\\\.\\pipe\\tools-test-${randomUUID()}`;
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => socket.end(output));
  });
  cleanups.push(async () => {
    sockets.forEach((socket) => socket.destroy());
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  return new ToolsSocketClient(1000, socketPath, verify);
}
it("strictly rejects duplicate JSON keys, invalid UTF8, nonfinite values and extra commands", () => {
  for (const text of ['{"ok":true,"ok":false}', '{"data":{"x":1,"x":2}}', '{"a":[{"a":1,"a":2}]}']) {
    expect(() => parseToolsJson(Buffer.from(text))).toThrow("invalid-response");
  }
  expect(parseToolsJson(Buffer.from('{"a":[1,{"b":"value"}],"b":"a"}'))).toEqual({ a: [1, { b: "value" }], b: "a" });
  expect(() => parseToolsJson(Buffer.from([0xff]))).toThrow("invalid-response");
  expect(toolsRequestSchema.safeParse({ ...request, command: "record-start" }).success).toBe(false);
  expect(toolsRequestSchema.safeParse({ ...request, arbitrary: "/secret" }).success).toBe(false);
  expect(toolsRequestSchema.safeParse({ ...request, command: "recordings-list", cursor: null, limit: true }).success).toBe(false);
  expect(sourceTelemetrySchema.safeParse({ ...emptySourceTelemetry(), sequence: Infinity }).success).toBe(false);
  expect(completedRecordingSchema.safeParse({ ...recording, label: "../../escape" }).success).toBe(false);
  for (const bytes of [0, 2 ** 32 + 1]) {
    expect(completedRecordingSchema.safeParse({ ...recording, bytes }).success).toBe(false);
  }
  for (const label of ["hidden\u202ename", "\ud800", "bad\u0085label"]) {
    expect(completedRecordingSchema.safeParse({ ...recording, label }).success).toBe(false);
  }
  expect(completedRecordingSchema.parse({ ...recording, label: "Cafe\u0301" }).label).toBe("Café");
});
it("validates a bounded response on one connection and waits for its end", async () => {
  const client = await socketFixture(JSON.stringify(reply(emptySourceTelemetry("inactive"))) + "\n");
  expect(await client.request(request)).toMatchObject({ bootId, data: { state: "inactive" } });
});
it.each([
  "x".repeat(262_145),
  '{"version":1,"version":1}\n',
  JSON.stringify({ ...reply({}), source_id: "c".repeat(64) }) + "\n",
  JSON.stringify({ ...reply({}), debug: "/secret" }) + "\n",
  JSON.stringify(reply({})) + "\nextra",
  JSON.stringify(reply({})),
])("rejects malformed, oversized, extra and source-mismatched responses", async (data) => {
  const client = await socketFixture(data);
  await expect(client.request(request)).rejects.toBeInstanceOf(SourceToolsError);
});
it("checks directory/socket identity again before sending any request", async () => {
  const verify = vi.fn().mockResolvedValueOnce("before").mockResolvedValueOnce("after");
  const client = await socketFixture(JSON.stringify(reply({})) + "\n", verify);
  await expect(client.request(request)).rejects.toMatchObject({ code: "unsafe-socket" });
  expect(verify).toHaveBeenCalledTimes(2);
});
it("keeps bytes following the download header in the stream rather than decoding them", async () => {
  const bytes = Buffer.from([0, 255, 10, 13]);
  const header = { bytes: recording.bytes, format: recording.format, label: recording.label };
  const client = await socketFixture(Buffer.concat([Buffer.from(JSON.stringify(reply(header)) + "\n"), bytes]));
  const result = await client.request({ version: 1, source_id: sourceId, command: "recording-download",
    boot_id: bootId, id: recording.id, revision: recording.revision });
  expect(result.data).toEqual(header);
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream!) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks)).toEqual(bytes);
});
it("rejects responses from a restarted source for mutations", async () => {
  const client = await socketFixture(JSON.stringify({ ...reply(recording), boot_id: "c".repeat(32) }) + "\n");
  await expect(client.request({ version: 1, source_id: sourceId, command: "recording-label",
    boot_id: bootId, id: recording.id, revision: recording.revision, label: "New" }))
    .rejects.toMatchObject({ code: "revision-changed" });
});
it("rejects an ordinary repository directory as an authenticated socket", async () => {
  await expect(verifyToolsSocket(1000, path.resolve("package.json"))).rejects.toBeInstanceOf(SourceToolsError);
});
it("fails closed for symlinks, wrong ownership, writable ancestors, unsafe modes and hardlinked sockets", async () => {
  const socket = path.resolve(".virtual-tools", "tools.sock"), directory = path.dirname(socket);
  let override: { target: "socket" | "directory" | "ancestor"; values: Partial<Stats> } | undefined;
  const stat = async (name: string): Promise<Stats> => {
    const target = name === socket ? "socket" : name === directory ? "directory" : "ancestor";
    return { dev: 1, ino: target === "socket" ? 3 : target === "directory" ? 2 : 1,
      uid: target === "ancestor" ? 0 : 1000, gid: 1001, nlink: 1,
      mode: target === "socket" ? 0o660 : target === "directory" ? 0o2750 : 0o755,
      isSocket: () => target === "socket", isDirectory: () => target !== "socket",
      ...(override?.target === target ? override.values : {}),
    } as Stats;
  };
  const fingerprint = await verifyToolsSocket(1000, socket, stat);
  expect(fingerprint).toContain(":1000:1001:");
  const cases: NonNullable<typeof override>[] = [
    { target: "socket", values: { isSocket: () => false } },
    { target: "directory", values: { isDirectory: () => false } },
    { target: "ancestor", values: { isDirectory: () => false } },
    { target: "socket", values: { uid: 1002 } },
    { target: "directory", values: { uid: 1002 } },
    { target: "ancestor", values: { uid: 1000 } },
    { target: "socket", values: { gid: 1002 } },
    { target: "socket", values: { mode: 0o666 } },
    { target: "directory", values: { mode: 0o2770 } },
    { target: "ancestor", values: { mode: 0o775 } },
    { target: "socket", values: { nlink: 2 } },
  ];
  for (const value of cases) {
    override = value;
    await expect(verifyToolsSocket(1000, socket, stat)).rejects.toMatchObject({ code: "unsafe-socket" });
  }
});
it("bounds request bytes and propagates only fixed operational failures", async () => {
  const client = new ToolsSocketClient(1000, "missing", vi.fn(async () => { throw new SourceToolsError("offline"); }));
  await expect(client.request(request)).rejects.toMatchObject({ message: "offline" });
  await expect(client.request({ ...request, source_id: "/secret" })).rejects.toMatchObject({ code: "invalid-request" });
});
it("coalesces telemetry and health, and clears repeated or old active bars", async () => {
  let now = 1000;
  const telemetry = { ...emptySourceTelemetry("active"), sequence: 1, sampleAgeMs: 0,
    left: { rmsDbfs: -10, peakDbfs: -5, holdDbfs: -4, possibleClipping: false } };
  const call = vi.fn(async () => ({ bootId, data: telemetry }));
  const tools = new SourceTools({ sourceId, sourceUid: 1000, transport: { request: call }, now: () => now });
  const values = await Promise.all([tools.telemetry(), tools.telemetry(), tools.telemetry()]);
  expect(call).toHaveBeenCalledTimes(1); expect(values[0]?.state).toBe("active");
  now += 50;
  expect(await tools.telemetry()).toMatchObject({ state: "active", sampleAgeMs: 50 });
  expect(call).toHaveBeenCalledTimes(1);
  now += 500;
  expect(await tools.telemetry()).toMatchObject({ state: "stale", left: { rmsDbfs: -60 } });
  telemetry.sequence++; telemetry.sampleAgeMs = 600; now += 100;
  expect((await tools.telemetry()).state).toBe("stale");
  const unavailable = new SourceTools();
  const health = await Promise.all([unavailable.health(), unavailable.health()]);
  expect(health[0]).toMatchObject({ source: { state: "not-configured" }, capture: { evidence: "unknown" }, disk: { freeBytes: null } });
  expect(sourceHealthSchema.safeParse(health[0]).success).toBe(true);
});
it("does not hide programming errors behind an offline meter", async () => {
  const tools = new SourceTools({ sourceId, sourceUid: 1000,
    transport: { request: async () => { throw new TypeError("programming-error"); } } });
  await expect(tools.telemetry()).rejects.toThrow("programming-error");
});
it("accounts for request latency and never revives a regressed sequence within the same boot", async () => {
  let now = 1000, sequence = 10, latency = 0;
  const call = vi.fn(async () => {
    now += latency;
    return { bootId, data: { ...emptySourceTelemetry("active"), sequence, sampleAgeMs: 0 } };
  });
  const tools = new SourceTools({ sourceId, sourceUid: 1000, transport: { request: call }, now: () => now });
  expect((await tools.telemetry()).state).toBe("active");
  sequence = 9; now += 100;
  expect((await tools.telemetry()).state).toBe("stale");
  now += 100;
  expect((await tools.telemetry()).state).toBe("stale");
  sequence = 11; latency = 600; now += 100;
  expect(await tools.telemetry()).toMatchObject({ state: "stale", sampleAgeMs: 600 });
});
it("coalesces configured health and keeps actual MA and Sendspin connections independent", async () => {
  const empty = await new SourceTools().health();
  const data = { capture: empty.capture, sendspin: { state: "disconnected", streaming: false },
    recording: empty.recording, disk: empty.disk, versions: empty.versions, errors: [] };
  const call = vi.fn(async () => ({ bootId, data }));
  const tools = new SourceTools({ sourceId, sourceUid: 1000, transport: { request: call },
    display: () => ({ state: "online", mode: "live", ma: "connected" }) });
  const health = await Promise.all([tools.health(), tools.health(), tools.health()]);
  expect(call).toHaveBeenCalledTimes(1);
  expect(health[0]).toMatchObject({ source: { state: "online" }, display: { ma: "connected" },
    sendspin: { state: "disconnected", streaming: false }, capture: { evidence: "unknown" } });
  await tools.health();
  expect(call).toHaveBeenCalledTimes(1);
});
it("binds mutations to a listed recording revision and boot", async () => {
  let sourceRevision = recording.revision;
  const call = vi.fn(async (command: ToolsRequest) => {
    if (command.command === "recordings-list") return { bootId, data: { version: 1, items: [recording], nextCursor: null } };
    if (!("revision" in command) || command.revision !== sourceRevision) throw new SourceToolsError("revision-changed");
    sourceRevision = "d".repeat(64);
    return { bootId, data: { ...recording, revision: sourceRevision, label: "New" } };
  });
  const tools = new SourceTools({ sourceId, sourceUid: 1000, transport: { request: call } });
  await expect(tools.label(recording.id, recording.revision, "New")).rejects.toMatchObject({ code: "revision-changed" });
  const first = (await tools.recordings(null, 50)).items[0]!;
  const updated = await tools.label(recording.id, first.revision, "New");
  expect(updated.label).toBe("New");
  expect(updated.revision).not.toBe(first.revision);
  expect(tools.binding(recording.id, updated.revision)).toMatchObject({ revision: sourceRevision, boot_id: bootId });
  expect(call.mock.calls[1]?.[0]).toMatchObject({
    command: "recording-label", boot_id: bootId, id: recording.id, revision: recording.revision,
  });
  await expect(tools.label(recording.id, first.revision, "Old")).rejects.toMatchObject({ code: "revision-changed" });
});
it("preserves signed record bindings across large pagination without an unbounded cache", async () => {
  let index = 0;
  const call = vi.fn(async (command: ToolsRequest) => ({
    bootId, data: command.command === "recordings-list"
      ? { version: 1, items: [{ ...recording, id: `recording-${index++}` }], nextCursor: null }
      : { ...recording, id: "id" in command ? command.id : "", label: "Still available" },
  }));
  const tools = new SourceTools({ sourceId, sourceUid: 1000, transport: { request: call } });
  const first = (await tools.recordings(null, 50)).items[0]!;
  for (let page = 0; page < 350; page++) await tools.recordings(null, 50);
  expect(await tools.label(first.id, first.revision, "Still available")).toMatchObject({ id: first.id, label: "Still available" });
  expect(first.revision).toHaveLength(128);
  expect(() => tools.binding("another-file", first.revision)).toThrow("revision-changed");
  expect(() => tools.binding(first.id, first.revision.slice(0, -1) + (first.revision.endsWith("0") ? "1" : "0")))
    .toThrow("revision-changed");
  expect(() => new SourceTools().binding(first.id, first.revision)).toThrow("revision-changed");
});
it("projects corrected cached context into a bound recording sidecar without artwork or track data", async () => {
  let context: CurrentAlbumContext | null = {
    sourceId, original: { albumKey: `${bootId}-1`, success: { boot_id: bootId, generation: 1, at_ms: 1000 },
      album: { title: "Original", artist: "Artist", artwork: null, catalog: null } },
    effective: { title: "Album", artist: "Artist", catalog: { kind: "collection", id: "123", country: "gb" },
      tracklist: unavailableTracklist(), artworkAsset: "d".repeat(64), revision: "e".repeat(64) },
    correction: { applied: true, revision: 1, scope: "remembered" },
  };
  const provider = recordingAlbumContext({ currentAlbumContext: async () => context }, 1000);
  const snapshot = await provider();
  expect(snapshot).toEqual({ sourceId, sourceUid: 1000, key: `${bootId}-1`, revision: "e".repeat(64),
    album: { title: "Album", artist: "Artist", catalog: { kind: "collection", id: "123", country: "gb" },
      provenance: { kind: "correction", revision: "e".repeat(64) } },
    success: context.original.success });
  context.effective.title = "Changed";
  context.effective.revision = "f".repeat(64);
  context.effective.catalog!.id = "456";
  expect(snapshot?.album.title).toBe("Album");
  expect(snapshot?.album.catalog?.id).toBe("123");
  expect((await provider())?.revision).not.toBe(snapshot?.revision);
  const tools = new SourceTools({ sourceId: "c".repeat(64), sourceUid: 1000, albumContext: provider });
  await expect(tools.context()).rejects.toMatchObject({ code: "context-changed" });
  const wrongUid = new SourceTools({ sourceId, sourceUid: 1001, albumContext: provider });
  await expect(wrongUid.context()).rejects.toMatchObject({ code: "context-changed" });
  context.correction = { applied: false, revision: 2, scope: "original" };
  context.original.success = null;
  const original = await provider();
  expect(original?.album.provenance.kind).toBe("recognition");
  expect(original).not.toHaveProperty("success");
  context = null;
  expect(await provider()).toBeNull();
});
it("loads the application package version without exposing a path", async () => {
  expect(await sourceToolsApplication()).toMatchObject({ version: "0.1.0", build: null, node: process.versions.node });
});
