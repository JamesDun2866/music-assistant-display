import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { EventEmitter } from "node:events";
import type { CecCommand, CecStatus } from "../shared/protocol.js";
import type { CecRemoteStatus, RemoteSignal, RemoteSource } from "../shared/remote.js";
import { CEC_ROUTE_ACKNOWLEDGEMENTS, CEC_ROUTE_DECISIONS, type CecRoutingEvent } from "../shared/remote.js";
import { CecInputNormalizer, type CecLogicalAddress, type CecPacket } from "./cec-input.js";

const EXECUTABLE = "/usr/bin/python3";
const HELPER = fileURLToPath(new URL("./native-cec.py", import.meta.url));
const DEVICE = /^\/dev\/cec(?:0|[1-9][0-9]*)$/;
const RECOVERY = " Kernel CEC registration may remain; stop all CEC clients and reboot the Pi before recovery.";
const ERRORS = {
  busy: "Native CEC adapter busy; waiting to reconnect.",
  "missing-device": "Native CEC device missing; waiting to reconnect.",
  permission: "Native CEC permission denied; check device and runtime permissions.",
  "invalid-device": "Native CEC device invalid; expected a built-in /dev/cecN adapter.",
  "no-physical-address": "Native CEC has no valid HDMI/EDID physical address; waiting to reconnect.",
  "no-logical-address": "Native CEC could not claim a playback logical address; check other CEC clients.",
  unsupported: "Native CEC runtime or adapter unsupported; check the Python helper installation and adapter capabilities.",
  disconnected: "Native CEC disconnected; waiting to reconnect.",
  "adapter-removed": "Native CEC adapter removal confirmed; waiting to reconnect.",
  protocol: "Native CEC helper protocol invalid; transport stopped.",
  "transmit-failed": "Native CEC transmission failed; transport stopped.",
  "registration-present": "Native CEC registration already present; refusing to clear or claim an unknown owner." + RECOVERY,
  "cleanup-failed": "Native CEC registration cleanup failed; automatic reconnect disabled." + RECOVERY,
  output: "Native CEC helper output limit exceeded; transport stopped.",
  startup: "Native CEC startup timed out; transport stopped.",
  timeout: "Native CEC command timed out; not replaying the command.",
} as const;
type Failure = keyof typeof ERRORS;
const RETRY = new Set<Failure>(["busy", "missing-device", "no-physical-address", "disconnected", "adapter-removed"]);
const HELPER_ERRORS = new Set<string>(Object.keys(ERRORS).filter((key) =>
  !["output", "startup", "timeout"].includes(key)));

export interface NativeCecReadable extends Pick<EventEmitter, "on"> {}
export interface NativeCecWritable extends Pick<EventEmitter, "on"> {
  write(data: string): boolean;
  end(): unknown;
}
export interface NativeCecChild extends Pick<EventEmitter, "on"> {
  stdout: NativeCecReadable;
  stderr: NativeCecReadable;
  stdin: NativeCecWritable;
  kill(signal: "SIGTERM" | "SIGKILL"): boolean;
}
export interface NativeCecSpawnOptions {
  shell: false;
  windowsHide: true;
  stdio: ["pipe", "pipe", "pipe"];
  env: { PATH: string; LANG: string; LC_ALL: string };
}
export type NativeCecProcessFactory = (
  executable: string, args: string[], options: NativeCecSpawnOptions,
) => NativeCecChild;

export interface NativeCecDependencies {
  spawn?: NativeCecProcessFactory;
  validateRuntime?: () => Promise<void>;
  monotonicNow?: () => number;
  wallNow?: () => number;
  random?: () => number;
}

async function validateRuntime(): Promise<void> {
  const [python, helper] = await Promise.all([stat(EXECUTABLE), lstat(HELPER)]);
  if (!python.isFile() || !helper.isFile()) throw new Error("unsupported");
  await Promise.all([access(EXECUTABLE, constants.X_OK), access(HELPER, constants.R_OK)]);
}

