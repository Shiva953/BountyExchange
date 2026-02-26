"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { toast } from "sonner";
import { extractApiError } from "./useApiError";
import { VolumeData, VolumeRequest, BatchVolumeResult } from "@/types/volume";

export type { VolumeData, VolumeRequest, BatchVolumeResult };

const BATCH_SIZE = 10; // Send up to 10 requests per batch API call
const POLL_INTERVAL = 5000; // Poll every 5 seconds

// NOTE: Removed localStorage caching - it was causing stale data bugs where
// cached values would override fresh data. The hook now only preserves data
// within the same session (no page refresh persistence).
// Stale-while-revalidate now only applies to refetch() calls within same session.
// time complexity of the entire logic

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

    // Fetch from DB first (fast) - this is the primary data source
    // DB is updated by cron, so we trust it and skip Helius for items in DB
    const dbSeededKeys = new Set<string>();
    if (!forceRevalidate) {
      try {
        const dbKeys = pendingRequests.map((r) => r.key);
        const dbResponse = await fetch("/api/deal/volumes", {
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
                // Seed from DB for any item that exists (even if volumeCompleted is 0)
                if (!newMap.has(item.publicKey)) {
                  const targetVolume = targetVolumeMap.current.get(item.publicKey) || 0;
                  const progress = targetVolume > 0 ? (item.volumeCompleted / targetVolume) * 100 : 0;
                  newMap.set(item.publicKey, {
                    volumeUSD: item.volumeCompleted,
                    totalVolume: 0,
                    totalSwapTransactions: 0,
                    tokenPrice: null,
                    progress,
                    lastUpdated: Date.now(),
                    isStale: false,
                  });
                  dbSeededKeys.add(item.publicKey);
                  fetchedKeysRef.current.add(item.publicKey); // Mark as done
                }
              }
              return newMap;
            });
          }
        }
      } catch (err) {
        // DB fetch failed - log but continue to Helius fallback
        console.warn("[useBatchVolumeProgress] DB fetch failed, falling back to Helius:", err);
      }
    }

    // Filter out DB-seeded keys - no need to hit slow Helius API for these
    const remainingRequests = pendingRequests.filter((req) => !dbSeededKeys.has(req.key));

    // If all items were fetched from DB, we're done
    if (remainingRequests.length === 0) {
      setLoading(false);
      setLoadingKeys(new Set());
      setIsRevalidating(false);
      return;
    }

    // Cancel any ongoing requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();


    setLoading(true);
    setLoadingKeys(new Set(remainingRequests.map((r) => r.key)));


    const batches: VolumeRequest[][] = [];
    for (let i = 0; i < remainingRequests.length; i += BATCH_SIZE) {
      batches.push(remainingRequests.slice(i, i + BATCH_SIZE));
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
          const apiError = await extractApiError(response);
          if (apiError.retryable) {
            toast.error(apiError.message, { description: "Will retry automatically..." });
          }
          throw new Error(apiError.message);
        }

        const result = await response.json();

        if (!result.success) {
          const errorMsg = result.error || "Batch request failed";
          if (result.retryable) {
            toast.error(errorMsg, { description: "Will retry automatically..." });
          }
          throw new Error(errorMsg);
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
            // Use structured error message from API if available
            const errorMsg = item.error || "Unknown error";
            setErrors((prev) => {
              const newMap = new Map(prev);
              newMap.set(item.key, errorMsg);
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

        // Determine user-friendly error message
        let errorMsg = "Failed to load volume data";
        if (err instanceof Error) {
          const msg = err.message.toLowerCase();
          if (msg.includes("connection") || msg.includes("network") || msg.includes("fetch")) {
            errorMsg = "Connection issue - please check your network";
          } else if (msg.includes("403") || msg.includes("forbidden")) {
            errorMsg = "Service temporarily unavailable";
          } else if (msg.includes("429") || msg.includes("rate")) {
            errorMsg = "Too many requests - please wait";
          } else {
            errorMsg = err.message;
          }
        }

        // Mark all items in this batch as errored
        for (const req of batch) {
          setErrors((prev) => {
            const newMap = new Map(prev);
            newMap.set(req.key, errorMsg);
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
        const response = await fetch("/api/deal/volumes", {
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
