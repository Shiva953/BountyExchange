"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";

type SSEEventType = "volume_update" | "milestone" | "finalized" | "heartbeat" | "connected";

interface SSEEventData {
  volumeUSD?: number;
  totalVolume?: number;
  progress?: number;
  milestone?: 25 | 50 | 75 | 90;
  outcome?: "won" | "lost";
  timestamp: number;
}

interface SSEEvent {
  type: SSEEventType;
  dealPublicKey: string;
  data: SSEEventData;
}

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

// SSE disabled in dev by default - set NEXT_PUBLIC_ENABLE_SSE=true to enable
const isSSEEnabled = () => {
  if (typeof window === "undefined") return false;
  if (process.env.NODE_ENV === "development") {
    return process.env.NEXT_PUBLIC_ENABLE_SSE === "true";
  }
  return true;
};

export function useDealSSE(options: UseDealSSEOptions): UseDealSSEReturn {
  const {
    dealPublicKeys,
    onVolumeUpdate,
    onMilestone,
    onFinalized,
    onEvent,
    enabled = true,
    reconnectDelay = 5000,
    maxReconnectAttempts = 3,
  } = options;

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isConnectingRef = useRef(false);
  const isMountedRef = useRef(true);

  const dealKeysString = useMemo(() => {
    const sorted = [...dealPublicKeys].sort();
    return sorted.join(",");
  }, [dealPublicKeys]);

  const prevKeysRef = useRef<string>("");

  const callbacksRef = useRef({
    onVolumeUpdate,
    onMilestone,
    onFinalized,
    onEvent,
  });
  callbacksRef.current = {
    onVolumeUpdate,
    onMilestone,
    onFinalized,
    onEvent,
  };

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    isConnectingRef.current = false;
    if (isMountedRef.current) {
      setConnected(false);
    }
  }, []);

  const connect = useCallback(() => {
    if (!isSSEEnabled()) return;
    if (!enabled || dealKeysString.length === 0 || isConnectingRef.current) return;
    if (eventSourceRef.current && eventSourceRef.current.readyState === EventSource.OPEN) return;

    isConnectingRef.current = true;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const url = `/api/sse/deals?deals=${dealKeysString}`;

    try {
      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (!isMountedRef.current) return;
        console.log("[useDealSSE] Connected");
        setConnected(true);
        setError(null);
        reconnectAttemptsRef.current = 0;
        isConnectingRef.current = false;
      };

      eventSource.onerror = () => {
        if (!isMountedRef.current) return;

        isConnectingRef.current = false;
        setConnected(false);

        if (!eventSourceRef.current || eventSource.readyState === EventSource.CLOSED) return;

        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectAttemptsRef.current++;
          const delay = reconnectDelay * Math.pow(2, reconnectAttemptsRef.current - 1);

          console.log(`[useDealSSE] Reconnecting in ${delay}ms (${reconnectAttemptsRef.current}/${maxReconnectAttempts})`);

          reconnectTimeoutRef.current = setTimeout(() => {
            if (isMountedRef.current) {
              isConnectingRef.current = false;
              connect();
            }
          }, delay);
        } else {
          setError(new Error("Max reconnection attempts reached"));
        }
      };

      eventSource.onmessage = (e) => {
        if (!isMountedRef.current) return;

        try {
          const event: SSEEvent = JSON.parse(e.data);

          callbacksRef.current.onEvent?.(event);

          switch (event.type) {
            case "volume_update":
              if (event.data.volumeUSD !== undefined && event.data.progress !== undefined) {
                callbacksRef.current.onVolumeUpdate?.(
                  event.dealPublicKey,
                  event.data.volumeUSD,
                  event.data.progress
                );
              }
              break;

            case "milestone":
              if (event.data.milestone) {
                callbacksRef.current.onMilestone?.(event.dealPublicKey, event.data.milestone);
              }
              break;

            case "finalized":
              if (event.data.outcome) {
                callbacksRef.current.onFinalized?.(event.dealPublicKey, event.data.outcome);
              }
              break;

            case "heartbeat":
            case "connected":
              break;
          }
        } catch (parseError) {
          console.error("[useDealSSE] Failed to parse event:", parseError);
        }
      };
    } catch (err) {
      console.error("[useDealSSE] Failed to create EventSource:", err);
      isConnectingRef.current = false;
      if (isMountedRef.current) {
        setError(err instanceof Error ? err : new Error("Failed to connect"));
      }
    }
  }, [enabled, dealKeysString, reconnectDelay, maxReconnectAttempts]);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    isConnectingRef.current = false;
    disconnect();
    setTimeout(() => {
      if (isMountedRef.current) {
        connect();
      }
    }, 100);
  }, [connect, disconnect]);

  useEffect(() => {
    isMountedRef.current = true;

    if (dealKeysString !== prevKeysRef.current) {
      prevKeysRef.current = dealKeysString;

      if (enabled && dealKeysString.length > 0) {
        disconnect();
        const timer = setTimeout(() => {
          if (isMountedRef.current) {
            connect();
          }
        }, 100);

        return () => clearTimeout(timer);
      }
    } else if (enabled && dealKeysString.length > 0 && !eventSourceRef.current) {
      connect();
    }

    return () => {
      isMountedRef.current = false;
      disconnect();
    };
  }, [enabled, dealKeysString, connect, disconnect]);

  return { connected, error, reconnect, disconnect };
}

export default useDealSSE;
