"use client";

import { useState, useEffect, useCallback } from "react";

interface VolumeProgressData {
  volumeUSD: number;
  totalVolume: number;
  totalSwapTransactions: number;
  tokenPrice: number | null;
  loading: boolean;
  error: string | null;
}

interface UseVolumeProgressParams {
  walletAddress: string;
  tokenMint: string;
  startTime?: number; // Unix timestamp (seconds)
  minBuyVolume?: number; // Minimum buy volume in USD - only count swaps >= this value
  enabled?: boolean;
}

export function useVolumeProgress({
  walletAddress,
  tokenMint,
  startTime,
  minBuyVolume,
  enabled = true,
}: UseVolumeProgressParams): VolumeProgressData & { refetch: () => void } {
  const [volumeUSD, setVolumeUSD] = useState(0);
  const [totalVolume, setTotalVolume] = useState(0);
  const [totalSwapTransactions, setTotalSwapTransactions] = useState(0);
  const [tokenPrice, setTokenPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchVolume = useCallback(async () => {
    if (!walletAddress || !tokenMint || !enabled) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/getVolume", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          wallet: walletAddress,
          token: tokenMint,
          fast: true,
          startTime: startTime,
          endTime: Math.floor(Date.now() / 1000),
          minBuyVolume: minBuyVolume,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || "Failed to fetch volume");
      }

      setVolumeUSD(result.data.volumeUSD);
      setTotalVolume(result.data.totalVolume);
      setTotalSwapTransactions(result.data.totalSwapTransactions);
      setTokenPrice(result.data.tokenPrice);
    } catch (err) {
      console.error("[useVolumeProgress] Error fetching volume:", err);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [walletAddress, tokenMint, startTime, minBuyVolume, enabled]);

  useEffect(() => {
    fetchVolume();

    // Poll every 30 seconds as fallback for SSE
    const interval = setInterval(() => {
      fetchVolume();
    }, 30000);

    return () => clearInterval(interval);
  }, [fetchVolume]);

  return {
    volumeUSD,
    totalVolume,
    totalSwapTransactions,
    tokenPrice,
    loading,
    error,
    refetch: fetchVolume,
  };
}
