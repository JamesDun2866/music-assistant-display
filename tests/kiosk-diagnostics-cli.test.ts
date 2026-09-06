import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  // Keep package resolution identical to a release with installed dependencies.
  const dir = await mkdtemp(path.join(process.cwd(), "node_modules", ".kiosk-cli-test-"));
  directories.push(dir);
  const release = path.join(dir, "releases", "test-release");
  for (const folder of ["server", "shared"]) {
    await mkdir(path.join(release, "dist", "server", folder), { recursive: true });
  }
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  for (const [folder, name] of [["server", "kiosk-diagnostics-cli"], ["shared", "kiosk-diagnostics"]] as const) {
    const source = await readFile(path.join("src", folder, `${name}.ts`), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    });
    await writeFile(path.join(release, "dist", "server", folder, `${name}.js`), outputText);
  }
  const current = path.join(dir, "current");
  await symlink(release, current, process.platform === "win32" ? "junction" : "dir");
  return {
    direct: path.join(release, "dist", "server", "server", "kiosk-diagnostics-cli.js"),
    linked: path.join(current, "dist", "server", "server", "kiosk-diagnostics-cli.js"),
  };
}

const preload = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const success = `
let calls = 0;
globalThis.fetch = async (url, options) => {
  calls++;
  if (calls === 1 && url === "http://127.0.0.1:8787/api/session") {
    return new Response(JSON.stringify({csrfToken: "a".repeat(64)}), {
      headers: {"set-cookie": "karaoke_session=" + "b".repeat(64) + "; HttpOnly"}
    });
  }
  if (calls === 2 && url === "http://127.0.0.1:8787/api/kiosk/diagnostics"
      && options.method === "POST" && options.headers.Cookie === "karaoke_session=" + "b".repeat(64)
      && options.headers["X-CSRF-Token"] === "a".repeat(64)) {
    return new Response(JSON.stringify({pages: []}));
  }
  throw new Error("Unexpected request");
};
`;
function run(args: string[], mock: string) {
  return spawnSync(process.execPath, ["--import", preload(mock), ...args], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
}

it.each(["direct", "linked"] as const)("executes the %s release entry point and prints diagnostics", async (kind) => {
  const files = await fixture();
  const result = run([files[kind]], success);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(JSON.stringify({ pages: [] }, null, 2));
  expect(result.stderr).toBe("");
});

it("also executes when Node preserves the symlinked main module path", async () => {
  const files = await fixture();
  const result = run(["--preserve-symlinks-main", files.linked], success);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(JSON.stringify({ pages: [] }, null, 2));
});

it("reports service failures instead of exiting silently through current", async () => {
  const files = await fixture();
  const result = run([files.linked], 'globalThis.fetch = async () => { throw new Error("private failure detail"); };');
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Could not read kiosk diagnostics.");
  expect(result.stderr).not.toContain("private failure detail");
});

it.each(["direct", "linked"] as const)("importing the %s module does not execute its CLI", async (kind) => {
  const files = await fixture();
  const importer = path.join(path.dirname(files.direct), "importer.js");
  await writeFile(importer, `await import(${JSON.stringify(pathToFileURL(files[kind]).href)}); console.log("import-only");`);
  const result = run([importer], 'globalThis.fetch = () => { process.exit(99); };');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("import-only");
  expect(result.stderr).toBe("");
});
