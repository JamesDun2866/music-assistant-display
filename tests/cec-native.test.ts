import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { access, lstat, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NativeCecController, type NativeCecDependencies, type NativeCecProcessFactory,
} from "../src/server/cec-native.js";
import type { CecCommand } from "../src/shared/protocol.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ access: vi.fn(), lstat: vi.fn(), stat: vi.fn() }));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_data: string) => true), end: vi.fn(),
  });
  kill = vi.fn((_signal: "SIGTERM" | "SIGKILL") => true);
  send(value: unknown): void { this.raw(JSON.stringify(value) + "\n"); }
  raw(value: string | Buffer, stream: "stdout" | "stderr" = "stdout"): void {
    this[stream].emit("data", typeof value === "string" ? Buffer.from(value) : value);
  }
  ready(logicalAddress = 4, physicalAddress = 0x1000): void {
    this.send({ type: "ready", logicalAddress, physicalAddress });
  }
  packet(message = [4, 0x44, 1], extra: object = {}): void {
    this.send({ type: "packet", message, sequence: 0, txStatus: 0, rxStatus: 1, ...extra });
  }
  close(signal: string | null = null): void { this.emit("close", signal ? null : 0, signal); }
}

const controllers: NativeCecController[] = [];
const children: FakeChild[] = [];
const routing = {
  type: "routing", id: 1, opcode: 0x86, source: 0, target: 15, physicalAddress: 0x1000,
  decision: "matched", acknowledgement: "pending",
};

