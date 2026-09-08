import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { retryBindingSchema, type RetryBinding } from "../shared/line-in-album.js";

const DIRECTORY = "/run/sendspin-karaoke-album";
export async function retryAlbum(binding: RetryBinding, uid: number, directory = DIRECTORY): Promise<void> {
  const request = retryBindingSchema.parse(binding);
  const dir = await lstat(directory);
  const socket = await lstat(`${directory}/retry.sock`);
  if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o7777) !== 0o2750
    || !socket.isSocket() || socket.uid !== uid || socket.gid !== dir.gid
    || (socket.mode & 0o777) !== 0o660 || socket.nlink !== 1) throw new Error("Unsafe album retry socket");
  await new Promise<void>((resolve, reject) => {
    const client = createConnection({ path: `${directory}/retry.sock` });
    let result = Buffer.alloc(0);
    const finish = (error?: Error) => { clearTimeout(timer); client.destroy(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error("Retry timed out; refresh status before trying again.")), 4000);
    client.once("connect", () => {
      void lstat(directory).then((after) => {
        if (after.ino !== dir.ino || after.dev !== dir.dev) throw new Error("Album retry directory changed");
        if (client.destroyed) return;
        client.write(`${JSON.stringify({ command: "recognition-retry", ...request })}\n`);
      }).catch((error: unknown) => finish(error instanceof Error ? error : new Error("Retry unavailable")));
    });
    client.on("data", (chunk: Buffer) => {
      result = Buffer.concat([result, chunk]);
      if (result.length > 1024) { finish(new Error("Invalid retry response")); return; }
      if (!result.includes(10)) return;
      try {
        const value: unknown = JSON.parse(result.toString("utf8"));
        if (!value || typeof value !== "object" || !("ok" in value) || typeof value.ok !== "boolean") {
          throw new Error("Invalid retry response");
        }
        if (!value.ok) throw new Error("error" in value && typeof value.error === "string"
          ? value.error : "Retry rejected");
        finish();
      } catch (error) {
        finish(error instanceof Error && !(error instanceof SyntaxError)
          ? error : new Error("Invalid retry response"));
      }
    });
    client.once("error", () => finish(new Error("Retry unavailable; update or check the source service.")));
    client.once("end", () => { if (!result.includes(10)) finish(new Error("Retry service disconnected")); });
  });
}
