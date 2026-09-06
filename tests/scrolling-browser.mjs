// Hardware-free profiling of the production renderer with original synthetic LRC.
// Build first. node tests/scrolling-browser.mjs <artifact-directory> [--verify]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import WebSocket from "ws";
import { parseLyrics } from "../dist/server/server/lrc.js";
import { DEFAULT_AMBIENT } from "../dist/server/shared/ambient.js";

const output = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "sendspin-scrolling-profile"));
const verify = process.argv.includes("--verify");
const fourK = process.argv.includes("--4k");
const instant = process.argv.includes("--instant");
const lyricsView = process.argv.includes("--lyrics");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "sendspin-scrolling-"));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clients = new Set();
let sequence = 0;
let state;
let browser;
let socket;
const app = express();
app.get("/api/state", (_req, res) => res.json(state));
app.get("/api/session", (_req, res) => res.json({ csrfToken: "synthetic-profile-only" }));
app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  clients.add(res);
  req.on("close", () => clients.delete(res));
});
app.use(express.static(path.resolve("dist", "web")));
const server = createServer(app);
const synthetic = (count) => {
  const lrc = Array.from({ length: count }, (_, i) => {
    const seconds = i * 2;
    return `[${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.000]` +
      (i === 6 ? "" : `Cue ${i}: amber shapes cross a paper sky.`);
  }).join("\n");
  return {
    sequence: ++sequence, generation: 1, demo: false, connection: "connected",
    playback: "paused", positionMs: 8_000, speed: 0, visualOffsetMs: 0,
    viewMode: lyricsView ? "lyrics" : "split", lyricFollowMode: instant ? "instant" : "smooth",
    ambient: DEFAULT_AMBIENT, precision: "ma-queue", message: null,
    track: { identity: `synthetic-${count}`, title: "Synthetic scrolling study", artist: "Original test fixture",
      album: "No media or hardware connected", durationMs: count * 2_000, artworkUrl: null },
    lyrics: parseLyrics(lrc),
    cec: { enabled: false, available: false, owned: false, message: "Disabled in this fixture." },
  };
};
const send = (changes = {}) => {
  state = { ...state, ...changes, sequence: ++sequence };
  for (const client of clients) client.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
};