function fixture(
  options = { enabled: true, device: "/dev/cec0" },
  dependencies: NativeCecDependencies = {},
) {
  const factory = vi.fn<NativeCecProcessFactory>(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const validate = vi.fn(async () => {});
  const cec = new NativeCecController(options, { spawn: factory, validateRuntime: validate, random: () => 0, ...dependencies });
  controllers.push(cec);
  const boot = async () => {
    await cec.start();
    return factory.mock.results.at(-1)!.value as FakeChild;
  };
  return { cec, factory, validate, boot };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
  vi.mocked(lstat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof lstat>>);
  vi.mocked(access).mockResolvedValue(undefined);
});
afterEach(async () => {
  const closing = controllers.splice(0).map((cec) => cec.close().catch(() => {}));
  for (const child of children.splice(0)) child.close();
  await Promise.all(closing);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("NativeCecController lifecycle (injected processes; no CEC hardware)", () => {
  it("recovers from the helper's startup event-loss error without a premature reset or power action", async () => {
    const f = fixture();
    const child = await f.boot();
    // Python's configuring path reports this error, not a pre-ready reset.
    child.send({ type: "error", code: "disconnected" });
    expect(f.cec.status().available).toBe(false);
    expect(f.cec.status().message).not.toMatch(/protocol/);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.factory).toHaveBeenCalledTimes(1);
    child.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.factory).toHaveBeenCalledTimes(2);
    const replacement = children.at(-1)!;
    replacement.ready();
    expect(f.cec.status().available).toBe(true);
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(replacement.stdin.write).not.toHaveBeenCalled();
  });

  it("disabled never validates, spawns, or powers the TV", async () => {
    const f = fixture({ enabled: false, device: "/dev/cec0" });
    await f.cec.start();
    await f.cec.execute("wake");
    await f.cec.close();
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.cec.status()).toMatchObject({ enabled: false, available: false, owned: false, remote: { listening: false } });
  });

  it("starts explicitly and once, with fixed executable/helper/args/env and no initial writes", async () => {
    vi.stubEnv("HOME", "/private");
    vi.stubEnv("PYTHONPATH", "/injection");
    vi.stubEnv("LD_PRELOAD", "/injection");
    vi.stubEnv("NODE_OPTIONS", "--inspect");
    vi.stubEnv("MA_TOKEN", "secret");
    vi.stubEnv("PATH", "/malicious");
    const f = fixture();
    expect(f.cec.status().available).toBe(false);
    await f.cec.execute("wake");
    expect(f.factory).not.toHaveBeenCalled();
    const child = await f.boot();
    await f.cec.start();
    expect(f.factory).toHaveBeenCalledExactlyOnceWith("/usr/bin/python3", [
      "-I", "-u", fileURLToPath(new URL("../src/server/native-cec.py", import.meta.url)), "--device", "/dev/cec0",
    ], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(f.cec.status().available).toBe(false);
    child.ready();
    expect(f.cec.status()).toMatchObject({
      available: true, owned: false,
      remote: { enabled: true, listening: true, device: "/dev/cec0", logicalAddress: 4, physicalAddress: 0x1000, lastEvent: null },
    });
  });

  it.each(["", "RPI", "/dev/ttyACM0", "/dev/cec0\n", "/dev/cec0;id", "/dev/cec-1", "/dev/cec00", "/dev/cec01", "/dev/cec0/../cec1"])(
    "rejects invalid device configuration without a spawn: %j", async (device) => {
      const f = fixture({ enabled: true, device });
      await f.cec.start();
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.validate).not.toHaveBeenCalled();
      expect(f.cec.status()).toMatchObject({ available: false, remote: { device: "(invalid)" } });
      expect(f.cec.status().message).toMatch(/device invalid/);
    },
  );

  it("uses the real fixed spawn wrapper and validates packaged files without invoking hardware", async () => {
    const child = new FakeChild();
    children.push(child);
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const cec = new NativeCecController({ enabled: true, device: "/dev/cec1" });
    controllers.push(cec);
    await cec.start();
    expect(stat).toHaveBeenCalledWith("/usr/bin/python3");
    expect(lstat).toHaveBeenCalledWith(fileURLToPath(new URL("../src/server/native-cec.py", import.meta.url)));
    expect(access).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledWith("/usr/bin/python3", expect.any(Array), expect.objectContaining({ shell: false }));
  });

  it.each(["ENOENT", "EACCES", "EPERM"])("runtime validation failure %s never spawns or leaks details", async (code) => {
    const f = fixture(undefined, {
      validateRuntime: vi.fn(async () => { throw Object.assign(new Error("private/token/path"), { code }); }),
    });
    await f.cec.start();
    expect(f.cec.status().message).toMatch(code === "ENOENT" ? /unsupported/ : /permission/);
    expect(f.cec.status().message).not.toContain("private");
    expect(f.factory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it.each(["python", "helper"])("refuses non-regular %s files", async (which) => {
    vi.mocked(which === "python" ? stat : lstat).mockResolvedValue({ isFile: () => false } as Awaited<ReturnType<typeof stat>>);
    const cec = new NativeCecController({ enabled: true, device: "/dev/cec0" });
    controllers.push(cec);
    await cec.start();
    expect(spawn).not.toHaveBeenCalled();
    expect(cec.status().message).toMatch(/unsupported/);
  });

  it("does not spawn if closed during asynchronous file validation", async () => {
    let release!: () => void;
    const f = fixture(undefined, { validateRuntime: () => new Promise<void>((resolve) => { release = resolve; }) });
    const starting = f.cec.start();
    const closing = f.cec.close();
    release();
    await Promise.all([starting, closing]);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("contains synchronous spawn exceptions and child/stdio errors without unhandled error events", async () => {
    const throwing = fixture(undefined, { spawn: () => { throw new Error("secret"); } });
    await throwing.cec.start();
    expect(throwing.cec.status().message).toMatch(/unsupported/);
    const f = fixture();
    const child = await f.boot();
    expect(() => {
      child.emit("error", Object.assign(new Error("private"), { code: "ENOENT" }));
      child.stdin.emit("error", new Error("private"));
      child.stdout.emit("error", new Error("private"));
      child.stderr.emit("error", new Error("private"));
    }).not.toThrow();
    child.close();
    expect(f.cec.status().message).not.toMatch(/private|secret/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.factory).toHaveBeenCalledTimes(1);
  });

  it("startup times out at twelve seconds and is never readiness", async () => {
    const f = fixture();
    const child = await f.boot();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(f.cec.status()).toMatchObject({ available: false, message: expect.stringMatching(/startup timed out/) });
    child.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.factory).toHaveBeenCalledTimes(1);
  });
});

describe("native CEC strict bounded protocol", () => {
  it("keeps routing diagnostics separate from navigation and manual command results", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    expect(f.cec.status().remote?.lastRouting).toBeNull();
    child.send(routing);
    const at = f.cec.status().remote!.lastRouting!.at;
    expect(f.cec.status().remote?.lastEvent).toBeNull();
    expect(child.stdin.write).not.toHaveBeenCalled();
    const manual = f.cec.execute("active-source");
    vi.setSystemTime(Date.now() + 60_000);
    child.send({ ...routing, acknowledgement: "sent" });
    expect(f.cec.status().remote?.lastRouting).toMatchObject({ id: 1, at, acknowledgement: "sent" });
    child.send({ type: "result", id: 1, ok: false });
    expect((await manual).message).toMatch(/transmission failed/);
    expect(f.cec.status().remote?.lastRouting?.acknowledgement).toBe("sent");
    child.packet();
    expect(f.cec.status()).toMatchObject({ owned: false, remote: { lastEvent: { key: "up" } } });
    const copy = f.cec.status().remote!.lastRouting!;
    copy.acknowledgement = "failed";
    expect(f.cec.status().remote?.lastRouting?.acknowledgement).toBe("sent");
    child.send({ ...routing, id: 2, physicalAddress: 0x2000, decision: "wrong-path", acknowledgement: "none" });
    expect(f.cec.status().remote?.lastRouting).toMatchObject({ id: 2, decision: "wrong-path" });
    expect(f.cec.status().remote?.lastEvent?.key).toBe("up");
  });

  it.each([
    { id: 0 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { opcode: 0x44 }, { source: 16 },
    { target: -1 }, { physicalAddress: 65536 }, { physicalAddress: "4096" },
    { decision: "anything" }, { acknowledgement: "owned" }, { private: "secret" },
  ])("rejects unbounded or non-allowlisted routing diagnostics: %j", async (patch) => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    child.send({ ...routing, ...patch });
    expect(f.cec.status()).toMatchObject({ available: false, message: expect.stringMatching(/protocol/) });
    expect(JSON.stringify(f.cec.status())).not.toContain("secret");
  });

  it.each([{ id: 1 }, { id: 2, source: 5 }])("rejects stale/cross-event acknowledgement updates: %j", async (patch) => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    child.send({ ...routing, id: 2 });
    child.send({ ...routing, acknowledgement: "sent", ...patch });
    expect(f.cec.status().message).toMatch(/protocol/);
  });

  it("cancels pending route diagnostics on transport loss and starts a new passive listener session", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    child.send(routing);
    child.send({ type: "error", code: "disconnected" });
    expect(f.cec.status().remote?.lastRouting?.acknowledgement).toBe("cancelled");
    child.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const replacement = children.at(-1)!;
    replacement.ready();
    expect(f.cec.status().remote?.lastRouting).toBeNull();
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(replacement.stdin.write).not.toHaveBeenCalled();
  });

  it.each([4, 8, 11])("accepts an EDID hierarchy and playback address %s only", async (address) => {
    const f = fixture();
    const child = await f.boot();
    child.ready(address, 0x1230);
    expect(f.cec.status().remote).toMatchObject({ listening: true, logicalAddress: address, physicalAddress: 0x1230 });
  });

  it.each([
    null, [], {}, { type: "ready", logicalAddress: 0, physicalAddress: 0x1000 },
    { type: "ready", logicalAddress: "4", physicalAddress: 0x1000 },
    ...[0, 0xffff, 0x1010, 0x0100, 0x10000, -1, 4096.1, "4096"].map((physicalAddress) =>
      ({ type: "ready", logicalAddress: 4, physicalAddress })),
    { type: "ready", logicalAddress: 4, physicalAddress: 0x1000, private: "secret" },
    { type: "error", code: "invented" }, { type: "error", code: "busy", message: "private" },
    { type: "log", message: "secret" },
  ])("rejects malformed/unknown startup schemas: %j", async (value) => {
    const f = fixture();
    const child = await f.boot();
    child.send(value);
    expect(f.cec.status()).toMatchObject({ available: false, message: expect.stringMatching(/protocol/) });
    expect(f.cec.status().message).not.toMatch(/secret|private/);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.factory).toHaveBeenCalledTimes(1);
  });

  it("requires ready once only and rejects packets/results/resets before readiness", async () => {
    for (const event of [
      { type: "packet", message: [4, 0x44, 1], sequence: 0, txStatus: 0, rxStatus: 1 },
      { type: "result", id: 1, ok: true }, { type: "reset", reason: "messages-lost" },
      routing,
    ]) {
      const f = fixture();
      const child = await f.boot();
      child.send(event);
      expect(f.cec.status().message).toMatch(/protocol/);
      child.close();
    }
    const f = fixture();
    const child = await f.boot();
    child.ready(); child.ready();
    expect(f.cec.status()).toMatchObject({ available: false, message: expect.stringMatching(/protocol/) });
  });

  it.each([
    { message: [] }, { message: Array.from({ length: 17 }, () => 0) },
    { message: [4, 0x44, -1] }, { message: [4, 0x44, 256] }, { message: [4, 0x44, 1.2] },
    { message: "04:44:01" }, { sequence: -1 }, { sequence: 0x100000000 }, { sequence: 0.1 },
    { txStatus: -1 }, { txStatus: 256 }, { rxStatus: 256 }, { rxStatus: "1" }, { extra: true },
  ])("rejects invalid packet schema %j", async (extra) => {
    const f = fixture();
    const child = await f.boot();
    child.ready(); child.packet(undefined, extra);
    expect(f.cec.status()).toMatchObject({ available: false, message: expect.stringMatching(/protocol/) });
  });

  it("ignores valid outgoing/irrelevant packets and updates lastEvent only from a normalized action", async () => {
    const f = fixture();
    const signals = vi.fn();
    f.cec.onRemote(signals);
    const child = await f.boot();
    child.ready();
    child.packet([4, 0x44, 1], { sequence: 0xffffffff, txStatus: 255, rxStatus: 255 });
    child.packet([4, 0x44, 1], { rxStatus: 3 });
    child.packet([8, 0x44, 1]);
    child.packet([4, 0x44, 0x4c]);
    child.packet([4, 0x44]);
    child.packet([4]);
    expect(f.cec.status().remote?.lastEvent).toBeNull();
    child.packet();
    expect(f.cec.status().remote?.lastEvent).toEqual({ key: "up", at: 1_000_000 });
    expect(signals).toHaveBeenCalledExactlyOnceWith({ type: "action", action: { key: "up", repeat: false } });
    child.packet([4, 0x45]);
    child.send({ type: "reset", reason: "routing-change" });
    expect(f.cec.status().remote?.lastEvent).toEqual({ key: "up", at: 1_000_000 });
  });

  it("returns deep snapshots, unsubscribes listeners, and lease reset does not recursively emit", async () => {
    const f = fixture();
    const signal = vi.fn();
    const unsubscribe = f.cec.onRemote(signal);
    f.cec.onRemote(() => { throw new Error("bad consumer"); });
    const child = await f.boot();
    child.ready(); child.packet();
    f.cec.resetRemote();
    await vi.advanceTimersByTimeAsync(450);
    child.packet();
    expect(signal).toHaveBeenCalledTimes(1);
    const snapshot = f.cec.status();
    snapshot.owned = true;
    snapshot.remote!.listening = false;
    snapshot.remote!.lastEvent!.key = "back";
    expect(f.cec.status()).toMatchObject({ owned: false, remote: { listening: true, lastEvent: { key: "up" } } });
    unsubscribe();
    child.send({ type: "reset", reason: "messages-lost" });
    expect(signal).toHaveBeenCalledTimes(1);
  });

  it.each([0, 0x0d])("keeps held key %s and directional timing monotonic while diagnostics use epoch time", async (code) => {
    vi.setSystemTime(1_700_000_000_000);
    const f = fixture();
    const signal = vi.fn();
    f.cec.onRemote(signal);
    const child = await f.boot();
    child.ready();
    child.packet([4, 0x44, code]);
    const firstEvent = f.cec.status().remote?.lastEvent;
    for (const jump of [3_600_000, -7_200_000]) {
      vi.setSystemTime(Date.now() + jump);
      await vi.advanceTimersByTimeAsync(100);
      child.packet([4, 0x44, code]);
      expect(signal).toHaveBeenCalledTimes(1);
      expect(f.cec.status().remote?.lastEvent).toEqual(firstEvent);
    }
    child.packet([4, 0x45]);
    child.packet();
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(449);
    child.packet();
    expect(signal).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    child.packet();
    expect(signal).toHaveBeenCalledTimes(3);
    expect(signal).toHaveBeenLastCalledWith({ type: "action", action: { key: "up", repeat: true } });
    expect(f.cec.status().remote?.lastEvent).toEqual({ key: "up", at: Date.now() });
    vi.setSystemTime(Date.now() + 7_200_000);
    await vi.advanceTimersByTimeAsync(119);
    child.packet();
    expect(signal).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    child.packet();
    expect(signal).toHaveBeenCalledTimes(4);
    expect(signal).toHaveBeenLastCalledWith({ type: "action", action: { key: "up", repeat: true } });
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(701);
    child.packet();
    expect(signal).toHaveBeenCalledTimes(5);
    expect(signal).toHaveBeenLastCalledWith({ type: "action", action: { key: "up", repeat: false } });
    expect(f.cec.status().remote?.lastEvent).toEqual({ key: "up", at: Date.now() });
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it("transport reset drops the kiosk lease and suppresses known held input without stopping readiness", async () => {
    const f = fixture();
    const signal = vi.fn();
    f.cec.onRemote(signal);
    const child = await f.boot();
    child.ready(); child.packet();
    child.send({ type: "reset", reason: "messages-lost" });
    await vi.advanceTimersByTimeAsync(500); child.packet();
    expect(signal.mock.calls).toEqual([
      [{ type: "action", action: { key: "up", repeat: false } }], [{ type: "reset" }],
    ]);
    expect(f.cec.status().available).toBe(true);
    child.packet([4, 0x45]); child.packet();
    expect(signal).toHaveBeenCalledTimes(3);
  });

  it("streams fragmented UTF-8 safely without decoding partial bytes as replacement characters", async () => {
    const f = fixture();
    const child = await f.boot();
    child.raw('{"type":"rea');
    child.raw('dy","logicalAddress":4,"physicalAddress":4096}\n');
    expect(f.cec.status().available).toBe(true);
    const utf8 = Buffer.from("é\n");
    child.raw(utf8.subarray(0, 1), "stderr");
    child.raw(utf8.subarray(1), "stderr");
    expect(f.cec.status().available).toBe(true);
    child.raw(Buffer.from([0xc3, 10]));
    expect(f.cec.status().message).toMatch(/protocol/);
  });

  it.each(["{", "\n", "not-json\n", '{"type":"error","code":"busy"} trailing\n'])(
    "fails malformed JSON or unterminated output safely: %j", async (output) => {
      const f = fixture();
      const child = await f.boot();
      child.raw(output);
      if (!output.endsWith("\n")) child.close();
      expect(f.cec.status()).toMatchObject({ available: false, message: expect.stringMatching(/protocol/) });
    },
  );

  it.each([
    '{"type":"ready","type":"ready","logicalAddress":4,"physicalAddress":4096}\n',
    '{"type":"ready","logicalAddress":4,"logical\\u0041ddress":8,"physicalAddress":4096}\n',
  ])("rejects duplicate JSON keys, including escaped spellings", async (line) => {
    const f = fixture();
    const child = await f.boot();
    child.raw(line);
    expect(f.cec.status()).toMatchObject({ available: false, message: expect.stringMatching(/protocol/) });
  });

  it.each(["stdout", "stderr"] as const)("bounds %s line bytes across chunks at 1024", async (stream) => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    child.raw("x".repeat(1024), stream);
    expect(f.cec.status().available).toBe(true);
    child.raw("x", stream);
    expect(f.cec.status()).toMatchObject({ available: false, message: expect.stringMatching(/output limit/) });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds line bytes rather than characters and checks full lines in one chunk", async () => {
    const f = fixture();
    const child = await f.boot();
    child.raw("é".repeat(513) + "\n", "stderr");
    expect(f.cec.status().message).toMatch(/output limit/);
  });

  it("caps combined stdout/stderr in a sliding one-second window, including split-window floods", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    await vi.advanceTimersByTimeAsync(100);
    child.raw(("x".repeat(999) + "\n").repeat(33), "stderr");
    await vi.advanceTimersByTimeAsync(900);
    child.raw(("x".repeat(999) + "\n").repeat(33), "stderr");
    expect(f.cec.status().message).toMatch(/output limit/);
  });

  it("does not accumulate prior output forever", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    for (let n = 0; n < 5; n++) {
      child.raw(("x".repeat(999) + "\n").repeat(60), "stderr");
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(f.cec.status().available).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not reset the output budget on a forward wall-clock correction", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    child.raw(("x".repeat(999) + "\n").repeat(33), "stderr");
    vi.setSystemTime(Date.now() + 3_600_000);
    await vi.advanceTimersByTimeAsync(100);
    child.raw(("x".repeat(999) + "\n").repeat(33), "stderr");
    expect(f.cec.status().message).toMatch(/output limit/);
  });

  it("expires the output budget on elapsed time after a backward wall-clock correction", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    child.raw(("x".repeat(999) + "\n").repeat(60), "stderr");
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(1_000);
    child.raw(("x".repeat(999) + "\n").repeat(60), "stderr");
    expect(f.cec.status().available).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not expose raw stderr, JSON fields, environment strings, or bus dumps", async () => {
    const f = fixture();
    const child = await f.boot();
    child.raw("MA_TOKEN=private-token 04:44:01\n", "stderr");
    child.send({ type: "error", code: "permission" });
    const output = JSON.stringify(f.cec.status());
    expect(output).not.toMatch(/MA_TOKEN|private-token|04:44:01/);
    expect(output).toMatch(/permission denied/);
  });
});