interface Transport {
  child: NativeCecChild;
  ready: boolean;
  stopping: boolean;
  retry: boolean;
  forced: boolean;
  closed: boolean;
  stuck: boolean;
  failure?: Failure;
  buffers: { stdout: Buffer; stderr: Buffer };
  output: { at: number; bytes: number }[];
  outputBytes: number;
  startup?: ReturnType<typeof setTimeout>;
  stable?: ReturnType<typeof setTimeout>;
  terminate?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  completion: Promise<"closed" | "stuck">;
  finish: (outcome: "closed" | "stuck") => void;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  resolve: (status: CecStatus) => void;
  command: "wake" | "active-source";
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function integer(value: unknown, max: number, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function physicalAddress(value: unknown): value is number {
  if (!integer(value, 0xfffe, 1)) return false;
  let zero = false;
  for (const shift of [12, 8, 4, 0]) {
    const nibble = (value >> shift) & 15;
    if (zero && nibble !== 0) return false;
    zero ||= nibble === 0;
  }
  return true;
}
function runtimeFailure(error: unknown): Failure {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "EACCES" || code === "EPERM" ? "permission" : "unsupported";
}

type HelperEvent =
  | { type: "ready"; logicalAddress: CecLogicalAddress; physicalAddress: number }
  | ({ type: "packet" } & CecPacket)
  | ({ type: "routing" } & CecRoutingEvent)
  | { type: "reset"; reason: "routing-change" | "messages-lost" }
  | { type: "result"; id: number; ok: boolean }
  | { type: "error"; code: Failure };

function parseEvent(line: string): HelperEvent | null {
  const value: unknown = JSON.parse(line);
  const keys = new Set<string>();
  // JSON.parse otherwise silently accepts duplicate (including escaped) object keys.
  for (const token of line.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (!line.slice(token.index! + token[0].length).trimStart().startsWith(":")) continue;
    const key = JSON.parse(token[0]) as string;
    if (keys.has(key)) return null;
    keys.add(key);
  }
  if (exact(value, ["type", "code"]) && value.type === "error" &&
      typeof value.code === "string" && HELPER_ERRORS.has(value.code)) {
    return { type: "error", code: value.code as Failure };
  }
  if (exact(value, ["type", "logicalAddress", "physicalAddress"]) && value.type === "ready" &&
      [4, 8, 11].includes(value.logicalAddress as number) && physicalAddress(value.physicalAddress)) {
    return { type: "ready", logicalAddress: value.logicalAddress as CecLogicalAddress, physicalAddress: value.physicalAddress };
  }
  if (exact(value, ["type", "message", "sequence", "txStatus", "rxStatus"]) && value.type === "packet" &&
      Array.isArray(value.message) && value.message.length >= 1 && value.message.length <= 16 &&
      value.message.every((byte: unknown) => integer(byte, 255)) &&
      integer(value.sequence, 0xffffffff) && integer(value.txStatus, 255) && integer(value.rxStatus, 255)) {
    return { type: "packet", message: value.message, sequence: value.sequence, txStatus: value.txStatus, rxStatus: value.rxStatus };
  }
  if (exact(value, ["type", "reason"]) && value.type === "reset" &&
      (value.reason === "routing-change" || value.reason === "messages-lost")) {
    return { type: "reset", reason: value.reason };
  }
  if (exact(value, ["type", "id", "opcode", "source", "target", "physicalAddress", "decision", "acknowledgement"]) &&
      value.type === "routing" && integer(value.id, Number.MAX_SAFE_INTEGER, 1) &&
      integer(value.opcode, 255) && [0x80, 0x81, 0x82, 0x86, 0x36, 0x9d].includes(value.opcode) &&
      integer(value.source, 15) && integer(value.target, 15) &&
      (value.physicalAddress === null || integer(value.physicalAddress, 65535))) {
    const decision = CEC_ROUTE_DECISIONS.find((item) => item === value.decision);
    const acknowledgement = CEC_ROUTE_ACKNOWLEDGEMENTS.find((item) => item === value.acknowledgement);
    if (decision && acknowledgement) return {
      type: "routing", id: value.id, opcode: value.opcode, source: value.source, target: value.target,
      physicalAddress: value.physicalAddress, decision, acknowledgement,
    };
  }
  if (exact(value, ["type", "id", "ok"]) && value.type === "result" &&
      integer(value.id, Number.MAX_SAFE_INTEGER, 1) && typeof value.ok === "boolean") {
    return { type: "result", id: value.id, ok: value.ok };
  }
  return null;
}

/** One persistent, opt-in adapter owner. Ownership here never authorizes TV standby. */
export class NativeCecController implements RemoteSource {
  private readonly options: { enabled: boolean; device: string };
  private readonly dependencies: Required<NativeCecDependencies>;
  private readonly listeners = new Set<(signal: RemoteSignal) => void>();
  private readonly input: CecInputNormalizer;
  private readonly remote: CecRemoteStatus;
  private message: string;
  private transport?: Transport;
  private startTask?: Promise<void>;
  private closeTask?: Promise<void>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, Pending>();

  constructor(options: { enabled: boolean; device: string }, dependencies: NativeCecDependencies = {}) {
    this.options = { ...options };
    this.dependencies = {
      spawn: dependencies.spawn ?? ((executable, args, spawnOptions) => spawn(executable, args, spawnOptions)),
      validateRuntime: dependencies.validateRuntime ?? validateRuntime,
      monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
      wallNow: dependencies.wallNow ?? Date.now,
      random: dependencies.random ?? Math.random,
    };
    this.remote = {
      enabled: options.enabled, listening: false,
      device: options.device.length <= 128 && DEVICE.test(options.device) ? options.device : "(invalid)",
      logicalAddress: null, physicalAddress: null, lastEvent: null, lastRouting: null, kioskConnected: false,
    };
    this.message = options.enabled ? "Native CEC not started; no power actions sent." : "CEC disabled.";
    this.input = new CecInputNormalizer({
      logicalAddress: null, monotonicNow: this.dependencies.monotonicNow,
      onSignal: (signal) => {
        if (signal.type === "action") {
          this.remote.lastEvent = { key: signal.action.key, at: this.dependencies.wallNow() };
        }
        this.emit(signal);
      },
    });
  }

  status(): CecStatus {
    return {
      enabled: this.options.enabled, available: this.remote.listening, owned: false, message: this.message,
      remote: {
        ...this.remote, lastEvent: this.remote.lastEvent ? { ...this.remote.lastEvent } : null,
        lastRouting: this.remote.lastRouting ? { ...this.remote.lastRouting } : null,
      },
    };
  }

  start(): Promise<void> {
    if (!this.startTask) {
      this.startTask = this.closed || !this.options.enabled ? Promise.resolve() : this.connect();
    }
    return this.startTask;
  }

  onRemote(listener: (signal: RemoteSignal) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  resetRemote(): void {
    this.input.resetRemote();
  }

  execute(command: CecCommand): Promise<CecStatus> {
    const refused = (message: string) => Promise.resolve({ ...this.status(), message });
    if (this.closed) return refused("Native CEC controller closed.");
    if (!this.options.enabled) return refused("CEC disabled.");
    if (command === "standby") return refused("Standby unsupported: native CEC never verifies active-source ownership.");
    if (command !== "wake" && command !== "active-source") return refused("Unsupported CEC command.");
    const transport = this.transport;
    if (!transport?.ready || transport.stopping || !this.remote.listening) {
      return refused(this.message);
    }
    if (this.pending.size >= 16) return refused("CEC queue busy; retry after pending requests finish.");
    if (!Number.isSafeInteger(this.nextId)) {
      this.fail(transport, "protocol");
      return refused(this.message);
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.fail(transport, "timeout"), 6_000);
      this.pending.set(id, { timer, resolve, command });
      try {
        transport.child.stdin.write(JSON.stringify({ id, command }) + "\n");
      } catch {
        this.fail(transport, "disconnected");
      }
    });
  }

  close(): Promise<void> {
    if (!this.closeTask) {
      this.closed = true;
      clearTimeout(this.reconnect);
      this.reconnect = undefined;
      this.closeTask = this.closeTransport();
    }
    return this.closeTask;
  }

  private async closeTransport(): Promise<void> {
    this.message = "Native CEC controller closed.";
    this.resetTransport();
    this.finishPending();
    const transport = this.transport;
    if (transport) {
      transport.retry = false;
      this.stop(transport);
      if (await transport.completion === "stuck") {
        throw new Error("Native CEC helper did not close after SIGKILL; no replacement process will be started." + RECOVERY);
      }
    }
    await this.startTask;
  }

  private async connect(): Promise<void> {
    if (this.closed || this.transport) return;
    if (this.remote.device === "(invalid)") {
      this.message = ERRORS["invalid-device"];
      return;
    }
    this.message = "Native CEC starting; no power actions sent.";
    try {
      await this.dependencies.validateRuntime();
      if (this.closed || this.transport) return;
      const child = this.dependencies.spawn(EXECUTABLE, ["-I", "-u", HELPER, "--device", this.options.device], {
        shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      });
      let finish!: Transport["finish"];
      const completion = new Promise<"closed" | "stuck">((resolve) => { finish = resolve; });
      const transport: Transport = {
        child, ready: false, stopping: false, retry: false, forced: false, closed: false, stuck: false,
        buffers: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
        output: [], outputBytes: 0, completion, finish,
      };
      this.transport = transport;
      child.on("error", (error: unknown) => this.fail(transport, runtimeFailure(error)));
      child.on("close", (_code: number | null, signal?: string | null) => this.didClose(transport, signal));
      child.stdin.on("error", () => this.fail(transport, "disconnected"));
      child.stdout.on("error", () => this.fail(transport, "disconnected"));
      child.stderr.on("error", () => this.fail(transport, "disconnected"));
      child.stdout.on("data", (data: Buffer) => this.collect(transport, "stdout", data));
      child.stderr.on("data", (data: Buffer) => this.collect(transport, "stderr", data));
      transport.startup = setTimeout(() => this.fail(transport, "startup"), 12_000);
    } catch (error) {
      if (!this.closed) {
        this.message = ERRORS[runtimeFailure(error)];
        this.resetTransport();
      }
    }
  }

  private emit(signal: RemoteSignal): void {
    for (const listener of [...this.listeners]) {
      // Consumer failures must not escape a child-process event handler.
      try { listener(signal); } catch { /* The transport remains fail-safe. */ }
    }
  }

  private resetTransport(): void {
    if (this.remote.lastRouting?.acknowledgement === "pending") {
      this.remote.lastRouting = { ...this.remote.lastRouting, acknowledgement: "cancelled" };
    }
    this.remote.listening = false;
    this.remote.logicalAddress = null;
    this.remote.physicalAddress = null;
    this.input.setLogicalAddress(null);
    this.emit({ type: "reset" });
  }

  private finishPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(this.status());
    }
    this.pending.clear();
  }

  private collect(transport: Transport, stream: "stdout" | "stderr", data: Buffer): void {
    if (transport.closed || transport.stuck || this.transport !== transport) return;
    if (!Buffer.isBuffer(data)) {
      this.fail(transport, "protocol");
      return;
    }
    const now = this.dependencies.monotonicNow();
    let expired = 0;
    while (expired < transport.output.length && now - transport.output[expired]!.at >= 1_000) {
      transport.outputBytes -= transport.output[expired++]!.bytes;
    }
    if (expired) transport.output.splice(0, expired);
    transport.outputBytes += data.length;
    if (transport.outputBytes > 65_536) {
      this.fail(transport, "output");
      return;
    }
    if (data.length) transport.output.push({ at: now, bytes: data.length });
    const buffer = Buffer.concat([transport.buffers[stream], data]);
    let start = 0;
    for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
      if (end - start > 1_024) {
        this.fail(transport, "output");
        return;
      }
      let line: string;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(start, end));
      } catch {
        this.fail(transport, "protocol");
        return;
      }
      start = end + 1;
      if (stream === "stdout") this.line(transport, line);
      if (transport.closed || transport.stuck) return;
    }
    if (buffer.length - start > 1_024) {
      this.fail(transport, "output");
      return;
    }
    transport.buffers[stream] = Buffer.from(buffer.subarray(start));
  }

  private line(transport: Transport, line: string): void {
    let value: HelperEvent | null;
    try { value = parseEvent(line); } catch {
      this.fail(transport, "protocol");
      return;
    }
    if (value === null) {
      this.fail(transport, "protocol");
      return;
    }
    if (value.type === "error") {
      this.fail(transport, value.code);
      return;
    }
    if (transport.stopping) return;
    if (value.type === "ready") {
      if (transport.ready) {
        this.fail(transport, "protocol");
        return;
      }
      clearTimeout(transport.startup);
      transport.ready = true;
      this.remote.listening = true;
      this.remote.logicalAddress = value.logicalAddress;
      this.remote.physicalAddress = value.physicalAddress;
      this.remote.lastRouting = null;
      this.input.setLogicalAddress(value.logicalAddress);
      this.message = "Native CEC listening; no TV power or active-source ownership is assumed.";
      transport.stable = setTimeout(() => { this.attempts = 0; }, 30_000);
      return;
    }
    if (!transport.ready) {
      this.fail(transport, "protocol");
      return;
    }
    if (value.type === "packet") {
      this.input.accept(value);
      return;
    }
    if (value.type === "routing") {
      const previous = this.remote.lastRouting;
      if (previous && (value.id < previous.id || (value.id === previous.id &&
          (value.opcode !== previous.opcode || value.source !== previous.source || value.target !== previous.target ||
           value.physicalAddress !== previous.physicalAddress || value.decision !== previous.decision)))) {
        this.fail(transport, "protocol");
        return;
      }
      const { type: _type, ...routing } = value;
      this.remote.lastRouting = {
        ...routing, at: previous?.id === value.id ? previous.at : this.dependencies.wallNow(),
      };
      return;
    }
    if (value.type === "reset") {
      this.resetRemote();
      this.emit({ type: "reset" });
      return;
    }
    if (value.type === "result") {
      const pending = this.pending.get(value.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(value.id);
        this.message = value.ok
          ? (pending.command === "wake" ? "Wake request sent; TV power is not verified."
            : "Active-source request sent; TV routing and ownership are not verified.")
          : "Native CEC transmission failed; request not replayed.";
        pending.resolve(this.status());
        return;
      }
    }
    this.fail(transport, "protocol");
  }

  private fail(transport: Transport, failure: Failure): void {
    if (this.transport !== transport || transport.closed || transport.stuck) return;
    if (transport.stopping) {
      if (failure === "adapter-removed" && transport.retry) {
        transport.failure = failure;
        this.message = ERRORS[failure];
      }
      if (failure === "cleanup-failed" || failure === "registration-present" ||
          (!RETRY.has(failure) && (!transport.failure || RETRY.has(transport.failure)))) {
        transport.retry = false;
        transport.failure = failure;
        this.message = ERRORS[failure];
      }
      return;
    }
    transport.failure = failure;
    this.message = ERRORS[failure];
    transport.retry = !this.closed && RETRY.has(failure);
    this.resetTransport();
    this.finishPending();
    this.stop(transport);
  }

  private stop(transport: Transport): void {
    if (transport.stopping || transport.closed) return;
    transport.stopping = true;
    clearTimeout(transport.startup);
    clearTimeout(transport.stable);
    // EOF and TERM both request helper cleanup; only close releases the process slot.
    try { transport.child.stdin.end(); } catch { /* TERM remains available. */ }
    if (transport.closed) return;
    try { transport.child.kill("SIGTERM"); } catch { /* Escalate on the bounded deadline. */ }
    if (transport.closed) return;
    transport.terminate = setTimeout(() => {
      transport.forced = true;
      this.message += RECOVERY;
      try { transport.child.kill("SIGKILL"); } catch { /* Still wait for actual close. */ }
      if (transport.closed) return;
      transport.deadline = setTimeout(() => {
        transport.stuck = true;
        transport.retry = false;
        this.message = "Native CEC helper did not close after SIGKILL; replacement disabled." + RECOVERY;
        transport.finish("stuck");
      }, 2_000);
    }, 2_000);
  }

  private didClose(transport: Transport, signal?: string | null): void {
    if (transport.closed || this.transport !== transport) return;
    transport.closed = true;
    for (const timer of [transport.startup, transport.stable, transport.terminate, transport.deadline]) {
      clearTimeout(timer);
    }
    if (!transport.stopping) {
      this.message = transport.buffers.stdout.length ? ERRORS.protocol : ERRORS.disconnected;
      transport.retry = !this.closed && !transport.buffers.stdout.length;
      if (signal || transport.ready) this.message += RECOVERY;
      this.resetTransport();
      this.finishPending();
    }
    transport.buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    transport.output = [];
    this.transport = undefined;
    transport.finish("closed");
    if (transport.retry && !transport.stuck && !this.closed) {
      const base = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts++, 5));
      const random = Math.max(0, Math.min(1, this.dependencies.random()));
      const delay = Math.min(30_000, base * (1 + random * 0.25));
      this.reconnect = setTimeout(() => {
        this.reconnect = undefined;
        void this.connect();
      }, delay);
    }
  }
}
