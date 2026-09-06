import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import sharp from "sharp";
import { BUILTIN_BACKGROUNDS } from "../src/shared/ambient.js";
import { describe, expect, it } from "vitest";

describe("explicit kiosk pointer mode", () => {
  it.each(["", "?kiosk=0", "?kiosk=true", "?other=1"])("leaves normal browsers unchanged: %s", async (search) => {
    const dataset: Record<string, string> = {};
    runInNewContext(await readFile("public/kiosk-mode.js", "utf8"), {
      window: { location: { search } }, document: { documentElement: { dataset } }, URLSearchParams,
    });
    expect(dataset).toEqual({});
  });

  it("sets kiosk mode on each boot before React and covers controls and pseudo-elements", async () => {
    const script = await readFile("public/kiosk-mode.js", "utf8");
    for (let load = 0; load < 2; load++) {
      const dataset: Record<string, string> = {};
      runInNewContext(script, {
        window: { location: { search: "?kiosk=1" } }, document: { documentElement: { dataset } }, URLSearchParams,
      });
      expect(dataset.kiosk).toBe("true");
    }
    const css = await readFile("public/kiosk-mode.css", "utf8");
    expect(css).toContain('html[data-kiosk="true"] *');
    expect(css).toContain('html[data-kiosk="true"] *::before');
    expect(css).toContain('html[data-kiosk="true"] *::after');
    expect(css).toContain('html[data-kiosk="true"] *::file-selector-button');
    expect(css).toContain("cursor: none !important");
    const html = await readFile("index.html", "utf8");
    expect(html.indexOf('src="/kiosk-mode.js"')).toBeLessThan(html.indexOf("<body>"));
    expect(html.indexOf('href="/kiosk-mode.css"')).toBeLessThan(html.indexOf('src="/kiosk-mode.js"'));
    const launcher = await readFile("scripts/kiosk.sh", "utf8");
    expect(launcher).toContain("'http://127.0.0.1:8787/?kiosk=1'");
    expect(launcher).toContain("--class=sendspin-karaoke-kiosk");
    expect(launcher).toContain('--user-data-dir="$profile"');
    expect(launcher).not.toMatch(/unclutter|--no-sandbox|hide-cursor/);
  });

  it("bundles rights-cleared local JPEG photographs with provenance and no embedded metadata", async () => {
    expect(BUILTIN_BACKGROUNDS).toHaveLength(34);
    for (const photo of BUILTIN_BACKGROUNDS) {
      expect(photo.url).toMatch(/^\/backgrounds\/[a-z-]+\.jpg\?v=[a-f0-9]{12}$/);
      expect(photo.credit?.author).toBe("Romain Guy");
      expect(photo.credit?.license).toBe("CC0 1.0");
      expect(photo.credit?.licenseUrl).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
      const bytes = await readFile(`public${new URL(photo.url, "http://localhost").pathname}`);
      const info = await sharp(bytes, { limitInputPixels: 32_000_000, failOn: "warning" }).metadata();
      expect(info.format).toBe("jpeg");
      expect(info.width).toBe(photo.width);
      expect(info.height).toBe(photo.height);
      expect(info.width).toBe(3840);
      expect(info.height).toBe(2160);
      expect(info.exif).toBeUndefined();
      expect(info.icc).toBeUndefined();
      expect(info.xmp).toBeUndefined();
      expect(bytes.length).toBe(photo.bytes);
      expect(bytes.length).toBeLessThan(8 * 1024 * 1024);
    }
  });
});