// A DevTools hook counts committed TimedLyrics work without a profiling build.
// Do not traverse the thousands of host lyric nodes on every root clock commit.
const instrumentation = `(() => {
  window.study = { phase: "mount", scrolls: [], renders: [], frames: [], commits: [], mutations: [] };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, inject: () => 1, checkDCE() {},
    onCommitFiberUnmount() {},
    onCommitFiberRoot(_id, root) {
      const now = performance.now();
      study.commits.push({ phase: study.phase, at: now });
      const visit = (node) => {
        for (; node; node = node.sibling) {
          const fn = typeof node.type === "function" ? node.type : node.type?.type;
          if (typeof fn === "function" && fn.toString().includes("lyric-line ")) {
            if (node.flags & 1) study.renders.push({ phase: study.phase, at: now });
            return;
          }
          if (node.memoizedProps?.className === "timed-lines") continue;
          if (node.child) visit(node.child);
        }
      };
      visit(root.current);
    }
  };
  const scrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function(...args) {
    if (!this.classList.contains("timed-viewport")) return scrollTo.apply(this, args);
    const start = performance.now();
    const entry = { phase: study.phase, at: start, from: this.scrollTop, ...args[0] };
    const result = scrollTo.apply(this, args);
    entry.duration = performance.now() - start;
    study.scrolls.push(entry);
    return result;
  };
  let previous;
  const frame = (at) => {
    const viewport = document.querySelector(".timed-viewport");
    study.frames.push({ phase: study.phase, at, delta: previous === undefined ? 0 : at - previous,
      top: viewport?.scrollTop ?? null });
    previous = at;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new MutationObserver((records) => {
    const count = records.filter(r => r.target.closest?.(".timed-lines")).length;
    if (count) study.mutations.push({ phase: study.phase, at: performance.now(), count });
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();`;

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8793, "127.0.0.1", resolve);
  });
  browser = spawn(process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--remote-debugging-port=0", `--user-data-dir=${path.join(temporary, "chrome")}`, "about:blank",
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
  const events = new Map();
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes);
    if (message.method) events.get(message.method)?.(message.params);
    const pending = requests.get(message.id);
    if (!pending) return;
    requests.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { requests.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    requests.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const evaluate = async (sessionId, expression) => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.result.description);
    return result.result.value;
  };
  const version = await cdp("Browser.getVersion");
  const results = [];
  const qualifications = [];
  for (const [width, height] of fourK ? [[3840, 2160]] : [[1920, 1080], [1280, 720]]) {
    for (const count of [80, 4000]) {
      for (const rate of [1, 4]) {
        state = synthetic(count);
        const name = `${height}p-${count}lines-${rate}x`;
        const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
        await cdp("Page.enable", {}, sessionId);
        await cdp("Runtime.enable", {}, sessionId);
        await cdp("Performance.enable", {}, sessionId);
        await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        await cdp("Emulation.setCPUThrottlingRate", { rate }, sessionId);
        await cdp("Page.addScriptToEvaluateOnNewDocument", { source: instrumentation }, sessionId);
        await cdp("Page.navigate", { url: "http://127.0.0.1:8793/" }, sessionId);
        const deadline = Date.now() + 20_000;
        while (!await evaluate(sessionId, "!!document.querySelector('.lyric-line.is-current')")) {
          assert.ok(Date.now() < deadline, "renderer must load"); await wait(100);
        }
        await wait(1500);
        assert.ok(await evaluate(sessionId, "study.renders.length > 0"), "React render instrumentation attached");
        const trace = [];
        events.set("Tracing.dataCollected", ({ value }) => trace.push(...value));
        await cdp("Tracing.start", { categories: "devtools.timeline,v8.execute,blink.user_timing,cc,disabled-by-default-devtools.timeline.layers", transferMode: "ReportEvents" });
        await cdp("Profiler.enable", {}, sessionId);
        await cdp("Profiler.start", {}, sessionId);
        const phases = {};
        const center = `(() => {
          const a = document.querySelector(".lyric-line.is-current").getBoundingClientRect();
          const v = document.querySelector(".timed-viewport").getBoundingClientRect();
          return (a.top + a.bottom - v.top - v.bottom) / 2;
        })()`;
        const phase = async (label, action) => {
          await evaluate(sessionId, `study.phase = ${JSON.stringify(label)}; performance.mark(${JSON.stringify(label)}); true`);
          const before = await cdp("Performance.getMetrics", {}, sessionId);
          await action();
          const after = await cdp("Performance.getMetrics", {}, sessionId);
          const values = Object.fromEntries(before.metrics.map(m => [m.name, m.value]));
          phases[label] = Object.fromEntries(after.metrics.filter(m => /Duration|Count/.test(m.name))
            .map(m => [m.name, m.value - (values[m.name] ?? 0)]));
          phases[label].centerError = await evaluate(sessionId, center);
        };
        await phase("clock-only", () => wait(1200));
        await phase("heartbeats", async () => {
          for (let i = 0; i < 3; i++) { send(); await wait(1000); }
        });
        await phase("next-cue", async () => { send({ positionMs: 10_000 }); await wait(1300); });
        const cueImage = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
        await writeFile(path.join(output, `${name}-cue.png`), Buffer.from(cueImage.data, "base64"));
        await phase("seek-with-events", async () => {
          send({ positionMs: 40_000 });
          for (let i = 0; i < 8; i++) { await wait(100); send(); }
          await wait(1600);
        });
        await phase("backward-seek", async () => { send({ positionMs: 8_000 }); await wait(1500); });
        await phase("new-generation", async () => { send({ generation: 2 }); await wait(1000); });
        await phase("new-track", async () => {
          send({ generation: 3, track: { ...state.track, identity: "next-synthetic-track" } }); await wait(1000);
        });
        await phase("revised-text", async () => {
          send({ lyrics: { ...state.lyrics, lines: state.lyrics.lines.map((line, index) =>
            index === 4 ? { ...line, text: line.text + " A second paper horizon opens." } : line) } });
          await wait(1200);
        });
        await phase("resize", async () => {
          await cdp("Emulation.setDeviceMetricsOverride", { width: width - 240, height: height - 100, deviceScaleFactor: 1, mobile: false }, sessionId);
          await wait(1500);
        });
        const centerError = await evaluate(sessionId, center);
        await phase("reduced-motion", async () => {
          await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, sessionId);
          send({ positionMs: 12_000 }); await wait(600);
        });
        const { profile } = await cdp("Profiler.stop", {}, sessionId);
        const tracingDone = new Promise(resolve => events.set("Tracing.tracingComplete", resolve));
        await cdp("Tracing.end");
        await tracingDone;
        const study = await evaluate(sessionId, "study");
        const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
        await writeFile(path.join(output, `${name}.png`), Buffer.from(image.data, "base64"));
        await writeFile(path.join(output, `${name}.cpuprofile`), JSON.stringify(profile));
        await writeFile(path.join(output, `${name}.trace.json`), JSON.stringify({ traceEvents: trace }));
        await writeFile(path.join(output, `${name}.samples.json`), JSON.stringify(study));
        const summary = { name, centerError, phases: Object.fromEntries(Object.entries(phases).map(([label, metrics]) => {
          const frames = study.frames.filter(f => f.phase === label);
          const deltas = frames.map(f => f.delta).sort((a, b) => a - b);
          const scrolls = study.scrolls.filter(s => s.phase === label);
          const moving = frames.filter((f, index) => index > 0 && f.top !== frames[index - 1].top);
          const mark = trace.find(event => event.name === label && event.cat?.includes("blink.user_timing"));
          const nextMark = trace.find(event => event.ts > mark?.ts && Object.hasOwn(phases, event.name)
            && event.cat?.includes("blink.user_timing"));
          const phaseTrace = trace.filter(event => event.ts >= mark?.ts && (!nextMark || event.ts < nextMark.ts));
          const timeline = Object.fromEntries(["Layout", "Paint", "RasterTask", "CompositeLayers", "DrawFrame"].map(eventName => {
            const entries = phaseTrace.filter(event => event.name === eventName);
            return [eventName, { count: entries.length, totalMs: entries.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000 }];
          }));
          return [label, {
            scrolls: scrolls.length,
            movingFrames: moving.length,
            // rAF timestamps are frame-start times, not instant-scroll latency measurements.
            lastMovementAfterRequestMs: scrolls.some(s => s.behavior === "smooth") && moving.length
              ? moving.at(-1).at - scrolls[0].at : null,
            timeline,
            lyricRenders: study.renders.filter(s => s.phase === label).length,
            rootCommits: study.commits.filter(s => s.phase === label).length,
            frames: frames.length, framesOver50ms: deltas.filter(d => d > 50).length,
            p95FrameMs: deltas[Math.floor(deltas.length * .95)],
            maxFrameMs: deltas.at(-1), ...metrics,
          }];
        })) };
        results.push(summary);
        console.log(`${name}: heartbeat scroll/render ${summary.phases.heartbeats.scrolls}/${summary.phases.heartbeats.lyricRenders}; ` +
          `seek+events ${summary.phases["seek-with-events"].scrolls}/${summary.phases["seek-with-events"].lyricRenders}; resize error ${centerError}px`);
        if (verify) {
          for (const label of ["clock-only", "heartbeats"]) {
            assert.equal(summary.phases[label].scrolls, 0, `${name} ${label} no repeated scroll`);
            assert.equal(summary.phases[label].lyricRenders, 0, `${name} ${label} no repeated lyric render`);
          }
          for (const label of ["next-cue", "seek-with-events", "backward-seek", "new-generation", "new-track", "revised-text"]) {
            assert.equal(summary.phases[label].scrolls, 1, `${name} ${label} one follow scroll`);
            assert.ok(Math.abs(summary.phases[label].centerError) < 1, `${name} ${label} centered`);
          }
          assert.equal(summary.phases.resize.scrolls, 1, `${name} one resize follow`);
          assert.ok(Math.abs(centerError) < 3, `${name} resize centers current line: ${centerError}`);
          assert.equal(study.scrolls.filter(s => s.phase === "reduced-motion").at(-1)?.behavior, "instant");
          if (instant) {
            const styling = await evaluate(sessionId, `(() => {
              const viewport = document.querySelector(".timed-viewport");
              const active = document.querySelector(".lyric-line.is-current");
              const neighbor = document.querySelector(".lyric-line:not(.is-current)");
              return { mask: getComputedStyle(viewport).maskImage, transition: getComputedStyle(active).transitionDuration,
                weight: getComputedStyle(active).fontWeight, neighborWeight: getComputedStyle(neighbor).fontWeight };
            })()`);
            assert.equal(styling.mask, "none");
            assert.equal(styling.transition, "0s");
            assert.equal(styling.weight, styling.neighborWeight);
            for (const label of ["next-cue", "seek-with-events", "backward-seek", "resize"]) {
              assert.ok(summary.phases[label].movingFrames <= 1, `${name} ${label} no ongoing scroll animation`);
              assert.ok(study.scrolls.filter(s => s.phase === label).every(s => s.behavior === "instant"));
            }
          }
        }
        if (verify && count === 80 && rate === 1) {
          assert.equal(await evaluate(sessionId, "document.querySelector('.wordmark, .brand-mark')"), null);
          await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
          send({ ...synthetic(count), generation: 4, positionMs: 9_500, playback: "playing", speed: 1 });
          await wait(1100);
          assert.ok(await evaluate(sessionId, "document.querySelector('.lyric-line.is-current').textContent.startsWith('Cue 5:')"),
            "the monotonic playback clock advances to the next cue without snapshots");
          send({ playback: "paused", speed: 0, positionMs: 10_000 });
          await wait(300);
          const fullSize = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
          await writeFile(path.join(output, `${height}p-split.png`), Buffer.from(fullSize.data, "base64"));
          send({ viewMode: "lyrics" });
          await wait(400);
          assert.ok(Math.abs(await evaluate(sessionId, center)) < 1, "Lyrics mode centers after wrapping");
          const lyricsImage = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
          await writeFile(path.join(output, `${height}p-lyrics.png`), Buffer.from(lyricsImage.data, "base64"));
          send({ viewMode: "now-playing" });
          await wait(300);
          assert.equal(await evaluate(sessionId, "document.querySelector('.timed-viewport') === null"), true);
          send({ viewMode: "split", positionMs: 0, visualOffsetMs: -500 });
          await wait(300);
          assert.equal(await evaluate(sessionId, "!!document.querySelector('.intro-note') && !document.querySelector('.lyric-line.is-current')"), true);
          send({ lyrics: { status: "plain", lines: [], plain: Array.from({ length: 80 }, (_, i) => `Original unsynced test row ${i}`).join("\n"), message: null } });
          await wait(300);
          await evaluate(sessionId, "document.querySelector('.plain-lyrics').focus(); true");
          await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }, sessionId);
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }, sessionId);
          await wait(400);
          const plainTop = await evaluate(sessionId, "document.querySelector('.plain-lyrics').scrollTop");
          assert.ok(plainTop > 0, "focused plain lyrics remain keyboard scrollable");
          send(); await wait(300);
          assert.equal(await evaluate(sessionId, "document.querySelector('.plain-lyrics').scrollTop"), plainTop);
          qualifications.push(`${height}p: clock cue, pause, Split/Lyrics wrapping, Now Playing, negative-offset intro, plain keyboard scroll retained through heartbeat`);
        }
        if (verify && count === 4000 && rate === 1) {
          await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, sessionId);
          await wait(1200);
          await evaluate(sessionId, "document.querySelector('.timed-viewport').focus(); true");
          await wait(100);
          await evaluate(sessionId, "study.phase = 'manual-reading'; true");
          for (let index = 0; index < 3; index++) {
            await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown",
              windowsVirtualKeyCode: 40, autoRepeat: index > 0 }, sessionId);
          }
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }, sessionId);
          const manualTop = await evaluate(sessionId, "document.querySelector('.timed-viewport').scrollTop");
          send({ positionMs: 50_000 });
          await wait(200);
          send({ positionMs: 20_000 });
          await wait(200);
          send();
          await evaluate(sessionId, "window.dispatchEvent(new Event('resize')); true");
          await wait(200);
          assert.equal(await evaluate(sessionId, "document.querySelector('.timed-viewport').scrollTop"), manualTop,
            "held-key reading is not fought by cues/seeks/heartbeats/resizes");
          assert.equal(await evaluate(sessionId, "study.scrolls.filter(s => s.phase === 'manual-reading').length"), 0);
          await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }, sessionId);
          assert.equal(await evaluate(sessionId, "document.activeElement.matches('.timed-viewport')"), false, "reading pane has a remote exit");
          await evaluate(sessionId, "document.querySelector('.lyric-follow-controls button').focus(); study.phase = 'resume'; true");
          await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
          await wait(1300);
          assert.equal(await evaluate(sessionId, "study.scrolls.filter(s => s.phase === 'resume').length"), 1, "one latest-cue resume");
          assert.ok(Math.abs(await evaluate(sessionId, center)) < 1, "resuming centers latest seek");
          await evaluate(sessionId, "study.phase = 'rapid-seeks'; true");
          send({ positionMs: 80_000 }); await wait(40);
          send({ positionMs: 30_000 }); await wait(1300);
          assert.ok(Math.abs(await evaluate(sessionId, center)) < 1, "rapid seeks finish on the latest cue, without queued animation");
          if (instant) {
            const rapid = await evaluate(sessionId, "study.scrolls.filter(s => s.phase === 'rapid-seeks')");
            assert.equal(rapid.length, 2);
            assert.ok(rapid.every(s => s.behavior === "instant"));
            const settled = await evaluate(sessionId, "document.querySelector('.timed-viewport').scrollTop");
            await wait(300);
            assert.equal(await evaluate(sessionId, "document.querySelector('.timed-viewport').scrollTop"), settled);
          }
          const point = await evaluate(sessionId, `(() => {
            const rect = document.querySelector(".timed-viewport").getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          })()`);
          await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: 180 }, sessionId);
          await wait(400);
          assert.equal(await evaluate(sessionId, "document.querySelector('.lyric-follow-controls button').textContent"), "Resume lyric follow",
            "real wheel input pauses following");
          await evaluate(sessionId, "study.phase = 'wheel-reading'; true");
          send({ positionMs: 60_000 }); await wait(300);
          assert.equal(await evaluate(sessionId, "study.scrolls.filter(s => s.phase === 'wheel-reading').length"), 0);
          qualifications.push(`${height}p/4000: held-key reading pause, cue/seek/resize protection, remote exit, one resume, rapid latest-cue seeks`);
        }
        await cdp("Target.closeTarget", { targetId });
      }
    }
  }
  await writeFile(path.join(output, "summary.json"), JSON.stringify({
    boundary: "Desktop headless Chrome, production bundle, local synthetic SSE only. CPU throttle is not Pi emulation.",
    version, mode: instant ? "instant" : "smooth", view: lyricsView ? "lyrics" : "split", results, qualifications,
  }, null, 2));
  await cdp("Browser.close");
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await new Promise(resolve => { if (browser.exitCode !== null) resolve(); else browser.once("exit", resolve); });
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
