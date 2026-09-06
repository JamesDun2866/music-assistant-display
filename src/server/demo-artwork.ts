import { deflateSync } from "node:zlib";
import type { Artwork } from "./http.js";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(type: string, data: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of content) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, content, checksum]);
}

/** Original geometric cover art, generated once per demo cover with no external assets. */
function makeCover(palette: "jade" | "ember"): Artwork {
  const size = 512;
  const pixels = Buffer.alloc(size * (1 + size * 3));
  const base = palette === "jade" ? [16, 61, 62] : [63, 28, 63];
  const light = palette === "jade" ? [172, 239, 173] : [250, 173, 120];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const distance = Math.hypot((u - 0.52) * 1.05, v - 0.43);
      const orb = distance < 0.325;
      const stripe = Math.sin((u * 0.8 + v) * 145) * 0.5 + 0.5;
      const ring = Math.abs(distance - 0.37) < 0.0025 || Math.abs(distance - 0.41) < 0.0015;
      const horizon = v > 0.74 + Math.sin(u * 5 + 1) * 0.04;
      const glow = Math.max(0, 1 - Math.hypot(u - 0.25, v - 0.12));
      const highlight = orb ? Math.max(0, 1 - distance / 0.44) * (0.52 + stripe * 0.48) : ring ? 0.45 : 0;
      for (let channel = 0; channel < 3; channel++) {
        const color = base[channel]! * (0.45 + glow * 1.05) + light[channel]! * highlight;
        pixels[y * (1 + size * 3) + 1 + x * 3 + channel] = Math.round(Math.max(0, Math.min(255, color * (horizon ? 0.4 : 1))));
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return {
    contentType: "image/png",
    bytes: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0)),
    ]),
  };
}
export class DemoArtwork {
  private covers = new Map<string, Artwork>();
  async get(identity: string, signal: AbortSignal): Promise<Artwork | null> {
    signal.throwIfAborted();
    if (identity !== "demo:0" && identity !== "demo:1") return null;
    let cover = this.covers.get(identity);
    if (!cover) {
      cover = makeCover(identity === "demo:0" ? "jade" : "ember");
      this.covers.set(identity, cover);
    }
    return cover;
  }
}
