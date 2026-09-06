import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import manifest from "../docs/background-manifest.json" with { type: "json" };
import { ambientSettingsSchema, BUILTIN_BACKGROUNDS } from "../src/shared/ambient.js";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("individually licensed native 4K catalog", () => {
  it("preserves the four existing identities, with room for every builtin and forty uploads", () => {
    expect(BUILTIN_BACKGROUNDS).toHaveLength(34);
    expect(BUILTIN_BACKGROUNDS.slice(0, 4).map((image) => image.id)).toEqual([
      "builtin-golden-gate", "builtin-lone-pine", "builtin-rockaway", "builtin-bonzai",
    ]);
    expect(manifest.photos.slice(0, 4).map((photo) => photo.flickrId)).toEqual([
      "3409068082", "5910108497", "6249263074", "6899851215",
    ]);
    const selectedIds = [...BUILTIN_BACKGROUNDS.map((image) => image.id),
      ...Array.from({ length: 40 }, (_, index) => `upload-00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`)];
    expect(ambientSettingsSchema.safeParse({ selectedIds, slideshow: true, dwellSeconds: 60 }).success).toBe(true);
    expect(ambientSettingsSchema.safeParse({
      selectedIds: [...selectedIds, "upload-ffffffff-ffff-ffff-ffff-ffffffffffff"], slideshow: true, dwellSeconds: 60,
    }).success).toBe(false);
  });

  it("ties every shipped JPEG and bounded thumbnail to unique original-source and license evidence", async () => {
    expect(manifest.native4kCount).toBe(34);
    expect(manifest.legacyCount).toBe(0);
    expect(manifest.photos.map((photo) => photo.id)).toEqual(BUILTIN_BACKGROUNDS.map((image) => image.id));
    for (const key of ["id", "flickrId"] as const) {
      expect(new Set(manifest.photos.map((photo) => photo[key])).size).toBe(34);
    }
    expect(new Set(manifest.photos.map((photo) => photo.source.sha256)).size).toBe(34);
    expect(new Set(manifest.photos.map((photo) => photo.output.sha256)).size).toBe(34);
    let total = 0;
    for (const photo of manifest.photos) {
      const image = BUILTIN_BACKGROUNDS.find((entry) => entry.id === photo.id)!;
      expect(photo.author).toBe("Romain Guy");
      expect(photo.licenseUrl).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
      expect(photo.evidence.imageObject.license).toBe(photo.licenseUrl);
      expect(photo.evidence.imageObject.author.name).toBe(photo.author);
      expect(photo.evidence.imageObject.acquireLicensePage.replace(/\/$/, "")).toBe(photo.photoUrl.replace(/\/$/, ""));
      expect(photo.photoUrl).toBe(`https://www.flickr.com/photos/romainguy/${photo.flickrId}/`);
      expect(photo.creatorUrl).toMatch(/^https:\/\/www\.curious-creature\.com\/posts\/\d{4}\/[a-z-]+\/$/);
      expect(photo.source.url).toMatch(new RegExp(`^https://live\\.staticflickr\\.com/\\d+/${photo.flickrId}_[a-f0-9]+_o\\.jpg$`));
      expect(photo.evidence.originalSize).toEqual({
        url: photo.source.url, width: photo.source.width, height: photo.source.height,
      });
      expect(photo.source.metadataPage).toBe(photo.photoUrl);
      for (const value of [photo.source.sha256, photo.source.metadataPageSha256, photo.source.creatorPageSha256]) {
        expect(value).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(photo.source.width).toBeGreaterThanOrEqual(3840);
      expect(photo.source.height).toBeGreaterThanOrEqual(2160);
      const sideways = photo.source.orientation >= 5 && photo.source.orientation <= 8;
      const sourceWidth = sideways ? photo.source.height : photo.source.width;
      const sourceHeight = sideways ? photo.source.width : photo.source.height;
      expect(photo.processing.usableSourceCrop).toEqual({
        width: Math.floor(Math.min(sourceWidth, sourceHeight * 16 / 9)),
        height: Math.floor(Math.min(sourceHeight, sourceWidth * 9 / 16)),
      });
      expect(photo.processing.usableSourceCrop.width).toBeGreaterThanOrEqual(3840);
      expect(photo.processing.usableSourceCrop.height).toBeGreaterThanOrEqual(2160);
      expect(photo.processing.withoutEnlargement).toBe(true);
      expect(image.credit).toEqual({
        author: photo.author, sourceUrl: photo.photoUrl, license: photo.license, licenseUrl: photo.licenseUrl,
      });
      expect(image.url).toBe(`${photo.output.file.slice("public".length)}?v=${photo.output.sha256.slice(0, 12)}`);
      expect(image.thumbnailUrl).toBe(`${photo.thumbnail.file.slice("public".length)}?v=${photo.thumbnail.sha256.slice(0, 12)}`);
      expect([image.width, image.height, image.bytes]).toEqual([3840, 2160, photo.output.bytes]);
      for (const [asset, width, height] of [[photo.output, 3840, 2160], [photo.thumbnail, 480, 270]] as const) {
        expect([asset.width, asset.height]).toEqual([width, height]);
        const data = await readFile(path.resolve(asset.file));
        total += data.length;
        expect(data.length).toBe(asset.bytes);
        expect(sha256(data)).toBe(asset.sha256);
        expect([...data.subarray(0, 2)]).toEqual([0xff, 0xd8]);
        expect([...data.subarray(-2)]).toEqual([0xff, 0xd9]);
        const metadata = await sharp(data).metadata();
        expect([metadata.format, metadata.width, metadata.height]).toEqual(["jpeg", width, height]);
        expect(metadata.exif).toBeUndefined();
        expect(metadata.icc).toBeUndefined();
        expect(metadata.xmp).toBeUndefined();
        // Force raster decoding too: a plausible JPEG header is not proof of usable image data.
        await sharp(data, { failOn: "warning" }).resize(1, 1).raw().toBuffer();
      }
    }
    expect(total).toBe(60_892_590);
    expect(total).toBeLessThan(64 * 1024 * 1024);
    const full = (await readdir("public/backgrounds")).filter((file) => file.endsWith(".jpg"));
    expect(full.sort()).toEqual(manifest.photos.map((photo) => path.basename(photo.output.file)).sort());
    expect((await readdir("public/backgrounds/thumbnails")).sort())
      .toEqual(manifest.photos.map((photo) => path.basename(photo.thumbnail.file)).sort());
  }, 60_000);
});
