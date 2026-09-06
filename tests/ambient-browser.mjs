// Hardware-free production Chrome study. Build first, then:
// node tests/ambient-browser.mjs <artifact-directory>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import WebSocket from "ws";
import { BUILTIN_BACKGROUNDS, DEFAULT_AMBIENT } from "../dist/server/shared/ambient.js";
import { AMBIENT_LIMITS } from "../dist/server/server/ambient.js";

const output = path.resolve(process.argv[2] ?? "artifacts/ambient-browser");
await mkdir(output, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expectedIds = ["builtin-golden-gate", "builtin-lone-pine", "builtin-rockaway", "builtin-bonzai"];
const clients = new Set();
const mutations = [];
let sequence = 0;
let state;
let browser;
let socket;
let profileDirectory;
let cdp;
let heartbeat;
const report = {
  startedAt: new Date().toISOString(),
  qualifications: [
    "Real installed Chrome rendering dist/web; synthetic same-origin HTTP/SSE/settings fixture, not the production backend.",
    "No Music Assistant, credentials, CEC, media playback, or hardware actions.",
    "CPU throttle is Chrome renderer throttling, NOT Raspberry Pi emulation or a Pi performance guarantee.",
    "TaskDuration / elapsed time is renderer-main-thread busy time, NOT whole-process CPU utilization.",
    "JS heap and DOM counters exclude decoded image/GPU/native memory. On Windows, explicit PIDs from this Chrome's CDP process list are sampled separately.",
    "Windows working set is resident memory (shared pages can be double-counted across processes); private bytes are committed private memory, not private RSS. Neither isolates image/GPU allocations.",
    "An observer and 250ms sample timer add a small instrumentation cost. No forced garbage collection.",
    "The fixture sends unchanged state heartbeats every second, keeping production controls connected during long measurements.",
    "Phase task-duration deltas include DOM instrumentation and screenshot work; renderer busy percentages use the CDP metrics timestamp interval, not Windows process-sampling latency.",
    "Offline means browser page requests restricted to the local origin, not OS-wide networking disabled.",
    "Output image metadata verifies real 3840x2160 encoded assets, not a downscaled display proxy; provenance is a separate asset audit.",
  ],
  assets: [],
  runs: [],
};
const send = (changes = {}) => {
  state = { ...state, ...changes, sequence: ++sequence };
  for (const client of clients) client.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
};
const app = express();
app.use(express.json());
app.get("/api/state", (_req, res) => res.json(state));
app.get("/api/session", (_req, res) => res.json({ csrfToken: "ambient-synthetic-only" }));
app.get("/api/backgrounds", (_req, res) => res.json({
  images: BUILTIN_BACKGROUNDS,
  limits: AMBIENT_LIMITS,
}));
app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  clients.add(res);
  req.on("close", () => clients.delete(res));
});
app.post("/api/settings", (req, res) => {
  if (req.get("X-CSRF-Token") !== "ambient-synthetic-only") return res.status(403).json({ error: "Fixture token required" });
  if (!req.body.ambient || Object.keys(req.body).some((key) => key !== "ambient")) {
    return res.status(400).json({ error: "Only synthetic ambient settings are accepted" });
  }
  mutations.push({ at: Date.now(), ambient: req.body.ambient });
  send({ ambient: { ...state.ambient, ...req.body.ambient } });
  res.json({ ok: true });
});
app.use("/api", (_req, res) => res.status(404).json({ error: "Not implemented in isolated fixture" }));
app.get("/favicon.ico", (_req, res) => res.status(204).end());
app.use(express.static(path.resolve("dist", "web")));
const server = createServer(app);

