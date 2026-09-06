import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CecController, spawnCec, type CecExecutionResult, type CecExecutor } from "../src/server/cec.js";
import type { CecCommand } from "../src/shared/protocol.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const ok: CecExecutionResult = { exitCode: 0, stdout: "opening a connection to the CEC adapter...", stderr: "" };
const options = { enabled: true, allowStandby: false };

describe("CecController (injected executor; never accesses hardware)", () => {
  it("does not probe or wake on construction, status, disabled actions, or close", async () => {
    const executor = vi.fn<CecExecutor>();
    const cec = new CecController({ ...options, enabled: false }, executor);
    expect(cec.status().available).toBe(false);
    await cec.execute("wake");
    await cec.close();
    expect(executor).not.toHaveBeenCalled();
  });

  it("uses explicit one-shot args, positional adapter, and only allowlisted input", async () => {
    const executor = vi.fn<CecExecutor>().mockResolvedValue(ok);
    const cec = new CecController({ ...options, adapter: "/dev/cec0" }, executor);
    expect((await cec.execute("wake")).available).toBe(true);
    await cec.execute("active-source");
    expect(executor.mock.calls.map(([r]) => r.input)).toEqual(["on 0\n", "as\n"]);
    expect(executor.mock.calls[0]![0]).toEqual({
      executable: "cec-client", args: ["-s", "-d", "1", "-t", "p", "-aw", "0", "/dev/cec0"],
      input: "on 0\n", timeoutMs: 12_000, maxOutputBytes: 65536,
    });
    expect(cec.status().owned).toBe(false);
  });

  it.each([false, true])("never sends standby without verified ownership (policy %s)", async (allowStandby) => {
    const executor = vi.fn<CecExecutor>().mockResolvedValue(ok);
    const cec = new CecController({ ...options, allowStandby }, executor);
    await cec.execute("active-source");
    const status = await cec.execute("standby");
    expect(status.owned).toBe(false);
    expect(status.message).toMatch(/Standby (disabled|unsupported)/);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it.each(["on 0\nstandby 0", "tx", "", "constructor"])("rejects runtime command %s", async (command) => {
    const executor = vi.fn<CecExecutor>();
    const cec = new CecController(options, executor);
    expect((await cec.execute(command as CecCommand)).message).toMatch(/Unsupported/);
    expect(executor).not.toHaveBeenCalled();
  });

  it.each(["-r", "/dev/cec0\nstandby 0", "RPI;shutdown", ""])("rejects unsafe adapter %s", async (adapter) => {
    const executor = vi.fn<CecExecutor>();
    const cec = new CecController({ ...options, adapter }, executor);
    expect((await cec.execute("wake")).available).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });

  it("rejects shell command executable configuration", async () => {
    const executor = vi.fn<CecExecutor>();
    const cec = new CecController({ ...options, executable: "cec-client; shutdown" }, executor);
    await cec.execute("wake");
    expect(executor).not.toHaveBeenCalled();
  });

  it.each(["ENOENT", "EBUSY", "EACCES", "TIMEOUT", "OUTPUT_LIMIT", "EPIPE"])("recovers from %s on next explicit request", async (code) => {
    const executor = vi.fn<CecExecutor>()
      .mockRejectedValueOnce(Object.assign(new Error("sensitive internal detail"), { code }))
      .mockResolvedValueOnce(ok);
    const cec = new CecController(options, executor);
    const failed = await cec.execute("wake");
    expect(failed.available).toBe(false);
    expect(failed.message).not.toContain("sensitive");
    expect((await cec.execute("wake")).available).toBe(true);
  });

  it.each(["ERROR: failed transmission", "autodetect FAILED", "unable to open the device", "resource busy", "permission denied"])("handles client error output even with exit zero: %s", async (stdout) => {
    const executor = vi.fn<CecExecutor>().mockResolvedValue({ ...ok, stdout });
    expect((await new CecController(options, executor).execute("wake")).available).toBe(false);
  });

  it("serializes requests and does not poison the queue after failure", async () => {
    let release!: (value: CecExecutionResult) => void;
    const executor = vi.fn<CecExecutor>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValueOnce(ok);
    const cec = new CecController(options, executor);
    const first = cec.execute("wake");
    const second = cec.execute("active-source");
    const third = cec.execute("wake");
    await Promise.resolve();
    expect(executor).toHaveBeenCalledTimes(1);
    release(ok);
    expect((await first).available).toBe(true);
    expect((await second).available).toBe(false);
    expect((await third).available).toBe(true);
    expect(executor).toHaveBeenCalledTimes(3);
  });

  it("returns detached status snapshots and prevents queued writes on close", async () => {
    const executor = vi.fn<CecExecutor>().mockResolvedValue(ok);
    const cec = new CecController(options, executor);
    cec.status().owned = true;
    expect(cec.status().owned).toBe(false);
    const queued = cec.execute("wake");
    await cec.close();
    expect((await queued).message).toMatch(/closed/);
    expect((await cec.execute("wake")).message).toMatch(/closed/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("caps queued operations without starting extra processes", async () => {
    let release!: (value: CecExecutionResult) => void;
    const executor = vi.fn<CecExecutor>().mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const cec = new CecController(options, executor);
    const pending = Array.from({ length: 16 }, () => cec.execute("wake"));
    expect((await cec.execute("wake")).message).toContain("queue busy");
    expect(executor).toHaveBeenCalledTimes(1);
    const closing = cec.close();
    release(ok);
    await Promise.all([...pending, closing]);
    expect(executor).toHaveBeenCalledTimes(1);
  });
});

describe("spawnCec transport (mock child process only)", () => {
  const request = {
    executable: "cec-client", args: ["-s"], input: "on 0\n", timeoutMs: 20, maxOutputBytes: 8,
  };
  function childProcess() {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    return child;
  }

  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("passes only allowlisted runtime environment, never MA credentials or loader injection", async () => {
    vi.stubEnv("MA_TOKEN", "fake-ma-token-never-forward");
    vi.stubEnv("MA_URL", "http://private-ma.invalid");
    vi.stubEnv("ARBITRARY_SECRET", "fake-secret");
    vi.stubEnv("LD_PRELOAD", "/untrusted/inject.so");
    vi.stubEnv("NODE_OPTIONS", "--inspect");
    vi.stubEnv("HOME", "/home/cec-test");
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("WINDIR", "C:\\Windows");
    const child = childProcess();
    const result = spawnCec(request);
    expect(spawn).toHaveBeenLastCalledWith("cec-client", ["-s"], expect.objectContaining({
      env: {
        PATH: "/usr/bin:/bin", HOME: "/home/cec-test",
        SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", LANG: "C", LC_ALL: "C",
      },
    }));
    child.emit("close", 0);
    await result;
  });

  it("spawns with shell disabled and captures only bounded child output", async () => {
    const child = childProcess();
    const end = vi.spyOn(child.stdin, "end");
    const result = spawnCec(request);
    expect(spawn).toHaveBeenLastCalledWith("cec-client", ["-s"], expect.objectContaining({
      shell: false, stdio: ["pipe", "pipe", "pipe"],
    }));
    expect(end).toHaveBeenCalledWith("on 0\n");
    child.stdout.write("ok");
    child.stderr.write("warn");
    child.emit("close", 0);
    expect(await result).toEqual({ exitCode: 0, stdout: "ok", stderr: "warn" });
  });

  it("kills timed-out child and waits for close before releasing the request", async () => {
    vi.useFakeTimers();
    const child = childProcess();
    let finished = false;
    const result = spawnCec(request).catch((error: unknown) => { finished = true; return error; });
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(finished).toBe(false);
    child.emit("close", null);
    expect(await result).toMatchObject({ code: "TIMEOUT" });
  });

  it("caps combined stdout/stderr rather than allowing unlimited output", async () => {
    const child = childProcess();
    const result = spawnCec(request).catch((error: unknown) => error);
    child.stdout.write("12345");
    child.stderr.write("6789");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null);
    expect(await result).toMatchObject({ code: "OUTPUT_LIMIT" });
  });

  it("handles spawn failure and stdin pipe errors without unhandled events", async () => {
    const child = childProcess();
    const result = spawnCec(request).catch((error: unknown) => error);
    child.emit("error", Object.assign(new Error("not installed"), { code: "ENOENT" }));
    child.stdin.emit("error", Object.assign(new Error("pipe closed"), { code: "EPIPE" }));
    child.emit("close", -2);
    expect(await result).toMatchObject({ code: "ENOENT" });
  });
});
