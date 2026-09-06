import { createServer } from "node:http";
import path from "node:path";
import { ConfigError, loadConfig } from "./config.js";
import { isFsError, LyricsCache } from "./cache.js";
import { SettingsStore } from "./settings.js";
import { Bridge } from "./bridge.js";
import { DemoPlayer, DemoProvider } from "./demo.js";
import { MaClient } from "./ma-client.js";
import { MaLyricsProvider, imageId } from "./ma-provider.js";
import { MaMonitor } from "./ma-monitor.js";
import { ArtworkStore } from "./artwork.js";
import { CecController } from "./cec.js";
import { NativeCecController } from "./cec-native.js";
import { createApp } from "./http.js";
import { log } from "./log.js";
import { AmbientStore } from "./ambient.js";

async function main(): Promise<void> {
  try { process.loadEnvFile(".env"); } catch (error) { if (!isFsError(error, "ENOENT")) throw error; }
  const config = loadConfig({ ...process.env, ...(process.argv.includes("--demo") ? { DEMO_MODE: "true" } : {}) });
  const settings = new SettingsStore(config.STATE_DIR);
  const ambient = new AmbientStore(config.STATE_DIR);
  const cache = new LyricsCache(path.join(config.STATE_DIR, config.DEMO_MODE ? "demo-cache" : "lyrics-cache"));
  await settings.init();
  await ambient.init();
  await cache.init();
  const nativeCec = config.CEC_REMOTE_ENABLED ? new NativeCecController({
    enabled: config.CEC_ENABLED && !config.DEMO_MODE,
    device: config.CEC_DEVICE,
  }) : undefined;
  const cec = nativeCec ?? new CecController({
    enabled: config.CEC_ENABLED && !config.DEMO_MODE,
    adapter: config.CEC_ADAPTER, allowStandby: config.CEC_ALLOW_STANDBY,
  });
  const client = config.DEMO_MODE ? null : new MaClient(config.MA_URL!, config.MA_TOKEN!);
  const artwork = client ? new ArtworkStore(config.MA_URL!) : null;
  const provider = client ? new MaLyricsProvider(client, config.MA_ALLOW_LYRICS_REFRESH, (identity, track) => {
    const proxyId = imageId(track);
    if (proxyId && artwork) bridge.updateArtwork(identity, artwork.set(identity, proxyId));
  }) : new DemoProvider();
  const bridge = new Bridge(provider, cache, settings, config.DEMO_MODE);
  const demo = config.DEMO_MODE ? new DemoPlayer(bridge) : undefined;
  const monitor = client && artwork ? new MaMonitor(client, bridge, config.MA_PLAYER_ID!, config.MA_QUEUE_ID!, artwork) : null;
  const server = createServer(createApp({
    bridge, settings, ambient, cec, demo, remote: nativeCec,
    ...(demo ? { artwork: (identity: string, signal: AbortSignal) => demo.artwork.get(identity, signal) } :
      artwork ? { artwork: (identity: string, signal: AbortSignal) => artwork.get(identity, signal) } : {}),
  }));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.PORT, config.HOST, () => { server.off("error", reject); resolve(); });
  });
  const tick = setInterval(() => { bridge.tick(); demo?.tick(); }, 250);
  nativeCec?.start();
  monitor?.start();
  demo?.action("play");
  log("service_started", config.DEMO_MODE ? "synthetic_demo" : "ma_queue_timing");
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(tick);
    monitor?.close();
    bridge.close();
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      cec.close(),
    ]);
    log("service_stopped");
  };
  const stop = () => {
    void close().catch(() => {
      log("shutdown_failed", "cec_shutdown_failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

void main().catch((error: unknown) => {
  log("startup_failed", error instanceof ConfigError ? error.message :
    isFsError(error, "EADDRINUSE") ? "port_in_use" :
    isFsError(error, "EACCES") ? "permission_denied" : "check_environment_state_and_build");
  process.exitCode = 1;
});
