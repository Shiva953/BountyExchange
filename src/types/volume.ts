/**
 * Volume tracking types used by useBatchVolumeProgress and related hooks.
 */

/** Volume data for a single deal, keyed by deal public key. */
export interface VolumeData {
  volumeUSD: number;
  totalVolume: number;
  totalSwapTransactions: number;
  tokenPrice: number | null;
  /** Percentage progress towards target volume */
  progress?: number;
  /** Unix timestamp of last update */
  lastUpdated?: number;
  /** True when this is cached data being revalidated in the background */
  isStale?: boolean;
}

/** Input spec for a single volume polling request. */
export interface VolumeRequest {
  walletAddress: string;
  tokenMint: string;
  /** Unix timestamp (seconds) — only count swaps after this time */
  startTime?: number;
  /** Only count swaps >= this USD value */
  minBuyVolume?: number;
  /** Unique identifier for this request (e.g. deal public key) */
  key: string;
  /** Target volume for progress percentage calculation */
  targetVolume?: number;
}

/** Return type of the useBatchVolumeProgress hook. */
export interface BatchVolumeResult {
  volumes: Map<string, VolumeData>;
  loading: boolean;
  loadingKeys: Set<string>;
  errors: Map<string, string>;
  refetch: () => void;
  /** Whether SSE is connected for real-time updates */
  sseConnected: boolean;
  /** True when refreshing stale data in the background */
  isRevalidating: boolean;
}
