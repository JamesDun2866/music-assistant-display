import { once } from "node:events";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { isFsError } from "./cache.js";
import { MaClient } from "./ma-client.js";

async function main() {
  try { process.loadEnvFile(".env"); } catch (error) { if (!isFsError(error, "ENOENT")) throw error; }
  const config = loadConfig({ ...process.env, DEMO_MODE: "true" });
  if (!config.MA_URL || !config.MA_TOKEN) throw new Error("Set MA_URL and MA_TOKEN first.");
  const client = new MaClient(config.MA_URL, config.MA_TOKEN);
  try {
    const authenticated = once(client, "authenticated", { signal: AbortSignal.timeout(15_000) });
    client.start();
    await authenticated;
    const players = z.array(z.object({ player_id: z.string(), name: z.string().optional(), available: z.boolean().optional() }))
      .parse(await client.request("players/all"));
    const queues = z.array(z.object({ queue_id: z.string(), display_name: z.string().optional(), active: z.boolean().optional() }))
      .parse(await client.request("player_queues/all"));
    console.log(JSON.stringify({ players, queues }, null, 2));
    if (config.MA_PLAYER_ID) {
      const active = z.object({ queue_id: z.string() }).nullable()
        .parse(await client.request("player_queues/get_active_queue", { player_id: config.MA_PLAYER_ID }));
      console.log(JSON.stringify({ selectedPlayer: config.MA_PLAYER_ID, activeQueueId: active?.queue_id ?? null }, null, 2));
    }
  } finally { client.close(); }
}
void main().catch(() => {
  console.error("Discovery failed: check MA_URL, MA_TOKEN, API compatibility and network. No configuration was changed.");
  process.exitCode = 1;
});
