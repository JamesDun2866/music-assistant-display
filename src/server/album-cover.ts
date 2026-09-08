import { z } from "zod";
import { albumArtworkReference } from "../shared/line-in-album.js";
import { MAX_ALBUM_COVER_BYTES, MAX_UPLOAD_BYTES } from "./ambient-decoder.js";
import { trustedGet } from "./line-in-network.js";

export { decodeAlbumCover, MAX_ALBUM_COVER_BYTES } from "./ambient-decoder.js";
export const ALBUM_COVER_VERSION = 1;
export const MAX_ALBUM_COVER_BASE64_BYTES = 4 * Math.ceil(MAX_ALBUM_COVER_BYTES / 3);
export const MAX_ALBUM_COVER_RECORD_BYTES = 3 * 1024 * 1024;
export const ALBUM_COVER_RETRY_MS = 5 * 60_000;

export const albumCoverJpegSchema = z.string().max(MAX_ALBUM_COVER_BASE64_BYTES).refine((value) => {
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= MAX_ALBUM_COVER_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8
    && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9 && bytes.toString("base64") === value;
}, "Invalid cached album cover").nullable();

/** Rewrite only the validated Apple thumbnail size, never a caller-supplied host or query. */
export function albumCoverUrl(url: string): string {
  const value = albumArtworkReference.parse(url);
  return albumArtworkReference.parse(value.replace(/\/([0-9]+)x([0-9]+)(bb|cc)\.(jpg|png)$/, (_match, width: string, height: string, fit: string, format: string) =>
    Number(width) >= 1200 && Number(height) >= 1200 && fit === "bb"
      ? `/${width}x${height}bb.${format}` : `/1200x1200bb.${format}`));
}

export function fetchAlbumCover(url: string, signal: AbortSignal): Promise<{ bytes: Buffer; type: string }> {
  return trustedGet(albumCoverUrl(url), signal, ["image/jpeg", "image/png"], MAX_UPLOAD_BYTES);
}
