import { afterEach, expect, it, vi } from "vitest";
import { ArtworkStore } from "../src/server/artwork.js";

afterEach(() => vi.unstubAllGlobals());
it("requires explicit Spotify artwork opt-in and source before accepting canonical covers", async () => {
  const cover = `https://i.scdn.co/image/${"a".repeat(40)}`;
  const disabled = new ArtworkStore("http://ma.example");
  const enabled = new ArtworkStore("http://ma.example", true);
  const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([255, 216, 255, 217]), {
    headers: { "Content-Type": "image/jpeg" },
  }));
  vi.stubGlobal("fetch", fetcher);
  expect(disabled.setFromPlayerUrl("track", cover, true)).toBeNull();
  expect(enabled.setFromPlayerUrl("track", cover, false)).toBeNull();
  expect(await disabled.get("track", new AbortController().signal)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(enabled.setFromPlayerUrl("track", cover, true)).toBe(`/api/artwork/track?v=spotify-${"a".repeat(40)}`);
  expect((await enabled.get("track", new AbortController().signal))?.contentType).toBe("image/jpeg");
  expect(fetcher.mock.calls[0]?.[0]).toBe(cover);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
  });
  expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  await enabled.get("track", new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("refuses alternate Spotify hosts, credentials, ports, queries and non-cover paths", () => {
  const store = new ArtworkStore("http://ma.example", true);
  const id = "a".repeat(40);
  for (const raw of [
    `http://i.scdn.co/image/${id}`, `https://i.scdn.co.evil.example/image/${id}`,
    `https://i.scdn.co@evil.example/image/${id}`, `https://user:secret@i.scdn.co/image/${id}`,
    `https://i.scdn.co:8443/image/${id}`, `https://i.scdn.co/image/${id}?token=private`,
    `https://i.scdn.co/image/${id}#fragment`, `https://i.scdn.co/other/${id}`,
    `https://i.scdn.co/image/../image/${id}`, "http://127.0.0.1/private", "file:///private",
  ]) expect(store.setFromPlayerUrl("track", raw, true)).toBeNull();
});
it("keeps Spotify artwork bounded and rejects bad responses without following redirects", async () => {
  const store = new ArtworkStore("http://ma.example", true);
  store.setFromPlayerUrl("track", `https://i.scdn.co/image/${"a".repeat(40)}`, true);
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } }))
    .mockResolvedValueOnce(new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }))
    .mockResolvedValueOnce(new Response("<html/>", { headers: { "Content-Type": "image/jpeg" } }))
    .mockResolvedValueOnce(new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { "Content-Type": "image/jpeg" } }))
    .mockRejectedValueOnce(new Error("request_aborted"));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  expect(await store.get("track", signal)).toBeNull();
  await expect(store.get("track", signal)).rejects.toThrow("artwork_request_failed");
  await expect(store.get("track", signal)).rejects.toThrow("unsupported_artwork_type");
  await expect(store.get("track", signal)).rejects.toThrow("invalid_artwork_signature");
  await expect(store.get("track", signal)).rejects.toThrow("artwork_too_large");
  await expect(store.get("track", signal)).rejects.toThrow("request_aborted");
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(fetcher.mock.calls.every((call) => call[1].redirect === "error")).toBe(true);
});
it("extracts external player artwork only from this MA server's bounded proxy route", () => {
  const artwork = new ArtworkStore("http://ma.example/base");
  const id = "a".repeat(64);
  expect(artwork.setFromMaUrl("external:one", `/base/imageproxy/${id}?size=1000`)).toBe(`/api/artwork/external%3Aone?v=${id}`);
  expect(artwork.setFromMaUrl("external:one", `http://ma.example/base/imageproxy/${id}`)).not.toBeNull();
  for (const url of [
    `https://external.example/imageproxy/${id}`, `http://ma.example/imageproxy/${id}`,
    "http://ma.example/base/imageproxy?path=untrusted", `http://user:secret@ma.example/base/imageproxy/${id}`,
    "javascript:alert(1)", `http://ma.example/base/imageproxy/${id}/extra`,
  ]) expect(artwork.setFromMaUrl("external:one", url)).toBeNull();
});
it("uses only validated MA proxy IDs, no tokens, and caches bounded raster data", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([255, 216, 255, 217]), { headers: { "Content-Type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetcher);
  const artwork = new ArtworkStore("http://ma.example/base");
  expect(artwork.set("provider://track/one", "a".repeat(64))).toBe(`/api/artwork/provider%3A%2F%2Ftrack%2Fone?v=${"a".repeat(64)}`);
  const image = await artwork.get("provider://track/one", new AbortController().signal);
  expect(image?.contentType).toBe("image/jpeg");
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(`http://ma.example/base/imageproxy/${"a".repeat(64)}?size=512&fmt=jpeg`);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  await artwork.get("provider://track/one", new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (let n = 0; n < 8; n++) artwork.set(`other:${n}`, "b".repeat(64));
  expect(await artwork.get("provider://track/one", new AbortController().signal)).toBeNull();
  expect(() => artwork.set("a", "http://evil.example/payload")).toThrow("invalid");
});
it("rejects executable image types, false raster signatures and oversized artwork", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response("<svg></svg>", { headers: { "Content-Type": "image/svg+xml" } }))
    .mockResolvedValueOnce(new Response("<html>no</html>", { headers: { "Content-Type": "image/jpeg" } }))
    .mockResolvedValueOnce(new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { "Content-Type": "image/png" } }));
  vi.stubGlobal("fetch", fetcher);
  const artwork = new ArtworkStore("http://ma.example");
  artwork.set("a", "a".repeat(64));
  await expect(artwork.get("a", new AbortController().signal)).rejects.toThrow("unsupported_artwork_type");
  await expect(artwork.get("a", new AbortController().signal)).rejects.toThrow("invalid_artwork_signature");
  await expect(artwork.get("a", new AbortController().signal)).rejects.toThrow("artwork_too_large");
});
it("does not replace a revised artwork cache with a late previous fetch", async () => {
  let resolve: (response: Response) => void = () => {};
  const fetcher = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
    .mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255, 2]), { headers: { "Content-Type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetcher);
  const artwork = new ArtworkStore("http://ma.example");
  const oldUrl = artwork.set("track", "a".repeat(64));
  const first = artwork.get("track", new AbortController().signal);
  const newUrl = artwork.set("track", "b".repeat(64));
  expect(newUrl).not.toBe(oldUrl);
  const newest = await artwork.get("track", new AbortController().signal);
  resolve(new Response(new Uint8Array([255, 216, 255, 1]), { headers: { "Content-Type": "image/jpeg" } }));
  await first;
  expect(await artwork.get("track", new AbortController().signal)).toBe(newest);
});