const instrumentation = `(() => {
  window.ambientStudy = { phase: "mount", samples: [], transitions: [], maxSceneImages: 0, phaseMax: {} };
  const sample = () => {
    const s = window.ambientStudy;
    const scene = document.querySelector(".ambient-scene");
    const count = scene?.querySelectorAll("img").length ?? 0;
    s.maxSceneImages = Math.max(s.maxSceneImages, count);
    s.phaseMax[s.phase] = Math.max(s.phaseMax[s.phase] ?? 0, count);
    const id = scene?.dataset.sceneId ?? null;
    if (s.transitions.at(-1)?.id !== id) s.transitions.push({ phase: s.phase, at: performance.now(), id, count });
    return { phase: s.phase, at: performance.now(), id, sceneImages: count,
      domElements: document.getElementsByTagName("*").length,
      heapBytes: performance.memory?.usedJSHeapSize ?? null,
      libraryImages: document.querySelectorAll(".ambient-image-grid img").length };
  };
  new MutationObserver(sample).observe(document, { subtree: true, childList: true, attributes: true });
  setInterval(() => ambientStudy.samples.push(sample()), 250);
})();`;

try {
  assert.equal(BUILTIN_BACKGROUNDS.length, 34, "production catalog must contain 34 built-ins");
  for (const id of expectedIds) assert.ok(BUILTIN_BACKGROUNDS.some((image) => image.id === id), `retained id ${id}`);
  assert.deepEqual(DEFAULT_AMBIENT.selectedIds, BUILTIN_BACKGROUNDS.map((image) => image.id));
  for (const image of BUILTIN_BACKGROUNDS) {
    assert.equal(image.width, 3840);
    assert.equal(image.height, 2160);
    assert.ok(image.thumbnailUrl, `${image.id} thumbnail URL`);
    const asset = { id: image.id, title: image.title, variants: {} };
    for (const [variant, url, dimensions] of [
      ["full", image.url, [3840, 2160]], ["thumbnail", image.thumbnailUrl, [480, 270]],
    ]) {
      assert.ok(url.startsWith("/") && !url.startsWith("//"), "asset must be same-origin");
      const file = path.join("dist", "web", ...new URL(url, "http://fixture.invalid").pathname.split("/").filter(Boolean));
      const buffer = await readFile(file);
      const metadata = await sharp(buffer).metadata();
      assert.deepEqual([metadata.width, metadata.height], dimensions, `${image.id} ${variant} encoded dimensions`);
      asset.variants[variant] = { url, width: metadata.width, height: metadata.height, bytes: buffer.length, format: metadata.format };
    }
    report.assets.push(asset);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  report.fixtureOrigin = origin;
  heartbeat = setInterval(() => { if (state && clients.size) send(); }, 1000);
  profileDirectory = await mkdtemp(path.resolve(".ambient-chrome-"));
  browser = spawn(process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${profileDirectory}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const endpoint = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("Chrome CDP startup timed out")), 15_000);
    browser.once("error", (error) => { clearTimeout(timer); reject(error); });
    browser.once("exit", () => { clearTimeout(timer); reject(new Error("Chrome exited before CDP")); });
    browser.stderr.on("data", (chunk) => {
      text = (text + chunk).slice(-8192);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let id = 0;
  const requests = new Map();
  const handlers = new Map();
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes);
    if (message.method) handlers.get(message.sessionId)?.(message);
    const pending = requests.get(message.id);
    if (!pending) return;
    requests.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
    else pending.resolve(message.result);
  });
  cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { requests.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    requests.set(requestId, { resolve, reject, timer, method });
    socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  report.browser = await cdp("Browser.getVersion");
  const processMemory = async () => {
    if (process.platform !== "win32") return { available: false, reason: "Windows Get-Process sampling is unavailable on this platform." };
    try {
      const { processInfo } = await cdp("SystemInfo.getProcessInfo");
      const processes = processInfo.filter((entry) => Number.isSafeInteger(entry.id) && entry.id > 0);
      assert.ok(processes.length, "Chrome returned explicit process IDs");
      const command = `$ids=@(${processes.map((entry) => entry.id).join(",")}); ` +
        `@(Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { ` +
        `[pscustomobject]@{pid=$_.Id;workingSetBytes=$_.WorkingSet64;privateMemoryBytes=$_.PrivateMemorySize64;cpuTotalSeconds=$_.CPU}` +
        ` }) | ConvertTo-Json -Compress`;
      const started = Date.now();
      const stdout = await new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
          windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        let errors = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("Get-Process sampling timed out")); }, 10_000);
        child.stdout.on("data", (chunk) => { text += chunk; });
        child.stderr.on("data", (chunk) => { errors += chunk; });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(text);
          else reject(new Error(errors || `Get-Process exited ${code}`));
        });
      });
      const decoded = JSON.parse(stdout.replace(/^\uFEFF/, ""));
      const samples = (Array.isArray(decoded) ? decoded : [decoded]).map((entry) => ({
        ...entry, type: processes.find((item) => item.id === entry.pid)?.type ?? "unknown",
      }));
      return {
        available: true, at: new Date().toISOString(), samplingDurationMs: Date.now() - started,
        requestedProcessIds: processes.map((entry) => ({ pid: entry.id, type: entry.type })),
        processes: samples,
        summedWorkingSetBytes: samples.reduce((sum, entry) => sum + entry.workingSetBytes, 0),
        summedPrivateMemoryBytes: samples.reduce((sum, entry) => sum + entry.privateMemoryBytes, 0),
      };
    } catch (error) {
      return { available: false, reason: error.message };
    }
  };
  for (const [width, height] of [[1920, 1080], [3840, 2160]]) {
    for (const rate of [1, 4]) {
      state = {
        sequence: ++sequence, generation: 1, demo: false, connection: "connected",
        playback: "idle", positionMs: 0, speed: 0, visualOffsetMs: 0,
        viewMode: "ambient", ambient: { ...structuredClone(DEFAULT_AMBIENT), slideshow: false, dwellSeconds: 15 },
        precision: "ma-queue", message: null, track: null,
        lyrics: { status: "missing", lines: [], plain: null, message: null },
        cec: { enabled: false, available: false, owned: false, message: "Disabled in synthetic fixture." },
      };
      const name = `${width}x${height}-${rate}x`;
      console.log(`Ambient Chrome: ${name}`);
      const run = { name, width, height, cpuThrottleRate: rate, phases: {}, network: [], externalRequests: [], errors: [],
        injectedThumbnailFailures: [] };
      report.runs.push(run);
      const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
      let phaseName = "mount";
      let failingThumbnailUrl;
      let thumbnailFailuresRemaining = 0;
      const networkById = new Map();
      handlers.set(sessionId, (event) => {
        const { method, params } = event;
        if (method === "Fetch.requestPaused") {
          const local = params.request.url.startsWith(`${origin}/`);
          if (!local) run.externalRequests.push(params.request.url);
          if (local && params.request.url === failingThumbnailUrl && thumbnailFailuresRemaining > 0) {
            thumbnailFailuresRemaining--;
            run.injectedThumbnailFailures.push({ requestId: params.networkId, url: params.request.url });
            void cdp("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 404,
              responseHeaders: [{ name: "Content-Type", value: "text/plain" }], body: Buffer.from("Synthetic missing thumbnail").toString("base64"),
            }, sessionId).catch((error) => run.errors.push(error.message));
            return;
          }
          void cdp(local ? "Fetch.continueRequest" : "Fetch.failRequest", {
            requestId: params.requestId, ...(!local ? { errorReason: "BlockedByClient" } : {}),
          }, sessionId).catch((error) => run.errors.push(error.message));
        }
        if (method === "Network.requestWillBeSent") {
          const item = { requestId: params.requestId, phase: phaseName, url: params.request.url, type: params.type };
          run.network.push(item);
          networkById.set(params.requestId, item);
        }
        if (method === "Network.responseReceived") {
          Object.assign(networkById.get(params.requestId) ?? {}, { status: params.response.status, mimeType: params.response.mimeType,
            fromDiskCache: params.response.fromDiskCache ?? false });
        }
        if (method === "Network.loadingFinished") {
          Object.assign(networkById.get(params.requestId) ?? {}, { encodedDataLength: params.encodedDataLength });
        }
        if (method === "Runtime.exceptionThrown") run.errors.push(params.exceptionDetails.text);
      });
      const evaluate = async (expression) => {
        const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.result.description ?? result.exceptionDetails.text);
        return result.result.value;
      };
      const until = async (expression, message, timeout = 20_000) => {
        const deadline = Date.now() + timeout;
        while (!await evaluate(expression)) {
          assert.ok(Date.now() < deadline, `${name}: ${message}`);
          await wait(100);
        }
      };
      const snapshot = async () => ({
        metrics: Object.fromEntries((await cdp("Performance.getMetrics", {}, sessionId)).metrics.map((m) => [m.name, m.value])),
        dom: await cdp("Memory.getDOMCounters", {}, sessionId),
        images: await evaluate(`Array.from(document.querySelectorAll(".ambient-scene img")).map(i => ({
          src: i.currentSrc, width: i.naturalWidth, height: i.naturalHeight, complete: i.complete
        }))`),
        processMemory: await processMemory(),
      });
      const phase = async (label, action) => {
        phaseName = label;
        await evaluate(`ambientStudy.phase = ${JSON.stringify(label)}`);
        const started = Date.now();
        const before = await snapshot();
        await action();
        const after = await snapshot();
        const elapsedMs = Date.now() - started;
        const delta = Object.fromEntries(Object.entries(after.metrics).filter(([key]) => /Duration|Count/.test(key))
          .map(([key, value]) => [key, value - (before.metrics[key] ?? 0)]));
        const measuredMs = (after.metrics.Timestamp - before.metrics.Timestamp) * 1000;
        run.phases[label] = { elapsedMs, measuredMs, before, after, delta,
          rendererBusyPercent: delta.TaskDuration * 100_000 / measuredMs };
      };
      const screenshot = async (label) => {
        const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
        const buffer = Buffer.from(image.data, "base64");
        await writeFile(path.join(output, `${name}-${label}.png`), buffer);
        if (width === 3840) await sharp(buffer).jpeg({ quality: 90 }).toFile(path.join(output, `${name}-${label}.jpg`));
      };
      const openLibrary = async () => {
        await evaluate(`window.dispatchEvent(new Event("pointermove")); document.querySelector(".ambient-library > summary").click()`);
        await until(`document.querySelector(".ambient-library")?.open && document.querySelectorAll(".ambient-image-grid img").length === 34`,
          "full collection opens");
      };
      const closeLibrary = () => evaluate(`document.querySelector(".ambient-library > summary").click(); document.activeElement?.blur()`);
      const showOnly = async (index) => {
        const selected = BUILTIN_BACKGROUNDS[index];
        await evaluate(`document.querySelectorAll('.ambient-image-grid button[aria-label^="Show only"]')[${index}].click()`);
        await until(`document.querySelector(".ambient-scene")?.dataset.sceneId === ${JSON.stringify(selected.id)}
          && document.querySelector(".ambient-save")?.disabled === true`, "Show only changes the scene");
        const deadline = Date.now() + 10_000;
        while (state.ambient.slideshow || state.ambient.selectedIds.length !== 1 || state.ambient.selectedIds[0] !== selected.id) {
          assert.ok(Date.now() < deadline, "synthetic service receives single-selection settings");
          await wait(100);
        }
        await wait(1500);
      };
      await cdp("Page.enable", {}, sessionId);
      await cdp("Runtime.enable", {}, sessionId);
      await cdp("Network.enable", {}, sessionId);
      await cdp("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
      await cdp("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
      await cdp("Performance.enable", {}, sessionId);
      await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      await cdp("Emulation.setCPUThrottlingRate", { rate }, sessionId);
      await cdp("Page.addScriptToEvaluateOnNewDocument", { source: instrumentation }, sessionId);
      await cdp("Page.navigate", { url: `${origin}/` }, sessionId);
      await until(`document.querySelector(".ambient-slide-current")?.naturalWidth === 3840`, "real 4K scene loads");
      await evaluate(`Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Hide controls").click()`);
      await until(`document.querySelector(".display-header")?.hidden === true`, "controls hidden through production UI");
      await phase("static", async () => {
        await wait(5500);
        assert.equal(await evaluate(`document.querySelectorAll(".ambient-scene img").length`), 1);
      });
      await screenshot("static");
      const beforeLibrary = run.network.length;
      await phase("library", async () => {
        await openLibrary();
        await wait(800);
        await screenshot("library");
        for (let index = 0; index < BUILTIN_BACKGROUNDS.length; index++) {
          await evaluate(`document.querySelectorAll(".ambient-image-grid li")[${index}].scrollIntoView({block:"center"})`);
          await until(`(() => { const i = document.querySelectorAll(".ambient-image-grid img")[${index}];
            return i.complete && i.naturalWidth === 480 && i.naturalHeight === 270; })()`, `thumbnail ${index} loads at 480x270`);
          await wait(60);
        }
        run.thumbnailDOM = await evaluate(`Array.from(document.querySelectorAll(".ambient-image-grid img")).map(i => ({
          src: i.currentSrc, width: i.naturalWidth, height: i.naturalHeight, complete: i.complete
        }))`);
        await screenshot("library-last");
        const fullUrls = new Set(BUILTIN_BACKGROUNDS.map((image) => origin + image.url));
        const libraryRequests = run.network.slice(beforeLibrary);
        run.libraryFullImageRequests = libraryRequests.filter((request) => fullUrls.has(request.url));
        assert.equal(run.libraryFullImageRequests.length, 0, "opening/scrolling library never requests full scene images");
        assert.equal(new Set(run.thumbnailDOM.map((image) => image.src)).size, 34);
        for (const image of run.thumbnailDOM) assert.deepEqual([image.width, image.height], [480, 270]);
      });
      await phase("single-selection", () => showOnly(2));
      assert.deepEqual(state.ambient.selectedIds, ["builtin-rockaway"]);
      await closeLibrary();
      await wait(1500);
      await screenshot("selected-static");
      await phase("slideshow", async () => {
        await openLibrary();
        await evaluate(`document.querySelector(".ambient-library-panel").scrollTop = 0;
          Array.from(document.querySelectorAll(".ambient-collection-actions button")).find(b => b.textContent === "Clear selection").click()`);
        await wait(100);
        for (const index of [2, 4]) {
          await evaluate(`document.querySelectorAll(".ambient-image-grid li")[${index}].querySelector('input[type="checkbox"]').click()`);
          await wait(100);
        }
        await evaluate(`document.querySelector('.ambient-preference-fields input[type="checkbox"]').click()`);
        await wait(100);
        await evaluate(`document.querySelector(".ambient-save").click()`);
        await until(`Array.from(document.querySelectorAll('[role="status"]')).some(e =>
          e.textContent.includes("Ambient settings saved."))`, "slideshow selection saved");
        assert.deepEqual(state.ambient.selectedIds, [BUILTIN_BACKGROUNDS[2].id, BUILTIN_BACKGROUNDS[4].id]);
        assert.equal(state.ambient.slideshow, true);
        assert.equal(state.ambient.dwellSeconds, 15);
        const startId = await evaluate(`document.querySelector(".ambient-scene").dataset.sceneId`);
        run.slideshowStart = await evaluate("performance.now()");
        await closeLibrary();
        await wait(12_000);
        assert.equal(await evaluate(`document.querySelector(".ambient-scene").dataset.sceneId`), startId, "15s dwell does not advance at 12s");
        await until(`document.querySelector(".ambient-scene").dataset.sceneId !== ${JSON.stringify(startId)}`, "real 15s slideshow timer advances", 10_000);
        run.slideshowAdvance = await evaluate("performance.now()");
        assert.ok(run.slideshowAdvance - run.slideshowStart >= 14_000, "actual timer, not accelerated virtual time");
        await wait(1600);
        assert.equal(await evaluate(`document.querySelectorAll(".ambient-scene img").length`), 1, "previous frame retired after crossfade");
      });
      await phase("reduced-motion", async () => {
        await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, sessionId);
        await until(`document.querySelector(".ambient-scene")?.classList.contains("reduced-motion")`, "reduced motion is active");
        await openLibrary();
        await showOnly(1);
        run.reducedMotion = await evaluate(`({matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
          transition: getComputedStyle(document.querySelector(".ambient-slide-current")).transitionDuration,
          images: document.querySelectorAll(".ambient-scene img").length})`);
        assert.equal(run.reducedMotion.matches, true);
        assert.equal(run.reducedMotion.transition, "0s");
        assert.equal(run.reducedMotion.images, 1);
        await closeLibrary();
      });
      run.study = await evaluate("ambientStudy");
      assert.equal(run.study.maxSceneImages, 2, "observed crossfade is bounded to current plus previous");
      assert.ok(run.study.phaseMax["reduced-motion"] <= 1, "reduced motion never retains a previous frame");
      phaseName = "thumbnail-failure";
      failingThumbnailUrl = origin + BUILTIN_BACKGROUNDS[0].thumbnailUrl;
      thumbnailFailuresRemaining = 2;
      await cdp("Page.reload", { ignoreCache: true }, sessionId);
      await until(`document.querySelector(".ambient-slide-current")?.naturalWidth === 3840`, "failure fixture reloads real scene");
      await phase("thumbnail-failure", async () => {
        const start = run.network.length;
        await evaluate(`document.querySelector(".ambient-library > summary").click()`);
        const retry = `document.querySelector('.ambient-image-grid button[aria-label^="Retry preview for"]')`;
        await until(`!!${retry}`, "missing thumbnail displays an explicit retry control");
        run.previewFailureText = await evaluate(`document.querySelector(".ambient-preview-unavailable").textContent`);
        assert.match(run.previewFailureText, /Preview unavailable/);
        await screenshot("preview-unavailable");
        await evaluate(`${retry}.click()`);
        await until(`!!${retry}`, "a failed retry stays explicit without requesting the full scene");
        await evaluate(`${retry}.click()`);
        await until(`(() => { const image = document.querySelector(".ambient-image-grid li img");
          return image?.complete && image.naturalWidth === 480 && image.naturalHeight === 270; })()`, "retry recovers a bounded 480x270 preview");
        const fullUrls = new Set(BUILTIN_BACKGROUNDS.map((image) => origin + image.url));
        run.previewFailureFullImageRequests = run.network.slice(start).filter((request) => fullUrls.has(request.url));
        assert.equal(run.previewFailureFullImageRequests.length, 0, "preview errors/retries never fall back to full-resolution images");
        assert.equal(run.injectedThumbnailFailures.length, 2, "first request and deliberate retry received real HTTP 404 responses");
      });
      assert.equal(run.externalRequests.length, 0, "no external page requests, even with full collection scroll");
      assert.deepEqual(run.errors, [], "no uncaught browser errors");
      assert.deepEqual(run.network.filter((request) => request.status >= 400 &&
        !run.injectedThumbnailFailures.some((failure) => failure.requestId === request.requestId)), [],
      "no unexpected failed HTTP assets or fixture requests");
      run.passed = true;
      await writeFile(path.join(output, `${name}.json`), JSON.stringify(run, null, 2));
      await cdp("Target.closeTarget", { targetId });
      handlers.delete(sessionId);
    }
  }
  report.mutations = mutations;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "metrics.json"), JSON.stringify(report, null, 2));
  if (socket?.readyState === WebSocket.OPEN && cdp) await cdp("Browser.close").catch(() => {});
  socket?.close();
  if (browser && browser.exitCode === null) {
    await Promise.race([new Promise((resolve) => browser.once("exit", resolve)), wait(3000)]);
    if (browser.exitCode === null) browser.kill();
  }
  clearInterval(heartbeat);
  for (const client of clients) client.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
console.log(JSON.stringify({ passed: report.passed, output, runs: report.runs.length, failure: report.failure?.message }));
