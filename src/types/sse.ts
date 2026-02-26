/**
 * Server-Sent Events types shared between the SSE broadcaster (server-side)
 * and the useDealSSE hook (client-side).
 */

export type SSEEventType =
  | "volume_update"
  | "milestone"
  | "finalized"
  | "heartbeat"
  | "connected";

export interface SSEEventData {
  volumeUSD?: number;
  totalVolume?: number;
  progress?: number;
  milestone?: 25 | 50 | 75 | 90;
  outcome?: "won" | "lost";
  timestamp: number;
}

export interface SSEEvent {
  type: SSEEventType;
  dealPublicKey: string;
  data: SSEEventData;
}

// ---------------------------------------------------------------------------
// useDealSSE hook public API types
// ---------------------------------------------------------------------------

export interface UseDealSSEOptions {
  dealPublicKeys: string[];
  onVolumeUpdate?: (dealKey: string, volumeUSD: number, progress: number) => void;
  onMilestone?: (dealKey: string, milestone: 25 | 50 | 75 | 90) => void;
  onFinalized?: (dealKey: string, outcome: "won" | "lost") => void;
  onEvent?: (event: SSEEvent) => void;
  enabled?: boolean;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
}

export interface UseDealSSEReturn {
  connected: boolean;
  error: Error | null;
  reconnect: () => void;
  disconnect: () => void;
}
