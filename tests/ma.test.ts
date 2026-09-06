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
import { playerAnchor, spotifyTrackUri } from "../src/server/ma-player.js";

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
const externalPlayer = (title = "Synthetic external one") => ({
  player_id: "exact-cast", available: true, active_group: "exact-group", synced_to: null,
  active_source: "spotify_connect--synthetic://audio_source/exact-group",
  playback_state: "playing", elapsed_time: 3, elapsed_time_last_updated: Date.now() / 1000,
  current_media: {
    uri: "spotify_connect--synthetic://audio_source/exact-group", media_type: "audio_source",
    title, artist: "Synthetic external artist", album: "Synthetic external album", duration: 60,
    queue_item_id: null,
  },
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
  it("follows Connect metadata across a stable source URI, ignores the old queue, and returns to MA lyrics", async () => {
    let current: ReturnType<typeof queue> | null = queue();
    let player = externalPlayer();
    const requests: string[] = [];
    const mock = await mockMa((command, args) => {
      if (command === "player_queues/get_active_queue") return current;
      if (command === "players/get") { expect(args).toEqual({ player_id: "exact-cast" }); return player; }
      if (command === "music/item_by_uri") {
        requests.push(String(args.uri));
        return syntheticTrack(String(args.uri).split("/").at(-1));
      }
      if (command === "metadata/get_track_lyrics") {
        return (args.track as { item_id: string }).item_id === "two" ? [null, null] : [null, "[00:00]Synthetic queue lyrics"];
      }
      throw new Error(`unexpected_command_${command}`);
    });
    const cachePut = vi.fn(async () => {});
    const bridge = new Bridge(new MaLyricsProvider(mock.client), { get: async () => null, put: cachePut }, { visualOffsetMs: 0 });
    const monitor = new MaMonitor(mock.client, bridge, "exact-cast", "exact-group", new ArtworkStore(mock.url));
    const emit = (event: string, object_id: string, data: unknown) => {
      for (const socket of mock.sockets) socket.send(JSON.stringify({ event, object_id, data }));
    };
    try {
      monitor.start();
      await vi.waitFor(() => expect(bridge.snapshot().lyrics.status).toBe("timed"));
      current = null;
      emit("player_updated", "exact-cast", player);
      await vi.waitFor(() => expect(bridge.snapshot().track?.title).toBe(player.current_media.title));
      expect(bridge.snapshot()).toMatchObject({
        precision: "ma-player", lyrics: { status: "unsupported", lines: [] },
        track: { artist: player.current_media.artist, album: player.current_media.album },
      });
      expect(bridge.snapshot().lyrics.message).toContain("no exact supported track URI");
      const firstIdentity = bridge.snapshot().track?.identity;
      player = externalPlayer("Synthetic external two");
      emit("player_updated", "exact-cast", player);
      await vi.waitFor(() => expect(bridge.snapshot().track?.title).toBe(player.current_media.title));
      expect(bridge.snapshot().track?.identity).not.toBe(firstIdentity);
      emit("queue_updated", "exact-group", queue("old"));
      emit("queue_time_updated", "exact-group", 50);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(bridge.snapshot().track?.title).toBe("Synthetic external two");
      expect(bridge.snapshot().positionMs).toBeLessThan(10_000);
      expect(requests).toEqual(["synthetic://track/one"]);
      expect(cachePut.mock.calls).toHaveLength(1);
      current = queue("two");
      emit("player_updated", "exact-cast", { ...player, active_source: "exact-group" });
      await vi.waitFor(() => expect(bridge.snapshot()).toMatchObject({
        precision: "ma-queue", track: { identity: "synthetic://track/two" }, lyrics: { status: "missing" },
      }));
      current = queue("three");
      emit("queue_updated", "exact-group", current);
      await vi.waitFor(() => expect(bridge.snapshot().lyrics.status).toBe("timed"));
      expect(bridge.snapshot().track?.identity).toBe("synthetic://track/three");
    } finally { monitor.close(); bridge.close(); }
  });
  it("fetches lyrics only for an exact externally reported Spotify track, with normal missing results", async () => {
    const firstId = "A".repeat(22);
    const secondId = "B".repeat(22);
    let player = {
      ...externalPlayer(), active_source: "spotify",
      current_media: { ...externalPlayer().current_media, media_type: "track", uri: `spotify:track:${firstId}` },
    };
    const mock = await mockMa((command, args) => {
      if (command === "player_queues/get_active_queue") return null;
      if (command === "players/get") return player;
      if (command === "music/item_by_uri") {
        expect(args.allow_update_metadata).toBe(false);
        return syntheticTrack(String(args.uri).split("/").at(-1), "spotify");
      }
      if (command === "metadata/get_track_lyrics") {
        return (args.track as { item_id: string }).item_id === firstId ? [null, "[00:00]Synthetic exact lyrics"] : [null, null];
      }
      throw new Error(`unexpected_command_${command}`);
    });
    const bridge = new Bridge(new MaLyricsProvider(mock.client), { get: async () => null, put: async () => {} }, { visualOffsetMs: 0 });
    const monitor = new MaMonitor(mock.client, bridge, "exact-cast", "exact-group", new ArtworkStore(mock.url));
    try {
      monitor.start();
      await vi.waitFor(() => expect(bridge.snapshot().lyrics.status).toBe("timed"));
      expect(bridge.snapshot().track?.identity).toBe(`spotify://track/${firstId}`);
      player = { ...player, current_media: { ...player.current_media, uri: `spotify:track:${secondId}` } };
      for (const socket of mock.sockets) socket.send(JSON.stringify({ event: "player_updated", object_id: "exact-cast", data: player }));
      await vi.waitFor(() => expect(bridge.snapshot()).toMatchObject({
        track: { identity: `spotify://track/${secondId}` }, lyrics: { status: "missing" },
      }));
    } finally { monitor.close(); bridge.close(); }
  });
  it("discards an external player read overtaken by a queue transition", async () => {
    let current: ReturnType<typeof queue> | null = null;
    let release: ((value: unknown) => void) | undefined;
    const mock = await mockMa((command) => {
      if (command === "player_queues/get_active_queue") return current;
      if (command === "players/get") return new Promise((resolve) => { release = resolve; });
      throw new Error(`unexpected_command_${command}`);
    });
    const bridge = new Bridge({ capability: "available", fetch: async () => parseLyrics(null) },
      { get: async () => null, put: async () => {} }, { visualOffsetMs: 0 });
    const monitor = new MaMonitor(mock.client, bridge, "exact-cast", "exact-group", new ArtworkStore(mock.url));
    try {
      monitor.start();
      await vi.waitFor(() => expect(release).toBeDefined());
      current = queue("new");
      for (const socket of mock.sockets) socket.send(JSON.stringify({ event: "queue_updated", object_id: "exact-group", data: current }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      release!(externalPlayer());
      await vi.waitFor(() => expect(bridge.snapshot().track?.identity).toBe("synthetic://track/new"));
      expect(bridge.snapshot().precision).toBe("ma-queue");
    } finally { monitor.close(); bridge.close(); }
  });
  it("never substitutes an external player for a different active MA queue", async () => {
    const mock = await mockMa(() => ({ ...queue(), queue_id: "other-group" }));
    const bridge = new Bridge({ capability: "available", fetch: async () => parseLyrics(null) },
      { get: async () => null, put: async () => {} }, { visualOffsetMs: 0 });
    const monitor = new MaMonitor(mock.client, bridge, "exact-cast", "exact-group", new ArtworkStore(mock.url));
    try {
      monitor.start();
      await vi.waitFor(() => expect(bridge.snapshot().message).toContain("target queue mismatch"));
      expect(bridge.snapshot().track).toBeNull();
      expect(mock.commands).not.toContain("players/get");
    } finally { monitor.close(); bridge.close(); }
  });
});
describe("external MA player identity", () => {
  it("updates Connect cover URLs without changing lyrics identity and clears missing covers", () => {
    const store = new ArtworkStore("http://ma.example", true);
    const bridge = new Bridge({ capability: "available", fetch: vi.fn() },
      { get: async () => null, put: async () => {} }, { visualOffsetMs: 0 });
    const player = externalPlayer();
    const cover = (id: string | null) => ({
      ...player, current_media: { ...player.current_media, image_url: id ? `https://i.scdn.co/image/${id.repeat(40)}` : null },
    });
    try {
      const first = playerAnchor(cover("a"), "exact-cast", "exact-group", Date.now(), store);
      bridge.accept(first);
      expect(first.request).toBeNull();
      expect(bridge.snapshot().track?.artworkUrl).toContain(`v=spotify-${"a".repeat(40)}`);
      const second = playerAnchor(cover("b"), "exact-cast", "exact-group", Date.now(), store);
      bridge.accept(second);
      expect(second.track?.identity).toBe(first.track?.identity);
      expect(bridge.snapshot().track?.artworkUrl).toContain(`v=spotify-${"b".repeat(40)}`);
      expect(bridge.snapshot().lyrics.status).toBe("unsupported");
      bridge.accept(playerAnchor(cover(null), "exact-cast", "exact-group", Date.now(), store));
      expect(bridge.snapshot().track?.artworkUrl).toBeNull();
      const disabled = new ArtworkStore("http://ma.example");
      expect(playerAnchor(cover("a"), "exact-cast", "exact-group", Date.now(), disabled).track?.artworkUrl).toBeNull();
    } finally { bridge.close(); }
  });
  it("does not confuse an endpoint, stream, episode or title with a Spotify track", () => {
    for (const uri of [
      externalPlayer().current_media.uri, "https://stream.example/song",
      `spotify:episode:${"A".repeat(22)}`, "Synthetic title", `https://open.spotify.com.evil.example/track/${"A".repeat(22)}`,
    ]) expect(spotifyTrackUri(uri)).toBeNull();
    for (const uri of [`spotify:track:${"A".repeat(22)}`, `spotify://track/${"A".repeat(22)}`,
      `https://open.spotify.com/track/${"A".repeat(22)}?si=synthetic`]) {
      expect(spotifyTrackUri(uri)).toBe(`spotify://track/${"A".repeat(22)}`);
    }
  });
  it("enforces exact player and group binding, and clears on idle", () => {
    const player = externalPlayer();
    expect(() => playerAnchor(player, "wrong", "exact-group", Date.now())).toThrow("target_player_mismatch");
    expect(() => playerAnchor({ ...player, active_group: "other" }, "exact-cast", "exact-group", Date.now())).toThrow("target_queue_mismatch");
    expect(() => playerAnchor({ ...player, synced_to: "other" }, "exact-cast", "exact-group", Date.now())).toThrow("target_queue_mismatch");
    expect(() => playerAnchor({ ...player, available: false }, "exact-cast", "exact-group", Date.now())).toThrow("unavailable");
    expect(() => playerAnchor({ ...player, active_source: "exact-group" }, "exact-cast", "exact-group", Date.now())).toThrow("unconfirmed");
    expect(() => playerAnchor({ ...player, current_media: null }, "exact-cast", "exact-group", Date.now())).toThrow("metadata_unavailable");
    expect(playerAnchor({ ...player, playback_state: "idle" }, "exact-cast", "exact-group", Date.now())).toMatchObject({ track: null, request: null });
  });
  it("uses the player's clock, freezes paused time, and never invents missing or stale timing", () => {
    const player = { ...externalPlayer(), elapsed_time: 3, elapsed_time_last_updated: 100 };
    expect(playerAnchor(player, "exact-cast", "exact-group", 101_000)).toMatchObject({ positionMs: 4000, speed: 1 });
    expect(playerAnchor({ ...player, playback_state: "paused" }, "exact-cast", "exact-group", 200_000)).toMatchObject({ positionMs: 3000, speed: 0 });
    const exact = { ...player, current_media: { ...player.current_media, media_type: "track", uri: `spotify:track:${"A".repeat(22)}` } };
    for (const timing of [{ elapsed_time: null }, { elapsed_time_last_updated: null }, { elapsed_time_last_updated: 1 }]) {
      const result = playerAnchor({ ...exact, ...timing }, "exact-cast", "exact-group", 300_000);
      expect(result).toMatchObject({ request: null, speed: 0, positionMs: 0 });
      expect(result.lyricsUnavailable).toContain("playback clock");
      expect(result.track?.title).toBe(player.current_media.title);
    }
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
