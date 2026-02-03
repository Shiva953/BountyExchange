/**
 * Volume Cache
 * Caches volume calculation results to reduce Helius API calls.
 * Supports incremental updates when new transactions arrive.
 */

import { cache } from "./redis";

// Cache TTLs in seconds
const ACTIVE_DEAL_TTL = 300; // 5 minutes for active deals
const COMPLETED_DEAL_TTL = 86400; // 24 hours for completed deals
const IDEMPOTENCY_TTL = 3600; // 1 hour for webhook idempotency

/**
 * Cached volume data structure
 */
export interface CachedVolume {
  volumeUSD: number;
  totalVolume: number;
  totalSwapTransactions: number;
  tokenPrice: number | null;
  lastTxSignature: string;
  lastTxTimestamp: number;
  calculatedAt: number;
  version: number;
}

/**
 * Volume update for incremental additions
 */
export interface VolumeIncrement {
  signature: string;
  timestamp: number;
  tokenAmount: number;
  volumeUSD: number;
}

/**
 * Generate cache key for volume data
 */
export function getVolumeCacheKey(
  walletAddress: string,
  tokenMint: string,
  startTime?: number
): string {
  const normalizedWallet = walletAddress.toLowerCase();
  const normalizedToken = tokenMint.toLowerCase();
  const timeKey = startTime || 0;
  return `volume:${normalizedWallet}:${normalizedToken}:${timeKey}`;
}

/**
 * Get cached volume data
 */
export async function getCachedVolume(
  walletAddress: string,
  tokenMint: string,
  startTime?: number
): Promise<CachedVolume | null> {
  const key = getVolumeCacheKey(walletAddress, tokenMint, startTime);

  try {
    const cached = await cache.get<CachedVolume>(key);

    if (cached) {
      console.log(`[VolumeCache] HIT for ${walletAddress.slice(0, 8)}...:${tokenMint.slice(0, 8)}...`);
      return cached;
    }

    console.log(`[VolumeCache] MISS for ${walletAddress.slice(0, 8)}...:${tokenMint.slice(0, 8)}...`);
    return null;
  } catch (error) {
    console.error("[VolumeCache] Error getting cached volume:", error);
    return null;
  }
}

/**
 * Set cached volume data
 */
export async function setCachedVolume(
  walletAddress: string,
  tokenMint: string,
  startTime: number | undefined,
  data: CachedVolume,
  isActiveDeal: boolean = true
): Promise<void> {
  const key = getVolumeCacheKey(walletAddress, tokenMint, startTime);
  const ttl = isActiveDeal ? ACTIVE_DEAL_TTL : COMPLETED_DEAL_TTL;

  try {
    await cache.set(key, data, ttl);
    console.log(`[VolumeCache] SET ${walletAddress.slice(0, 8)}...:${tokenMint.slice(0, 8)}... TTL=${ttl}s`);
  } catch (error) {
    console.error("[VolumeCache] Error setting cached volume:", error);
  }
}

/**
 * Increment cached volume with new transaction data
 * Used when webhook receives new swap transaction
 */
export async function incrementCachedVolume(
  walletAddress: string,
  tokenMint: string,
  startTime: number | undefined,
  increment: VolumeIncrement
): Promise<CachedVolume | null> {
  const key = getVolumeCacheKey(walletAddress, tokenMint, startTime);

  try {
    const cached = await cache.get<CachedVolume>(key);

    if (!cached) {
      console.log(`[VolumeCache] No cache to increment for ${walletAddress.slice(0, 8)}...`);
      return null;
    }

    // Skip if this transaction is older than our last known
    if (increment.timestamp <= cached.lastTxTimestamp) {
      console.log(`[VolumeCache] Skipping old transaction ${increment.signature.slice(0, 8)}...`);
      return cached;
    }

    const updated: CachedVolume = {
      ...cached,
      volumeUSD: cached.volumeUSD + increment.volumeUSD,
      totalVolume: cached.totalVolume + increment.tokenAmount,
      totalSwapTransactions: cached.totalSwapTransactions + 1,
      lastTxSignature: increment.signature,
      lastTxTimestamp: increment.timestamp,
      calculatedAt: Date.now(),
    };

    await cache.set(key, updated, ACTIVE_DEAL_TTL);

    console.log(`[VolumeCache] Incremented ${walletAddress.slice(0, 8)}...: +$${increment.volumeUSD.toFixed(2)} → $${updated.volumeUSD.toFixed(2)}`);

    return updated;
  } catch (error) {
    console.error("[VolumeCache] Error incrementing cached volume:", error);
    return null;
  }
}

/**
 * Invalidate volume cache for a wallet/token pair
 */
