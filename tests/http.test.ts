import { createServer, request, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createApp, type HttpOptions, type Artwork } from "../src/server/http.js";
import { SettingsStore } from "../src/server/settings.js";
import { Bridge } from "../src/server/bridge.js";
import { DemoProvider, DemoPlayer } from "../src/server/demo.js";
import { DEFAULT_AMBIENT } from "../src/shared/ambient.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(artwork?: HttpOptions["artwork"]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "karaoke-http-"));
  const settings = new SettingsStore(dir);
  await settings.init();
  const bridge = new Bridge(new DemoProvider(), { get: async () => null, put: async () => {} }, settings, true);
  const demo = new DemoPlayer(bridge);
  const status = { enabled: false, available: false, message: "disabled", owned: false };
  const cec = { status: () => status, execute: vi.fn(async () => status) };
  const server: Server = createServer(createApp({
    bridge, settings, cec, demo,
    artwork: artwork ?? ((identity, signal) => demo.artwork.get(identity, signal)),
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("no_address");
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    bridge.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const session = await fetch(`${base}/api/session`);
  const { csrfToken } = await session.json() as { csrfToken: string };
  const headers = { Cookie: session.headers.get("set-cookie")!.split(";")[0]!, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
  return { base, headers, cec, bridge, demo, dir };
}
it("protects local TV controls against cross-origin, DNS rebinding, missing CSRF and arbitrary commands", async () => {
  const { base, headers, cec } = await fixture();
  const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
    request(`${base}/api/state`, { headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject).end();
  });
  expect(reboundStatus).toBe(403);
  expect((await fetch(`${base}/api/session`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  expect((await fetch(`${base}/api/cec`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"command":"wake"}' })).status).toBe(403);
  expect((await fetch(`${base}/api/cec`, { method: "POST", headers, body: '{"command":"rm -rf /"}' })).status).toBe(400);
  expect(cec.execute).not.toHaveBeenCalled();
});
  it("persists selected views without changing offset and rejects invalid or unauthenticated patches", async () => {
    const { base, headers, dir } = await fixture();
    await fetch(`${base}/api/settings`, { method: "POST", headers, body: '{"visualOffsetMs":900}' });
    const response = await fetch(`${base}/api/settings`, { method: "POST", headers, body: '{"viewMode":"now-playing"}' });
    expect(await response.json()).toEqual({ visualOffsetMs: 900, viewMode: "now-playing", lyricFollowMode: "smooth", ambient: DEFAULT_AMBIENT });
    const state = await (await fetch(`${base}/api/state`)).json() as { viewMode: string };
    expect(state.viewMode).toBe("now-playing");
    const restored = new SettingsStore(dir);
    await restored.init();
    expect(restored.viewMode).toBe("now-playing");
    expect(restored.visualOffsetMs).toBe(900);
    for (const body of ['{}', '{"viewMode":"bad"}', '{"viewMode":"lyrics","token":"not-allowed"}']) {
      expect((await fetch(`${base}/api/settings`, { method: "POST", headers, body })).status).toBe(400);
    }
    expect((await fetch(`${base}/api/settings`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: '{"viewMode":"lyrics"}',
    })).status).toBe(403);
  });
  it("serves only the current synthetic cover and no cover for the no-art track", async () => {
    const { base, demo, bridge } = await fixture();
    demo.action("play");
    const response = await fetch(`${base}${bridge.snapshot().track?.artworkUrl}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^image\/png/);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(bytes.readUInt32BE(16)).toBe(512);
    expect(bytes.readUInt32BE(20)).toBe(512);
    demo.action("next");
    expect((await fetch(`${base}/api/artwork/demo%3A0`)).status).toBe(404);
    demo.action("next");
    expect(bridge.snapshot().track?.artworkUrl).toBeNull();
    expect((await fetch(`${base}/api/artwork/demo%3A2`)).status).toBe(404);
  });
  it("rejects delayed old cover responses after track changes or same-track artwork revisions", async () => {
    let resolve: (value: Artwork | null) => void = () => {};
    const signals: AbortSignal[] = [];
    const artwork = vi.fn((_identity: string, signal: AbortSignal) => new Promise<Artwork | null>((done) => {
      signals.push(signal); resolve = done;
    }));
    const { base, demo, bridge } = await fixture(artwork);
    demo.action("play");
    const first = fetch(`${base}/api/artwork/demo%3A0`);
    await vi.waitFor(() => expect(artwork).toHaveBeenCalledTimes(1));
    demo.action("next");
    expect(signals[0]?.aborted).toBe(true);
    resolve({ contentType: "image/png", bytes: Buffer.from("old artwork") });
    expect((await first).status).toBe(404);
    const second = fetch(`${base}/api/artwork/demo%3A1`);
    await vi.waitFor(() => expect(artwork).toHaveBeenCalledTimes(2));
    bridge.updateArtwork("demo:1", "/api/artwork/demo%3A1?v=new");
    expect(signals[1]?.aborted).toBe(true);
    resolve({ contentType: "image/png", bytes: Buffer.from("superseded artwork") });
    expect((await second).status).toBe(404);
  });
it("serves meaningful readiness and persists offset through authenticated local controls", async () => {
  const { base, headers } = await fixture();
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
  expect((await fetch(`${base}/readyz`)).status).toBe(503);
  expect((await fetch(`${base}/api/demo`, { method: "POST", headers, body: '{"action":"play"}' })).status).toBe(200);
  expect((await fetch(`${base}/readyz`)).status).toBe(200);
  const offset = await fetch(`${base}/api/settings`, { method: "POST", headers, body: '{"visualOffsetMs":750}' });
  expect(offset.status).toBe(200);
  const state = await (await fetch(`${base}/api/state`)).json() as { visualOffsetMs: number; demo: boolean };
  expect(state.visualOffsetMs).toBe(750);
  expect(state.demo).toBe(true);
  expect((await fetch(`${base}/api/settings`, { method: "POST", headers, body: '{"visualOffsetMs":999999}' })).status).toBe(400);
  expect((await fetch(`${base}/api/settings`, { method: "POST", headers, body: JSON.stringify({ visualOffsetMs: "x".repeat(4096) }) })).status).toBe(413);
});
it("publishes and persists authenticated follow settings without changing timing, view or photos", async () => {
  const { base, headers, dir, bridge } = await fixture();
  const changed = vi.fn();
  bridge.on("change", changed);
  const initial = await (await fetch(`${base}/api/settings`)).json();
  expect(initial.lyricFollowMode).toBe("smooth");
  expect((await fetch(`${base}/api/settings`, {
    method: "POST", headers, body: '{"lyricFollowMode":"instant"}',
  })).status).toBe(200);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(await (await fetch(`${base}/api/settings`)).json()).toEqual({ ...initial, lyricFollowMode: "instant" });
  expect(await (await fetch(`${base}/api/state`)).json()).toMatchObject({ lyricFollowMode: "instant" });
  const restored = new SettingsStore(dir);
  await restored.init();
  expect(restored.lyricFollowMode).toBe("instant");
  expect((await fetch(`${base}/api/settings`, {
    method: "POST", headers, body: '{"lyricFollowMode":"auto"}',
  })).status).toBe(400);
  expect((await fetch(`${base}/api/settings`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: '{"lyricFollowMode":"smooth"}',
  })).status).toBe(403);
  expect(changed).toHaveBeenCalledTimes(1);
});