describe("native CEC explicit commands and reconnect safety", () => {
  it("sends only positive-ID wake/active-source JSON through the same persistent child", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    const wake = f.cec.execute("wake");
    const active = f.cec.execute("active-source");
    expect(child.stdin.write.mock.calls).toEqual([
      ['{"id":1,"command":"wake"}\n'], ['{"id":2,"command":"active-source"}\n'],
    ]);
    child.send({ type: "result", id: 2, ok: true });
    child.send({ type: "result", id: 1, ok: true });
    expect(await active).toMatchObject({ owned: false, message: expect.stringMatching(/ownership.*not verified/) });
    expect(await wake).toMatchObject({ owned: false, message: expect.stringMatching(/power.*not verified/) });
    expect(f.factory).toHaveBeenCalledTimes(1);
  });

  it.each(["standby", "tx", "", "wake\nstandby", "constructor"])("refuses unsupported command %j without writing", async (command) => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    expect((await f.cec.execute(command as CecCommand)).message).toMatch(/unsupported|Unsupported/);
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(f.cec.status().owned).toBe(false);
  });

  it("bounds pending commands at sixteen and frees slots on results", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    const pending = Array.from({ length: 16 }, () => f.cec.execute("wake"));
    expect((await f.cec.execute("wake")).message).toMatch(/queue busy/);
    expect(child.stdin.write).toHaveBeenCalledTimes(16);
    child.send({ type: "result", id: 1, ok: false });
    expect(await pending[0]).toMatchObject({ available: true, message: expect.stringMatching(/transmission failed/) });
    pending.push(f.cec.execute("wake"));
    expect(child.stdin.write).toHaveBeenCalledTimes(17);
    child.close();
    await Promise.all(pending);
  });

  it.each([
    { id: 0, ok: true }, { id: -1, ok: true }, { id: 1.5, ok: true },
    { id: Number.MAX_SAFE_INTEGER + 1, ok: true }, { id: "1", ok: true },
    { id: 1, ok: "true" }, { id: 2, ok: true }, { id: 1, ok: true, extra: "secret" },
  ])("fails malformed or unsolicited command result %j", async (result) => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    const pending = f.cec.execute("wake");
    child.send({ type: "result", ...result });
    expect(await pending).toMatchObject({ available: false, message: expect.stringMatching(/protocol/) });
  });

  it("times commands out within six seconds, clears every pending request, and never replays", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    const first = f.cec.execute("wake");
    const second = f.cec.execute("active-source");
    await vi.advanceTimersByTimeAsync(5_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toMatchObject({ available: false, message: expect.stringMatching(/timed out/) });
    expect(await second).toMatchObject({ available: false });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.send({ type: "result", id: 1, ok: true });
    expect(f.cec.status().available).toBe(false);
    child.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.factory).toHaveBeenCalledTimes(1);
  });

  it("handles write throws and pipe errors without rejecting command promises", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    child.stdin.write.mockImplementationOnce(() => { throw new Error("private"); });
    expect(await f.cec.execute("wake")).toMatchObject({ available: false, message: expect.stringMatching(/disconnected/) });
    child.stdin.emit("error", new Error("another private error"));
  });

  it("fails pending commands on death, drops the lease, waits for close, and reconnects without replay", async () => {
    const f = fixture();
    const signal = vi.fn();
    f.cec.onRemote(signal);
    const first = await f.boot();
    first.ready(); first.packet();
    const pending = f.cec.execute("wake");
    first.send({ type: "error", code: "disconnected" });
    expect(await pending).toMatchObject({ available: false });
    expect(signal).toHaveBeenLastCalledWith({ type: "reset" });
    await f.cec.execute("active-source");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(f.factory).toHaveBeenCalledTimes(1);
    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.factory).toHaveBeenCalledTimes(2);
    const second = f.factory.mock.results[1]!.value as FakeChild;
    expect(second.stdin.write).not.toHaveBeenCalled();
    second.ready();
    expect(f.cec.status().owned).toBe(false);
    expect(second.stdin.write).not.toHaveBeenCalled();
  });

  it.each(["busy", "missing-device", "no-physical-address", "disconnected", "adapter-removed"])("retries recoverable %s only after process close", async (code) => {
    const f = fixture();
    const child = await f.boot();
    child.send({ type: "error", code });
    expect(f.cec.status().available).toBe(false);
    expect(child.stdin.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.factory).toHaveBeenCalledTimes(1);
    child.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(f.factory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.factory).toHaveBeenCalledTimes(2);
  });

  it.each(["permission", "invalid-device", "no-logical-address", "unsupported", "protocol",
    "transmit-failed", "registration-present", "cleanup-failed"])("never retries terminal %s", async (code) => {
    const f = fixture();
    const child = await f.boot();
    child.send({ type: "error", code });
    const message = f.cec.status().message;
    expect(f.cec.status().available).toBe(false);
    child.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.cec.status().message).toBe(message);
  });

  it("uses bounded exponential reconnect delays and resets only after a stable ready period", async () => {
    const f = fixture(undefined, { random: () => 1 });
    let child = await f.boot();
    for (const delay of [1_250, 2_500, 5_000, 10_000, 20_000, 30_000, 30_000]) {
      child.ready();
      await vi.advanceTimersByTimeAsync(100);
      child.close();
      const count = f.factory.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.factory).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.factory).toHaveBeenCalledTimes(count + 1);
      child = f.factory.mock.results.at(-1)!.value as FakeChild;
    }
    child.ready();
    await vi.advanceTimersByTimeAsync(30_000);
    child.close();
    const count = f.factory.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_249);
    expect(f.factory).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.factory).toHaveBeenCalledTimes(count + 1);
  });

  it("refuses stale kernel registration after abrupt death, even from a previously ready child", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    child.close("SIGKILL");
    expect(f.cec.status().message).toMatch(/registration may remain.*reboot/);
    await vi.advanceTimersByTimeAsync(1_000);
    const replacement = f.factory.mock.results[1]!.value as FakeChild;
    replacement.send({ type: "error", code: "registration-present" });
    replacement.close();
    expect(f.cec.status().message).toMatch(/unknown owner.*stop all CEC clients and reboot/);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(replacement.stdin.write).not.toHaveBeenCalled();
  });

  it("reconnects after confirmed adapter removal without hiding ambiguous cleanup failure", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    const pending = f.cec.execute("wake");
    child.send({ type: "error", code: "disconnected" });
    child.send({ type: "error", code: "adapter-removed" });
    expect(await pending).toMatchObject({ available: false });
    expect(f.cec.status().message).toMatch(/adapter removal confirmed/);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.factory).toHaveBeenCalledTimes(1);
    child.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const replugged = f.factory.mock.results[1]!.value as FakeChild;
    replugged.ready();
    expect(replugged.stdin.write).not.toHaveBeenCalled();
    expect(f.cec.status().available).toBe(true);
    replugged.send({ type: "error", code: "cleanup-failed" });
    replugged.send({ type: "error", code: "adapter-removed" });
    replugged.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(f.cec.status().message).toMatch(/cleanup failed.*reconnect disabled/);
  });
});

