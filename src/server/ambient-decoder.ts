import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_PIXELS = 32_000_000;
export const MAX_DIMENSION = 16_384;
export const MAX_CANONICAL_BYTES = 8 * 1024 * 1024;
export const DECODE_TIMEOUT_MS = 10_000;
export const MAX_THUMBNAIL_BYTES = 256 * 1024;

export class AmbientError extends Error {
  constructor(readonly status: number, message: string, options?: ErrorOptions) { super(message, options); }
}
export interface CanonicalImage { data: Buffer; width: number; height: number }

// Isolate native decoding so the deadline can terminate work, not merely stop awaiting it.
// Input/output, pixel count, dimensions, libvips cache/threads and V8 heap are all bounded.
const decoderProgram = `
import sharp from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("sharp")).href)};
sharp.cache(false);
sharp.concurrency(1);
const chunks = [];
let size = 0;
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > ${MAX_UPLOAD_BYTES}) throw new Error("LIMIT");
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  const image = sharp(input, { limitInputPixels: ${MAX_PIXELS}, failOn: "warning", sequentialRead: true });
  const meta = await image.metadata();
  if (!["jpeg", "png"].includes(meta.format)) throw new Error("FORMAT");
  if ((meta.pages ?? 1) !== 1) throw new Error("ANIMATED");
  if (!meta.width || !meta.height || meta.width > ${MAX_DIMENSION} || meta.height > ${MAX_DIMENSION} ||
      meta.width * meta.height > ${MAX_PIXELS}) throw new Error("LIMIT");
  const result = await image.rotate().resize({
    width: Number(process.env.AMBIENT_WIDTH), height: Number(process.env.AMBIENT_HEIGHT), fit: "inside", withoutEnlargement: true
  }).flatten({ background: "#171b21" }).jpeg({ quality: 85, chromaSubsampling: "4:2:0" })
    .timeout({ seconds: 8 }).toBuffer({ resolveWithObject: true });
  if (result.data.length > Number(process.env.AMBIENT_OUTPUT_BYTES)) throw new Error("LIMIT");
  process.stdout.write(JSON.stringify({ width: result.info.width, height: result.info.height }) + "\\n");
  process.stdout.write(result.data);
} catch (error) {
  const message = String(error?.message);
  process.stderr.write(message === "LIMIT" || message.includes("pixel limit") ? "LIMIT" :
    /timeout|timed out/i.test(message) ? "TIMEOUT" : message === "ANIMATED" ? "ANIMATED" : "INVALID");
  process.exitCode = 1;
}
`;

function prepareContainer(input: Buffer, contentType: string): Buffer {
  if (input.length === 0 || input.length > MAX_UPLOAD_BYTES) throw new AmbientError(413, "Image exceeds the 12 MiB upload limit or is empty");
  if (contentType === "image/png") {
    if (!input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new AmbientError(400, "Image does not match its PNG content type");
    }
    let offset = 8;
    let ended = false;
    let chunkCount = 0;
    const raster: Buffer[] = [input.subarray(0, 8)];
    const ancillaryLimit: Record<string, number> = { tRNS: 256, gAMA: 4, cHRM: 32, sRGB: 1, eXIf: 65_536 };
    while (offset + 12 <= input.length) {
      if (++chunkCount > 4096) throw new AmbientError(400, "PNG has too many chunks");
      const length = input.readUInt32BE(offset);
      const type = input.toString("ascii", offset + 4, offset + 8);
      if (length > input.length - offset - 12) break;
      if (type === "acTL" || type === "fcTL" || type === "fdAT") throw new AmbientError(400, "Animated or multipage images are not supported");
      if (type === "IHDR" && length === 13) {
        const width = input.readUInt32BE(offset + 8);
        const height = input.readUInt32BE(offset + 12);
        if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
          throw new AmbientError(413, "Image dimensions or pixel count exceed the limit");
        }
      }
      // Compressed text/ICC chunks can expand independently of the pixel limit.
      // Drop ancillary metadata before native parsing, retaining only bounded rendering/orientation data.
      if (type === "eXIf" && length > 65_536) throw new AmbientError(400, "PNG orientation metadata exceeds the limit");
      if ((type.charCodeAt(0) & 32) === 0 || (ancillaryLimit[type] !== undefined && length <= ancillaryLimit[type]!)) {
        raster.push(input.subarray(offset, offset + length + 12));
      }
      offset += length + 12;
      if (type === "IEND") { ended = length === 0 && offset === input.length; break; }
    }
    if (!ended) throw new AmbientError(400, "Invalid or truncated PNG image");
    return Buffer.concat(raster);
  } else if (contentType === "image/jpeg") {
    if (input[0] !== 0xff || input[1] !== 0xd8) throw new AmbientError(400, "Image does not match its JPEG content type");
    let offset = 2;
    let ended = false;
    while (offset < input.length) {
      if (input[offset++] !== 0xff) continue;
      while (input[offset] === 0xff) offset++;
      const marker = input[offset++];
      if (marker === 0xd9) { ended = offset === input.length; break; }
      if (marker === 0x00 || marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > input.length) break;
      const length = input.readUInt16BE(offset);
      if (length < 2 || length > input.length - offset) break;
      if (marker === 0xe2 && input.toString("ascii", offset + 2, offset + 6) === "MPF\0") {
        throw new AmbientError(400, "Animated or multipage images are not supported");
      }
      offset += length;
    }
    if (!ended) throw new AmbientError(400, "Invalid, truncated or multipage JPEG image");
    return input;
  } else {
    throw new AmbientError(415, "Only image/jpeg and image/png uploads are supported");
  }
}

