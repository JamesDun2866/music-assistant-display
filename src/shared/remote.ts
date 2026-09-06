export const REMOTE_KEYS = ["up", "down", "left", "right", "select", "back"] as const;
export type RemoteKey = typeof REMOTE_KEYS[number];

export const CEC_ROUTE_DECISIONS = [
  "matched", "wrong-source", "wrong-target", "wrong-length", "wrong-path",
  "invalid-registration", "route-away", "observed",
] as const;
export const CEC_ROUTE_ACKNOWLEDGEMENTS = ["none", "pending", "sent", "failed", "suppressed", "cancelled"] as const;

export interface CecRoutingEvent {
  id: number;
  opcode: number;
  source: number;
  target: number;
  physicalAddress: number | null;
  decision: typeof CEC_ROUTE_DECISIONS[number];
  acknowledgement: typeof CEC_ROUTE_ACKNOWLEDGEMENTS[number];
}

export interface CecRoutingStatus extends CecRoutingEvent {
  at: number;
}

export interface RemoteAction {
  key: RemoteKey;
  repeat: boolean;
}

export type RemoteSignal = { type: "action"; action: RemoteAction } | { type: "reset" };

/** In-process only: never exposed as a writable HTTP input API. */
export interface RemoteSource {
  onRemote(listener: (signal: RemoteSignal) => void): () => void;
  resetRemote(): void;
}

export interface CecRemoteStatus {
  enabled: boolean;
  listening: boolean;
  device: string;
  logicalAddress: number | null;
  physicalAddress: number | null;
  lastEvent: { key: RemoteKey; at: number } | null;
  lastRouting?: CecRoutingStatus | null;
  kioskConnected: boolean;
}
