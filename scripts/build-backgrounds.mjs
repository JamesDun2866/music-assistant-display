// Maintainer-only offline build. Originals are never bundled or fetched by the app.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const originals = process.argv[2];
if (!originals) throw new Error("Usage: node scripts/build-backgrounds.mjs <verified-originals-directory>");
const manifest = JSON.parse(await readFile("docs/background-manifest.json", "utf8"));
const hash = (data) => createHash("sha256").update(data).digest("hex");
sharp.cache(false);
sharp.concurrency(1);
await mkdir("public/backgrounds/thumbnails", { recursive: true });
const catalog = [];
for (const photo of manifest.photos) {
  assert.match(photo.id, /^builtin-[a-z-]+$/);
  const slug = photo.id.slice("builtin-".length);
  const original = await readFile(path.join(originals, `${slug}.jpg`));
  assert.equal(hash(original), photo.source.sha256, `${slug}: source hash`);
  assert.equal(original.length, photo.source.bytes, `${slug}: source bytes`);
  const metadata = await sharp(original, { limitInputPixels: 160_000_000 }).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, photo.source.width);
  assert.equal(metadata.height, photo.source.height);
  const oriented = metadata.autoOrient;
  assert.ok(oriented.width >= 3840 && oriented.height >= 2160, `${slug}: native crop too small`);
  assert.equal(photo.processing.withoutEnlargement, true);
  const output = await sharp(original, { limitInputPixels: 160_000_000 }).rotate()
    .resize(3840, 2160, { fit: "cover", position: photo.processing.position, withoutEnlargement: true })
    .jpeg({ quality: 90, chromaSubsampling: "4:2:0" }).toBuffer();
  const thumbnail = await sharp(output).resize(480, 270).jpeg({ quality: 78 }).toBuffer();
  assert.equal(hash(output), photo.output.sha256, `${slug}: output hash (use the locked Sharp version)`);
  assert.equal(hash(thumbnail), photo.thumbnail.sha256, `${slug}: thumbnail hash`);
  await writeFile(path.join("public", "backgrounds", `${slug}.jpg`), output);
  await writeFile(path.join("public", "backgrounds", "thumbnails", `${slug}.jpg`), thumbnail);
  catalog.push({
    id: photo.id, title: photo.title, source: "builtin",
    url: `/backgrounds/${slug}.jpg?v=${photo.output.sha256.slice(0, 12)}`,
    thumbnailUrl: `/backgrounds/thumbnails/${slug}.jpg?v=${photo.thumbnail.sha256.slice(0, 12)}`,
    width: photo.output.width, height: photo.output.height, bytes: photo.output.bytes,
    credit: { author: photo.author, sourceUrl: photo.photoUrl, license: photo.license, licenseUrl: photo.licenseUrl },
  });
}
await writeFile("src/shared/background-catalog.json", JSON.stringify(catalog, null, 2) + "\n");
console.log(`Built ${catalog.length} native 3840x2160 photos and 480x270 thumbnails, without source enlargement.`);
