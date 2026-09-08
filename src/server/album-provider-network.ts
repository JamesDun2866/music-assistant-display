import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { publicAddress } from "./line-in-network.js";

export const PROVIDER_USER_AGENT = "sendspin-karaoke/0.1.0 ( https://github.com/JamesDun2866/music-assistant-display )";

type ProviderErrorCode = "not-found" | "rate-limited" | "unavailable" | "invalid-response" | "denied" | "busy" | "budget";

const messages: Record<ProviderErrorCode, string> = {
  "not-found": "Album provider item not found",
  "rate-limited": "Album provider rate limited",
  unavailable: "Album provider unavailable",
  "invalid-response": "Invalid album provider response",
  denied: "Album provider request denied",
  busy: "Album provider busy",
  budget: "Album provider request budget exhausted",
};

export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, readonly retryAt?: number) {
    super(messages[code]);
    this.name = "ProviderError";
  }
}

export interface ProviderBudget { remaining: number }

type Kind = "musicbrainz" | "caa-manifest" | "caa-image";
interface GetOptions {
  kind: Kind;
  releaseId?: string;
  imageId?: string;
  maximum?: number;
  budget?: ProviderBudget;
}

/** Low-level seams retain all URL, DNS, response, scheduling and budget checks. */
interface NetworkOptions {
  request?: typeof httpsRequest;
  lookup?: typeof dnsLookup;
}

type Result = { bytes: Buffer; type: string };
type Hop = Result | { location: string };
type Scope = { releaseId: string; imageId?: string };
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const limits: Record<Kind, number> = {
  musicbrainz: 2 * 1024 * 1024,
  "caa-manifest": 512 * 1024,
  "caa-image": 12 * 1024 * 1024,
};

interface Waiting {
  signal: AbortSignal;
  run: () => Promise<Hop>;
  resolve: (result: Hop) => void;
  reject: (error: ProviderError) => void;
  abort: () => void;
}

// One gate for all providers and instances. Redirects release their slot before queuing again.
const waiting: Waiting[] = [];
let active = false;
let lastStart = -Infinity;
let wake: ReturnType<typeof setTimeout> | undefined;
let cooldownUntil = -Infinity;
let cooldownRetryAt = 0;

function cooldownError(): ProviderError | undefined {
  return performance.now() < cooldownUntil
    ? new ProviderError("rate-limited", cooldownRetryAt) : undefined;
}

function pump(): void {
  if (wake) { clearTimeout(wake); wake = undefined; }
  if (active || !waiting.length) return;
  const blocked = cooldownError();
  if (blocked) {
    for (const entry of waiting.splice(0)) {
      entry.signal.removeEventListener("abort", entry.abort);
      entry.reject(blocked);
    }
    return;
  }
  const delay = lastStart + 1100 - performance.now();
  if (delay > 0) { wake = setTimeout(pump, delay); return; }
  const entry = waiting.shift()!;
  entry.signal.removeEventListener("abort", entry.abort);
  if (entry.signal.aborted) {
    entry.reject(new ProviderError("unavailable"));
    pump();
    return;
  }
  active = true;
  void Promise.resolve().then(() => {
    lastStart = performance.now();
    return entry.run();
  }).then(entry.resolve, (error: unknown) => {
    entry.reject(error instanceof ProviderError ? error : new ProviderError("unavailable"));
  }).finally(() => { active = false; pump(); });
}

function schedule(signal: AbortSignal, run: () => Promise<Hop>): Promise<Hop> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ProviderError("unavailable")); return; }
    const blocked = cooldownError();
    if (blocked) { reject(blocked); return; }
    if (waiting.length >= 8) { reject(new ProviderError("busy")); return; }
    const entry: Waiting = {
      signal, run, resolve, reject,
      abort: () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        signal.removeEventListener("abort", entry.abort);
        reject(new ProviderError("unavailable"));
        pump();
      },
    };
    waiting.push(entry);
    signal.addEventListener("abort", entry.abort, { once: true });
    pump();
  });
}

function retryTime(value: string | undefined, fallback: boolean): number | undefined {
  const now = Date.now();
  let delay: number | undefined;
  if (value && /^\d+$/.test(value.trim())) delay = Number(value.trim()) * 1000;
  else if (value && /^[A-Za-z]{3}, /.test(value)) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) delay = date - now;
  }
  if (delay === undefined || Number.isNaN(delay)) delay = fallback ? 60_000 : undefined;
  return delay === undefined ? undefined : now + Math.max(0, Math.min(delay, 86_400_000));
}

function backoff(retryAt: number): void {
  const until = performance.now() + Math.max(0, retryAt - Date.now());
  if (until > cooldownUntil) {
    cooldownUntil = until;
    cooldownRetryAt = retryAt;
  }
}

