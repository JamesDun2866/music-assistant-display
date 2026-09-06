import { describe, expect, it, vi } from "vitest";
import { CecInputNormalizer, type CecLogicalAddress, type CecPacket } from "../src/server/cec-input.js";
import type { RemoteSignal } from "../src/shared/remote.js";

function fixture(address: CecLogicalAddress = 4) {
  let elapsed = 0;
  const signals: RemoteSignal[] = [];
  const input = new CecInputNormalizer({ logicalAddress: address, monotonicNow: () => elapsed, onSignal: (s) => signals.push(s) });
  const packet = (message: number[], metadata: Partial<CecPacket> = {}) =>
    input.accept({ message, sequence: 0, txStatus: 0, rxStatus: 1, ...metadata });
  return {
    input, packet, signals,
    advance: (ms: number) => { elapsed += ms; },
    press: (code = 1, source = 0, target: number = address) => packet([(source << 4) | target, 0x44, code]),
    release: (source = 0, target: number = address) => packet([(source << 4) | target, 0x45]),
    actions: () => signals.filter((s) => s.type === "action").map((s) => s.action),
  };
}

describe("native CEC input normalization (synthetic bus frames only)", () => {
  it("uses monotonic time by default across wall-clock corrections, including lease tombstones", () => {
    let elapsed = 0;
    let wall = 1_700_000_000_000;
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const epoch = vi.spyOn(Date, "now").mockImplementation(() => wall);
    try {
      const signal = vi.fn();
      const input = new CecInputNormalizer({ logicalAddress: 4, onSignal: signal });
      const packet = (message: number[]) => input.accept({ message, sequence: 0, txStatus: 0, rxStatus: 1 });
      for (const code of [0, 0x0d]) {
        packet([4, 0x44, code]);
        const actions = signal.mock.calls.length;
        for (const jump of [3_600_000, -7_200_000]) {
          wall += jump; elapsed += 100;
          packet([4, 0x44, code]);
          expect(signal).toHaveBeenCalledTimes(actions);
        }
        input.resetRemote();
        wall += 7_200_000; elapsed += 100;
        packet([4, 0x44, code]);
        expect(signal).toHaveBeenCalledTimes(actions);
        packet([4, 0x45]);
      }
      packet([4, 0x44, 1]);
      wall -= 7_200_000; elapsed += 449;
      packet([4, 0x44, 1]);
      expect(signal).toHaveBeenCalledTimes(3);
      elapsed += 1;
      packet([4, 0x44, 1]);
      expect(signal).toHaveBeenLastCalledWith({ type: "action", action: { key: "up", repeat: true } });
      expect(signal).toHaveBeenCalledTimes(4);
      wall += 7_200_000; elapsed += 701;
      packet([4, 0x44, 1]);
      expect(signal).toHaveBeenLastCalledWith({ type: "action", action: { key: "up", repeat: false } });
      expect(signal).toHaveBeenCalledTimes(5);
    } finally {
      monotonic.mockRestore();
      epoch.mockRestore();
    }
  });

  it.each([[0, "select"], [1, "up"], [2, "down"], [3, "left"], [4, "right"], [0x0d, "back"]])(
    "maps user-control code %s to %s", (code, key) => {
      const f = fixture();
      f.press(code as number);
      expect(f.actions()).toEqual([{ key, repeat: false }]);
    },
  );

  it.each([4, 8, 11] as const)("accepts only this claimed address (%s), not other players or broadcast", (address) => {
    const f = fixture(address);
    for (const target of [0, 1, 4, 8, 11, 15].filter((n) => n !== address)) f.press(1, 0, target);
    for (const source of [1, 2, 3, 4, 6, 8, 11, 15]) f.press(1, source);
    expect(f.actions()).toEqual([]);
    f.press(1, 0);
    f.press(2, 5);
    expect(f.actions()).toEqual([{ key: "up", repeat: false }, { key: "down", repeat: false }]);
  });

  it.each([
    { sequence: 1 }, { sequence: 0xffffffff }, { txStatus: 1 }, { txStatus: 0x80 },
    { rxStatus: 0 }, { rxStatus: 2 }, { rxStatus: 3 }, { rxStatus: 0xff },
  ])("ignores outgoing, queued, failed, and ambiguous metadata %j", (metadata) => {
    const f = fixture();
    f.packet([4, 0x44, 1], metadata);
    expect(f.signals).toEqual([]);
  });

  it("rejects malformed lengths, unknown keys, backward, and invalid bytes", () => {
    const f = fixture();
    for (const message of [
      [], [4], [4, 0x44], [4, 0x44, 1, 0], [4, 0x45, 0], [4, 0x44, 0x4c],
      [4, 0x44, 0x41], [4, 0x44, 256], [4, 0x44, -1], [4, 0x44, 1.5],
      Array.from({ length: 17 }, () => 0),
    ]) f.packet(message);
    expect(f.signals).toEqual([]);
  });

  it("repeats directions only on actual frames after 450ms, at most once per 120ms", () => {
    const f = fixture();
    f.press();
    f.advance(449); f.press();
    expect(f.actions()).toHaveLength(1);
    f.advance(1); f.press();
    f.advance(119); f.press();
    expect(f.actions()).toHaveLength(2);
    f.advance(1); f.press();
    expect(f.actions()).toEqual([
      { key: "up", repeat: false }, { key: "up", repeat: true }, { key: "up", repeat: true },
    ]);
    f.advance(60_000);
    expect(f.actions()).toHaveLength(3);
    f.press();
    expect(f.actions().at(-1)).toEqual({ key: "up", repeat: false });
  });

  it.each([0, 0x0d])("suppresses select/back (%s) throughout a continuous hold, even over 700ms", (key) => {
    const f = fixture();
    f.press(key);
    for (let n = 0; n < 30; n++) { f.advance(100); f.press(key); }
    expect(f.actions()).toHaveLength(1);
    f.advance(700); f.press(key);
    expect(f.actions()).toHaveLength(1);
    f.advance(701); f.press(key);
    expect(f.actions()).toHaveLength(2);
    expect(f.actions().every((action) => !action.repeat)).toBe(true);
    f.release(); f.press(key);
    expect(f.actions()).toHaveLength(3);
  });

  it("tracks TV and AVR independently and only matching releases clear their held key", () => {
    const f = fixture();
    f.press(0, 0);
    f.press(0, 5);
    f.release(0, 8);
    f.release(1);
    f.press(0, 0);
    expect(f.actions()).toHaveLength(2);
    f.release(5);
    f.press(0, 0);
    f.press(0, 5);
    expect(f.actions()).toHaveLength(3);
    f.release(0); f.press(0, 0);
    expect(f.actions()).toHaveLength(4);
  });

  it("unsupported keys clear only the matching source/destination, without an action", () => {
    const f = fixture();
    f.press(0);
    f.press(0x4c, 5);
    f.press(0x4c, 0, 8);
    f.press(0);
    expect(f.actions()).toHaveLength(1);
    f.press(0x4c);
    f.press(0);
    expect(f.actions()).toHaveLength(2);
  });

  it("allows a changed direction to begin a fresh press", () => {
    const f = fixture();
    f.press(1);
    f.advance(100);
    f.press(2);
    expect(f.actions()).toEqual([{ key: "up", repeat: false }, { key: "down", repeat: false }]);
    f.advance(450); f.press(2);
    expect(f.actions().at(-1)).toEqual({ key: "down", repeat: true });
  });

  it("lease reset emits no reset event and tombstones held input until release or silence", () => {
    const f = fixture();
    f.press();
    f.input.resetRemote();
    for (let n = 0; n < 20; n++) { f.advance(100); f.press(); }
    f.press(2);
    f.press(0x4c);
    f.press(0);
    expect(f.signals).toHaveLength(1);
    f.release(); f.press();
    expect(f.actions()).toHaveLength(2);
    f.input.resetRemote();
    f.advance(701); f.press();
    expect(f.actions()).toHaveLength(3);
    expect(f.actions().at(-1)?.repeat).toBe(false);
  });

  it.each([
    [0x80, 0x10, 0, 0x20, 0], [0x81, 0x10, 0], [0x82, 0x10, 0], [0x86, 0x10, 0], [0x36],
  ])("routing/standby resets suppress existing holds but never creates an action: %j", (...body) => {
    const f = fixture();
    f.press();
    f.packet([0x0f, ...body]);
    expect(f.signals.at(-1)).toEqual({ type: "reset" });
    f.advance(500); f.press();
    expect(f.actions()).toHaveLength(1);
    f.release(); f.press();
    expect(f.actions()).toHaveLength(2);
  });

  it("does not let other initiators, outgoing frames, or malformed routing messages reset a hold", () => {
    const f = fixture();
    f.press();
    f.packet([0x4f, 0x36]);
    f.packet([0x0f, 0x82, 0x10]);
    f.packet([0x08, 0x36]);
    f.packet([0x0f, 0x36], { sequence: 1 });
    f.advance(450); f.press();
    expect(f.signals).toEqual([
      { type: "action", action: { key: "up", repeat: false } },
      { type: "action", action: { key: "up", repeat: true } },
    ]);
  });

  it("another playback device becoming active clears held state, but cannot produce keys or standby", () => {
    const f = fixture();
    f.press();
    f.packet([0x8f, 0x36]);
    f.packet([0x84, 0x44, 0]);
    expect(f.signals).toHaveLength(1);
    f.packet([0x8f, 0x82, 0x20, 0]);
    expect(f.signals.at(-1)).toEqual({ type: "reset" });
    f.advance(450); f.press();
    expect(f.actions()).toHaveLength(1);
  });

  it("cannot emit while disconnected and preserves known-held suppression across address changes", () => {
    const f = fixture();
    f.press();
    f.input.setLogicalAddress(null);
    f.press();
    f.input.setLogicalAddress(8);
    f.advance(450); f.press(1, 0, 8);
    expect(f.actions()).toHaveLength(1);
    f.release(0, 8); f.press(1, 0, 8);
    expect(f.actions()).toHaveLength(2);
  });
});
