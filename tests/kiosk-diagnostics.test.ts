import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { KioskDiagnostics } from "../src/server/kiosk-diagnostics.js";
import { readKioskDiagnostics } from "../src/server/kiosk-diagnostics-cli.js";
import { kioskDiagnosticsSchema, type KioskPage } from "../src/shared/kiosk-diagnostics.js";
import { createApp } from "../src/server/http.js";
import { Bridge } from "../src/server/bridge.js";
import { DemoProvider } from "../src/server/demo.js";
import { SettingsStore } from "../src/server/settings.js";

const page: KioskPage = {
  queryEnabled: true, rootPath: true, bootstrapEnabled: true, stylesheetLoaded: true,
  visibility: "visible", focused: true, fullscreenMedia: true, viewportWidth: 3840, viewportHeight: 2160,
  rootCursor: "none", bodyCursor: "none", centerCursor: "none", pointerCursor: "unavailable",
  pointerObserved: false, remote: "connected",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe("bounded kiosk diagnostics", () => {
  function fixture() {
    let now = 0;
    const store = new KioskDiagnostics(() => now);
    const request = (action: "report" | "read", body: unknown, session = "a".repeat(64)) => {
      let status = 200;
      let data: unknown;
      const res = {
        status(value: number) { status = value; return res; },
        json(value: unknown) { data = value; },
      };
      store[action]({ body, headers: { cookie: `karaoke_session=${session}` } } as Request, res as Response);
      return { status, data };
    };
    return { request, advance: (ms: number) => { now += ms; } };
  }

  it("expires reports, caps page count, rate-limits updates and never exposes identities", () => {
    const f = fixture();
    const pageId = randomUUID();
    expect(f.request("report", { pageId, page }).status).toBe(200);
    expect(f.request("report", { pageId, page }).status).toBe(429);
    expect(f.request("report", { pageId, page }, "b".repeat(64)).status).toBe(409);
    for (let i = 0; i < 3; i++) expect(f.request("report", { pageId: randomUUID(), page }).status).toBe(200);
    expect(f.request("report", { pageId: randomUUID(), page }).status).toBe(429);
    f.advance(10_000);
    expect(f.request("report", { pageId, page: { ...page, focused: false, visibility: "hidden" } }).status).toBe(200);
    const result = kioskDiagnosticsSchema.parse(f.request("read", {}).data);
    expect(result.pages).toHaveLength(4);
    expect(result.pages[0]).toEqual({ ageMs: 0, page: { ...page, focused: false, visibility: "hidden" } });
    expect(JSON.stringify(result)).not.toContain(pageId);
    expect(JSON.stringify(result)).not.toContain("session");
    f.advance(35_000);
    expect(kioskDiagnosticsSchema.parse(f.request("read", {}).data).pages).toHaveLength(1);
    f.advance(10_000);
    expect(f.request("read", {}).data).toEqual({ pages: [] });
  });

  it("rejects arbitrary strings, commands, URL contents, oversized values and non-kiosk reports", () => {
    const f = fixture();
    for (const body of [
      {}, { pageId: "bad", page }, { pageId: randomUUID(), page, execute: "anything" },
      { pageId: randomUUID(), page: { ...page, queryEnabled: false } },
      { pageId: randomUUID(), page: { ...page, url: "https://example.test/?secret=value" } },
      { pageId: randomUUID(), page: { ...page, viewportWidth: 32769 } },
      { pageId: randomUUID(), page: { ...page, rootCursor: "url(secret)" } },
    ]) expect(f.request("report", body).status).toBe(400);
    expect(f.request("report", { pageId: randomUUID(), page }, "").status).toBe(403);
    expect(f.request("read", { execute: "anything" }).status).toBe(400);
    expect(f.request("read", []).status).toBe(400);
  });

  it("authenticates both HTTP routes and supports the installed SSH reader without CEC", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "karaoke-diagnostics-"));
    const settings = new SettingsStore(dir);
    await settings.init();
    const bridge = new Bridge(new DemoProvider(), { get: async () => null, put: async () => {} }, settings, true);
    const cec = { enabled: false, available: false, owned: false, message: "Off" };
    const server = createServer(createApp({ bridge, settings, cec: { status: () => cec, execute: async () => cec } }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      bridge.close();
      await rm(dir, { recursive: true, force: true });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}`;
    const session = await fetch(`${base}/api/session`);
    const token = await session.json() as { csrfToken: string };
    const headers = {
      "Content-Type": "application/json",
      Cookie: session.headers.get("set-cookie")!.split(";")[0]!,
      "X-CSRF-Token": token.csrfToken,
    };
    for (const route of ["/api/kiosk/diagnostics", "/api/kiosk/diagnostics/report"]) {
      for (const custom of [
        { "Content-Type": "application/json" },
        { ...headers, Origin: "https://evil.example" },
        { ...headers, "Sec-Fetch-Site": "cross-site" },
        { ...headers, "X-CSRF-Token": "b".repeat(64) },
      ]) expect((await fetch(`${base}${route}`, { method: "POST", headers: custom, body: "{}" })).status).toBe(403);
      expect((await fetch(`${base}${route}`)).status).toBe(404);
    }
    expect(await readKioskDiagnostics(base)).toEqual({ pages: [] });
    expect((await fetch(`${base}/api/kiosk/diagnostics/report`, {
      method: "POST", headers, body: JSON.stringify({ pageId: randomUUID(), page }),
    })).status).toBe(200);
    const result = await readKioskDiagnostics(base);
    expect(result.pages[0]?.page).toEqual(page);
    expect(result.pages[0]?.ageMs).toBeLessThan(5000);
  });
});
