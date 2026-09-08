import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { albumCoverUrl, albumCoverJpegSchema, decodeAlbumCover, fetchAlbumCover,
  MAX_ALBUM_COVER_BYTES, MAX_ALBUM_COVER_BASE64_BYTES } from "../src/server/album-cover.js";
import { decodeAmbientImage, MAX_UPLOAD_BYTES } from "../src/server/ambient-decoder.js";
import { trustedGet } from "../src/server/line-in-network.js";

vi.mock("../src/server/line-in-network.js", () => ({ trustedGet: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const url = "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/a/b/c/100x100bb.jpg";

it("enlarges only validated Apple size suffixes, uses non-cropping bb, and preserves already large sources", () => {
  expect(albumCoverUrl(url)).toBe(url.replace("100x100", "1200x1200"));
  expect(albumCoverUrl(url.replace("100x100bb", "400x600cc"))).toBe(url.replace("100x100", "1200x1200"));
  expect(albumCoverUrl(url.replace("100x100", "3000x3000"))).toBe(url.replace("100x100", "3000x3000"));
  for (const invalid of [url.replace("https:", "http:"), url.replace("is1-ssl", "is9-ssl"),
    url.replace("mzstatic.com", "mzstatic.com.evil"), url.replace("https://", "https://user@"),
    url.replace("/a/", "/../"), `${url}?url=http://localhost`, `${url}#fragment`,
    url.replace(".com/", ".com:443/"), "https://127.0.0.1/100x100bb.jpg"]) {
    expect(() => albumCoverUrl(invalid)).toThrow();
    expect(() => fetchAlbumCover(invalid, AbortSignal.timeout(1000))).toThrow();
  }
  expect(trustedGet).not.toHaveBeenCalled();
  fetchAlbumCover(url, AbortSignal.timeout(1000));
  expect(trustedGet).toHaveBeenCalledExactlyOnceWith(url.replace("100x100", "1200x1200"),
    expect.any(AbortSignal), ["image/jpeg", "image/png"], MAX_UPLOAD_BYTES);
});

it("produces actual full-cover pixels independently of journal thumbnails, without cropping or upscaling", async () => {
  for (const [width, height, expected] of [
    [1800, 1800, [1200, 1200]], [1800, 1200, [1200, 800]],
    [1200, 1800, [800, 1200]], [100, 80, [100, 80]],
  ] as const) {
    const input = await sharp({ create: { width, height, channels: 3, background: "#689abc" } }).png().toBuffer();
    const full = await decodeAlbumCover(input, "image/png");
    expect([full.width, full.height]).toEqual(expected);
    const metadata = await sharp(full.data).metadata();
    expect([metadata.width, metadata.height, metadata.format]).toEqual([...expected, "jpeg"]);
    if (width === height) {
      const journal = await decodeAmbientImage(input, "image/png", undefined, true);
      expect([journal.width, journal.height]).toEqual([270, 270]);
    }
  }
});

it("supports detailed covers larger than the old thumbnail cap with bounded canonical base64 validation", async () => {
  const pixels = Buffer.alloc(1200 * 1200 * 3);
  let seed = 7;
  for (let index = 0; index < pixels.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[index] = seed >>> 24;
  }
  const input = await sharp(pixels, { raw: { width: 1200, height: 1200, channels: 3 } }).png().toBuffer();
  const cover = await decodeAlbumCover(input, "image/png");
  expect(cover.data.length).toBeGreaterThan(256 * 1024);
  expect(cover.data.length).toBeLessThanOrEqual(MAX_ALBUM_COVER_BYTES);
  expect(albumCoverJpegSchema.parse(cover.data.toString("base64"))).toBe(cover.data.toString("base64"));
  for (const invalid of ["abc", "/9j/2Q==!", "A".repeat(MAX_ALBUM_COVER_BASE64_BYTES + 1)]) {
    expect(albumCoverJpegSchema.safeParse(invalid).success).toBe(false);
  }
});

it("retains the shared input, container and cancellation guards for full covers", async () => {
  await expect(decodeAlbumCover(Buffer.alloc(MAX_UPLOAD_BYTES + 1), "image/jpeg")).rejects.toMatchObject({ status: 413 });
  await expect(decodeAlbumCover(Buffer.from("<svg/>"), "image/svg+xml")).rejects.toMatchObject({ status: 415 });
  await expect(decodeAlbumCover(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).rejects.toMatchObject({ status: 400 });
  const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().toBuffer();
  await expect(decodeAlbumCover(image, "image/png", AbortSignal.abort())).rejects.toMatchObject({ status: 408 });
});
