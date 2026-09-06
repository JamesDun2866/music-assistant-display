import { maBaseUrl } from "./ma-client.js";
import type { Artwork } from "./http.js";

type ImageEntry = { url: string; version: string; artwork?: Artwork };

export class ArtworkStore {
  private images = new Map<string, ImageEntry>();
  constructor(private readonly maUrl: string, private readonly allowSpotifyArtwork = false) {}
  setFromPlayerUrl(identity: string, raw: string, spotifySource: boolean): string | null {
    const proxied = this.setFromMaUrl(identity, raw);
    if (proxied) return proxied;
    if (!this.allowSpotifyArtwork || !spotifySource) return null;
    // Accept only canonical cover URLs, never arbitrary hosts, paths, queries or redirects.
    const match = /^https:\/\/i\.scdn\.co\/image\/([a-fA-F0-9]{40})$/.exec(raw);
    if (!match) return null;
    return this.remember(identity, raw, `spotify-${match[1]}`);
  }
  setFromMaUrl(identity: string, raw: string): string | null {
    const base = maBaseUrl(this.maUrl);
    if (!URL.canParse(raw, base)) return null;
    const url = new URL(raw, base);
    const prefix = `${base.pathname}imageproxy/`;
    if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(prefix)) return null;
    const proxyId = url.pathname.slice(prefix.length);
    return /^[a-fA-F0-9]{64}$/.test(proxyId) ? this.set(identity, proxyId) : null;
  }
  set(identity: string, proxyId: string): string {
    if (!/^[a-fA-F0-9]{64}$/.test(proxyId)) throw new Error("invalid_image_proxy_id");
    const url = new URL(`imageproxy/${proxyId}?size=512&fmt=jpeg`, maBaseUrl(this.maUrl)).href;
    return this.remember(identity, url, proxyId);
  }
  private remember(identity: string, url: string, version: string): string {
    const previous = this.images.get(identity);
    this.images.delete(identity);
    this.images.set(identity, previous?.url === url ? previous : { url, version });
    while (this.images.size > 8) this.images.delete(this.images.keys().next().value!);
    return `/api/artwork/${encodeURIComponent(identity)}?v=${version}`;
  }
  async get(identity: string, signal: AbortSignal): Promise<Artwork | null> {
    const image = this.images.get(identity);
    if (!image) return null;
    if (image.artwork) return image.artwork;
    const response = await fetch(image.url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), redirect: "error",
      credentials: "omit", referrerPolicy: "no-referrer",
    });
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