export async function invalidateVolumeCache(
  walletAddress: string,
  tokenMint: string
): Promise<void> {
  try {
    // Find all cache keys for this wallet/token combo
    const pattern = getVolumeCacheKey(walletAddress, tokenMint, undefined).replace(":0", ":*");
    const keys = await cache.keys(pattern);

    if (keys.length > 0) {
      await cache.del(...keys);
      console.log(`[VolumeCache] Invalidated ${keys.length} cache entries for ${walletAddress.slice(0, 8)}...:${tokenMint.slice(0, 8)}...`);
    }
  } catch (error) {
    console.error("[VolumeCache] Error invalidating cache:", error);
  }
}

/**
 * Check if a webhook signature has been processed (idempotency)
 */
export async function isWebhookProcessed(signature: string): Promise<boolean> {
  const key = `webhook-processed:${signature}`;

  try {
    return await cache.exists(key);
  } catch (error) {
    console.error("[VolumeCache] Error checking webhook idempotency:", error);
    return false;
  }
}

/**
 * Mark webhook signature as processed
 */
export async function markWebhookProcessed(signature: string): Promise<void> {
  const key = `webhook-processed:${signature}`;

  try {
    await cache.set(key, { processedAt: Date.now() }, IDEMPOTENCY_TTL);
  } catch (error) {
    console.error("[VolumeCache] Error marking webhook processed:", error);
  }
}

/**
 * Store deal pubkeys for a wallet (for webhook lookups)
 */
export async function cacheDealForWallet(
  walletAddress: string,
  tokenMint: string,
  dealPubkey: string,
  startTime: number,
  expiresAt: number
): Promise<void> {
  const key = `wallet-deals:${walletAddress.toLowerCase()}`;

  try {
    // Get existing deals
    const existing = await cache.get<Array<{
      dealPubkey: string;
      tokenMint: string;
      startTime: number;
      expiresAt: number;
    }>>(key) || [];

    // Check if deal already exists
    const exists = existing.some(d => d.dealPubkey === dealPubkey);
    if (!exists) {
      existing.push({ dealPubkey, tokenMint, startTime, expiresAt });

      // TTL based on longest expiration
      const maxExpiry = Math.max(...existing.map(d => d.expiresAt));
      const ttl = Math.max(Math.ceil((maxExpiry - Date.now()) / 1000), ACTIVE_DEAL_TTL);

      await cache.set(key, existing, ttl);
      console.log(`[VolumeCache] Cached deal ${dealPubkey.slice(0, 8)}... for wallet ${walletAddress.slice(0, 8)}...`);
    }
  } catch (error) {
    console.error("[VolumeCache] Error caching deal for wallet:", error);
  }
}

/**
 * Get active deals for a wallet (for webhook processing)
 */
export async function getDealsForWallet(
  walletAddress: string
): Promise<Array<{
  dealPubkey: string;
  tokenMint: string;
  startTime: number;
  expiresAt: number;
}>> {
  const key = `wallet-deals:${walletAddress.toLowerCase()}`;

  try {
    const deals = await cache.get<Array<{
      dealPubkey: string;
      tokenMint: string;
      startTime: number;
      expiresAt: number;
    }>>(key);

    if (!deals) return [];

    // Filter out expired deals
    const now = Date.now();
    return deals.filter(d => d.expiresAt > now);
  } catch (error) {
    console.error("[VolumeCache] Error getting deals for wallet:", error);
    return [];
  }
}

/**
 * Remove deal from wallet's deal list
 */
export async function removeDealFromWallet(
  walletAddress: string,
  dealPubkey: string
): Promise<void> {
  const key = `wallet-deals:${walletAddress.toLowerCase()}`;

  try {
    const existing = await cache.get<Array<{
      dealPubkey: string;
      tokenMint: string;
      startTime: number;
      expiresAt: number;
    }>>(key);

    if (!existing) return;

    const filtered = existing.filter(d => d.dealPubkey !== dealPubkey);

    if (filtered.length > 0) {
      const maxExpiry = Math.max(...filtered.map(d => d.expiresAt));
      const ttl = Math.max(Math.ceil((maxExpiry - Date.now()) / 1000), ACTIVE_DEAL_TTL);
      await cache.set(key, filtered, ttl);
    } else {
      await cache.del(key);
    }

    console.log(`[VolumeCache] Removed deal ${dealPubkey.slice(0, 8)}... from wallet ${walletAddress.slice(0, 8)}...`);
  } catch (error) {
    console.error("[VolumeCache] Error removing deal from wallet:", error);
  }
}

/**
 * Get volume cache stats for monitoring
 */
export async function getVolumeCacheStats(): Promise<{
  cachedVolumes: number;
  cachedDeals: number;
  processedWebhooks: number;
}> {
  try {
    const volumeKeys = await cache.keys("volume:*");
    const dealKeys = await cache.keys("wallet-deals:*");
    const webhookKeys = await cache.keys("webhook-processed:*");

    return {
      cachedVolumes: volumeKeys.length,
      cachedDeals: dealKeys.length,
      processedWebhooks: webhookKeys.length,
    };
  } catch (error) {
    console.error("[VolumeCache] Error getting cache stats:", error);
    return {
      cachedVolumes: 0,
      cachedDeals: 0,
      processedWebhooks: 0,
    };
  }
}