function checkedUrl(raw: string): URL {
  // Check the original spelling before URL normalization can erase ports, dot segments or escapes.
  if (raw.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(raw)
      || !/^https:\/\/[a-z0-9.-]+\//.test(raw)) throw new ProviderError("denied");
  const authority = raw.slice(8, raw.indexOf("/", 8));
  if (!/^[a-z0-9.-]+$/.test(authority)) throw new ProviderError("denied");
  let url: URL;
  try { url = new URL(raw); } catch { throw new ProviderError("denied"); }
  const rawPath = raw.slice(raw.indexOf("/", 8)).split(/[?#]/)[0]!;
  if (url.protocol !== "https:" || url.username || url.password || url.port
      || raw.includes("#") || rawPath.includes("%") || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)
      || url.pathname !== rawPath || /%(?![0-9a-f]{2})/i.test(raw)) throw new ProviderError("denied");
  return url;
}

function musicbrainzUrl(url: URL): void {
  if (url.hostname !== "musicbrainz.org") throw new ProviderError("denied");
  const query = url.searchParams;
  const rawKeys = url.search.slice(1).split("&").map((part) => part.split("=")[0]);
  const exact = (keys: string[]): boolean =>
    rawKeys.length === keys.length && keys.every((key) => query.getAll(key).length === 1)
    && rawKeys.every((key) => keys.includes(key!));
  let valid = false;
  if (new RegExp(`^/ws/2/release/${uuid}$`).test(url.pathname)) {
    valid = exact(["inc", "fmt"]) && ["recordings artist-credits url-rels", "recordings+artist-credits+url-rels"].includes(query.get("inc") ?? "");
  } else if (url.pathname === "/ws/2/release") {
    valid = exact(["query", "limit", "fmt"]) && !!query.get("query")?.trim() && query.get("limit") === "20";
  } else if (url.pathname === "/ws/2/url") {
    const resources = query.getAll("resource");
    valid = resources.length >= 1 && resources.length <= 4
      && resources.every((resource) => /^https:\/\/(?:music\.apple\.com\/[a-z]{2}\/album\/[1-9][0-9]{0,14}|itunes\.apple\.com\/[a-z]{2}\/album\/id[1-9][0-9]{0,14})$/.test(resource))
      && query.getAll("inc").length === 1 && query.get("inc") === "release-rels"
      && query.getAll("fmt").length === 1
      && rawKeys.length === resources.length + 2
      && rawKeys.every((key) => ["resource", "inc", "fmt"].includes(key!));
  }
  if (!valid || query.get("fmt") !== "json"
      || [...query.values()].some((value) => /[\u0000-\u001f\u007f\ufffd]/.test(value))) {
    throw new ProviderError("denied");
  }
}

function caaScope(url: URL, options: GetOptions): Scope {
  const pattern = options.kind === "caa-manifest"
    ? new RegExp(`^/release/(${uuid})$`)
    : new RegExp(`^/release/(${uuid})/([0-9]+)-1200(?:\\.jpg)?$`);
  const match = pattern.exec(url.pathname);
  if (url.hostname !== "coverartarchive.org" || url.search || url.href.includes("?") || !match
      || options.releaseId !== undefined && options.releaseId !== match[1]
      || options.imageId !== undefined && options.imageId !== match[2]) throw new ProviderError("denied");
  return { releaseId: match[1]!, imageId: match[2] };
}

function caaHop(url: URL, scope: Scope, kind: Kind): void {
  if (url.search || url.href.includes("?")) throw new ProviderError("denied");
  const { releaseId, imageId } = scope;
  if (url.hostname === "coverartarchive.org") {
    const expected = `/release/${releaseId}${kind === "caa-image" ? `/${imageId}-1200` : ""}`;
    if (url.pathname === expected || kind === "caa-image" && url.pathname === `${expected}.jpg`) return;
  }
  const folder = `mbid-${releaseId}`;
  const filename = kind === "caa-manifest" ? "index.json" : `${folder}-${imageId}-1200.jpg`;
  if (url.hostname === "archive.org" && url.pathname === `/download/${folder}/${filename}`) return;
  if (url.hostname === "s3.us.archive.org" && url.pathname === `/${folder}/${filename}`) return;
  if (/^(?:ia[0-9]{6}\.us|dn[0-9]{6}\.ca)\.archive\.org$/.test(url.hostname)
      && (url.pathname === `/download/${folder}/${filename}`
        || new RegExp(`^/[0-9]{1,2}/items/${folder}/${filename.replace(".", "\\.")}$`).test(url.pathname))) return;
  throw new ProviderError("denied");
}

function redirectUrl(location: string, current: URL): URL {
  if (!location || location.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(location)
      || location.includes("%") || /(?:^|\/)\.{1,2}(?:\/|$)/.test(location.split(/[?#]/)[0]!)) {
    throw new ProviderError("denied");
  }
  // Root-relative redirects are safe to resolve; arbitrary relative and network-path URLs are not.
  if (location.startsWith("/") && !location.startsWith("//")) return checkedUrl(`${current.origin}${location}`);
  return checkedUrl(location);
}

export class ProviderNetwork {
  private readonly request: typeof httpsRequest;
  private readonly lookup: typeof dnsLookup;

  constructor(private readonly userAgent: string = PROVIDER_USER_AGENT, options: NetworkOptions = {}) {
    if (typeof userAgent !== "string" || userAgent.length > 512 || userAgent.trim().length < 8
        || /[^\x20-\x7e]/.test(userAgent) || !/[A-Za-z][A-Za-z0-9._-]*\/[0-9]/.test(userAgent)) {
      throw new ProviderError("denied");
    }
    this.request = options.request ?? httpsRequest;
    this.lookup = options.lookup ?? dnsLookup;
  }

  async get(raw: string, signal: AbortSignal, options: GetOptions): Promise<Result> {
    if (!Object.hasOwn(limits, options.kind)) throw new ProviderError("denied");
    let url = checkedUrl(raw);
    let scope: Scope | undefined;
    if (options.kind === "musicbrainz") musicbrainzUrl(url);
    else scope = caaScope(url, options);
    const maximum = options.maximum === undefined ? limits[options.kind] : Math.min(options.maximum, limits[options.kind]);
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new ProviderError("denied");
    const budget = options.budget ?? { remaining: 8 };
    const operation = new AbortController();
    const expiresAt = performance.now() + 45_000;
    const cancel = (): void => operation.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const deadline = setTimeout(cancel, 45_000);
    try {
      for (let redirects = 0; ; redirects++) {
        if (!Number.isSafeInteger(budget.remaining) || budget.remaining < 1) throw new ProviderError("budget");
        const current = url;
        const hop = await schedule(operation.signal, () => {
          if (operation.signal.aborted || performance.now() >= expiresAt) throw new ProviderError("unavailable");
          if (!Number.isSafeInteger(budget.remaining) || budget.remaining < 1) throw new ProviderError("budget");
          budget.remaining--;
          return this.fetch(current, operation.signal, options.kind, maximum);
        });
        if ("bytes" in hop) return hop;
        if (!scope || redirects >= 4) throw new ProviderError("denied");
        url = redirectUrl(hop.location, current);
        caaHop(url, scope, options.kind);
      }
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", cancel);
    }
  }

  private fetch(url: URL, signal: AbortSignal, kind: Kind, maximum: number): Promise<Hop> {
    return new Promise((resolve, reject) => {
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: ProviderError, result?: Hop): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve(result!);
        response?.destroy();
        request?.destroy();
      };
      const cancel = (): void => finish(new ProviderError("unavailable"));
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(cancel, 8000);
      try {
        request = this.request(url, {
          method: "GET", agent: false, signal,
          headers: { "User-Agent": this.userAgent, Accept: kind === "caa-image" ? "image/jpeg, image/png" : "application/json" },
          lookup: (hostname, options, callback) => {
            this.lookup(hostname, { ...options, all: true }, (error, addresses) => {
              if (settled) { callback(new ProviderError("unavailable"), []); return; }
              if (error) { callback(new ProviderError("unavailable"), []); return; }
              // Reject mixed public/private answers rather than risk an unsafe fallback.
              if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
                callback(new ProviderError("denied"), []); return;
              }
              if (options.all) callback(null, addresses);
              else callback(null, addresses[0]!.address, addresses[0]!.family);
            });
          },
        }, (incoming) => {
          response = incoming;
          response.on("error", () => finish(new ProviderError("unavailable")));
          response.on("aborted", cancel);
          response.on("close", () => { if (!response?.complete) cancel(); });
          if (settled) { response.destroy(); return; }
          const status = response.statusCode;
          if (status === 429 || status === 503) {
            const retryAt = retryTime(response.headers["retry-after"], true)!;
            backoff(retryAt);
            finish(new ProviderError(status === 429 ? "rate-limited" : "unavailable", retryAt));
            return;
          }
          if (status === 404) { finish(new ProviderError("not-found")); return; }
          if (status && [301, 302, 303, 307, 308].includes(status)) {
            const location = response.headers.location;
            if (kind === "musicbrainz" || !location) finish(new ProviderError("denied"));
            else finish(undefined, { location });
            return;
          }
          if (status !== 200) { finish(new ProviderError("unavailable")); return; }
          const type = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
          const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
          const length = response.headers["content-length"];
          const types = kind === "caa-image" ? ["image/jpeg", "image/png"] : ["application/json"];
          if (!type || !types.includes(type) || encoding !== undefined && encoding !== "identity"
              || length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) {
            finish(new ProviderError("invalid-response")); return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > maximum) { finish(new ProviderError("invalid-response")); return; }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (length !== undefined && size !== Number(length)) finish(new ProviderError("invalid-response"));
            else finish(undefined, { bytes: Buffer.concat(chunks), type });
          });
        });
        request.on("error", (error: Error) => finish(error instanceof ProviderError ? error : new ProviderError("unavailable")));
        if (settled) request.destroy();
        else request.end();
      } catch { finish(new ProviderError("unavailable")); }
    });
  }
}