let decoderQueue: Promise<void> = Promise.resolve();

export async function decodeAmbientImage(input: Buffer, contentType: string, signal?: AbortSignal, thumbnail = false): Promise<CanonicalImage> {
  const raster = prepareContainer(input, contentType);
  if (signal?.aborted) throw new AmbientError(408, "Image upload timed out or was cancelled");
  // Upload and preview workers share the appliance's native-memory budget.
  const operation = decoderQueue.then(() => runDecoder(raster, signal, thumbnail));
  decoderQueue = operation.then(() => {}, () => {});
  return operation;
}

async function runDecoder(raster: Buffer, signal: AbortSignal | undefined, thumbnail: boolean): Promise<CanonicalImage> {
  const width = thumbnail ? 480 : 3840;
  const height = thumbnail ? 270 : 2160;
  const maximum = thumbnail ? MAX_THUMBNAIL_BYTES : MAX_CANONICAL_BYTES;
  if (signal?.aborted) throw new AmbientError(408, "Image upload timed out or was cancelled");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=96", "--input-type=module", "--eval", decoderProgram], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, AMBIENT_WIDTH: String(width), AMBIENT_HEIGHT: String(height), AMBIENT_OUTPUT_BYTES: String(maximum) },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let reason = "";
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const aborted = () => stop(new AmbientError(408, "Image upload timed out or was cancelled"));
    const timer = setTimeout(() => stop(new AmbientError(408, "Image decoding timed out")), DECODE_TIMEOUT_MS);
    signal?.addEventListener("abort", aborted, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum + 256) { stop(new AmbientError(413, "Decoded image exceeds the output limit")); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (reason.length < 512) reason += chunk.toString().slice(0, 512 - reason.length); });
    child.on("error", (error) => { failure = error; });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (failure) { reject(failure); return; }
      if (code !== 0) {
        const error = reason === "LIMIT" ? new AmbientError(413, "Image dimensions or pixel count exceed the limit") :
          reason === "TIMEOUT" ? new AmbientError(408, "Image decoding timed out") :
          reason === "INVALID" || reason === "ANIMATED" ? new AmbientError(400, "Invalid, corrupt or unsupported image") :
          new AmbientError(503, "Image decoder unavailable; inspect service status/logs", { cause: reason || `Decoder exited with code ${code}` });
        reject(error); return;
      }
      try {
        const output = Buffer.concat(chunks);
        const newline = output.indexOf(10);
        if (newline < 1 || newline > 256) throw new Error("Invalid decoder response");
        const dimensions = JSON.parse(output.toString("utf8", 0, newline)) as { width: number; height: number };
        if (!Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) ||
            dimensions.width < 1 || dimensions.width > width || dimensions.height < 1 || dimensions.height > height) {
          throw new Error("Invalid decoder dimensions");
        }
        const data = output.subarray(newline + 1);
        if (!data.length || data.length > maximum) throw new Error("Invalid decoder image");
        resolve({ data, ...dimensions });
      } catch (error) { reject(error); }
    });
    child.stdin.end(raster);
  });
}
