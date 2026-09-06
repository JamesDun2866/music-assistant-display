// Explicit hardware-free browser qualification. No injection route is installed.
// Build first, then: node tests/remote-browser.mjs <artifact-directory>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { Bridge } from "../dist/server/server/bridge.js";
import { SettingsStore } from "../dist/server/server/settings.js";
import { AmbientStore } from "../dist/server/server/ambient.js";
import { DemoPlayer, DemoProvider } from "../dist/server/server/demo.js";
import { createApp } from "../dist/server/server/http.js";
import { readKioskDiagnostics } from "../dist/server/server/kiosk-diagnostics-cli.js";

const output = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "sendspin-remote-browser-artifacts"));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "sendspin-remote-browser-"));
const settings = new SettingsStore(path.join(temporary, "state"));
const ambient = new AmbientStore(path.join(temporary, "state"));
await settings.init(); await ambient.init();
const bridge = new Bridge(new DemoProvider(), { get: async () => null, put: async () => {} }, settings, true);
const demo = new DemoPlayer(bridge);
demo.action("play");
const listeners = new Set();
let registrations = 0;
const source = {
  onRemote(listener) { registrations++; listeners.add(listener); return () => listeners.delete(listener); },
  resetRemote() {},
};
const status = {
  enabled: true, available: true, owned: false, message: "SIMULATED remote transport: no HDMI device is opened.",
  remote: { enabled: true, listening: true, device: "/dev/cec1", logicalAddress: 8,
    physicalAddress: 0x1200, lastEvent: null, kioskConnected: false },
};
const appOptions = {
  settings, ambient, bridge, demo, remote: source,
  cec: { status: () => structuredClone(status), execute: async () => { throw new Error("Power controls must not run in this qualification"); } },
  artwork: (identity, signal) => demo.artwork.get(identity, signal),
};
let server = createServer(createApp(appOptions));
let browser;
let socket;
const assertions = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, description, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(50);
  }
  throw new Error(`Timed out: ${description}`);
};
const check = (name, actual, expected = true) => {
  assert.deepEqual(actual, expected, name);
  assertions.push(name);
  console.log(`PASS ${name}`);
};

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const launcher = await readFile(new URL("../scripts/kiosk.sh", import.meta.url), "utf8");
  const launcherUrl = new URL(launcher.match(/'(http:\/\/127\.0\.0\.1:8787\/[^']*)'/)[1]);
  // Use the production launcher's actual path/query with an isolated test port.
  launcherUrl.port = String(port);
  browser = spawn(process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--remote-debugging-port=0", `--user-data-dir=${path.join(temporary, "chrome")}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const endpoint = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("Chrome CDP startup timed out")), 15_000);
    browser.once("error", (error) => { clearTimeout(timer); reject(error); });
    browser.once("exit", () => { clearTimeout(timer); reject(new Error("Chrome exited before CDP was ready")); });
    browser.stderr.on("data", (chunk) => {
      text = (text + chunk.toString()).slice(-8192);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let sequence = 0;
  const requests = new Map();
  socket.on("message", (bytes) => {
    const response = JSON.parse(bytes.toString());
    const pending = requests.get(response.id);
    if (!pending) return;
    requests.delete(response.id); clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error(response.error.message));
    else pending.resolve(response.result);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
    requests.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const page = async (url) => {
    const { targetId } = await cdp("Target.createTarget", { url: "about:blank", background: true });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    await cdp("Page.enable", {}, sessionId);
    await cdp("Runtime.enable", {}, sessionId);
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp("Page.navigate", { url }, sessionId);
    return sessionId;
  };
  const evaluate = async (id, expression) => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, id);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ": " + result.result.description);
    return result.result.value;
  };
  const kiosk = await page(launcherUrl.href);
  await cdp("Page.bringToFront", {}, kiosk);
  await until(() => listeners.size === 1, "kiosk lease");
  await until(() => evaluate(kiosk, "!!document.getElementById('tab-split')"), "rendered app");
  const admin = await page(base);
  await until(() => evaluate(admin, "!!document.getElementById('tab-split')"), "admin rendered");
  await cdp("Page.bringToFront", {}, kiosk);
  await until(() => listeners.size === 1, "kiosk remains sole consumer");
  check("ordinary admin tab never adds a remote consumer", listeners.size, 1);
  await until(async () => (await readKioskDiagnostics(base)).pages.length === 1, "kiosk diagnostic report");
  check("only the explicit kiosk reports diagnostics", (await readKioskDiagnostics(base)).pages.length, 1);
  const initialReport = (await readKioskDiagnostics(base)).pages[0].page;
  check("production bootstrap and stylesheet are reported", [
    initialReport.queryEnabled, initialReport.rootPath, initialReport.bootstrapEnabled, initialReport.stylesheetLoaded,
  ], [true, true, true, true]);
  check("production kiosk root, body and center cursor are none",
    [initialReport.rootCursor, initialReport.bodyCursor, initialReport.centerCursor], ["none", "none", "none"]);
  const focus = (id, selector) => evaluate(id, `document.querySelector(${JSON.stringify(selector)}).focus(); true`);
  const focused = (id) => evaluate(id, "document.activeElement.id || document.activeElement.textContent.trim().slice(0,80)");
  const emit = async (key, repeat = false) => {
    status.remote.lastEvent = { key, at: Date.now() };
    for (const listener of listeners) listener({ type: "action", action: { key, repeat } });
    await wait(150);
  };
  const mode = () => evaluate(kiosk, "document.querySelector('.display').className");
  const screenshot = async (name) => {
    const result = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, kiosk);
    await writeFile(path.join(output, name), Buffer.from(result.data, "base64"));
  };
  await focus(admin, "#tab-split");
  await focus(kiosk, "#tab-split");
  await emit("right");
  check("remote Right moves real view-tab focus", await focused(kiosk), "tab-ambient");
  check("view-tab focus alone does not activate", (await mode()).includes("view-split"));
  await emit("select");
  await until(async () => (await mode()).includes("view-ambient"), "Ambient activation");
  check("remote OK activates Ambient", settings.viewMode, "ambient");
  check("admin focus is untouched by remote keys", await focused(admin), "tab-split");
  await focus(kiosk, ".ambient-library > summary");
  await emit("select");
  check("remote OK opens the real scene library", await evaluate(kiosk, "document.querySelector('.ambient-library').open"));
  await emit("back");
  check("Back closes the library and restores its summary focus",
    await evaluate(kiosk, "!document.querySelector('.ambient-library').open && document.activeElement.matches('.ambient-library > summary')"));
  await focus(kiosk, "#tab-ambient");
  await emit("left");
  await emit("select");
  await until(async () => (await mode()).includes("view-split"), "Split activation");
  await focus(kiosk, ".settings > summary");
  await emit("select");
  check("OK opens display settings", await evaluate(kiosk, "document.querySelector('.settings').open"));
  check("Display distinguishes no routing traffic from navigation", await evaluate(kiosk,
    "/Last routing event: none observed/.test(document.querySelector('.cec-diagnostics').textContent)"));
  status.remote.lastRouting = {
    id: 1, opcode: 0x86, source: 0, target: 15, physicalAddress: 0x1200,
    decision: "matched", acknowledgement: "sent", at: Date.now(),
  };
  bridge.changed();
  await until(() => evaluate(kiosk,
    "/Active Source acknowledgement: sent/.test(document.querySelector('.cec-diagnostics').textContent)"), "route acknowledgement diagnostics");
  check("Display shows solicited route acknowledgement without claiming TV ownership", await evaluate(kiosk,
    "/does not prove TV routing or key forwarding/.test(document.querySelector('.cec-diagnostics').textContent)"));
  await focus(kiosk, ".follow-mode-controls button:last-child");
  await emit("select");
  await until(() => settings.lyricFollowMode === "instant", "instant follow saved by remote");
  await until(() => evaluate(admin, "document.querySelector('.follow-mode-controls button:last-child').getAttribute('aria-pressed') === 'true'"), "admin receives follow setting");
  check("remote OK persists instant follow and synchronizes admin", settings.lyricFollowMode, "instant");
  await emit("select", true);
  check("held OK does not toggle follow mode back", settings.lyricFollowMode, "instant");
  await evaluate(admin, "document.querySelector('.follow-mode-controls button:first-child').click(); true");
  await until(() => settings.lyricFollowMode === "smooth", "admin changes follow without kiosk remote ownership");
  await until(() => evaluate(kiosk, "document.querySelector('.follow-mode-controls button:first-child').getAttribute('aria-pressed') === 'true'"), "kiosk receives admin follow");
  check("admin can change the TV follow mode without a physical mouse on the Pi", settings.lyricFollowMode, "smooth");
  await focus(kiosk, ".follow-mode-controls button:last-child");
  await emit("select");
  await until(() => settings.lyricFollowMode === "instant", "instant follow restored");
  const restored = new SettingsStore(path.join(temporary, "state"));
  await restored.init();
  check("instant follow survives a fresh settings store", restored.lyricFollowMode, "instant");
  await focus(kiosk, '.offset-controls button[aria-label="Show lyrics 100 milliseconds later"]');
  await emit("right");
  check("Right moves between real calibration controls", await evaluate(kiosk,
    'document.activeElement.getAttribute("aria-label")'), "Show lyrics 100 milliseconds earlier");
  await emit("select");
  await until(() => settings.visualOffsetMs === 100, "offset write");
  await until(() => evaluate(kiosk, '!document.querySelector(".offset-controls button:last-child").disabled'), "command completed");
  check("OK persists calibration without playback commands", settings.visualOffsetMs, 100);
  check("focus survives an async calibration command", await evaluate(kiosk,
    'document.activeElement.getAttribute("aria-label")'), "Show lyrics 100 milliseconds earlier");
  await screenshot("remote-settings-1080.png");
  await emit("back");
  check("Back closes settings and restores summary focus", await evaluate(kiosk,
    "!document.querySelector('.settings').open && document.activeElement.matches('.settings > summary')"));
  await emit("select", true);
  check("repeated OK cannot reopen a panel", await evaluate(kiosk, "!document.querySelector('.settings').open"));
  await focus(kiosk, "#tab-split");
  const beforeReset = await focused(kiosk);
  const routeRegistration = registrations;
  for (const listener of [...listeners]) listener({ type: "reset" });
  await until(() => registrations > routeRegistration && listeners.size === 1, "fresh lease after source reset");
  await wait(400);
  check("source reconnect does not replay an activation or move focus", await focused(kiosk), beforeReset);
  await emit("right");
  check("route-reset lease reacquires automatically and delivers the next key", await focused(kiosk), "tab-ambient");
  await focus(kiosk, "#tab-split");
  const previousRegistration = registrations;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  server = createServer(createApp(appOptions));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await until(() => registrations > previousRegistration && listeners.size === 1, "fresh authenticated lease after backend restart");
  await until(() => evaluate(kiosk, "!document.getElementById('tab-ambient').disabled"), "state stream reconnect");
  check("backend restart refreshes authorization without replay", await focused(kiosk), beforeReset);
  await emit("right");
  check("post-restart Right reaches the next view tab", await focused(kiosk), "tab-ambient");
  await emit("select");
  await until(async () => (await mode()).includes("view-ambient"), "Ambient return");
  await evaluate(kiosk, "[...document.querySelectorAll('button')].find(b=>b.textContent==='Hide controls').focus(); true");
  await emit("select");
  await until(() => evaluate(kiosk, "document.querySelector('.display').classList.contains('ambient-quiet')"), "hidden controls");
  await emit("select");
  check("first hidden-Ambient OK reveals and focuses without activation",
    await evaluate(kiosk, "!document.querySelector('.display').classList.contains('ambient-quiet') && document.activeElement.id==='tab-ambient' && !document.querySelector('.ambient-library').open"));
  check("remote navigation preserves the hidden kiosk cursor", await evaluate(kiosk, "getComputedStyle(document.activeElement).cursor"), "none");
  check("admin retains a normal pointer", await evaluate(admin, "getComputedStyle(document.documentElement).cursor !== 'none'"));
  await focus(kiosk, ".ambient-library > summary");
  await emit("select");
  await until(() => evaluate(kiosk, "document.querySelectorAll('.ambient-library input[type=checkbox]').length >= 5"), "scene choices");
  const checkbox = ".ambient-library input[type=checkbox]";
  await focus(kiosk, checkbox);
  const before = await evaluate(kiosk, `document.querySelector(${JSON.stringify(checkbox)}).checked`);
  await emit("select");
  check("OK changes an actual controlled slideshow checkbox",
    await evaluate(kiosk, `document.querySelector(${JSON.stringify(checkbox)}).checked`), !before);
  await focus(kiosk, ".ambient-save"); await emit("select");
  await until(() => settings.ambient.slideshow === !before, "saved slideshow");
  check("remote slideshow setting persists", settings.ambient.slideshow, !before);
  await focus(kiosk, ".ambient-library input[type=number]");
  await emit("right");
  check("Right edits the real controlled dwell value", await evaluate(kiosk, "document.querySelector('.ambient-library input[type=number]').value"), "61");
  await emit("down");
  check("Down leaves the numeric field without trapping focus", await evaluate(kiosk, "document.activeElement.type !== 'number'"));
  await focus(kiosk, ".ambient-save"); await emit("select");
  await until(() => settings.ambient.dwellSeconds === 61, "saved dwell time");
  check("remote dwell adjustment is persisted", settings.ambient.dwellSeconds, 61);
  await focus(kiosk, ".ambient-library-panel");
  await emit("down");
  check("Down scrolls a focused scene-library pane", await evaluate(kiosk, "document.querySelector('.ambient-library-panel').scrollTop > 0"));
  await emit("left");
  check("Left leaves the focused scroll pane", await evaluate(kiosk, "!document.activeElement.matches('.ambient-library-panel')"));
  check("kiosk directs file selection to an admin browser",
    await evaluate(kiosk, "!document.querySelector('.ambient-upload input[type=file]') && /admin browser/i.test(document.querySelector('.ambient-upload').textContent)"));
  check("normal admin still offers the native file chooser", await evaluate(admin, "!!document.querySelector('.ambient-upload input[type=file]')"));
  bridge.setConnection("disconnected", "Synthetic MA loss; no upstream accessed");
  bridge.tick();
  check("Ambient choice and calibration survive MA loss", [settings.viewMode, settings.visualOffsetMs], ["ambient", 100]);
  for (const [width, height, name] of [[1920, 1080, "1080"], [1280, 720, "720"], [390, 844, "mobile"]]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, kiosk);
    await wait(250);
    check(`${name}: no horizontal viewport overflow`, await evaluate(kiosk, "document.documentElement.scrollWidth <= innerWidth"));
    await focus(kiosk, ".ambient-save");
    await emit("back");
    check(`${name}: Back exits the scene panel without a focus trap`, await evaluate(kiosk, "!document.querySelector('.ambient-library').open"));
    await focus(kiosk, ".ambient-library > summary"); await emit("select");
    await screenshot(`remote-library-${name}.png`);
  }
  await emit("back");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 3840, height: 2160, deviceScaleFactor: 1, mobile: false }, kiosk);
  demo.action("play");
  for (const viewMode of ["now-playing", "lyrics", "split", "ambient"]) {
    await settings.set({ viewMode });
    bridge.changed();
    await until(async () => (await mode()).includes(`view-${viewMode}`), `${viewMode} 4K display`);
    await wait(500);
    check(`${viewMode}: removed branding with no placeholder`, await evaluate(kiosk,
      "document.querySelector('.wordmark, .brand-mark, .wordmark-detail') === null"));
    check(`${viewMode}: navigation and settings retained`, await evaluate(kiosk,
      "!!document.querySelector('[role=tablist]') && !!document.querySelector('.settings > summary')"));
    check(`${viewMode}: 4K layout has no horizontal overflow`, await evaluate(kiosk,
      "document.documentElement.scrollWidth <= innerWidth"));
    await screenshot(`unbranded-${viewMode}-2160.png`);
  }
  await focus(kiosk, ".settings > summary");
  await emit("select");
  const pointer = await evaluate(kiosk, `(() => {
    const rect = document.querySelector('.follow-mode-controls button').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...pointer }, kiosk);
  await until(async () => {
    const report = (await readKioskDiagnostics(base)).pages[0]?.page;
    return report?.pointerObserved && report.viewportWidth === 3840 && report.pointerCursor === "none";
  }, "4K real pointer-hover report", 15_000);
  check("hovering real kiosk controls still reports cursor none at 4K", true);
  await evaluate(kiosk, "delete document.documentElement.dataset.kiosk; true");
  await until(async () => {
    const report = (await readKioskDiagnostics(base)).pages[0]?.page;
    return report && !report.bootstrapEnabled && report.rootCursor === "other";
  }, "discriminating bootstrap failure report", 15_000);
  check("diagnostics distinguish missing bootstrap from a hidden CSS cursor", true);
  await evaluate(kiosk, "document.documentElement.dataset.kiosk = 'true'; true");
  await until(async () => (await readKioskDiagnostics(base)).pages[0]?.page.bootstrapEnabled,
    "restored bootstrap report", 15_000);
  await evaluate(admin, "document.querySelector('.settings').open = true; true");
  await evaluate(admin, "[...document.querySelectorAll('button')].find(b => b.textContent === 'Read kiosk diagnostics').click(); true");
  await until(() => evaluate(admin, "!!document.querySelector('pre[aria-label=\"Kiosk diagnostics report\"]')"),
    "admin reads authenticated kiosk diagnostics");
  check("admin can inspect TV reports without moving its focus", await evaluate(admin,
    "JSON.parse(document.querySelector('pre[aria-label=\"Kiosk diagnostics report\"]').textContent).pages.length"), 1);
  check("admin diagnostic control retains its pointer", await evaluate(admin,
    "getComputedStyle([...document.querySelectorAll('button')].find(b => b.textContent === 'Read kiosk diagnostics')).cursor !== 'none'"));
  await screenshot("follow-settings-2160.png");
  await writeFile(path.join(output, "assertions.json"), JSON.stringify({
    boundary: "Normalized RemoteSource injected into real createApp; Chrome CDP; no native CEC, MA, TV or receiver access",
    assertions, screenshots: ["remote-settings-1080.png", "remote-library-1080.png", "remote-library-720.png", "remote-library-mobile.png",
      "unbranded-now-playing-2160.png", "unbranded-lyrics-2160.png", "unbranded-split-2160.png", "unbranded-ambient-2160.png", "follow-settings-2160.png"],
  }, null, 2));
  console.log(`${assertions.length} browser assertions passed. Artifacts: ${output}`);
  await cdp("Browser.close");
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await new Promise((resolve) => { if (browser.exitCode !== null) resolve(); else browser.once("exit", resolve); });
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  bridge.close();
  // Chrome may briefly retain profile handles after the browser process exits.
  await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