describe("native CEC close and escalation", () => {
  it("EOF/TERM has no commands and close resolves only after the process closes", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    const pending = f.cec.execute("wake");
    let completed = false;
    const closing = f.cec.close().then(() => { completed = true; });
    expect(await pending).toMatchObject({ available: false, message: expect.stringMatching(/closed/) });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    child.close();
    await closing;
    expect(completed).toBe(true);
    await f.cec.start();
    expect((await f.cec.execute("wake")).message).toMatch(/closed/);
    expect(f.factory).toHaveBeenCalledTimes(1);
  });

  it("escalates to SIGKILL after two seconds, warns about stale registration, and still awaits close", async () => {
    const f = fixture();
    const child = await f.boot();
    let done = false;
    const closing = f.cec.close().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(done).toBe(false);
    expect(f.cec.status().message).toMatch(/registration may remain.*reboot/);
    child.close("SIGKILL");
    await closing;
    expect(done).toBe(true);
  });

  it("explicitly rejects a bounded failed shutdown and never starts an overlapping/replacement owner", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    child.send({ type: "error", code: "disconnected" });
    const closing = f.cec.close().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await closing).toEqual(expect.objectContaining({ message: expect.stringMatching(/did not close after SIGKILL/) }));
    expect(f.cec.status()).toMatchObject({ available: false, message: expect.stringMatching(/replacement disabled/) });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.factory).toHaveBeenCalledTimes(1);
    child.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.factory).toHaveBeenCalledTimes(1);
  });

  it("contains failed kill calls and late errors on an unresponsive process", async () => {
    const f = fixture();
    const child = await f.boot();
    child.kill.mockImplementation(() => { throw new Error("private process path"); });
    child.stdin.end.mockImplementation(() => { throw new Error("private pipe"); });
    const closing = f.cec.close().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await closing).toBeInstanceOf(Error);
    expect(() => child.emit("error", new Error("late"))).not.toThrow();
    expect(f.cec.status().message).not.toMatch(/private/);
  });

  it("cleanup-failed during shutdown overrides a retryable error and prevents reconnect", async () => {
    const f = fixture();
    const child = await f.boot();
    child.ready();
    child.send({ type: "error", code: "disconnected" });
    child.send({ type: "error", code: "cleanup-failed" });
    child.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.cec.status().message).toMatch(/cleanup failed.*reconnect disabled/);
  });

  it.each(["broken\n", '{"type":"unknown"}\n', "x".repeat(1025)])(
    "malformed/oversized output after a recoverable error disables reconnect", async (line) => {
      const f = fixture();
      const child = await f.boot();
      child.send({ type: "error", code: "busy" });
      child.raw(line);
      child.close();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.factory).toHaveBeenCalledTimes(1);
      expect(f.cec.status().message).toMatch(/protocol|output limit/);
    },
  );

  it("cancels already scheduled reconnect on close", async () => {
    const f = fixture();
    const child = await f.boot();
    child.send({ type: "error", code: "busy" }); child.close();
    await f.cec.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.factory).toHaveBeenCalledTimes(1);
  });
});
