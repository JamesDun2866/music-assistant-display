import { EventEmitter } from "node:events";
import type { lookup as dnsLookup, LookupAddress } from "node:dns";
import type { request as httpsRequest, RequestOptions } from "node:https";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderNetwork as NetworkType } from "../src/server/album-provider-network.js";

const release = "12345678-1234-1234-1234-123456789abc";
const other = "87654321-1234-1234-1234-123456789abc";
const mb = `https://musicbrainz.org/ws/2/release/${release}?inc=recordings+artist-credits+url-rels&fmt=json`;
const manifest = `https://coverartarchive.org/release/${release}`;
const image = `${manifest}/12345-1200`;
const archive = `https://archive.org/download/mbid-${release}/index.json`;
const archiveImage = `https://archive.org/download/mbid-${release}/mbid-${release}-12345-1200.jpg`;
const ua = "AlbumNetworkTest/1.0 (test suite)";
const signal = (): AbortSignal => new AbortController().signal;
let ProviderNetwork: typeof NetworkType;

interface Reply {
  status?: number;
  headers?: IncomingHttpHeaders;
  chunks?: Buffer[];
  hang?: boolean;
  addresses?: LookupAddress[];
  dnsError?: Error;
  error?: Error;
  close?: boolean;
}

function transport(replies: Reply[] = []) {
  const starts: number[] = [];
  const requests: ClientRequest[] = [];
  const urls: URL[] = [];
  const headers: RequestOptions["headers"][] = [];
  let current: Reply;
  const lookup = vi.fn((_hostname, _options, callback) => {
    callback(current.dnsError ?? null, current.addresses ?? [{ address: "93.184.216.34", family: 4 }]);
  }) as unknown as typeof dnsLookup;
  const request = vi.fn((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    current = replies.shift() ?? {};
    const reply = current;
    starts.push(performance.now());
    urls.push(url);
    headers.push(options.headers);
    const req = new EventEmitter() as ClientRequest;
    req.destroy = vi.fn(() => { req.destroyed = true; return req; });
    req.end = vi.fn(() => {
      const checkedLookup = options.lookup as (
        host: string, opts: { all: boolean }, cb: (error: Error | null, address?: unknown, family?: number) => void
      ) => void;
      checkedLookup(url.hostname, { all: false }, (error) => {
        if (error) { req.emit("error", error); return; }
        if (reply.error) { req.emit("error", reply.error); return; }
        if (reply.hang) return;
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = reply.status ?? 200;
        response.headers = { "content-type": "application/json", ...reply.headers };
        response.complete = false;
        response.destroy = vi.fn(() => { response.destroyed = true; return response; });
        callback(response);
        if (response.destroyed) return;
        if (reply.close) { response.emit("close"); return; }
        for (const chunk of reply.chunks ?? [Buffer.from("{}")]) response.emit("data", chunk);
        if (response.destroyed) return;
        response.complete = true;
        response.emit("end");
      });
      return req;
    }) as ClientRequest["end"];
    requests.push(req);
    return req;
  }) as unknown as typeof httpsRequest;
  return { request, lookup, starts, requests, urls, headers };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  vi.resetModules();
  ({ ProviderNetwork } = await import("../src/server/album-provider-network.js"));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("defaults to the approved public project User-Agent", async () => {
  const { PROVIDER_USER_AGENT } = await import("../src/server/album-provider-network.js");
  const approved = "sendspin-karaoke/0.1.0 ( https://github.com/JamesDun2866/music-assistant-display )";
  expect(PROVIDER_USER_AGENT).toBe(approved);
  const wire = transport();
  await new ProviderNetwork(undefined, wire).get(mb, signal(), { kind: "musicbrainz" });
  expect(wire.headers).toEqual([{ "User-Agent": approved, Accept: "application/json" }]);
});

it("accepts only fixed MusicBrainz requests and sends a meaningful User-Agent without other credentials", async () => {
  const wire = transport();
  const network = new ProviderNetwork(ua, wire);
  const urls = [
    mb,
    mb.replaceAll("+", "%2B"),
    "https://musicbrainz.org/ws/2/release?query=release%3A%22An+Album%22&limit=20&fmt=json",
    "https://musicbrainz.org/ws/2/url?resource=https%3A%2F%2Fmusic.apple.com%2Fgb%2Falbum%2F123&resource=https%3A%2F%2Fitunes.apple.com%2Fgb%2Falbum%2Fid123&inc=release-rels&fmt=json",
  ];
  for (const url of urls) {
    const result = network.get(url, signal(), { kind: "musicbrainz" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(await result).toEqual({ bytes: Buffer.from("{}"), type: "application/json" });
  }
  expect(wire.lookup).toHaveBeenCalledTimes(urls.length);
  expect(wire.headers).toEqual(urls.map(() => ({ "User-Agent": ua, Accept: "application/json" })));
  for (const bad of ["", "anonymous", "test/1\r\nCookie: secret"]) {
    expect(() => new ProviderNetwork(bad, wire)).toThrow("request denied");
  }
});

it.each([
  mb.replace("https:", "http:"),
  mb.replace("musicbrainz.org", "musicbrainz.org:443"),
  mb.replace("musicbrainz.org", "user@musicbrainz.org"),
  mb.replace("musicbrainz.org", "127.0.0.1"),
  mb.replace("musicbrainz.org", "[::1]"),
  mb.replace("musicbrainz.org", "musicbrainz.org.evil"),
  mb.replace("/ws/", "/%77s/"),
  mb.replace("/ws/", "/anything/../ws/"),
  mb.replace("/ws/", "/anything/%2e%2e/ws/"),
  mb.replace("/ws/", "\\ws/"),
  mb.replace("release/", "recording/"),
  `${mb}#secret`,
  `${mb}&fmt=json`,
  `${mb}&offset=1`,
  mb.replace("inc=", "%69nc="),
  mb.replace("recordings+", "lyrics+"),
  "https://musicbrainz.org/ws/2/url?resource=https%3A%2F%2Fexample.com%2Fa&inc=release-rels&fmt=json",
  "https://musicbrainz.org/ws/2/release?query=a&limit=100&fmt=json",
  "https://musicbrainz.org/ws/2/release?query=&limit=20&fmt=json",
  "https://musicbrainz.org/ws/2/release?query=%zz&limit=20&fmt=json",
  "https://musicbrainz.org/ws/2/release?query=%0asecret&limit=20&fmt=json",
  `https://musicbrainz.org/ws/2/release?query=${"x".repeat(4096)}&limit=20&fmt=json`,
  "https://musicbrainz.org/ws/2/url?resource=file%3A%2F%2Fsecret&inc=release-rels&fmt=json",
  `https://musicbrainz.org/ws/2/url?${"resource=https%3A%2F%2Fexample.com&".repeat(5)}inc=release-rels&fmt=json`,
])("denies noncanonical MusicBrainz URLs before transport: %s", async (url) => {
  const wire = transport();
  await expect(new ProviderNetwork(ua, wire).get(url, signal(), { kind: "musicbrainz" }))
    .rejects.toMatchObject({ code: "denied", message: "Album provider request denied" });
  expect(wire.request).not.toHaveBeenCalled();
});

it("shares serialization and monotonic 1100ms spacing across instances", async () => {
  const wire = transport([{ hang: true }, {}, {}]);
  const first = new ProviderNetwork(ua, wire);
  const second = new ProviderNetwork(ua, wire);
  const controller = new AbortController();
  const pending = first.get(mb, controller.signal, { kind: "musicbrainz" }).catch((error: unknown) => error);
  const next = second.get(mb, signal(), { kind: "musicbrainz" });
  const last = first.get(mb, signal(), { kind: "musicbrainz" });
  await vi.advanceTimersByTimeAsync(2000);
  expect(wire.request).toHaveBeenCalledTimes(1);
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(wire.starts).toEqual([0, 2000]);
  vi.setSystemTime(new Date("2020-01-01"));
  await vi.advanceTimersByTimeAsync(1099);
  expect(wire.request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all([pending, next, last]);
  expect(wire.starts).toEqual([0, 2000, 3100]);
});

it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fd00::1"])(
  "denies a private DNS result from the actual HTTPS lookup callback: %s", async (address) => {
    const wire = transport([{ addresses: [{ address, family: address.includes(":") ? 6 : 4 }] }]);
    await expect(new ProviderNetwork(ua, wire).get(mb, signal(), { kind: "musicbrainz" }))
      .rejects.toMatchObject({ code: "denied" });
    expect(wire.lookup).toHaveBeenCalledWith("musicbrainz.org", expect.objectContaining({ all: true }), expect.any(Function));
  },
);

it("denies mixed DNS answers and sanitizes DNS/transport failures", async () => {
  const wire = transport([
    { addresses: [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.2", family: 4 }] },
    { dnsError: new Error("private hostname and resolver detail") },
    { error: new Error("secret URL transport failure") },
  ]);
  const network = new ProviderNetwork(ua, wire);
  for (const code of ["denied", "unavailable", "unavailable"]) {
    const result = network.get(mb, signal(), { kind: "musicbrainz" });
    const assertion = expect(result).rejects.toMatchObject({ code, message: `Album provider ${code === "denied" ? "request denied" : "unavailable"}` });
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
  }
});

it("follows four narrowly scoped CAA redirects with DNS checks and budget per hop", async () => {
  const locations = [
    archive,
    `https://s3.us.archive.org/mbid-${release}/index.json`,
    `https://ia123456.us.archive.org/12/items/mbid-${release}/index.json`,
    `https://ia654321.us.archive.org/download/mbid-${release}/index.json`,
  ];
  const wire = transport([...locations.map((location) => ({ status: 302, headers: { location } })), {}]);
  const budget = { remaining: 5 };
  const result = new ProviderNetwork(ua, wire).get(manifest, signal(), { kind: "caa-manifest", releaseId: release, budget });
  await vi.advanceTimersByTimeAsync(4400);
  expect((await result).type).toBe("application/json");
  expect(wire.urls.map((url) => url.href)).toEqual([manifest, ...locations]);
  expect(wire.lookup).toHaveBeenCalledTimes(5);
  expect(wire.starts).toEqual([0, 1100, 2200, 3300, 4400]);
  expect(budget.remaining).toBe(0);
});

it("accepts scoped image redirects and optional initial .jpg", async () => {
  const wire = transport([
    { status: 307, headers: { location: archiveImage, "set-cookie": ["private=secret"] } },
    { headers: { "content-type": "image/jpeg" }, chunks: [Buffer.from("jpeg")] },
  ]);
  const result = new ProviderNetwork(ua, wire).get(`${image}.jpg`, signal(), {
    kind: "caa-image", releaseId: release, imageId: "12345",
  });
  await vi.advanceTimersByTimeAsync(1100);
  expect(await result).toEqual({ bytes: Buffer.from("jpeg"), type: "image/jpeg" });
  expect(wire.headers).toEqual(Array.from({ length: 2 }, () => ({ "User-Agent": ua, Accept: "image/jpeg, image/png" })));
});

it.each([
  { kind: "caa-manifest" as const, url: manifest, filename: "index.json", type: "application/json" },
  { kind: "caa-image" as const, url: image, filename: `mbid-${release}-12345-1200.jpg`, type: "image/jpeg" },
])("accepts the observed narrowly scoped Canadian archive CDN for $kind", async ({ kind, url, filename, type }) => {
  const location = `https://dn711103.ca.archive.org/0/items/mbid-${release}/${filename}`;
  const wire = transport([
    { status: 302, headers: { location } },
    { headers: { "content-type": type } },
  ]);
  const result = new ProviderNetwork(ua, wire).get(url, signal(), { kind });
  await vi.advanceTimersByTimeAsync(1100);
  expect((await result).type).toBe(type);
  expect(wire.urls[1]?.href).toBe(location);
  expect(wire.lookup).toHaveBeenCalledTimes(2);
});

it.each([
  archive.replace(release, other),
  archive.replace("archive.org", "anything.archive.org"),
  archive.replace("archive.org", "archive.org.evil"),
  archive.replace("archive.org", "ia12345.us.archive.org"),
  archive.replace("archive.org", "archive.org:443"),
  archive.replace("archive.org", "user@archive.org"),
  archive.replace("https:", "http:"),
  archive.replace("index.json", "%69ndex.json"),
  archive.replace("index.json", "../index.json"),
  archive.replace("index.json", "other.json"),
  `${archive}?signature=private`,
  `${archive}#secret`,
  `https://ia123456.us.archive.org/123/items/mbid-${release}/index.json`,
  `https://dn711103.ca.archive.org/0/items/mbid-${other}/index.json`,
  `https://dn711103.ca.archive.org/0/items/mbid-${release}/other.json`,
  `https://dn711103.ca.archive.org/123/items/mbid-${release}/index.json`,
  `https://dn711103.ca.archive.org/0/items/mbid-${release}/index.json?private=1`,
  `https://dn711103.ca.archive.org.evil/0/items/mbid-${release}/index.json`,
  `https://dn71110.ca.archive.org/0/items/mbid-${release}/index.json`,
  `https://dn711103.us.archive.org/0/items/mbid-${release}/index.json`,
  `https://ia711103.ca.archive.org/0/items/mbid-${release}/index.json`,
  "//archive.org/download/file",
  "https://127.0.0.1/download/file",
])("denies unsafe or cross-release redirect before another outbound request: %s", async (location) => {
  const wire = transport([{ status: 302, headers: { location } }]);
  await expect(new ProviderNetwork(ua, wire).get(manifest, signal(), { kind: "caa-manifest" }))
    .rejects.toMatchObject({ code: "denied" });
  expect(wire.request).toHaveBeenCalledOnce();
});

it("checks image identity, release binding, endpoint kind, and initial authority", async () => {
  const wire = transport([{ status: 302, headers: { location: archiveImage.replace("-12345-", "-99999-") } }]);
  const network = new ProviderNetwork(ua, wire);
  await expect(network.get(image, signal(), { kind: "caa-image" })).rejects.toMatchObject({ code: "denied" });
  for (const [url, options] of [
    [manifest, { kind: "caa-manifest", releaseId: other }],
    [image, { kind: "caa-image", imageId: "99999" }],
    [image, { kind: "caa-manifest" }],
    [archive, { kind: "caa-manifest" }],
    [`${manifest}?`, { kind: "caa-manifest" }],
  ] as const) await expect(network.get(url, signal(), options)).rejects.toMatchObject({ code: "denied" });
  expect(wire.request).toHaveBeenCalledOnce();
});

it("checks DNS again on redirects, including the same hostname", async () => {
  const wire = transport([
    { status: 302, headers: { location: `/release/${release}` } },
    { addresses: [{ address: "10.0.0.1", family: 4 }] },
  ]);
  const result = new ProviderNetwork(ua, wire).get(manifest, signal(), { kind: "caa-manifest" });
  const assertion = expect(result).rejects.toMatchObject({ code: "denied" });
  await vi.advanceTimersByTimeAsync(1100);
  await assertion;
  expect(wire.lookup).toHaveBeenCalledTimes(2);
});

it("does not redirect MusicBrainz or exceed four CAA redirects", async () => {
  const wire = transport(Array.from({ length: 6 }, () => ({ status: 302, headers: { location: archive } })));
  const network = new ProviderNetwork(ua, wire);
  await expect(network.get(mb, signal(), { kind: "musicbrainz" })).rejects.toMatchObject({ code: "denied" });
  const result = network.get(manifest, signal(), { kind: "caa-manifest" });
  const assertion = expect(result).rejects.toMatchObject({ code: "denied" });
  await vi.advanceTimersByTimeAsync(5500);
  await assertion;
  expect(wire.request).toHaveBeenCalledTimes(6);
});

it.each([
  { headers: { "content-type": "text/html" } },
  { headers: { "content-type": "image/jpeg" } },
  { headers: { "content-encoding": "gzip" } },
  { headers: { "content-encoding": "br" } },
  { headers: { "content-encoding": "identity, gzip" } },
  { headers: { "content-length": "999999999" } },
  { headers: { "content-length": "-1" } },
  { headers: { "content-length": "3" }, chunks: [Buffer.from("{}")] },
  { chunks: [Buffer.alloc(2), Buffer.alloc(3)] },
])("rejects invalid MIME, encoding, length and streamed size: %j", async (reply) => {
  const wire = transport([reply]);
  await expect(new ProviderNetwork(ua, wire).get(mb, signal(), { kind: "musicbrainz", maximum: 4 }))
    .rejects.toMatchObject({ code: "invalid-response" });
  expect(wire.requests[0]?.destroy).toHaveBeenCalled();
});

it.each([
  { kind: "musicbrainz" as const, url: mb, maximum: 2 * 1024 * 1024, type: "application/json" },
  { kind: "caa-manifest" as const, url: manifest, maximum: 512 * 1024, type: "application/json" },
  { kind: "caa-image" as const, url: image, maximum: 12 * 1024 * 1024, type: "image/png" },
])("never increases the default byte cap for $kind", async ({ kind, url, maximum, type }) => {
  const wire = transport([{ headers: { "content-type": type }, chunks: [Buffer.alloc(maximum), Buffer.alloc(1)] }]);
  await expect(new ProviderNetwork(ua, wire).get(url, signal(), { kind, maximum: maximum * 2 }))
    .rejects.toMatchObject({ code: "invalid-response" });
});

it("accepts identity encoding, JSON charset, and exact byte limits", async () => {
  const wire = transport([{ headers: { "content-type": "application/json; charset=utf-8", "content-encoding": "identity", "content-length": "2" } }]);
  await expect(new ProviderNetwork(ua, wire).get(mb, signal(), { kind: "musicbrainz", maximum: 2 }))
    .resolves.toEqual({ bytes: Buffer.from("{}"), type: "application/json" });
});

it("rejects non-image formats even on an allowed image URL", async () => {
  const wire = transport([{ headers: { "content-type": "image/svg+xml" } }]);
  await expect(new ProviderNetwork(ua, wire).get(image, signal(), { kind: "caa-image" }))
    .rejects.toMatchObject({ code: "invalid-response" });
});

it("times out requests at eight seconds and destroys the transport", async () => {
  const wire = transport([{ hang: true }]);
  const result = new ProviderNetwork(ua, wire).get(mb, signal(), { kind: "musicbrainz" });
  const assertion = expect(result).rejects.toMatchObject({ code: "unavailable" });
  await vi.advanceTimersByTimeAsync(7999);
  expect(wire.requests[0]?.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await assertion;
  expect(wire.requests[0]?.destroy).toHaveBeenCalledOnce();
});

it("cancels running requests without exposing caller abort reasons", async () => {
  const wire = transport([{ hang: true }]);
  const controller = new AbortController();
  const result = new ProviderNetwork(ua, wire).get(mb, controller.signal, { kind: "musicbrainz" });
  const assertion = expect(result).rejects.toMatchObject({ code: "unavailable", message: "Album provider unavailable" });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(new Error("private caller data"));
  await assertion;
  expect(wire.requests[0]?.destroy).toHaveBeenCalledOnce();
});

it("never sends or charges an already cancelled request", async () => {
  const wire = transport();
  const controller = new AbortController();
  controller.abort(new Error("private reason"));
  const budget = { remaining: 1 };
  await expect(new ProviderNetwork(ua, wire).get(mb, controller.signal, { kind: "musicbrainz", budget }))
    .rejects.toMatchObject({ code: "unavailable" });
  expect(budget.remaining).toBe(1);
  expect(wire.request).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("places redirect hops behind existing waiters without holding the scheduler slot", async () => {
  const wire = transport([{ status: 302, headers: { location: archive } }, {}, {}]);
  const network = new ProviderNetwork(ua, wire);
  const first = network.get(manifest, signal(), { kind: "caa-manifest" });
  const second = network.get(mb, signal(), { kind: "musicbrainz" });
  await vi.advanceTimersByTimeAsync(2200);
  await Promise.all([first, second]);
  expect(wire.urls.map((url) => url.href)).toEqual([manifest, mb, archive]);
  expect(wire.starts).toEqual([0, 1100, 2200]);
});

it("bounds the queue at eight, removes cancelled entries promptly, and skips cancelled outbound calls", async () => {
  const wire = transport([{ hang: true }]);
  const network = new ProviderNetwork(ua, wire);
  const active = new AbortController();
  const first = network.get(mb, active.signal, { kind: "musicbrainz" }).catch((error: unknown) => error);
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const queued = controllers.map((controller) => network.get(mb, controller.signal, { kind: "musicbrainz" }).catch((error: unknown) => error));
  await expect(network.get(mb, signal(), { kind: "musicbrainz" })).rejects.toMatchObject({ code: "busy" });
  controllers[0]!.abort();
  expect(await queued[0]).toMatchObject({ code: "unavailable" });
  const replacement = new AbortController();
  const accepted = network.get(mb, replacement.signal, { kind: "musicbrainz" }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(wire.request).toHaveBeenCalledOnce();
  replacement.abort();
  controllers.forEach((controller) => controller.abort());
  active.abort();
  await Promise.all([first, ...queued, accepted]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(wire.request).toHaveBeenCalledOnce();
});

it("applies the 45-second deadline to queue time as well as network time", async () => {
  const wire = transport(Array.from({ length: 9 }, () => ({ hang: true })));
  const network = new ProviderNetwork(ua, wire);
  const calls = Array.from({ length: 9 }, () => network.get(mb, signal(), { kind: "musicbrainz" }).catch((error: unknown) => error));
  await vi.advanceTimersByTimeAsync(45_000);
  expect(await Promise.all(calls)).toEqual(Array.from({ length: 9 }, () => expect.objectContaining({ code: "unavailable" })));
  expect(wire.request).toHaveBeenCalledTimes(6);
  expect(vi.getTimerCount()).toBe(0);
});

it("shares a mutable request budget and charges each outbound redirect", async () => {
  const wire = transport([{ status: 302, headers: { location: archive } }]);
  const network = new ProviderNetwork(ua, wire);
  const budget = { remaining: 1 };
  await expect(network.get(manifest, signal(), { kind: "caa-manifest", budget })).rejects.toMatchObject({ code: "budget" });
  expect(budget.remaining).toBe(0);
  await expect(network.get(mb, signal(), { kind: "musicbrainz", budget })).rejects.toMatchObject({ code: "budget" });
  expect(wire.request).toHaveBeenCalledOnce();
});

it("checks shared budgets again after queuing", async () => {
  const wire = transport();
  const network = new ProviderNetwork(ua, wire);
  const budget = { remaining: 1 };
  const first = network.get(mb, signal(), { kind: "musicbrainz", budget });
  const second = network.get(mb, signal(), { kind: "musicbrainz", budget });
  const assertion = expect(second).rejects.toMatchObject({ code: "budget" });
  await vi.advanceTimersByTimeAsync(1100);
  await first;
  await assertion;
  expect(wire.request).toHaveBeenCalledOnce();
});

it.each([
  { status: 429, retry: "3", expected: 3000, code: "rate-limited" },
  { status: 503, retry: "Tue, 08 Sep 2026 12:00:03 GMT", expected: 3000, code: "unavailable" },
  { status: 429, retry: "999999999", expected: 86_400_000, code: "rate-limited" },
  { status: 429, retry: "9".repeat(400), expected: 86_400_000, code: "rate-limited" },
  { status: 503, retry: "invalid private value", expected: 60_000, code: "unavailable" },
  { status: 429, retry: undefined, expected: 60_000, code: "rate-limited" },
])("surfaces bounded Retry-After and a shared fail-fast cooldown: $status / $retry", async ({ status, retry, expected, code }) => {
  const wire = transport([{ status, headers: { "retry-after": retry } }, {}]);
  const network = new ProviderNetwork(ua, wire);
  const now = Date.now();
  const result = network.get(mb, signal(), { kind: "musicbrainz" });
  const queued = new ProviderNetwork(ua, wire).get(manifest, signal(), { kind: "caa-manifest" });
  const assertions = [
    expect(result).rejects.toMatchObject({ code, retryAt: now + expected }),
    expect(queued).rejects.toMatchObject({ code: "rate-limited", retryAt: now + expected }),
  ];
  await vi.advanceTimersByTimeAsync(0);
  await Promise.all(assertions);
  await expect(network.get(mb, signal(), { kind: "musicbrainz" }))
    .rejects.toMatchObject({ code: "rate-limited", retryAt: now + expected });
  expect(wire.request).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(expected);
  await expect(network.get(mb, signal(), { kind: "musicbrainz" })).resolves.toMatchObject({ type: "application/json" });
  expect(wire.request).toHaveBeenCalledTimes(2);
});

it("maps 404 and truncated streams without leaking provider details or retrying", async () => {
  const wire = transport([{ status: 404 }, { close: true }]);
  const network = new ProviderNetwork(ua, wire);
  await expect(network.get(mb, signal(), { kind: "musicbrainz" })).rejects.toMatchObject({ code: "not-found" });
  const second = network.get(mb, signal(), { kind: "musicbrainz" });
  const assertion = expect(second).rejects.toMatchObject({ code: "unavailable" });
  await vi.advanceTimersByTimeAsync(1100);
  await assertion;
  expect(wire.request).toHaveBeenCalledTimes(2);
});
