import { afterEach, expect, it, vi } from "vitest";
import { AlbumCatalogFallback, fallbackEligibility } from "../src/server/album-catalog-fallback.js";
import type { OriginalAlbumContext } from "../src/server/album-editions.js";
const original: OriginalAlbumContext = {
  sourceId: "a".repeat(64), albumKey: `${"b".repeat(32)}-1`,
  success: { boot_id: "b".repeat(32), generation: 1, at_ms: 1000 },
  album: { title: "Test", artist: "Artist", catalog: null, artwork: null },
};
const none = () => ({ state: "no-match" as const, message: "Choose a release.", retryAt: null, candidates: [] });
const workers: AlbumCatalogFallback[] = [];
afterEach(() => { workers.splice(0).forEach((worker) => worker.close()); vi.useRealTimers(); });
async function setup(resolve = vi.fn(async (_original: OriginalAlbumContext, _signal: AbortSignal) => none())) {
  let disk: unknown = null;
  const store = { read: vi.fn(async () => disk), save: vi.fn(async (value: unknown) => { disk = structuredClone(value); }) };
  const worker = new AlbumCatalogFallback(1000, store, resolve); workers.push(worker); await worker.init();
  return { worker, store, resolve };
}
it("persists one automatic eligibility attempt despite repeated status polling and restart", async () => {
  const { worker, store, resolve } = await setup();
  for (let index = 0; index < 100; index++) worker.observe(original, true, true);
  await vi.waitFor(() => expect(worker.view(original).state).toBe("no-match"));
  expect(resolve).toHaveBeenCalledOnce();
  const restored = new AlbumCatalogFallback(1000, store, resolve); workers.push(restored); await restored.init();
  for (let index = 0; index < 100; index++) restored.observe(original, true, true);
  expect(resolve).toHaveBeenCalledOnce();
});
it("does not automatically fetch offline but explicitly retries cached bound metadata", async () => {
  const { worker, resolve } = await setup();
  worker.observe(original, true, false);
  expect(resolve).not.toHaveBeenCalled();
  expect(await worker.retry(original)).toEqual(none());
  expect(resolve).toHaveBeenCalledOnce();
});
it("requires durable attempt state before dispatch and surfaces storage failure", async () => {
  const { worker, store, resolve } = await setup();
  store.save.mockRejectedValue(new Error("disk"));
  worker.observe(original, true, true);
  await vi.waitFor(() => expect(worker.view(original).message).toMatch(/storage/));
  expect(resolve).not.toHaveBeenCalled();
});
it("a new genuine success allows another attempt while polling does not", async () => {
  const { worker, resolve } = await setup();
  worker.observe(original, true, true);
  await vi.waitFor(() => expect(worker.view(original).state).toBe("no-match"));
  worker.observe({ ...original, success: { ...original.success!, generation: 2 } }, true, true);
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
});
it("persists transient backoff across restart and does not retry on every poll", async () => {
  const { worker, store, resolve } = await setup(vi.fn(async () => { throw new Error("outage"); }));
  worker.observe(original, true, true);
  await vi.waitFor(() => expect(worker.view(original).state).toBe("unavailable"));
  expect(worker.view(original).retryAt).toBeGreaterThan(Date.now());
  const restored = new AlbumCatalogFallback(1000, store, resolve); workers.push(restored); await restored.init();
  restored.observe(original, true, true);
  await expect(restored.retry(original)).rejects.toThrow();
  expect(resolve).toHaveBeenCalledOnce();
});
it("offline polling does not abort a deliberate cached-metadata retry", async () => {
  let finish!: () => void;
  let signal!: AbortSignal;
  const { worker } = await setup(vi.fn(async (_original: OriginalAlbumContext, abort: AbortSignal) => {
    signal = abort;
    await new Promise<void>((resolve) => { finish = resolve; });
    return none();
  }));
  worker.observe(original, true, false);
  const retry = worker.retry(original);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  worker.observe(original, false, false);
  expect(signal.aborted).toBe(false);
  finish(); await retry;
});
it("restores an interrupted attempt as an explicit recoverable state without restarting it", async () => {
  const storage = {
    read: async () => ({ version: 1, sourceUid: 1000, entries: [{
      key: fallbackEligibility(original, 1000), attempts: 1, updatedAt: Date.now(),
      status: { state: "loading", message: "Loading", retryAt: null, candidates: [] },
    }] }),
    save: vi.fn(async () => {}),
  };
  const resolve = vi.fn(async () => none());
  const worker = new AlbumCatalogFallback(1000, storage, resolve); workers.push(worker);
  await worker.init();
  expect(worker.observe(original, true, true)).toMatchObject({ state: "unavailable", message: expect.stringMatching(/interrupted/) });
  expect(resolve).not.toHaveBeenCalled();
});
