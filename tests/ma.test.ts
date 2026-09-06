import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MaClient, reconnectDelay, maBaseUrl, type MaCommand } from "../src/server/ma-client.js";
import { MaLyricsProvider } from "../src/server/ma-provider.js";
import { MaMonitor, queueAnchor } from "../src/server/ma-monitor.js";
import { ArtworkStore } from "../src/server/artwork.js";
import { Bridge } from "../src/server/bridge.js";
import { parseLyrics } from "../src/server/lrc.js";
import { UnavailableSendspinLyricsProvider } from "../src/server/provider.js";

const syntheticTrack = (id = "one", provider = "synthetic") => ({
  uri: `${provider}://track/${id}`, item_id: id, provider, media_type: "track", name: `Synthetic ${id}`,
  duration: 60, provider_mappings: [{ item_id: id, provider_instance: provider, provider_domain: provider, available: true }],
  artists: [{ name: "Synthetic Artist" }], album: { name: "Synthetic Album" },
  metadata: { lyrics: null, lrc_lyrics: null, images: null },
});
const queue = (id = "one") => ({
  queue_id: "exact-group", available: true, active: true, state: "playing",
  elapsed_time: 2, elapsed_time_last_updated: Date.now() / 1000, playback_speed: 1,
  current_item: { queue_item_id: id, name: `Synthetic ${id}`, media_item: syntheticTrack(id), duration: 60 },
  next_item: null,
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });
async function mockMa(handler: (command: string, args: Record<string, unknown>) => unknown) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("invalid_address");
  const sockets = new Set<WebSocket>();
  const commands: string[] = [];
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.send(JSON.stringify({ server_id: "synthetic-test", server_version: "2.10.2", schema_version: 65, min_supported_schema_version: 28 }));
    socket.on("message", async (bytes) => {
      const input = JSON.parse(bytes.toString()) as { command: string; message_id: string; args: Record<string, unknown> };
      commands.push(input.command);
      if (input.command === "auth") {
        socket.send(JSON.stringify({ message_id: input.message_id, result: { authenticated: input.args.token === "synthetic-test-token" }, partial: false }));
      } else {
        const result = await handler(input.command, input.args);
        socket.send(JSON.stringify({ message_id: input.message_id, result, partial: false }));
      }
    });
  });
  const client = new MaClient(`http://127.0.0.1:${address.port}`, "synthetic-test-token");
  cleanups.push(async () => {
    client.close();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { client, commands, sockets, server, url: `http://127.0.0.1:${address.port}` };
}
describe("verified MA wire contract", () => {
  it("authenticates after server greeting and follows exact active queue, lyrics, seek and next", async () => {
    let current = queue();
    const mock = await mockMa((command, args) => {
      if (command === "player_queues/get_active_queue") { expect(args.player_id).toBe("exact-cast"); return current; }
      if (command === "music/item_by_uri") {
        expect(args.allow_update_metadata).toBe(false);
        return syntheticTrack(String(args.uri).split("/").at(-1));
      }
      if (command === "metadata/get_track_lyrics") {
        expect(args.track).toMatchObject({ provider_mappings: expect.any(Array), media_type: "track" });
        return [null, "[00:00]Synthetic live line\n[00:05]Another original test line"];
      }
      throw new Error(`unexpected_command_${command}`);
    });
    const bridge = new Bridge(new MaLyricsProvider(mock.client), { get: async () => null, put: async () => {} }, { visualOffsetMs: 0 });
    const monitor = new MaMonitor(mock.client, bridge, "exact-cast", "exact-group", new ArtworkStore(mock.url));
    monitor.start();
    await vi.waitFor(() => expect(bridge.snapshot().lyrics.status).toBe("timed"));
    expect(bridge.snapshot().track?.identity).toBe("synthetic://track/one");
    const before = bridge.snapshot().generation;
    current = { ...queue("two"), elapsed_time: 0 };
    for (const socket of mock.sockets) socket.send(JSON.stringify({ event: "queue_updated", object_id: "exact-group", data: current }));
    await vi.waitFor(() => expect(bridge.snapshot().track?.identity).toBe("synthetic://track/two"));
    expect(bridge.snapshot().generation).toBeGreaterThan(before);
    for (const socket of mock.sockets) socket.send(JSON.stringify({ event: "queue_time_updated", object_id: "exact-group", data: 12.5 }));
    await vi.waitFor(() => expect(bridge.snapshot().positionMs).toBeGreaterThanOrEqual(12_500));
    expect(mock.commands.every((command) => !command.includes("cmd/") && !command.includes("subscribe"))).toBe(true);
    monitor.close(); bridge.close();
  });
  it("freezes on disconnect and reconnects with a new authoritative anchor", async () => {
    const mock = await mockMa(() => queue());
    const bridge = new Bridge({ capability: "available", fetch: async () => parseLyrics(null) }, { get: async () => null, put: async () => {} }, { visualOffsetMs: 0 });
    const monitor = new MaMonitor(mock.client, bridge, "exact-cast", "exact-group", new ArtworkStore(mock.url));
    monitor.start();
    await vi.waitFor(() => expect(bridge.snapshot().connection).toBe("connected"));
    for (const socket of mock.sockets) socket.terminate();
    await vi.waitFor(() => expect(bridge.snapshot().speed).toBe(0));
    await vi.waitFor(() => expect(bridge.snapshot().connection).toBe("connected"), { timeout: 3000 });
    expect(mock.commands.filter((command) => command === "auth").length).toBe(2);
    monitor.close(); bridge.close();
  });
  it("acquires slow queues despite frequent time events and unchanged routing, without undoing newer seeks", async () => {
    const mock = await mockMa(async () => {
      const oldSnapshot = queue();
      await new Promise((resolve) => setTimeout(resolve, 110));
      return oldSnapshot;
    });
    const bridge = new Bridge({ capability: "available", fetch: async () => parseLyrics(null) },
      { get: async () => null, put: async () => {} }, { visualOffsetMs: 0 });
    const monitor = new MaMonitor(mock.client, bridge, "exact-cast", "exact-group", new ArtworkStore(mock.url));
    const interval = setInterval(() => {
      for (const socket of mock.sockets) {
        socket.send(JSON.stringify({ event: "queue_time_updated", object_id: "exact-group", data: 35 }));
        socket.send(JSON.stringify({ event: "player_updated", object_id: "exact-cast", data: { active_group: "exact-group" } }));
      }
    }, 25);
    try {
      monitor.start();
      await vi.waitFor(() => expect(bridge.snapshot().connection).toBe("connected"), { timeout: 2500 });
      expect(bridge.snapshot().track?.identity).toBe("synthetic://track/one");
      expect(bridge.snapshot().positionMs).toBeGreaterThanOrEqual(35_000);
    } finally { clearInterval(interval); monitor.close(); bridge.close(); }
  });
  it("rejects runtime attempts to send playback mutations", async () => {
    const mock = await mockMa(() => null);
    await expect(mock.client.request("players/cmd/group" as MaCommand)).rejects.toThrow("not_allowed");
    expect(mock.commands).toEqual([]);
  });
});
describe("MA provider", () => {
  it("resolves the actual URI and passes complete returned Track to the real lyrics endpoint", async () => {
    const rpc = { request: vi.fn().mockResolvedValueOnce(syntheticTrack()).mockResolvedValueOnce(["Synthetic plain", "[00:01]Synthetic timed"]) };
    const provider = new MaLyricsProvider(rpc);
    const result = await provider.fetch({ identity: "synthetic://track/one", uri: "synthetic://track/one" }, new AbortController().signal);
    expect(result.status).toBe("timed");
    expect(rpc.request.mock.calls[0]?.[1]).toEqual({ uri: "synthetic://track/one", allow_update_metadata: false });
    expect(rpc.request.mock.calls[1]?.[0]).toBe("metadata/get_track_lyrics");
  });
  it("uses embedded lyrics without enrichment and gates returned library identity rather than requested URI", async () => {
    const track = syntheticTrack("one", "library");
    const rpc = { request: vi.fn().mockResolvedValue(track) };
    const request = { identity: "synthetic://track/one", uri: "synthetic://track/one" };
    const denied = await new MaLyricsProvider(rpc).fetch(request, new AbortController().signal);
    expect(denied.message).toContain("refresh is disabled");
    expect(rpc.request).toHaveBeenCalledTimes(1);
    rpc.request.mockResolvedValue({ ...track, metadata: { lyrics: null, lrc_lyrics: "[00:00]Synthetic stored", images: null } });
    const embedded = await new MaLyricsProvider(rpc).fetch(request, new AbortController().signal);
    expect(embedded.status).toBe("timed");
    expect(rpc.request).toHaveBeenCalledTimes(2);
  });
  it("performs explicit opt-in library enrichment and reports missing/plain properly", async () => {
    const rpc = { request: vi.fn().mockResolvedValueOnce(syntheticTrack("one", "library")).mockResolvedValueOnce([null, null]) };
    expect((await new MaLyricsProvider(rpc, true).fetch({ identity: "a", uri: "a" }, new AbortController().signal)).status).toBe("missing");
    rpc.request.mockResolvedValueOnce(syntheticTrack()).mockResolvedValueOnce(["Original untimed text", null]);
    expect((await new MaLyricsProvider(rpc).fetch({ identity: "a", uri: "a" }, new AbortController().signal)).status).toBe("plain");
  });
  it("rejects malformed upstream lyrics and aborts before follow-up lookup", async () => {
    const rpc = { request: vi.fn().mockResolvedValueOnce(syntheticTrack()).mockResolvedValueOnce({ lyrics: "not the actual tuple" }) };
    await expect(new MaLyricsProvider(rpc).fetch({ identity: "a", uri: "a" }, new AbortController().signal)).rejects.toThrow();
    const abort = new AbortController(); abort.abort();
    rpc.request.mockResolvedValueOnce(syntheticTrack());
    await expect(new MaLyricsProvider(rpc).fetch({ identity: "a", uri: "a" }, abort.signal)).rejects.toThrow();
  });
  it("future Sendspin provider is explicitly unsupported, never a silent fallback", async () => {
    const provider = new UnavailableSendspinLyricsProvider();
    expect(provider.capability).toBe("unsupported");
    expect((await provider.fetch({ identity: "a", uri: "a" }, new AbortController().signal)).status).toBe("unsupported");
  });
});
describe("queue binding and time", () => {
  it("converts seconds once, corrects snapshot age and freezes paused time", () => {
    const raw = { ...queue(), elapsed_time_last_updated: 100, elapsed_time: 2.5 };
    expect(queueAnchor(raw, "exact-group", 101_000).positionMs).toBe(3500);
    const paused = queueAnchor({ ...raw, state: "paused" }, "exact-group", 200_000);
    expect(paused.positionMs).toBe(2500);
    expect(paused.playback).toBe("paused");
  });
  it("fails closed on wrong group, stale clock, unsupported speed and radio", () => {
    expect(() => queueAnchor(queue(), "unrelated", Date.now())).toThrow("mismatch");
    expect(() => queueAnchor({ ...queue(), playback_speed: 1.5 }, "exact-group", Date.now())).toThrow("unsupported_playback_speed");
    expect(() => queueAnchor({ ...queue(), elapsed_time_last_updated: 1 }, "exact-group", Date.now())).toThrow("timestamp");
    const raw = queue(); raw.current_item.media_item.media_type = "radio";
    expect(() => queueAnchor(raw, "exact-group", Date.now())).toThrow("unsupported_media_type");
  });
  it("uses capped jittered backoff and preserves reverse proxy path in URL", () => {
    expect(reconnectDelay(0, () => 0)).toBe(750);
    expect(reconnectDelay(20, () => 1)).toBe(37500);
    expect(new URL("ws", maBaseUrl("https://ma.example/base", true)).href).toBe("wss://ma.example/base/ws");
    expect(maBaseUrl("wss://ma.example/base/ws").href).toBe("https://ma.example/base/");
  });
});
