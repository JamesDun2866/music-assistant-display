import type { RemoteKey, RemoteSignal } from "../shared/remote.js";

export interface CecPacket {
  message: number[];
  sequence: number;
  txStatus: number;
  rxStatus: number;
}

export type CecLogicalAddress = 4 | 8 | 11;

const KEYS = new Map<number, RemoteKey>([
  [0x00, "select"], [0x01, "up"], [0x02, "down"],
  [0x03, "left"], [0x04, "right"], [0x0d, "back"],
]);
const ROUTING_LENGTHS = new Map([[0x80, 6], [0x81, 4], [0x82, 4], [0x86, 4], [0x36, 2]]);
const HELD_TIMEOUT = 700;

interface HeldKey {
  key: RemoteKey;
  pressedAt: number;
  lastSeen: number;
  lastAction: number;
  suppressed: boolean;
}

/** Normalizes received bus frames only; timers never manufacture remote actions. */
export class CecInputNormalizer {
  private readonly held = new Map<number, HeldKey>();
  private logicalAddress: CecLogicalAddress | null;
  private readonly monotonicNow: () => number;

  constructor(private readonly options: {
    logicalAddress: CecLogicalAddress | null;
    onSignal: (signal: RemoteSignal) => void;
    monotonicNow?: () => number;
  }) {
    this.logicalAddress = options.logicalAddress;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  setLogicalAddress(address: CecLogicalAddress | null): void {
    this.resetRemote();
    this.logicalAddress = address;
  }

  /** Keep tombstones across lease changes so an ongoing hold cannot operate a new page. */
  resetRemote(): void {
    for (const held of this.held.values()) held.suppressed = true;
  }

  accept(packet: CecPacket): void {
    const { message, sequence, txStatus, rxStatus } = packet;
    if (this.logicalAddress === null || sequence !== 0 || txStatus !== 0 || rxStatus !== 1 ||
        message.length < 1 || message.length > 16 ||
        !message.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return;

    const source = message[0]! >> 4;
    const target = message[0]! & 15;
    const opcode = message[1];
    if (opcode === undefined) return;
    const routingSource = opcode === 0x36 ? source === 0 || source === 5
      : source !== this.logicalAddress && source !== 15;
    if (routingSource && (target === this.logicalAddress || target === 15) &&
        ROUTING_LENGTHS.get(opcode) === message.length) {
      this.resetRemote();
      this.options.onSignal({ type: "reset" });
      return;
    }
    if (source !== 0 && source !== 5) return;
    if (target !== this.logicalAddress) return;
    if (opcode === 0x45 && message.length === 2) {
      this.held.delete(source);
      return;
    }
    if (opcode !== 0x44 || message.length !== 3) return;

    const now = this.monotonicNow();
    let held = this.held.get(source);
    if (held && now - held.lastSeen > HELD_TIMEOUT) {
      this.held.delete(source);
      held = undefined;
    }
    // Even unsupported/changed keys cannot bypass a lease-reset tombstone.
    if (held?.suppressed) {
      held.lastSeen = now;
      return;
    }
    const key = KEYS.get(message[2]!);
    if (key === undefined) {
      this.held.delete(source);
      return;
    }
    if (!held || held.key !== key) {
      this.held.set(source, { key, pressedAt: now, lastSeen: now, lastAction: now, suppressed: false });
      this.options.onSignal({ type: "action", action: { key, repeat: false } });
      return;
    }
    held.lastSeen = now;
    if (key === "select" || key === "back" || now - held.pressedAt < 450 || now - held.lastAction < 120) return;
    held.lastAction = now;
    this.options.onSignal({ type: "action", action: { key, repeat: true } });
  }
}
