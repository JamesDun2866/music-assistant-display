import { maBaseUrl } from "./ma-client.js";
import type { Artwork } from "./http.js";

export class ArtworkStore {
  private images = new Map<string, { proxyId: string; artwork?: Artwork }>();
  constructor(private readonly maUrl: string) {}
  set(identity: string, proxyId: string): string {
    if (!/^[a-fA-F0-9]{64}$/.test(proxyId)) throw new Error("invalid_image_proxy_id");
    const previous = this.images.get(identity);
    this.images.delete(identity);
    this.images.set(identity, previous?.proxyId === proxyId ? previous : { proxyId });
    while (this.images.size > 8) this.images.delete(this.images.keys().next().value!);
    return `/api/artwork/${encodeURIComponent(identity)}?v=${proxyId}`;
  }
  async get(identity: string, signal: AbortSignal): Promise<Artwork | null> {
    const image = this.images.get(identity);
    if (!image) return null;
    if (image.artwork) return image.artwork;
    const url = new URL(`imageproxy/${image.proxyId}?size=512&fmt=jpeg`, maBaseUrl(this.maUrl));
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), redirect: "error" });
    if (response.status === 404) return null;
    if (!response.ok || !response.body) throw new Error("artwork_request_failed");
    const type = response.headers.get("content-type")?.split(";")[0];
    if (!["image/jpeg", "image/png", "image/webp"].includes(type ?? "")) {
      await response.body.cancel(); throw new Error("unsupported_artwork_type");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("artwork_too_large"); }
      chunks.push(chunk.value);
    }
    const bytes = Buffer.concat(chunks);
    const jpeg = type === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = type === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp = type === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!jpeg && !png && !webp) throw new Error("invalid_artwork_signature");
    const artwork: Artwork = { bytes, contentType: jpeg ? "image/jpeg" : png ? "image/png" : "image/webp" };
    image.artwork = artwork;
    return artwork;
  }
}
