import { z } from "zod";

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const schema = z.object({
  HOST: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  STATE_DIR: z.string().min(1).default("./state"),
  DEMO_MODE: bool,
  MA_URL: z.string().url().optional(),
  MA_TOKEN: z.string().min(1).optional(),
  MA_PLAYER_ID: z.string().min(1).optional(),
  MA_QUEUE_ID: z.string().min(1).optional(),
  MA_ALLOW_LYRICS_REFRESH: bool,
  MA_ALLOW_SPOTIFY_ARTWORK: bool,
  LINE_IN_ALBUM_SOURCE_ID: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  LINE_IN_ALBUM_SOURCE_UID: z.coerce.number().int().positive().max(0xfffffffe).optional(),
  SOURCE_TOOLS_SOURCE_ID: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  SOURCE_TOOLS_SOURCE_UID: z.coerce.number().int().positive().max(0xfffffffe).optional(),
  CEC_ENABLED: bool,
  CEC_REMOTE_ENABLED: bool,
  CEC_DEVICE: z.string().max(32).regex(/^\/dev\/cec(?:0|[1-9][0-9]*)$/).default("/dev/cec0"),
  CEC_ADAPTER: z.string().max(256).optional(),
  CEC_ALLOW_STANDBY: bool,
});
export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration fields: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const config = result.data;
  if ((config.LINE_IN_ALBUM_SOURCE_ID === undefined) !== (config.LINE_IN_ALBUM_SOURCE_UID === undefined)) {
    throw new ConfigError("Line-in album display requires both LINE_IN_ALBUM_SOURCE_ID and LINE_IN_ALBUM_SOURCE_UID");
  }
  if ((config.SOURCE_TOOLS_SOURCE_ID === undefined) !== (config.SOURCE_TOOLS_SOURCE_UID === undefined)) {
    throw new ConfigError("Source tools require both SOURCE_TOOLS_SOURCE_ID and SOURCE_TOOLS_SOURCE_UID");
  }
  if (config.SOURCE_TOOLS_SOURCE_ID === undefined) {
    config.SOURCE_TOOLS_SOURCE_ID = config.LINE_IN_ALBUM_SOURCE_ID;
    config.SOURCE_TOOLS_SOURCE_UID = config.LINE_IN_ALBUM_SOURCE_UID;
  }
  if (!config.DEMO_MODE) {
    if (!config.MA_URL || !config.MA_TOKEN || !config.MA_PLAYER_ID || !config.MA_QUEUE_ID) {
      throw new ConfigError("Live mode requires MA_URL, MA_TOKEN, MA_PLAYER_ID and MA_QUEUE_ID");
    }
  }
  if (config.MA_URL) {
    const url = new URL(config.MA_URL);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ConfigError("MA_URL must be an HTTP(S)/WS(S) server URL without credentials, query or fragment");
    }
  }
  return config;
}
export type Config = ReturnType<typeof loadConfig>;
