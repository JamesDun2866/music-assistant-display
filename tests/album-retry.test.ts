import { createServer, type Server } from "node:net";
import { chmod, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { retryAlbum } from "../src/server/album-retry.js";

const binding = { source_id: "a".repeat(64), boot_id: "b".repeat(32), generation: 9 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(response = '{"ok":true}\n') {
  const directory = await mkdtemp(path.join(process.cwd(), ".retry-"));
  await chmod(directory, 0o2750);
  const messages: unknown[] = [];
  const server: Server = createServer((client) => {
    client.once("data", (data) => {
      messages.push(JSON.parse(data.toString()));
      client.end(response);
    });
  });
  const file = path.join(directory, "retry.sock");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, resolve);
  });
  await chmod(file, 0o660);
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file, uid: (await lstat(directory)).uid, messages };
}

it.skipIf(process.platform === "win32")("sends only the fixed bound retry command through a source-owned shared socket", async () => {
  const value = await fixture();
  await retryAlbum(binding, value.uid, value.directory);
  expect(value.messages).toEqual([{ command: "recognition-retry", ...binding }]);
  await expect(retryAlbum(binding, value.uid + 1, value.directory)).rejects.toThrow("Unsafe");
  expect(value.messages).toHaveLength(1);
});

it.skipIf(process.platform === "win32")("rejects writable paths, broad socket access and symlink substitution before mutation", async () => {
  const value = await fixture();
  await chmod(value.file, 0o666);
  await expect(retryAlbum(binding, value.uid, value.directory)).rejects.toThrow("Unsafe");
  await chmod(value.file, 0o660);
  await chmod(value.directory, 0o2770);
  await expect(retryAlbum(binding, value.uid, value.directory)).rejects.toThrow("Unsafe");
  await chmod(value.directory, 0o2750);
  const link = path.join(value.directory, "link");
  await symlink(value.directory, link);
  await expect(retryAlbum(binding, value.uid, link)).rejects.toThrow("Unsafe");
  expect(value.messages).toEqual([]);
});

it.skipIf(process.platform === "win32")("propagates useful busy/off/rate errors and bounds malformed source responses", async () => {
  for (const message of ["Recognition is busy.", "Recognition is off.", "Retry is rate limited."]) {
    const value = await fixture(`${JSON.stringify({ ok: false, error: message })}\n`);
    await expect(retryAlbum(binding, value.uid, value.directory)).rejects.toThrow(message);
    expect(value.messages).toHaveLength(1);
  }
  for (const response of ['{"ok":"true"}\n', "invalid\n", "x".repeat(1025), ""]) {
    const value = await fixture(response);
    await expect(retryAlbum(binding, value.uid, value.directory)).rejects.toThrow(/Invalid|disconnected/);
  }
});

it("rejects arbitrary mutation fields before attempting any socket I/O", async () => {
  await expect(retryAlbum({ ...binding, command: "record-start" } as typeof binding, 123)).rejects.toThrow();
});
