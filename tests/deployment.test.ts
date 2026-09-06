import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bash = process.platform === "win32"
  ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
  : "/bin/bash";
const shellPath = (file: string) => file.replaceAll("\\", "/");
const runtime = shellPath(path.resolve("scripts/check-runtime.sh"));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "karaoke-runtime-"));
  directories.push(dir);
  await mkdir(path.join(dir, "user-bin"));
  await writeFile(path.join(dir, "user-bin", "node"), "#!/bin/bash\nexit 97\n", { mode: 0o755 });
  await writeFile(path.join(dir, "node"), `#!/bin/bash
if [[ "$1" == -e ]]; then
  exec "$TEST_REAL_NODE" -e 'Object.defineProperty(process.versions, "node", {value: process.env.TEST_NODE_VERSION}); eval(process.argv[1]);' "$2"
fi
exec "$TEST_REAL_NODE" "$@"
`, { mode: 0o755 });
  await writeFile(path.join(dir, "npm"), `#!/usr/bin/env deliberately-unavailable-node
if (process.argv[2] !== "--version") process.exit(2);
console.log("11.0.0");
`);
  return dir;
}

function check(dir: string, version: string, node = "./node", npm = "./npm") {
  return spawnSync(bash, ["-c",
    'source "$1"; check_system_runtime "$2" "$3" || exit $?; printf "preflight-passed\\n"',
    "runtime-test", runtime, node, npm,
  ], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shellPath(path.join(dir, "user-bin"))}:/usr/bin:/bin`,
      TEST_REAL_NODE: shellPath(process.execPath),
      TEST_NODE_VERSION: version,
    },
  });
}

describe("native system runtime preflight", () => {
  it.each(["20.19.2", "22.11.0", "27.0.0"])("rejects unsupported system Node %s", async (version) => {
    const result = check(await fixture(), version);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Required: >=22.12.0 and <27");
    expect(result.stdout).not.toContain("preflight-passed");
  });

  it.each(["22.12.0", "24.20.0", "26.8.1"])("accepts supported Node %s and invokes npm with that Node", async (version) => {
    const result = check(await fixture(), version);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("preflight-passed");
  });

  it("rejects missing system Node instead of selecting a user-PATH runtime", async () => {
    const result = check(await fixture(), "24.20.0", "./missing-node");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing or unsupported system Node.js");
  });

  it("rejects missing system npm before proceeding", async () => {
    const result = check(await fixture(), "24.20.0", "./node", "./missing-npm");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("System npm");
    expect(result.stdout).not.toContain("preflight-passed");
  });

  it("rejects npm that cannot run under the selected system Node", async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, "npm"), "process.exit(3);\n");
    const result = check(dir, "24.20.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot run");
    expect(result.stdout).not.toContain("preflight-passed");
  });

  it("checks before installer mutations and never requests distro Node/npm packages", async () => {
    const script = await readFile("scripts/install.sh", "utf8");
    const preflight = script.indexOf("check_system_runtime /usr/bin/node /usr/bin/npm");
    expect(preflight).toBeGreaterThan(0);
    for (const mutation of ["exec 9>", "apt-get update", "apt-get install", "groupadd ", "useradd ", "install -d "]) {
      expect(script.indexOf(mutation), mutation).toBeGreaterThan(preflight);
    }
    const packages = script.match(/^apt-get install (.+)$/m)?.[1]?.split(/\s+/);
    expect(packages).toEqual([
      "-y", "--no-install-recommends", "cec-utils", "python3", "chromium", "curl", "ca-certificates", "util-linux",
    ]);
    expect(script.match(/check_system_runtime \/usr\/bin\/node \/usr\/bin\/npm/g)).toHaveLength(2);
  });

  it("pins the system PATH and interpreter for install, update and service execution", async () => {
    const [installer, checker, updater, unit] = await Promise.all([
      readFile("scripts/install.sh", "utf8"),
      readFile("scripts/check-runtime.sh", "utf8"),
      readFile("scripts/update.sh", "utf8"),
      readFile("deploy/sendspin-karaoke.service", "utf8"),
    ]);
    for (const script of [installer, checker]) {
      expect(script).toContain("export PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    }
    expect(installer).toContain('runuser -u sendspin-karaoke -- /usr/bin/env PATH="$PATH" /usr/bin/node /usr/bin/npm');
    expect(updater).toContain('exec /bin/bash "$script_dir/install.sh" "$@"');
    expect(unit).toContain("Environment=PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/sendspin-karaoke/current/dist/server/server/index.js");
  });
});

describe("public source installation and update instructions", () => {
  it.each([
    ["https://github.com/JamesDun2866/music-assistant-display.git", 0],
    ["git@github.com:JamesDun2866/music-assistant-display.git", 0],
    ["ssh://git@github.com/JamesDun2866/music-assistant-display.git", 0],
    ["https://github.com/JamesDun2866/unrelated-project.git", 1],
    ["https://github.com/JamesDun2866/music-assistant-display.git.evil", 1],
    ["https://github.com.evil/JamesDun2866/music-assistant-display.git", 1],
    ["https://example.invalid/JamesDun2866/music-assistant-display.git", 1],
    ["https://placeholder@github.com/JamesDun2866/music-assistant-display.git", 1],
  ])("checks the documented origin %s with exit status %s", async (origin, status) => {
    const guide = await readFile("docs/upgrading.md", "utf8");
    const guard = guide.match(/  case "\$origin" in[\s\S]*?  esac/)?.[0];
    expect(guard).toBeDefined();
    const result = spawnSync(bash, ["-c",
      'fail() { printf "%s\\n" "$*" >&2; exit 1; }; origin="$1"; ' + guard,
      "origin-test", String(origin),
    ], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    if (status === 1) expect(result.stderr).toContain("Unexpected origin");
  });

  it("documents anonymous cloning and keeps existing installation paths", async () => {
    const [guide, upgrade, pkg, lock, unit] = await Promise.all([
      readFile("docs/installation-guide.md", "utf8"),
      readFile("docs/upgrading.md", "utf8"),
      readFile("package.json", "utf8").then(JSON.parse),
      readFile("package-lock.json", "utf8").then(JSON.parse),
      readFile("deploy/sendspin-karaoke.service", "utf8"),
    ]);
    expect(guide).toContain("https://github.com/JamesDun2866/music-assistant-display.git");
    expect(guide).not.toContain("ssh-keygen");
    expect(guide).not.toContain("Deploy keys -> Add deploy key");
    expect(guide).not.toContain("$HOME/projects/sendspin-karaoke");
    expect(upgrade).toContain("public repository has fresh history");
    expect(pkg.name).toBe("music-assistant-display");
    expect(pkg.license).toBe("MIT");
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[""].name).toBe(pkg.name);
    expect(lock.packages[""].license).toBe(pkg.license);
    expect(unit).toContain("Description=Music Assistant Display local backend");
    expect(unit).toContain("/opt/sendspin-karaoke/current/");
  });
});
