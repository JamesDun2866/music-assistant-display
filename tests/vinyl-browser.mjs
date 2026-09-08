// Build first; hardware-free installed Chrome fixture, following ambient-browser.mjs.
// node tests\vinyl-browser.mjs <artifact-directory> [--line-in]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import WebSocket from "ws";
import { DEFAULT_AMBIENT } from "../dist/server/shared/ambient.js";
import { emptySourceTelemetry } from "../dist/server/shared/source-tools.js";

const output = path.resolve(process.argv[2] ?? ".vinyl-browser-artifacts");
const lineIn = process.argv.includes("--line-in");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, "chrome-"));
const key = `${"a".repeat(32)}-1`;
const cover = await sharp(Buffer.from(`<svg width="600" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="600" fill="#405f67"/><circle cx="300" cy="250" r="160" fill="#deb478"/><path d="M0 600L300 220L600 600" fill="#263f45"/><text x="300" y="540" fill="white" font-size="36" text-anchor="middle">SYNTHETIC RECORD</text></svg>`))
  .resize(lineIn ? 1200 : 480, lineIn ? 1200 : 270, { fit: "contain", background: "#101411" }).jpeg().toBuffer();
let sequence = 1;
let state = { sequence, generation: 1, demo: false, connection: "connected", playback: "playing",
  positionMs: 5000, speed: 1, visualOffsetMs: 250, viewMode: "vinyl", lyricFollowMode: "instant",
  vinyl: { showMeters: true, showTracklist: false }, ambient: DEFAULT_AMBIENT, precision: "ma-queue", message: null,
  track: { identity: "ma:test", title: "Forbidden MA title", album: "MA album", artist: "MA artist", durationMs: 60000, artworkUrl: null },
  lyrics: { status: "plain", lines: [], plain: "Forbidden MA lyrics", message: null },
  cec: { enabled: false, available: false, owned: false, message: "Off" } };
