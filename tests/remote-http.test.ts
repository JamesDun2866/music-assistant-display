import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/http.js";
import { Bridge } from "../src/server/bridge.js";
import { DemoProvider } from "../src/server/demo.js";
import { SettingsStore } from "../src/server/settings.js";
import type { CecStatus } from "../src/shared/protocol.js";
import type { RemoteSignal, RemoteSource } from "../src/shared/remote.js";
import { loadConfig } from "../src/server/config.js";
import { NativeCecController } from "../src/server/cec-native.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function fixture(native?: NativeCecController) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "karaoke-remote-"));
  const settings = new SettingsStore(dir);
  await settings.init();
  const bridge = new Bridge(new DemoProvider(), { get: async () => null, put: async () => {} }, settings, true);
  const listeners = new Set<(signal: RemoteSignal) => void>();
  const source: RemoteSource = {
    resetRemote: vi.fn(),
    onRemote: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const status: CecStatus = {
    enabled: true, available: true, owned: false, message: "Injected transport; no hardware",
    remote: {
      enabled: true, listening: true, device: "/dev/cec1", logicalAddress: 8, physicalAddress: 0x1200,
      lastEvent: null, kioskConnected: false,
    },
  };
  let now = 0;
  const server = createServer(createApp({
    bridge, settings, cec: native ?? { status: () => status, execute: async () => status }, remote: native ?? source,
    remoteTiming: { now: () => now, leaseMs: 30_000, pingMs: 20 },
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("missing address");
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    bridge.close();
    await rm(dir, { recursive: true, force: true });
  });
  const session = async () => {
    const response = await fetch(`${base}/api/session`);
    const data = await response.json() as { csrfToken: string };
    return {
      Cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      "X-CSRF-Token": data.csrfToken, "Content-Type": "application/json",
    };
  };
  const headers = await session();
  const post = (endpoint: string, body: unknown, custom = headers) =>
    fetch(`${base}${endpoint}`, { method: "POST", headers: custom, body: JSON.stringify(body) });
  const stream = async (pageId = randomUUID(), custom = headers) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/kiosk/remote`, {
      method: "POST", headers: custom, body: JSON.stringify({ role: "kiosk", pageId }), signal: controller.signal,
    });
    const reader = response.body!.getReader();
    cleanups.push(async () => { controller.abort(); await reader.cancel().catch(() => {}); });
    let buffer = "";
    const decoder = new TextDecoder();
    const next = async (): Promise<{ event: string; data: Record<string, unknown> } | null> => {
      while (true) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const item = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(item)?.[1];
          const data = /^data: (.+)$/m.exec(item)?.[1];
          if (!event || !data) throw new Error("invalid event");
          if (event === "ping") continue;
          return { event, data: JSON.parse(data) as Record<string, unknown> };
        }
        const chunk = await reader.read();
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    return { response, next, controller, pageId };
  };
  return {
    base, headers, status, source, listeners, stream, post, session, bridge,
    emit: (signal: RemoteSignal) => { for (const listener of listeners) listener(signal); },
    advance: (ms: number) => { now += ms; },
  };
}

it("requires local CSRF authorization, explicit kiosk role and a UUID; never accepts key injection", async () => {
  const f = await fixture();
  const body = { pageId: randomUUID(), role: "kiosk" };
  for (const headers of [
    { "Content-Type": "application/json" },
    { ...f.headers, Origin: "https://evil.example" },
    { ...f.headers, "Sec-Fetch-Site": "cross-site" },
    { ...f.headers, "X-CSRF-Token": "f".repeat(64) },
    { ...f.headers, Cookie: "" },
  ]) {
    expect((await fetch(`${f.base}/api/kiosk/remote`, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(403);
  }
  for (const body of [{}, { pageId: randomUUID() }, { role: "admin", pageId: randomUUID() },
    { role: "kiosk", pageId: "bad" }, { role: "kiosk", pageId: randomUUID(), key: "up" }]) {
    expect((await f.post("/api/kiosk/remote", body)).status).toBe(400);
  }
  expect((await fetch(`${f.base}/api/kiosk/remote`)).status).toBe(404);
  expect((await f.post("/api/remote/inject", { key: "up" })).status).toBe(404);
  expect(f.listeners.size).toBe(0);
});

it("uses one per-connection lease even for two pages sharing a session cookie", async () => {
  const f = await fixture();
  const first = await f.stream();
  expect(first.response.status).toBe(200);
  const ready = await first.next();
  expect(ready).toMatchObject({ event: "ready", data: { sequence: 0 } });
  for (const pageId of [first.pageId, randomUUID()]) {
    expect((await f.post("/api/kiosk/remote", { role: "kiosk", pageId })).status).toBe(409);
  }
  expect(f.listeners.size).toBe(1);
  const data = await (await fetch(`${f.base}/api/state`)).json() as { cec: CecStatus };
  expect(data.cec.remote?.kioskConnected).toBe(true);
  f.emit({ type: "action", action: { key: "up", repeat: false } });
  expect(await first.next()).toMatchObject({
    event: "key", data: { epoch: ready!.data.epoch, sequence: 1, key: "up", repeat: false },
  });
});

it("does not deliver input to ordinary state streams or replay it on a new remote connection", async () => {
  const f = await fixture();
  const adminAbort = new AbortController();
  const admin = await fetch(`${f.base}/api/events`, { signal: adminAbort.signal });
  const adminReader = admin.body!.getReader();
  cleanups.push(async () => { adminAbort.abort(); await adminReader.cancel().catch(() => {}); });
  expect(new TextDecoder().decode((await adminReader.read()).value)).toContain("event: state");
  const first = await f.stream();
  const oldReady = await first.next();
  f.emit({ type: "action", action: { key: "select", repeat: false } });
  expect((await first.next())!.data.sequence).toBe(1);
  f.bridge.changed();
  expect(new TextDecoder().decode((await adminReader.read()).value)).not.toContain("event: key");
  first.controller.abort();
  await vi.waitFor(() => expect(f.listeners.size).toBe(0));
  f.emit({ type: "action", action: { key: "down", repeat: false } });
  const second = await f.stream(first.pageId);
  const ready = await second.next();
  expect(ready!.data.epoch).not.toBe(oldReady!.data.epoch);
  expect(ready!.data.sequence).toBe(0);
  f.emit({ type: "action", action: { key: "right", repeat: false } });
  expect(await second.next()).toMatchObject({ event: "key", data: { key: "right", sequence: 1 } });
  expect(f.source.resetRemote).toHaveBeenCalledTimes(3);
});

it("ends the epoch on native transport/routing loss, with no keys in the next epoch", async () => {
  const f = await fixture();
  const stream = await f.stream();
  const old = await stream.next();
  f.emit({ type: "reset" });
  expect(await stream.next()).toBeNull();
  expect(f.listeners.size).toBe(0);
  const next = await f.stream();
  expect((await next.next())!.data.epoch).not.toBe(old!.data.epoch);
  f.emit({ type: "action", action: { key: "back", repeat: true } });
  f.emit({ type: "action", action: { key: "select", repeat: true } });
  f.emit({ type: "action", action: { key: "left", repeat: true } });
  expect(await next.next()).toMatchObject({ data: { key: "left", repeat: true, sequence: 1 } });
});

it("native TV route selection exposes acknowledgement and reacquires a safe navigation lease", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn() }),
    kill: vi.fn(() => true),
  });
  const native = new NativeCecController({ enabled: true, device: "/dev/cec0" }, {
    spawn: () => child, validateRuntime: async () => {},
  });
  cleanups.push(async () => { const closing = native.close(); child.emit("close", 0); await closing; });
  const send = (event: object) => child.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
  const packet = (message: number[]) => send({ type: "packet", message, sequence: 0, txStatus: 0, rxStatus: 1 });
  await native.start();
  send({ type: "ready", logicalAddress: 4, physicalAddress: 0x2100 });
  const f = await fixture(native);
  const first = await f.stream();
  const old = await first.next();
  packet([4, 0x44, 1]);
  expect(await first.next()).toMatchObject({ data: { key: "up" } });
  packet([15, 0x86, 0x21, 0]);
  expect(await first.next()).toBeNull();
  send({
    type: "routing", id: 1, opcode: 0x86, source: 0, target: 15,
    physicalAddress: 0x2100, decision: "matched", acknowledgement: "sent",
  });
  const second = await f.stream(first.pageId);
  expect((await second.next())!.data.epoch).not.toBe(old!.data.epoch);
  packet([4, 0x44, 1]); // The old held key stays suppressed in the new epoch.
  packet([4, 0x45]);
  packet([4, 0x44, 4]);
  expect(await second.next()).toMatchObject({ data: { sequence: 1, key: "right" } });
  const state = await (await fetch(`${f.base}/api/state`)).json() as { cec: CecStatus };
  expect(state.cec).toMatchObject({
    owned: false, remote: {
      kioskConnected: true, lastEvent: { key: "right" },
      lastRouting: { decision: "matched", acknowledgement: "sent", physicalAddress: 0x2100 },
    },
  });
  send({
    type: "routing", id: 2, opcode: 0x9d, source: 8, target: 0,
    physicalAddress: 0x2000, decision: "route-away", acknowledgement: "none",
  });
  // Native handles directed-to-TV Inactive Source, which the packet normalizer cannot see.
  send({ type: "reset", reason: "routing-change" });
  packet([0x80, 0x9d, 0x20, 0]);
  expect(await second.next()).toBeNull();
  const third = await f.stream(first.pageId);
  await third.next();
  packet([4, 0x44, 4]);
  packet([4, 0x45]);
  packet([4, 0x44, 3]);
  expect(await third.next()).toMatchObject({ data: { sequence: 1, key: "left" } });
  expect(child.stdin.write).not.toHaveBeenCalled();
});

it("requires the page, epoch, session and CSRF to renew and releases expired leases", async () => {
  const f = await fixture();
  const stream = await f.stream();
  const ready = await stream.next();
  const body = { pageId: stream.pageId, epoch: ready!.data.epoch };
  expect((await f.post("/api/kiosk/remote/renew", { ...body, pageId: randomUUID() })).status).toBe(409);
  expect((await f.post("/api/kiosk/remote/renew", { ...body, epoch: randomUUID() })).status).toBe(409);
  expect((await f.post("/api/kiosk/remote/renew", body, await f.session())).status).toBe(409);
  const unauthorized = await fetch(`${f.base}/api/kiosk/remote/renew`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  expect(unauthorized.status).toBe(403);
  f.advance(29_000);
  expect((await f.post("/api/kiosk/remote/renew", body)).status).toBe(200);
  f.advance(29_000);
  expect((await f.post("/api/kiosk/remote/renew", body)).status).toBe(200);
  f.advance(30_000);
  expect((await f.post("/api/kiosk/remote/renew", body)).status).toBe(409);
  expect(await stream.next()).toBeNull();
  expect(f.listeners.size).toBe(0);
});

it("does not treat absent or disabled native transport as a ready input listener", async () => {
  const f = await fixture();
  f.status.remote!.listening = false;
  expect((await f.post("/api/kiosk/remote", { role: "kiosk", pageId: randomUUID() })).status).toBe(503);
  f.status.remote!.enabled = false;
  expect((await f.post("/api/kiosk/remote", { role: "kiosk", pageId: randomUUID() })).status).toBe(404);
  expect(f.listeners.size).toBe(0);
});

it("expires a silent lease on its heartbeat and bounds a backpressured consumer", async () => {
  const f = await fixture();
  const expired = await f.stream();
  await expired.next();
  f.advance(30_000);
  expect(await expired.next()).toBeNull();
  expect(f.listeners.size).toBe(0);
  const slow = await f.stream();
  await slow.next();
  // Synchronous delivery outpaces the socket: the server must stop buffering.
  for (let index = 0; index < 200; index++) f.emit({ type: "action", action: { key: "down", repeat: true } });
  expect(f.listeners.size).toBe(0);
  let count = 0;
  while (await slow.next()) count++;
  expect(count).toBeLessThan(100);
});

it("validates exact native device configuration while keeping master/demo gates opt-in", () => {
  const defaults = loadConfig({ DEMO_MODE: "true" });
  expect(defaults.CEC_REMOTE_ENABLED).toBe(false);
  expect(defaults.CEC_ENABLED).toBe(false);
  expect(defaults.CEC_DEVICE).toBe("/dev/cec0");
  expect(loadConfig({ DEMO_MODE: "true", CEC_DEVICE: "/dev/cec1" }).CEC_DEVICE).toBe("/dev/cec1");
  for (const device of ["/dev/../dev/cec0", "/dev/ttyACM0", "/dev/cec00", "/dev/cec1\n", "RPI", "", "/dev/cec" + "1".repeat(40)]) {
    expect(() => loadConfig({ DEMO_MODE: "true", CEC_DEVICE: device })).toThrow(/CEC_DEVICE/);
  }
});
