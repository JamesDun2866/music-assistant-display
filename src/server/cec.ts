import { spawn } from "node:child_process";
import type { CecCommand, CecStatus } from "../shared/protocol.js";

export interface CecOptions {
  enabled: boolean;
  adapter?: string;
  executable?: string;
  allowStandby: boolean;
}

export interface CecExecutionRequest {
  executable: string;
  args: readonly string[];
  input: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CecExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type CecExecutor = (request: CecExecutionRequest) => Promise<CecExecutionResult>;

class CecProcessError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** No shell, bounded combined output, and wait for process exit before releasing the adapter. */
export const spawnCec: CecExecutor = (request) => new Promise((resolve, reject) => {
  const env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
  for (const name of ["PATH", "HOME", "SystemRoot", "WINDIR"] as const) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const child = spawn(request.executable, [...request.args], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let failure: Error | undefined;
  const stop = (error: Error) => {
    failure ??= error;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => stop(new CecProcessError("TIMEOUT")), request.timeoutMs);
  const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
    if (failure) return;
    bytes += chunk.length;
    if (bytes > request.maxOutputBytes) {
      stop(new CecProcessError("OUTPUT_LIMIT"));
      return;
    }
    if (stream === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
  child.on("error", (error) => { failure ??= error; });
  child.stdin.on("error", (error) => stop(error));
  child.on("close", (exitCode) => {
    clearTimeout(timer);
    if (failure) reject(failure);
    else resolve({ exitCode, stdout, stderr });
  });
  child.stdin.end(request.input);
});

function failureMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  if (code === "ENOENT") return "CEC unavailable: install cec-utils or reconnect the adapter; retry explicitly.";
  if (code === "EACCES" || code === "EPERM") return "CEC unavailable: adapter or executable permission denied.";
  if (code === "EBUSY") return "CEC adapter busy; close other CEC clients and retry.";
  if (code === "TIMEOUT") return "CEC request timed out; check the adapter and retry.";
  if (code === "OUTPUT_LIMIT") return "CEC client exceeded its output limit; check the installation.";
  return "CEC request failed; check the adapter and retry.";
}

export class CecController {
  private readonly options: CecOptions;
  private current: CecStatus;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;

  constructor(options: CecOptions, private readonly executor: CecExecutor = spawnCec) {
    this.options = { ...options };
    this.current = {
      enabled: options.enabled,
      available: false,
      owned: false,
      message: options.enabled ? "CEC not checked; commands require explicit action." : "CEC disabled.",
    };
  }

  status(): CecStatus {
    return { ...this.current };
  }

  execute(command: CecCommand): Promise<CecStatus> {
    if (this.pending >= 16) {
      return Promise.resolve({ ...this.current, message: "CEC queue busy; retry after pending requests finish." });
    }
    this.pending++;
    const result = this.tail.then(() => this.run(command));
    this.tail = result.then(() => { this.pending--; }, () => { this.pending--; });
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    this.set(false, "CEC controller closed.");
  }

  private set(available: boolean, message: string): CecStatus {
    this.current = { enabled: this.options.enabled, available, owned: false, message };
    return this.status();
  }

  private async run(command: CecCommand): Promise<CecStatus> {
    if (this.closed) return this.set(false, "CEC controller closed.");
    if (!this.options.enabled) return this.set(false, "CEC disabled.");
    if (command !== "wake" && command !== "active-source" && command !== "standby") {
      return this.set(false, "Unsupported CEC command.");
    }
    if (command === "standby") {
      return this.set(this.current.available, this.options.allowStandby
        ? "Standby unsupported: one-shot libCEC cannot verify this instance still owns the active source."
        : "Standby disabled by policy.");
    }
    const executable = this.options.executable ?? "cec-client";
    const adapter = this.options.adapter;
    if (!/^(?:cec-client|\/[A-Za-z0-9/_.-]+)$/.test(executable) ||
        (adapter !== undefined && !/^(?:\/dev\/[A-Za-z0-9/_.:-]+|RPI)$/.test(adapter))) {
      return this.set(false, "Invalid CEC executable or adapter configuration.");
    }
    try {
      const result = await this.executor({
        executable,
        args: ["-s", "-d", "1", "-t", "p", "-aw", "0", ...(adapter ? [adapter] : [])],
        input: command === "wake" ? "on 0\n" : "as\n",
        timeoutMs: 12_000,
        maxOutputBytes: 64 * 1024,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      if (/busy|resource temporarily unavailable|already in use/i.test(output)) {
        return this.set(false, "CEC adapter busy; close other CEC clients and retry.");
      }
      if (/permission denied|access denied/i.test(output)) {
        return this.set(false, "CEC unavailable: adapter permission denied.");
      }
      if (/autodetect\s+failed|no (?:cec )?adapters?|unable to open|could not open|cannot open|devices:\s*none/i.test(output)) {
        return this.set(false, "CEC adapter unavailable; reconnect it and retry.");
      }
      if (result.exitCode !== 0 || /error:|failed|not supported|unrecognised|unrecognized/i.test(output)) {
        return this.set(false, "CEC client reported a failure; check adapter compatibility and retry.");
      }
      // A successful one-shot process is not proof of TV power, routing, or lasting ownership.
      return this.set(true, command === "wake"
        ? "Wake request sent; TV power state is not verified."
        : "Active-source request sent; TV routing and ownership are not verified.");
    } catch (error) {
      return this.set(false, failureMessage(error));
    }
  }
}