let long = false;
let sourceOffline = false;
const clients = new Set();
const app = express();
app.use(express.json());
app.get("/api/state", (_req, res) => res.json(state));
app.get("/api/session", (_req, res) => res.json({ csrfToken: "vinyl-fixture" }));
app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); res.flushHeaders();
  clients.add(res); req.on("close", () => clients.delete(res));
});
const send = () => {
  state.sequence = ++sequence;
  for (const client of clients) client.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
};
app.post("/api/settings", (req, res) => {
  if (req.get("X-CSRF-Token") !== "vinyl-fixture") return res.sendStatus(403);
  state = { ...state, ...req.body, vinyl: { ...state.vinyl, ...req.body.vinyl } }; send(); res.json({});
});
app.get("/api/line-in-album", (_req, res) => res.json({
  state: sourceOffline ? "offline" : "identified", expiresAt: Date.now() + 4000, key,
  album: { title: "Synthetic record", artist: "Local fixture", artworkUrl: `/api/line-in-album/artwork/${key}` },
  tracklist: { status: "complete", title: long ? "An extraordinarily long catalog album title ".repeat(8).slice(0, 256) : "Mountains at dusk",
    artist: long ? "A very long artist and orchestra credit ".repeat(8).slice(0, 256) : "The local quartet", message: null, discCount: 2,
    tracks: Array.from({ length: 200 }, (_, i) => ({ disc: Math.floor(i / 100) + 1, number: i % 100 + 1,
      title: i === 199 ? "Final track 200" : `Catalog track ${i + 1}` })) },
  ...(lineIn ? { edition: {
    binding: { sourceId: "a".repeat(64), albumKey: key, success: null, revision: 1 },
    original: { title: long ? "Original recognized album ".repeat(12).slice(0, 256) : "Mountains at dusk",
      artist: long ? "Original recognized artist ".repeat(12).slice(0, 256) : "The local quartet", country: "gb" },
    corrected: true, scope: "current-album",
    fallback: { state: "confirmation-required", retryAt: null, candidates: [],
      message: "No unique exact catalog relationship. Search and confirm the release before replacing the album." },
  } } : {}),
}));
app.get("/api/line-in-album/artwork/:key", (_req, res) => res.type("jpeg").send(cover));
app.get("/api/source-tools/telemetry", (_req, res) => res.json(emptySourceTelemetry(sourceOffline ? "offline" : "stale")));
app.use(express.static(path.resolve("dist", "web")));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const heartbeat = setInterval(send, 1000);
let browser, socket;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  browser = spawn(process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const endpoint = await new Promise((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(() => reject(new Error("Chrome startup timeout")), 15000);
    browser.once("error", reject);
    browser.stderr.on("data", (chunk) => {
      text += chunk;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const requests = new Map();
  let id = 0;
  socket.on("message", (bytes) => {
    const data = JSON.parse(bytes);
    const pending = requests.get(data.id);
    if (!pending) return;
    requests.delete(data.id); clearTimeout(pending.timeout);
    if (data.error) pending.reject(new Error(JSON.stringify(data.error))); else pending.resolve(data.result);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
    requests.set(requestId, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
  });
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const report = [];
  for (const [width, height] of [[1280, 720], [1920, 1080], [3840, 2160], [390, 844], [320, 568]]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    for (const tracks of [false, true]) {
      long = tracks; state.vinyl.showTracklist = tracks;
      await cdp("Page.navigate", { url: origin }, sessionId);
      await wait(1400);
      if (lineIn) {
        await evaluate(`document.querySelector("#tab-line-in").click()`);
        await wait(900);
        const name = `line-in-${width}x${height}-${long ? "long" : "normal"}`;
        const shot = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
        await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, "base64"));
        const layout = await evaluate(`(() => {
          const root = document.querySelector(".line-in-album"), header = root.querySelector(".album-header");
          const cover = root.querySelector(".album-cover"), tracks = root.querySelector(".album-tracklist");
          const catalog = root.querySelector(".album-catalog-status"), notes = root.querySelector(".album-notes");
          const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
          const boxes = [header,cover,tracks,catalog,notes].map(rect);
          const overlap = (a,b) => Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
          return {boxes, overlaps:boxes.flatMap((a,i)=>boxes.slice(i+1).filter(b=>overlap(a,b))),
            documentWidth:document.documentElement.scrollWidth, documentClientWidth:document.documentElement.clientWidth, stage:rect(document.querySelector("main")),
            rootWidth:root.scrollWidth, rootClientWidth:root.clientWidth,
            trackHeight:tracks.clientHeight, count:tracks.querySelectorAll("li").length,
            fit:getComputedStyle(cover.querySelector("img")).objectFit,
            contentRows:[...header.children].map(rect) };
        })()`);
        report.push({name,...layout});
        assert.ok(layout.documentWidth <= layout.documentClientWidth && layout.rootWidth <= layout.rootClientWidth + 1, `${name}: no horizontal overflow`);
        assert.ok(layout.contentRows[0].width >= 180, `${name}: readable title column`);
        assert.equal(layout.overlaps.length, 0, `${name}: album regions do not overlap: ${JSON.stringify(layout)}`);
        assert.ok(layout.trackHeight > 100, `${name}: tracklist has readable height`);
        assert.equal(layout.count, 200);
        assert.equal(layout.fit, "contain");
        assert.ok(await evaluate(`(() => {
          const pane=document.querySelector(".album-tracklist"); pane.scrollIntoView(); pane.scrollTop=pane.scrollHeight;
          const last=[...pane.querySelectorAll("li")].at(-1).getBoundingClientRect(), box=pane.getBoundingClientRect();
          return last.bottom<=box.bottom+1 && last.top>=box.top;
        })()`), `${name}: final track reachable`);
        await evaluate(`document.querySelector(".album-edition-control > button").click()`);
        await wait(100);
        assert.ok(await evaluate(`!!document.querySelector(".edition-dialog")`), `${name}: editor opens`);
        await evaluate(`document.querySelector(".edition-dialog [data-navigation-cancel]").click()`);
        continue;
      }
      const layout = await evaluate(`(() => {
        const img = document.querySelector(".vinyl-cover img"), pane = document.querySelector(".vinyl-tracklist");
        const rect = img.getBoundingClientRect(), cover = img.parentElement.getBoundingClientRect();
        const main = document.querySelector("main").getBoundingClientRect();
        return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
          image: { width: rect.width, height: rect.height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, fit: getComputedStyle(img).objectFit },
          cover: { width: cover.width, height: cover.height }, mainHeight: main.height,
          trackCount: pane?.querySelectorAll("li").length ?? 0, scrollable: pane ? pane.scrollHeight > pane.clientHeight : false,
          forbidden: document.body.innerText.includes("Forbidden MA"), progress: !!document.querySelector("progress"),
          requests: performance.getEntriesByType("resource").map(e => e.name) };
      })()`);
      assert.ok(layout.documentWidth <= width, "No horizontal document overflow");
      assert.ok(layout.mainHeight > 100);
      assert.equal(layout.image.fit, "contain", "Decoded artwork is neither cropped nor stretched");
      assert.equal(layout.image.naturalWidth / layout.image.naturalHeight, 480 / 270);
      assert.ok(layout.image.width <= layout.cover.width + 1 && layout.image.height <= layout.cover.height + 1, "Artwork fits cover");
      assert.ok(!layout.forbidden && !layout.progress, "No MA content or timing");
      assert.ok(layout.requests.every((url) => url.startsWith(origin)), "Only same-origin page resources");
      if (!tracks && width > 700) assert.ok(await evaluate(`document.querySelector(".vinyl-artist").getBoundingClientRect().bottom <= document.querySelector(".vinyl-album").getBoundingClientRect().bottom`), "Normal metadata fits without scrolling");
      if (tracks) {
        assert.equal(layout.trackCount, 200); assert.ok(layout.scrollable);
        await evaluate(`(() => { const pane=document.querySelector(".vinyl-tracklist"); pane.focus(); pane.scrollTop=pane.scrollHeight; })()`);
        assert.ok(await evaluate(`(() => { const pane=document.querySelector(".vinyl-tracklist"), last=pane.querySelector("li:last-child"); return last.getBoundingClientRect().bottom <= pane.getBoundingClientRect().bottom; })()`));
        assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), "Focus and scrolling do not widen the document");
      }
      const name = `${width}x${height}-${tracks ? "long-tracks" : "cover"}`;
      const shot = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
      await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, "base64"));
      report.push({ name, ...layout });
    }
  }
  if (!lineIn) {
  sourceOffline = true;
  await wait(850);
  assert.ok(await evaluate(`document.body.innerText.includes("Line-in source unavailable") && !!document.querySelector(".vinyl-cover img")`));
  await evaluate(`document.querySelector("main").focus()`);
  await wait(8500);
  assert.ok(await evaluate(`document.querySelector(".display").classList.contains("vinyl-quiet")`));
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
  await wait(300);
  const wake = await evaluate(`({quiet:document.querySelector(".display").classList.contains("vinyl-quiet"), active:document.activeElement.outerHTML.slice(0,400), visible:getComputedStyle(document.querySelector(".display-header")).visibility})`);
  assert.ok(!wake.quiet && wake.active.includes('id="tab-vinyl"'), JSON.stringify(wake));
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, sessionId);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector(".display-header")).transitionDuration`), "0s");
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify({ qualification: "Synthetic local browser fixtures; no live audio, Shazam, MA or Pi performance claims.", layouts: report }, null, 2));
  console.log(`Verified ${report.length} Chrome ${lineIn ? "Line-in album" : "Vinyl"} layouts and full 200-track scrolling. Artifacts: ${output}`);
  await cdp("Browser.close");
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise((resolve) => browser.once("exit", resolve)); }
  clearInterval(heartbeat); for (const client of clients) client.end();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
