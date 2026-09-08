import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns";
import { isIP } from "node:net";

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return !([0, 10, 127].includes(a) || a >= 224 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 2, 168].includes(b)
      || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b)
      || a === 203 && b === 0);
  }
  return isIP(address) === 6 && /^[23][a-f0-9]{3}:/i.test(address)
    && !/^2001:(?:0{0,4}|0?db8):|^2002:|^3fff:/i.test(address);
}

/** Callers construct/validate the fixed catalog endpoint or canonical artwork URL. */
export function trustedGet(url: string, signal: AbortSignal, types: string[], maximum: number):
Promise<{ bytes: Buffer; type: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      signal, agent: false,
      lookup: (hostname, options, callback) => {
        lookup(hostname, { ...options, all: true }, (error, addresses) => {
          if (error) { callback(error, []); return; }
          const safe = addresses.filter(({ address }) => publicAddress(address));
          if (!safe.length) { callback(new Error("album_address_denied"), []); return; }
          if (options.all) callback(null, safe);
          else callback(null, safe[0]!.address, safe[0]!.family);
        });
      },
    }, (response) => {
      const type = response.headers["content-type"]?.split(";")[0];
      if (response.statusCode !== 200 || !types.includes(type ?? "")) {
        response.destroy(); reject(new Error("album_response_denied")); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximum) { response.destroy(new Error("album_response_too_large")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ bytes: Buffer.concat(chunks), type: type! }));
    });
    request.once("error", reject);
    request.end();
  });
}
