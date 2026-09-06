import type { Lyrics, TimedLine } from "../shared/protocol.js";

export const MAX_LYRICS_BYTES = 256 * 1024;
export const MAX_LINES = 4000;

export function parseLyrics(text: string | null): Lyrics {
  if (!text?.trim()) return { status: "missing", lines: [], plain: null, message: "No lyrics provided for this track." };
  if (Buffer.byteLength(text, "utf8") > MAX_LYRICS_BYTES) throw new Error("lyrics_too_large");
  const rows = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  if (rows.length > MAX_LINES) throw new Error("too_many_lyric_lines");
  let offset = 0;
  for (const row of rows) {
    const match = /^\s*\[offset:([+-]?\d+)\]\s*$/i.exec(row);
    if (match) {
      offset = Number(match[1]);
      if (!Number.isSafeInteger(offset) || Math.abs(offset) > 3_600_000) throw new Error("invalid_lrc_offset");
    }
  }
  const lines: TimedLine[] = [];
  for (const row of rows) {
    const timestamps: number[] = [];
    let remaining = row.trim();
    let match: RegExpExecArray | null;
    while ((match = /^\[(\d{1,4}):([0-5]\d)(?:[.:](\d{1,3}))?\]/.exec(remaining))) {
      const timeMs = Number(match[1]) * 60_000 + Number(match[2]) * 1000 + Number((match[3] ?? "").padEnd(3, "0"));
      timestamps.push(Math.max(0, timeMs + offset));
      remaining = remaining.slice(match[0].length);
    }
    // Enhanced/word-level LRC is deliberately reduced to the supported line-level baseline.
    const content = remaining.replace(/<\d{1,4}:[0-5]\d(?:[.:]\d{1,3})?>/g, "").trim();
    for (const timeMs of timestamps) lines.push({ timeMs, text: content });
    if (lines.length > MAX_LINES) throw new Error("too_many_lyric_lines");
  }
  if (!lines.length) return { status: "plain", lines: [], plain: text.trim(), message: "Lyrics have no usable line timestamps." };
  lines.sort((a, b) => a.timeMs - b.timeMs);
  return { status: "timed", lines, plain: null, message: null };
}
