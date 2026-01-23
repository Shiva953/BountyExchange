"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface VolumeData {
  volumeUSD: number;
  totalVolume: number;
  totalSwapTransactions: number;
  tokenPrice: number | null;
}

interface VolumeRequest {
  walletAddress: string;
  tokenMint: string;
  startTime?: number;
  key: string; // unique identifier for this request (e.g., dealPubkey)
}

interface BatchVolumeResult {
  volumes: Map<string, VolumeData>;
  loading: boolean;
  loadingKeys: Set<string>;
  errors: Map<string, string>;
  refetch: () => void;
}

const BATCH_SIZE = 10; // Send up to 10 requests per batch API call

export function useBatchVolumeProgress(
  requests: VolumeRequest[],
  enabled = true
): BatchVolumeResult {
  const [volumes, setVolumes] = useState<Map<string, VolumeData>>(new Map());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fetchedKeysRef = useRef<Set<string>>(new Set());

  const fetchVolumes = useCallback(async () => {
    if (!enabled || requests.length === 0) {
      return;
    }

    // Filter out already fetched requests
    const pendingRequests = requests.filter(
      (req) => !fetchedKeysRef.current.has(req.key)
    );

    if (pendingRequests.length === 0) {
      return;
    }

    // Cancel any ongoing requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setLoading(true);
    setLoadingKeys(new Set(pendingRequests.map((r) => r.key)));

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
            setVolumes((prev) => {
              const newMap = new Map(prev);
              newMap.set(item.key, {
                volumeUSD: item.data.volumeUSD,
                totalVolume: item.data.totalVolume,
                totalSwapTransactions: item.data.totalSwapTransactions,
                tokenPrice: item.data.tokenPrice,
              });
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
  }, [requests, enabled]);

  // Fetch when requests change (new keys added)
  useEffect(() => {
    const hasNewKeys = requests.some((r) => !fetchedKeysRef.current.has(r.key));

    if (hasNewKeys) {
      fetchVolumes();
    }
  }, [requests, fetchVolumes]);

  const refetch = useCallback(() => {
    // Clear cached keys to force refetch
    fetchedKeysRef.current.clear();
    setVolumes(new Map());
    setErrors(new Map());
    fetchVolumes();
  }, [fetchVolumes]);

  return {
    volumes,
    loading,
    loadingKeys,
    errors,
    refetch,
  };
}
