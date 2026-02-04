"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";

interface VolumeData {
  volumeUSD: number;
  totalVolume: number;
  totalSwapTransactions: number;
  tokenPrice: number | null;
  progress?: number; // Percentage progress towards target
  lastUpdated?: number; // Timestamp of last update
  isStale?: boolean; // True if this is cached data being revalidated
}

interface VolumeRequest {
  walletAddress: string;
  tokenMint: string;
  startTime?: number;
  minBuyVolume?: number; // Minimum buy volume in USD - only count swaps >= this value
  key: string; // unique identifier for this request (e.g., dealPubkey)
  targetVolume?: number; // Target volume for progress calculation
}

interface BatchVolumeResult {
  volumes: Map<string, VolumeData>;
  loading: boolean;
  loadingKeys: Set<string>;
  errors: Map<string, string>;
  refetch: () => void;
  sseConnected: boolean; // Whether SSE is connected for real-time updates
  isRevalidating: boolean; // True when refreshing stale data in background
}

const BATCH_SIZE = 10; // Send up to 10 requests per batch API call
const POLL_INTERVAL = 5000; // Poll every 5 seconds

// NOTE: Removed localStorage caching - it was causing stale data bugs where
// cached values would override fresh data. The hook now only preserves data
// within the same session (no page refresh persistence).
// Stale-while-revalidate now only applies to refetch() calls within same session.

