import type { CecRemoteStatus, CecRoutingStatus } from "../shared/remote.js";

const hex = (value: number, length: number) => `0x${value.toString(16).padStart(length, "0")}`;
const time = (at: number) => new Date(at).toLocaleTimeString();
const decisions: Record<CecRoutingStatus["decision"], string> = {
  matched: "Exact TV selection of this Pi",
  "wrong-source": "Not from the TV (logical 0)",
  "wrong-target": "Not broadcast",
  "wrong-length": "Invalid routing frame length",
  "wrong-path": "Not this Pi's exact physical path",
  "invalid-registration": "No valid native registration",
  "route-away": "Route cleared or another source selected",
  observed: "Routing observed; no selection authorization",
};
const acknowledgements: Record<CecRoutingStatus["acknowledgement"], string> = {
  none: "not requested",
  pending: "pending",
  sent: "sent",
  failed: "failed; not replayed",
  suppressed: "suppressed (duplicate or busy); not queued",
  cancelled: "cancelled; not replayed",
};

export function CecDiagnostics({ remote }: { remote: CecRemoteStatus }) {
  const route = remote.lastRouting;
  return <div className="cec-diagnostics">
    <p>Native CEC: {remote.listening ? "listening" : "not listening"} on {remote.device}.
      {" "}Logical address: {remote.logicalAddress ?? "unavailable"}.
      {" "}Physical path: {remote.physicalAddress === null ? "unavailable" : hex(remote.physicalAddress, 4)}.
      {" "}Kiosk lease: {remote.kioskConnected ? "connected" : "not connected"}.</p>
    <p>Last accepted navigation key: {remote.lastEvent
      ? `${remote.lastEvent.key} at ${time(remote.lastEvent.at)}` : "none"}.</p>
    <p>Last routing event: {route
      ? `${hex(route.opcode, 2)} from ${route.source} to ${route.target}${route.physicalAddress === null
        ? "" : `, path ${hex(route.physicalAddress, 4)}`} at ${time(route.at)}. ${decisions[route.decision]}. Active Source acknowledgement: ${acknowledgements[route.acknowledgement]}.`
      : "none observed in this listener session."}</p>
    <p>Manual input selection stays in your control. Only a TV broadcast selecting this Pi's exact path
      can request an acknowledgement. A sent acknowledgement does not prove TV routing or key forwarding.</p>
  </div>;
}
