import type { MeterChannel, SourceTelemetry } from "../shared/source-tools.js";
import "./source-tools.css";

const clamp = (value: number) => Number.isFinite(value) ? Math.max(-60, Math.min(0, value)) : -60;
const percent = (value: number) => `${(value + 60) / 60 * 100}%`;
const stateLabels: Record<SourceTelemetry["state"], string> = {
  "not-configured": "Source not configured",
  offline: "Source offline",
  inactive: "Input inactive",
  active: "Input active",
  stale: "Input stale",
  unavailable: "Input levels unavailable",
};

function Channel({ name, channel, active }: { name: string; channel: MeterChannel; active: boolean }) {
  const rms = active ? clamp(channel.rmsDbfs) : -60;
  const peak = active ? clamp(channel.peakDbfs) : -60;
  const hold = active ? clamp(channel.holdDbfs) : -60;
  return <div className="source-meter-channel">
    <span>{name}</span>
    <div className="source-meter-track" role="meter" aria-label={`${name} RMS`}
      aria-valuemin={-60} aria-valuemax={0} aria-valuenow={rms}
      aria-valuetext={`${rms.toFixed(1)} dBFS RMS; peak ${peak.toFixed(1)}; hold ${hold.toFixed(1)} dBFS`}>
      <span className="source-meter-rms" style={{ width: percent(rms) }} />
      <span className="source-meter-peak" style={{ left: percent(peak) }} />
      <span className="source-meter-hold" style={{ left: percent(hold) }} />
    </div>
    <span className="source-meter-reading">{rms.toFixed(1)} dBFS</span>
    <span className="source-meter-clipping">{active && channel.possibleClipping ? "Possible input clipping" : "No clipping warning"}</span>
  </div>;
}

export function StereoMeters({ telemetry, compact = false }: {
  telemetry: SourceTelemetry; compact?: boolean;
}): React.JSX.Element {
  const active = telemetry.state === "active" && telemetry.sampleAgeMs !== null
    && telemetry.sampleAgeMs >= 0 && telemetry.sampleAgeMs < 500;
  return <section className={`source-meters${compact ? " source-meters-compact" : ""}`} aria-label="Stereo source levels">
    <p>{stateLabels[telemetry.state === "active" && !active ? "stale" : telemetry.state]}</p>
    <Channel name="Left" channel={telemetry.left} active={active} />
    <Channel name="Right" channel={telemetry.right} active={active} />
    <div className="source-meter-scale" aria-hidden="true"><span>−60</span><span>−30</span><span>0 dBFS</span></div>
    {!compact && <p>Approximate VU-style RMS level, sample peak and 1.5-second peak hold. Not calibrated VU or true peak;
      no warning is not proof that upstream audio is unclipped. Passive observation only; no audio capture is started.</p>}
  </section>;
}
