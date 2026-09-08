import { useEffect, useState } from "react";
import { sourceHealthSchema, type SourceHealth as SourceHealthSnapshot } from "../shared/source-tools.js";
import "./source-tools.css";

const ageLabel = (age: number | null) => age === null ? "age unknown" : `${Math.round(age / 1000)} seconds ago`;
const versionLabel = (version: string | null) => version ?? "Unknown";
const bytesLabel = (bytes: number | null) => bytes === null ? "Unavailable" : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
const visible = () => document.visibilityState !== "hidden";

export function SourceHealth(): React.JSX.Element {
  const [health, setHealth] = useState<SourceHealthSnapshot | null>(null);
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected" | "paused">("connecting");
  useEffect(() => {
    let active = true;
    let request: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || !visible() || request) return;
      const controller = new AbortController();
      request = controller;
      const timeout = setTimeout(() => controller.abort(), 2000);
      controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
      try {
        const response = await fetch("/api/source-tools/health", {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("Health unavailable");
        const parsed = sourceHealthSchema.safeParse(await response.json());
        if (!parsed.success || controller.signal.aborted) throw new Error("Invalid health");
        if (!active || request !== controller) return;
        setHealth(parsed.data);
        setConnection("connected");
      } catch {
        if (active && request === controller) {
          setHealth(null);
          setConnection("disconnected");
        }
      } finally {
        clearTimeout(timeout);
        if (request === controller) {
          request = null;
          if (active && visible()) timer = setTimeout(() => void poll(), 2000);
        }
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      request?.abort();
      request = null;
      setHealth(null);
      setConnection(document.visibilityState === "hidden" ? "paused" : "connecting");
      if (document.visibilityState !== "hidden") void poll();
    };
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => {
      active = false;
      clearTimeout(timer);
      request?.abort();
      request = null;
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return <section className="source-health" aria-label="Source health">
    <h2>Source health</h2>
    <p role="status">Browser to display: {connection === "connected" ? "connected (health request succeeded)"
      : connection === "paused" ? "paused while hidden" : connection === "disconnected" ? "unavailable (health request failed)" : "checking…"}</p>
    {!health && <p>No current health snapshot. Retrying while this section is visible; playback is unaffected.</p>}
    {health && <>
      {health.display.mode === "demo" && <p>Demo display mode — no source health is simulated.</p>}
      <dl>
        <dt>Optional source</dt><dd>{health.source.state}</dd>
        <dt>Display service</dt><dd>{health.display.state}</dd>
        <dt>Music Assistant</dt><dd>{health.display.ma}</dd>
        <dt>Capture</dt><dd>{health.capture.state}</dd>
        <dt>Device evidence</dt><dd>{health.capture.evidence} · {ageLabel(health.capture.evidenceAgeMs)}
          {health.capture.state !== "active" && " · Idle or unavailable capture does not verify device health."}</dd>
        <dt>Sendspin transport</dt><dd>{health.sendspin.state}</dd>
        <dt>Sendspin streaming</dt><dd>{health.sendspin.streaming ? "Yes" : "No"}</dd>
        <dt>Recording</dt><dd>{health.recording.state}</dd>
        <dt>Recording disk</dt><dd>{health.disk.state === "available"
          ? `${bytesLabel(health.disk.freeBytes)} free of ${bytesLabel(health.disk.totalBytes)} · ${ageLabel(health.disk.sampleAgeMs)}`
          : "Unavailable — not a zero-space reading"}</dd>
        <dt>Running source</dt><dd>{versionLabel(health.versions.source)}</dd>
        <dt>Installed source</dt><dd>{versionLabel(health.versions.installedSource)}
          {health.versions.source && health.versions.installedSource && health.versions.source !== health.versions.installedSource
            ? " (differs from running version)" : ""}</dd>
        <dt>Tools ABI</dt><dd>{health.versions.toolsAbi}</dd>
        <dt>Python</dt><dd>{versionLabel(health.versions.python)}</dd>
        <dt>Sendspin package</dt><dd>{versionLabel(health.versions.sendspin)}</dd>
        <dt>Application</dt><dd>{versionLabel(health.application.version)}</dd>
        <dt>Application build</dt><dd>{versionLabel(health.application.build)}</dd>
        <dt>Node</dt><dd>{versionLabel(health.application.node)}</dd>
      </dl>
      <h3>Recent error categories</h3>
      {!health.errors.length ? <p>No recent error categories reported.</p> : <ul>
        {health.errors.map((error, index) => <li key={`${error.category}:${index}`}>
          {error.category} · {error.count} occurrence(s) · {ageLabel(error.ageMs)}
        </li>)}
      </ul>}
    </>}
    <p>Diagnostic export contains only allowlisted health and version fields. No source identities, addresses,
      paths, credentials, recording labels, album history or raw logs.</p>
    <a href="/api/source-tools/diagnostics" download="source-diagnostics.json">Download health diagnostics</a>
  </section>;
}
