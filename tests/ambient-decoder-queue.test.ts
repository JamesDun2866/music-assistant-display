import * as processes from "node:child_process";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { decodeAmbientImage } from "../src/server/ambient-decoder.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => vi.restoreAllMocks());

it("shares one native worker between uploads and previews and skips cancelled queued work", async () => {
  const input = await sharp({ create: { width: 3840, height: 2160, channels: 3, background: "#456789" } }).jpeg().toBuffer();
  const spawn = vi.mocked(processes.spawn);
  const { spawn: original } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let active = 0;
  let peak = 0;
  spawn.mockImplementation((...args) => {
    const child = original(...args);
    peak = Math.max(peak, ++active);
    child.once("close", () => active--);
    return child;
  });
  const controller = new AbortController();
  const upload = decodeAmbientImage(input, "image/jpeg");
  const cancelled = decodeAmbientImage(input, "image/jpeg", controller.signal);
  const preview = decodeAmbientImage(input, "image/jpeg", undefined, true);
  const rejected = expect(cancelled).rejects.toMatchObject({ status: 408 });
  controller.abort();
  const [canonical, thumbnail] = await Promise.all([upload, preview, rejected]);
  expect([canonical.width, canonical.height]).toEqual([3840, 2160]);
  expect([thumbnail.width, thumbnail.height]).toEqual([480, 270]);
  expect(peak).toBe(1);
  expect(active).toBe(0);
  expect(spawn).toHaveBeenCalledTimes(2);
  const activeController = new AbortController();
  let stopped: ReturnType<typeof processes.spawn> | undefined;
  spawn.mockImplementationOnce((...args) => {
    stopped = original(...args);
    queueMicrotask(() => activeController.abort());
    return stopped;
  });
  await expect(decodeAmbientImage(input, "image/jpeg", activeController.signal)).rejects.toMatchObject({ status: 408 });
  expect(stopped?.killed).toBe(true);
  expect((await decodeAmbientImage(input, "image/jpeg", undefined, true)).width).toBe(480);
});
