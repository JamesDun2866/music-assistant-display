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
import { unavailableTracklist } from "../src/shared/line-in-album.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(artwork?: HttpOptions["artwork"], lineInAlbum?: HttpOptions["lineInAlbum"], journal?: HttpOptions["journal"],
  editions?: HttpOptions["editions"]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "karaoke-http-"));
  const settings = new SettingsStore(dir);
  await settings.init();
  const bridge = new Bridge(new DemoProvider(), { get: async () => null, put: async () => {} }, settings, true);
  const demo = new DemoPlayer(bridge);
  const status = { enabled: false, available: false, message: "disabled", owned: false };
  const cec = { status: () => status, execute: vi.fn(async () => status) };
  const server: Server = createServer(createApp({
    bridge, settings, cec, demo, lineInAlbum, journal, editions,
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
it("protects journal clear/export/artwork with local guards, explicit confirmation and bounded page schemas", async () => {
  const revision = "f".repeat(32);
  const page = vi.fn(async () => ({
    entries: [], nextCursor: null, revision, retentionDays: 90 as const, status: "ready" as const, message: null,
  }));
  const clear = vi.fn(async () => {});
  const artwork = vi.fn(async () => null);
  const { base, headers } = await fixture(undefined, undefined, {
    page, clear, artwork, async *export() { yield '{"version":1,"entries":[]}'; },
  });
  const url = `${base}/api/listening-journal`;
  expect((await fetch(url, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  expect((await fetch(`${url}/export`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  expect((await fetch(`${url}/artwork/${"a".repeat(64)}`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  expect(artwork).not.toHaveBeenCalled();
  expect((await fetch(`${url}?limit=101`)).status).toBe(400);
  expect((await fetch(`${url}?url=https://evil.example`)).status).toBe(400);
  expect((await fetch(`${url}/clear`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true, revision }) })).status).toBe(403);
  for (const body of [{ revision }, { confirm: false, revision }, { confirm: true, revision, command: "record" }]) {
    expect((await fetch(`${url}/clear`, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
  }
  expect(clear).not.toHaveBeenCalled();
  expect((await fetch(`${url}/clear`, { method: "POST", headers,
    body: JSON.stringify({ confirm: true, revision }) })).status).toBe(200);
  expect(clear).toHaveBeenCalledExactlyOnceWith(revision);
  const exported = await fetch(`${url}/export`);
  expect(exported.headers.get("content-disposition")).toBe('attachment; filename="listening-journal.json"');
  expect(await exported.json()).toEqual({ version: 1, entries: [] });
});
it("requires local CSRF and strict edition bodies and keeps preview artwork session-bound", async () => {
  const binding = { sourceId: "a".repeat(64), albumKey: `${"b".repeat(32)}-1`, success: null, revision: 0 };
  const search = vi.fn(async () => ({ searchToken: "d".repeat(64), results: [] }));
  const artwork = vi.fn(async () => null);
  const { base, headers } = await fixture(undefined, undefined, undefined, {
    search, artwork, preview: vi.fn(), confirm: vi.fn(), remove: vi.fn(),
  });
  const url = `${base}/api/line-in-album/edition`;
  const body = { binding, artist: "Artist", album: "Album", country: "gb" };
  expect((await fetch(`${url}/search`, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" } })).status).toBe(403);
  for (const patch of [{ country: "" }, { artist: "https://private.local/album" }, { url: "http://localhost" }]) {
    expect((await fetch(`${url}/search`, { method: "POST", headers, body: JSON.stringify({ ...body, ...patch }) })).status).toBe(400);
  }
  expect(search).not.toHaveBeenCalled();
  expect((await fetch(`${url}/search`, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(200);
  expect(search).toHaveBeenCalledWith(body, expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(AbortSignal));
  expect((await fetch(`${url}/artwork/${"d".repeat(64)}`)).status).toBe(403);
  expect(artwork).not.toHaveBeenCalled();
  expect((await fetch(`${url}/artwork/${"d".repeat(64)}`, { headers })).status).toBe(404);
  expect(artwork).toHaveBeenCalledWith("d".repeat(64), expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(AbortSignal));
});
it("keeps album endpoints read-only and behind existing local Host/Origin guards", async () => {
  const view = vi.fn(async () => ({
    state: "disabled" as const, expiresAt: Date.now(), key: null, album: null, tracklist: unavailableTracklist(),
    retry: null, cacheError: null,
  }));
  const image = vi.fn(async () => null);
  const { base, headers } = await fixture(undefined, { view, artwork: image });
  expect((await fetch(`${base}/api/line-in-album`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  view.mockClear();
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    request(`${base}/api/line-in-album`, { headers: { Host: "evil.example" } }, (res) => {
      res.resume(); resolve(res.statusCode);
    }).on("error", reject).end();
  });
  expect(rebound).toBe(403);
  expect(view).not.toHaveBeenCalled();
  expect(await (await fetch(`${base}/api/line-in-album`)).json()).toMatchObject({ state: "disabled", album: null });
  expect((await fetch(`${base}/api/line-in-album`, { method: "POST", headers, body: '{"enabled":true}' })).status).toBe(404);
  expect((await fetch(`${base}/api/line-in-album/artwork/old`, {
    headers: { Origin: "https://evil.example" },
  })).status).toBe(403);
  expect(image).not.toHaveBeenCalled();
});
it("serves full local covers with strict content-version queries without relaxing origin guards", async () => {
    const jpeg = Buffer.alloc(300 * 1024, 1);
    const artwork = vi.fn(async (): Promise<Artwork> => ({ bytes: jpeg, contentType: "image/jpeg" }));
    const { base } = await fixture(undefined, {
      artwork, view: async () => ({ state: "offline", expiresAt: Date.now(), key: null, album: null,
        tracklist: unavailableTracklist(), retry: null, cacheError: null }),
    });
    const url = `${base}/api/line-in-album/artwork/${"b".repeat(32)}-1`;
    const hash = "a".repeat(64);
    for (const query of [`cover=${hash}`, "edition=1", ""]) {
      const response = await fetch(`${url}?${query}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/jpeg");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg);
    }
    artwork.mockClear();
    for (const query of [`cover=${hash}&edition=1`, `cover=${hash}&cover=${hash}`, "cover=bad",
      "cover=https://evil.example", "unknown=1", "edition=0"]) {
      expect((await fetch(`${url}?${query}`)).status).toBe(400);
    }
    expect((await fetch(`${url}?cover=${hash}`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect(artwork).not.toHaveBeenCalled();
});
it("allows only CSRF-protected source-bound album retries and preserves useful source errors", async () => {
    const retry = vi.fn(async () => {});
    const { base, headers } = await fixture(undefined, {
      view: async () => ({ state: "offline", expiresAt: Date.now(), key: null, album: null,
        tracklist: unavailableTracklist(), retry: null, cacheError: null }),
      artwork: async () => null, retry,
    });
    const body = { source_id: "a".repeat(64), boot_id: "b".repeat(32), generation: 1 };
    const url = `${base}/api/line-in-album/retry`;
    expect((await fetch(url, { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" } })).status).toBe(403);
    expect((await fetch(url, { method: "POST", body: JSON.stringify(body),
      headers: { ...headers, Origin: "https://evil.example" } })).status).toBe(403);
    for (const bad of [{}, { ...body, enabled: true }, { ...body, command: "record-start" }, { ...body, generation: -1 }]) {
      expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(bad) })).status).toBe(400);
    }
    expect(retry).not.toHaveBeenCalled();
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(200);
    expect(retry).toHaveBeenCalledExactlyOnceWith(body);
    retry.mockRejectedValue(new Error("Recognition is off. Enable it explicitly before retrying."));
    const rejected = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: expect.stringContaining("Recognition is off") });
  });
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
    expect(await response.json()).toEqual({ visualOffsetMs: 900, viewMode: "now-playing", lyricFollowMode: "smooth", ambient: DEFAULT_AMBIENT,
      vinyl: { showTracklist: false, showMeters: true } });
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
  it("publishes and persists independent vinyl preference patches", async () => {
    const { base, headers, dir } = await fixture();
    const response = await fetch(`${base}/api/settings`, { method: "POST", headers,
      body: JSON.stringify({ viewMode: "vinyl", vinyl: { showTracklist: true, showMeters: false } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ viewMode: "vinyl", vinyl: { showTracklist: true, showMeters: false } });
    expect(await (await fetch(`${base}/api/state`)).json()).toMatchObject({ viewMode: "vinyl", vinyl: { showTracklist: true, showMeters: false } });
    const restored = new SettingsStore(dir); await restored.init();
    expect(restored.vinyl).toEqual({ showTracklist: true, showMeters: false });
    expect((await fetch(`${base}/api/settings`, { method: "POST", headers,
      body: '{"vinyl":{"showMeters":"false"}}' })).status).toBe(400);
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