export function useBatchVolumeProgress(
  requests: VolumeRequest[],
  enabled = true
): BatchVolumeResult {
  const [volumes, setVolumes] = useState<Map<string, VolumeData>>(new Map());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [isRevalidating, setIsRevalidating] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fetchedKeysRef = useRef<Set<string>>(new Set());
  const targetVolumeMap = useRef(new Map<string, number>());

  const dealPublicKeys = useMemo(() => requests.map((r) => r.key), [requests]);

  useEffect(() => {
    for (const req of requests) {
      if (req.targetVolume) {
        targetVolumeMap.current.set(req.key, req.targetVolume);
      }
    }
  }, [requests]);

  const fetchVolumes = useCallback(async (forceRevalidate = false) => {
    if (!enabled || requests.length === 0) {
      return;
    }

    // Filter out already fetched requests (unless force revalidating)
    const pendingRequests = forceRevalidate
      ? requests
      : requests.filter((req) => !fetchedKeysRef.current.has(req.key));

    if (pendingRequests.length === 0) {
      return;
    }

    // Seed initial values from DB (fast) before running slow Helius calculation
    const dbSeededKeys = new Set<string>();
    if (!forceRevalidate) {
      try {
        const dbKeys = pendingRequests.map((r) => r.key);
        const dbResponse = await fetch("/api/deals/volumes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealPublicKeys: dbKeys }),
        });
        if (dbResponse.ok) {
          const dbData = await dbResponse.json();
          if (dbData.success && dbData.volumes) {
            setVolumes((prev) => {
              const newMap = new Map(prev);
              for (const item of dbData.volumes) {
                if (item.volumeCompleted > 0 && !newMap.has(item.publicKey)) {
                  const targetVolume = targetVolumeMap.current.get(item.publicKey) || 0;
                  const progress = targetVolume > 0 ? (item.volumeCompleted / targetVolume) * 100 : 0;
                  newMap.set(item.publicKey, {
                    volumeUSD: item.volumeCompleted,
                    totalVolume: 0,
                    totalSwapTransactions: 0,
                    tokenPrice: null,
                    progress,
                    lastUpdated: Date.now(),
                    isStale: true,
                  });
                  dbSeededKeys.add(item.publicKey);
                }
              }
              return newMap;
            });
          }
        }
      } catch {
        // DB seed failed, continue with Helius batch
      }
    }

    // Cancel any ongoing requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // If we have cached data (from DB seed or previous fetch), this is a revalidation
    const hasCachedData = dbSeededKeys.size > 0 || pendingRequests.some((req) => volumes.has(req.key));
    if (hasCachedData || forceRevalidate) {
      setIsRevalidating(true);
    } else {
      setLoading(true);
    }

    // Only show loading indicators for keys without cached data (including DB seed)
    const keysWithoutCache = pendingRequests
      .filter((req) => !volumes.has(req.key) && !dbSeededKeys.has(req.key))
      .map((r) => r.key);
    if (keysWithoutCache.length > 0) {
      setLoadingKeys(new Set(keysWithoutCache));
    }

    // Split into batches for the batch API
    const batches: VolumeRequest[][] = [];
    for (let i = 0; i < pendingRequests.length; i += BATCH_SIZE) {
      batches.push(pendingRequests.slice(i, i + BATCH_SIZE));
    }

    for (const batch of batches) {
      if (abortControllerRef.current?.signal.aborted) {
        break;
      }

      try {
        const response = await fetch("/api/getVolumeBatch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            requests: batch.map((req) => ({
              wallet: req.walletAddress,
              token: req.tokenMint,
              startTime: req.startTime,
              endTime: Math.floor(Date.now() / 1000),
              minBuyVolume: req.minBuyVolume,
              key: req.key,
            })),
          }),
          signal: abortControllerRef.current?.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status}`);
        }

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Batch request failed");
        }

        // Process results
        for (const item of result.results) {
          if (item.success && item.data) {
            fetchedKeysRef.current.add(item.key);
            const volumeData: VolumeData = {
              volumeUSD: item.data.volumeUSD,
              totalVolume: item.data.totalVolume,
              totalSwapTransactions: item.data.totalSwapTransactions,
              tokenPrice: item.data.tokenPrice,
              lastUpdated: Date.now(),
              isStale: false,
            };

            setVolumes((prev) => {
              const newMap = new Map(prev);
              newMap.set(item.key, volumeData);
              return newMap;
            });
          } else {
            setErrors((prev) => {
              const newMap = new Map(prev);
              newMap.set(item.key, item.error || "Unknown error");
              return newMap;
            });
          }

          setLoadingKeys((prev) => {
            const newSet = new Set(prev);
            newSet.delete(item.key);
            return newSet;
          });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          break;
        }

        console.error("[useBatchVolumeProgress] Batch request failed:", err);

        // Mark all items in this batch as errored
        for (const req of batch) {
          setErrors((prev) => {
            const newMap = new Map(prev);
            newMap.set(
              req.key,
              err instanceof Error ? err.message : "Unknown error"
            );
            return newMap;
          });

          setLoadingKeys((prev) => {
            const newSet = new Set(prev);
            newSet.delete(req.key);
            return newSet;
          });
        }
      }
    }

    setLoading(false);
    setIsRevalidating(false);
  }, [requests, enabled, volumes]);

  // Fetch when requests change (new keys added)
  useEffect(() => {
    const hasNewKeys = requests.some((r) => !fetchedKeysRef.current.has(r.key));

    if (hasNewKeys) {
      fetchVolumes(false);
    }
  }, [requests, fetchVolumes]);

  const refetch = useCallback(() => {
    // Stale-while-revalidate: keep showing current data while refreshing
    // Don't clear volumes - show stale data while revalidating
    fetchedKeysRef.current.clear();
    setErrors(new Map());
    fetchVolumes(true); // Force revalidate
  }, [fetchVolumes]);

  // Polling for real-time updates - only when tab is visible
  useEffect(() => {
    if (!enabled || dealPublicKeys.length === 0) return;

    let intervalId: NodeJS.Timeout | null = null;
    let isVisible = true;

    const pollVolumes = async () => {
      // Skip if tab is not visible
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }

      try {
        const response = await fetch("/api/deals/volumes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealPublicKeys }),
        });

        if (!response.ok) return;

        const data = await response.json();
        if (!data.success || !data.volumes) return;

        // Update volumes from DB - only if something changed
        setVolumes((prev) => {
          let hasChanges = false;

          for (const item of data.volumes) {
            const existing = prev.get(item.publicKey);
            if (!existing || existing.volumeUSD !== item.volumeCompleted) {
              hasChanges = true;
              break;
            }
          }

          // Return same reference if nothing changed (prevents re-render)
          if (!hasChanges) return prev;

          const newMap = new Map(prev);
          for (const item of data.volumes) {
            const existing = newMap.get(item.publicKey);
            const targetVolume = targetVolumeMap.current.get(item.publicKey) || 0;
            const progress = targetVolume > 0 ? (item.volumeCompleted / targetVolume) * 100 : 0;

            if (!existing || existing.volumeUSD !== item.volumeCompleted) {
              newMap.set(item.publicKey, {
                volumeUSD: item.volumeCompleted,
                totalVolume: existing?.totalVolume || 0,
                totalSwapTransactions: existing?.totalSwapTransactions || 0,
                tokenPrice: existing?.tokenPrice || null,
                progress,
                lastUpdated: Date.now(),
              });
            }
          }
          return newMap;
        });
      } catch {
        // Silently fail - polling is best-effort
      }
    };

    // Handle visibility change
    const handleVisibilityChange = () => {
      isVisible = document.visibilityState === "visible";
      if (isVisible) {
        // Poll immediately when tab becomes visible
        pollVolumes();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    // Start polling
    intervalId = setInterval(pollVolumes, POLL_INTERVAL);

    // Initial poll after a short delay
    const timeoutId = setTimeout(pollVolumes, 2000);

    return () => {
      if (intervalId) clearInterval(intervalId);
      clearTimeout(timeoutId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [enabled, dealPublicKeys]);

  return {
    volumes,
    loading,
    loadingKeys,
    errors,
    refetch,
    sseConnected: false, // SSE disabled, using polling instead
    isRevalidating, // True when refreshing cached data in background
  };
}
