import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { kioskDiagnosticsSchema } from "../shared/kiosk-diagnostics.js";

export async function readKioskDiagnostics(base = "http://127.0.0.1:8787") {
  const signal = AbortSignal.timeout(5_000);
  const session = await fetch(`${base}/api/session`, { signal, redirect: "error" });
  if (!session.ok) throw new Error(`Local session unavailable (${session.status}).`);
  const cookie = /^karaoke_session=[a-f0-9]{64}(?=;|$)/.exec(session.headers.get("set-cookie") ?? "")?.[0];
  const data: unknown = await session.json();
  if (!cookie || !data || typeof data !== "object" || !("csrfToken" in data)
    || typeof data.csrfToken !== "string" || !/^[a-f0-9]{64}$/.test(data.csrfToken)) {
    throw new Error("Invalid local diagnostics session.");
  }
  const response = await fetch(`${base}/api/kiosk/diagnostics`, {
    method: "POST", signal, redirect: "error",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": data.csrfToken },
    body: "{}",
  });
  if (!response.ok) throw new Error(`Kiosk diagnostics unavailable (${response.status}).`);
  return kioskDiagnosticsSchema.parse(await response.json());
}

// Installed "current" is a symlink; Node normally resolves only the module URL.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify(await readKioskDiagnostics(), null, 2));
  } catch {
    console.error("Could not read kiosk diagnostics. Check the local service and that the installed release includes diagnostics.");
    process.exitCode = 1;
  }
}
