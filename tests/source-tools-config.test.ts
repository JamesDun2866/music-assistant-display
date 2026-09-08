import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

const source = "a".repeat(64);
const other = "b".repeat(64);
const album = { LINE_IN_ALBUM_SOURCE_ID: source, LINE_IN_ALBUM_SOURCE_UID: "123" };

describe("source tools identity configuration", () => {
  it("remains optional and reuses a complete validated album pair", () => {
    expect(loadConfig({ DEMO_MODE: "true" }).SOURCE_TOOLS_SOURCE_ID).toBeUndefined();
    const config = loadConfig({ DEMO_MODE: "true", ...album });
    expect(config.SOURCE_TOOLS_SOURCE_ID).toBe(source);
    expect(config.SOURCE_TOOLS_SOURCE_UID).toBe(123);
  });

  it("allows an independent explicit complete pair without recognition", () => {
    const config = loadConfig({ DEMO_MODE: "true", SOURCE_TOOLS_SOURCE_ID: other, SOURCE_TOOLS_SOURCE_UID: "456" });
    expect(config.LINE_IN_ALBUM_SOURCE_ID).toBeUndefined();
    expect(config.SOURCE_TOOLS_SOURCE_ID).toBe(other);
    expect(config.SOURCE_TOOLS_SOURCE_UID).toBe(456);
  });

  it("never combines identity fields from explicit tools and album pairs", () => {
    const config = loadConfig({
      DEMO_MODE: "true", ...album, SOURCE_TOOLS_SOURCE_ID: other, SOURCE_TOOLS_SOURCE_UID: "456",
    });
    expect(config.SOURCE_TOOLS_SOURCE_ID).toBe(other);
    expect(config.SOURCE_TOOLS_SOURCE_UID).toBe(456);
    expect(config.LINE_IN_ALBUM_SOURCE_ID).toBe(source);
    expect(config.LINE_IN_ALBUM_SOURCE_UID).toBe(123);
    for (const fields of [{ SOURCE_TOOLS_SOURCE_ID: other }, { SOURCE_TOOLS_SOURCE_UID: "456" }]) {
      expect(() => loadConfig({ DEMO_MODE: "true", ...album, ...fields })).toThrow("both SOURCE_TOOLS");
    }
  });

  it.each([
    { SOURCE_TOOLS_SOURCE_ID: "", SOURCE_TOOLS_SOURCE_UID: "456" },
    { SOURCE_TOOLS_SOURCE_ID: "../state", SOURCE_TOOLS_SOURCE_UID: "456" },
    { SOURCE_TOOLS_SOURCE_ID: other, SOURCE_TOOLS_SOURCE_UID: "" },
    { SOURCE_TOOLS_SOURCE_ID: other, SOURCE_TOOLS_SOURCE_UID: "0" },
    { SOURCE_TOOLS_SOURCE_ID: other, SOURCE_TOOLS_SOURCE_UID: "4294967295" },
    { SOURCE_TOOLS_SOURCE_ID: other, SOURCE_TOOLS_SOURCE_UID: "not-a-uid" },
  ])("rejects invalid explicit fields instead of falling back: %o", (fields) => {
    expect(() => loadConfig({ DEMO_MODE: "true", ...album, ...fields })).toThrow("Invalid configuration fields");
  });

  it("validates the fallback pair even when tools configuration is independent", () => {
    expect(() => loadConfig({
      DEMO_MODE: "true", LINE_IN_ALBUM_SOURCE_ID: source, LINE_IN_ALBUM_SOURCE_UID: "4294967295",
    })).toThrow("Invalid configuration fields");
    expect(() => loadConfig({
      DEMO_MODE: "true", LINE_IN_ALBUM_SOURCE_ID: source,
      SOURCE_TOOLS_SOURCE_ID: other, SOURCE_TOOLS_SOURCE_UID: "456",
    })).toThrow("both LINE_IN_ALBUM");
  });
});
