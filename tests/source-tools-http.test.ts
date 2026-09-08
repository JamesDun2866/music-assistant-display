import { createServer, type Server } from "node:http";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/http.js";
import { SourceTools, SourceToolsError, type AlbumContext, type ToolsRequest } from "../src/server/source-tools.js";
import { downloadDisposition, sourceDiagnostics } from "../src/server/source-tools-http.js";
import { SettingsStore } from "../src/server/settings.js";
import { Bridge } from "../src/server/bridge.js";
import { DemoProvider } from "../src/server/demo.js";
import type { CompletedRecording, SourceHealth } from "../src/shared/source-tools.js";

const sourceId = "a".repeat(64), bootId = "b".repeat(32);
const recording: CompletedRecording = { id: "id", revision: "c".repeat(64), label: "Recording", format: "wav",
  completedAt: "2026-09-08T12:00:00Z", bytes: 4, album: null };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const context: AlbumContext = { sourceId, sourceUid: 1000, key: "key", revision: "correction-1",
    album: { title: "Title", artist: "Artist", catalog: null, provenance: { kind: "recognition", revision: null } } };
  const call = vi.fn(async (command: ToolsRequest) => {
    if (command.command === "recordings-list") return { bootId, data: { version: 1, items: [recording], nextCursor: null } };
    if (command.command === "recording-download") {
      const stream = new PassThrough();
      stream.end("abcd");
      return { bootId, data: { bytes: recording.bytes, format: recording.format, label: recording.label }, stream: stream as unknown as Socket };
    }
    if (command.command === "recording-label" || command.command === "recording-album") return { bootId, data: recording };
    throw new SourceToolsError("offline");
  });
  const tools = new SourceTools({ sourceId, sourceUid: 1000, transport: { request: call }, albumContext: async () => context });
  const settings = new SettingsStore(".");
  const bridge = new Bridge(new DemoProvider(), { get: async () => null, put: async () => {} }, settings, true);
  const cec = { status: () => ({ enabled: false, available: false, message: "disabled", owned: false }),
    execute: vi.fn() };
  const server: Server = createServer(createApp({ bridge, settings, cec, sourceTools: tools }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing-address");
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { bridge.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const local = await fetch(`${base}/api/session`);
  const { csrfToken } = await local.json() as { csrfToken: string };
  const headers = { Cookie: local.headers.get("set-cookie")!.split(";")[0]!, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
  const page = await (await fetch(`${base}/api/source-tools/recordings`)).json() as { items: CompletedRecording[] };
  const publicRevision = page.items[0]!.revision;
  const post = (suffix: string, body: unknown, requestHeaders = headers) => fetch(`${base}/api/source-tools/recordings/id/${suffix}`,
    { method: "POST", headers: requestHeaders, body: JSON.stringify(
      body && typeof body === "object" && "revision" in body && body.revision === "rev"
        ? { ...body, revision: publicRevision } : body,
    ) });
  return { base, headers, tools, call, post, context };
}
it("keeps tools behind Host, Origin and existing CSRF guards", async () => {
  const { base, post, call, headers } = await fixture();
  call.mockClear();
  expect((await post("label", { revision: "rev", label: "New" }, { ...headers, "X-CSRF-Token": "" })).status).toBe(403);
  expect((await fetch(`${base}/api/source-tools/health`, { headers: { Origin: "https://evil.test" } })).status).toBe(403);
  expect((await post("label", { revision: "rev", label: "New", path: "/secret" })).status).toBe(400);
  expect((await fetch(`${base}/api/source-tools/recordings/id/label`, { method: "POST", headers,
    body: '{"revision":"rev","label":"Safe","label":"Other"}' })).status).toBe(400);
  expect(call).not.toHaveBeenCalled();
  expect((await post("label", { revision: "rev", label: "New" })).status).toBe(200);
});
it("uses cookie-bound single-use download tickets, rejects ranges and streams exact bytes", async () => {
  const { base, headers, post } = await fixture();
  const issued = await post("download", { revision: "rev" });
  const { url } = await issued.json() as { url: string };
  expect((await fetch(`${base}${url}`)).status).toBe(403);
  expect((await fetch(`${base}${url}`, { headers: { Cookie: `karaoke_session=${"c".repeat(64)}` } })).status).toBe(403);
  expect((await fetch(`${base}${url}`, { headers: { ...headers, Range: "bytes=0-1" } })).status).toBe(416);
  const download = await fetch(`${base}${url}`, { headers });
  expect(download.status).toBe(200); expect(await download.text()).toBe("abcd");
  expect(download.headers.get("content-length")).toBe("4");
  expect(download.headers.get("content-disposition")).toContain('filename="Recording.wav"');
  expect(download.headers.get("cache-control")).toBe("no-store");
  expect((await fetch(`${base}${url}`, { headers })).status).toBe(403);
});
it("caps ticket storage and never passes caller paths or metadata to IPC", async () => {
  const { post, call } = await fixture();
  for (let i = 0; i < 128; i++) expect((await post("download", { revision: "rev" })).status).toBe(200);
  expect((await post("download", { revision: "rev" })).status).toBe(429);
  expect((await post("album", { revision: "rev", confirmationToken: "made-up", album: { title: "Forged" } })).status).toBe(400);
  expect(call).toHaveBeenCalledTimes(1);
});
it("expires both confirmation and download tickets after sixty seconds", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { base, headers, post } = await fixture();
    const { url } = await (await post("download", { revision: "rev" })).json() as { url: string };
    const { confirmationToken } = await (await post("album-preview", { revision: "rev" })).json() as { confirmationToken: string };
    now += 60_001;
    expect((await fetch(`${base}${url}`, { headers })).status).toBe(403);
    expect((await post("album", { revision: "rev", confirmationToken })).status).toBe(403);
  } finally { clock.mockRestore(); }
});
it("requires explicit confirmation and rejects changed effective metadata revision", async () => {
  const { post, context, call } = await fixture();
  const preview = await (await post("album-preview", { revision: "rev" })).json() as { confirmationToken: string; album: unknown };
  expect(preview.album).toMatchObject({ title: "Title", provenance: { kind: "recognition" } });
  context.revision = "correction-2";
  const failed = await post("album", { revision: "rev", confirmationToken: preview.confirmationToken });
  expect(failed.status).toBe(409); expect(await failed.json()).toEqual({ error: "context-changed" });
  expect(call).toHaveBeenCalledTimes(1);
  const fresh = await (await post("album-preview", { revision: "rev" })).json() as { confirmationToken: string };
  expect((await post("album", { revision: "rev", confirmationToken: fresh.confirmationToken })).status).toBe(200);
  expect(call.mock.calls.at(-1)?.[0]).toMatchObject({ command: "recording-album", boot_id: bootId, album: { title: "Title" } });
  expect((await post("album", { revision: "rev", confirmationToken: fresh.confirmationToken })).status).toBe(403);
});
it("binds original album success separately without serializing it into attached metadata", async () => {
  const { post, context, call } = await fixture();
  context.success = { boot_id: bootId, generation: 1, at_ms: 1000 };
  const preview = await (await post("album-preview", { revision: "rev" })).json() as { confirmationToken: string };
  expect(JSON.stringify(preview)).not.toContain("boot_id");
  context.success.generation = 2;
  expect((await post("album", { revision: "rev", confirmationToken: preview.confirmationToken })).status).toBe(409);
  const fresh = await (await post("album-preview", { revision: "rev" })).json() as { confirmationToken: string };
  expect((await post("album", { revision: "rev", confirmationToken: fresh.confirmationToken })).status).toBe(200);
  const request = call.mock.calls.at(-1)![0];
  expect(request.command).toBe("recording-album");
  expect(request).not.toHaveProperty("success");
  if (request.command === "recording-album") {
    expect(Object.keys(request.album).sort()).toEqual(["artist", "catalog", "provenance", "title"]);
  }
});
it("exports only projected health fields even with adversarial extra internal properties", async () => {
  const health = await new SourceTools().health();
  const poisoned = { ...health, token: "secret", hostname: "private", source_id: sourceId, album: { title: "Private title" },
    capture: { ...health.capture, path: "/secret/audio" }, versions: { ...health.versions, env: "credential" },
    errors: [{ category: "offline", count: 1, ageMs: 0, message: "/secret/private" }] } as unknown as SourceHealth;
  const encoded = JSON.stringify(sourceDiagnostics(poisoned));
  for (const secret of ["secret", "private", "Private", "credential", sourceId]) expect(encoded).not.toContain(secret);
  expect(JSON.parse(encoded)).toMatchObject({ source: { state: "not-configured" }, display: { ma: "unknown" } });
});
it("returns fixed errors rather than socket paths or exceptions", async () => {
  const { base, call } = await fixture();
  call.mockRejectedValue(new SourceToolsError("unsafe-socket"));
  const result = await fetch(`${base}/api/source-tools/recordings`);
  expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: "unsafe-socket" });
  const health = await (await fetch(`${base}/api/source-tools/health`)).json() as SourceHealth;
  expect(health.source.state).toBe("incompatible"); expect(health.disk.freeBytes).toBeNull();
});
it("bounds and sanitizes download filenames including Unicode", () => {
  const value = downloadDisposition('Évil"\r\n/\\title', "flac");
  expect(value).not.toContain("\r"); expect(value).not.toContain("\n");
  expect(value).toContain("filename*=UTF-8''%C3%89vil");
  expect(downloadDisposition("a".repeat(500), "wav").length).toBeLessThan(310);
});
it.each(["abc", "abcde"])("does not complete an HTTP download with the wrong declared byte count", async (bytes) => {
  const { base, headers, post, tools } = await fixture();
  vi.spyOn(tools, "download").mockImplementation(async () => {
    const stream = new PassThrough(); stream.end(bytes);
    return { recording, stream: stream as unknown as Socket };
  });
  const { url } = await (await post("download", { revision: "rev" })).json() as { url: string };
  await expect((async () => {
    const response = await fetch(`${base}${url}`, { headers });
    return response.text();
  })()).rejects.toThrow();
});
it("streams before EOF and caps active downloads separately from control requests", async () => {
  const { base, headers, post, tools } = await fixture();
  const streams: PassThrough[] = [];
  const download = vi.spyOn(tools, "download").mockImplementation(async () => {
    const stream = new PassThrough({ highWaterMark: 65_536 });
    streams.push(stream);
    stream.write(Buffer.alloc(65_536)); stream.write(Buffer.alloc(65_536));
    return { recording: { ...recording, bytes: 196_608 }, stream: stream as unknown as Socket };
  });
  const urls: string[] = [];
  for (let i = 0; i < 3; i++) urls.push((await (await post("download", { revision: "rev" })).json() as { url: string }).url);
  const controllers = [new AbortController(), new AbortController()];
  const transfers = await Promise.all(controllers.map((controller, i) =>
    fetch(`${base}${urls[i]}`, { headers, signal: controller.signal })));
  expect(download).toHaveBeenCalledTimes(2);
  const reader = transfers[0]!.body!.getReader();
  expect((await reader.read()).value!.length).toBeGreaterThan(0);
  expect(streams[0]!.writableEnded).toBe(false);
  expect((await fetch(`${base}${urls[2]}`, { headers })).status).toBe(429);
  expect((await fetch(`${base}/api/source-tools/health`)).status).toBe(200);
  controllers.forEach((controller) => controller.abort());
  await vi.waitFor(() => expect(streams.every((stream) => stream.destroyed)).toBe(true));
  const { url } = await (await post("download", { revision: "rev" })).json() as { url: string };
  const controller = new AbortController();
  const response = await fetch(`${base}${url}`, { headers, signal: controller.signal });
  expect(response.status).toBe(200);
  controller.abort();
});
