/**
 * Redis Client with In-Memory Fallback
 * Uses Upstash Redis for Vercel compatibility (HTTP-based, no TCP)
 * Falls back to in-memory Map when REDIS_URL not set or Redis is unavailable
 */

import { Redis } from "@upstash/redis";

// Circuit breaker state
interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

const circuitBreaker: CircuitBreakerState = {
  failures: 0,
  lastFailure: 0,
  isOpen: false,
};

const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 60000; // 1 minute

// In-memory fallback cache
const memoryCache = new Map<string, { value: string; expiresAt: number | null }>();

// Redis client singleton
let redisClient: Redis | null = null;

function getRedisClient(): Redis | null {
  if (redisClient) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url) {
    console.log("[Redis] No REDIS_URL configured, using in-memory fallback");
    return null;
  }

  try {
    // Upstash REST API format
    if (token) {
      redisClient = new Redis({
        url,
        token,
      });
    } else {
      // Standard Redis URL format (for local development)
      redisClient = Redis.fromEnv();
    }
    console.log("[Redis] Client initialized");
    return redisClient;
  } catch (error) {
    console.error("[Redis] Failed to initialize client:", error);
    return null;
  }
}

function isCircuitOpen(): boolean {
  if (!circuitBreaker.isOpen) return false;

  // Check if reset timeout has passed
  if (Date.now() - circuitBreaker.lastFailure > CIRCUIT_BREAKER_RESET_MS) {
    console.log("[Redis] Circuit breaker reset");
    circuitBreaker.isOpen = false;
    circuitBreaker.failures = 0;
    return false;
  }

  return true;
}

function recordFailure(): void {
  circuitBreaker.failures++;
  circuitBreaker.lastFailure = Date.now();

  if (circuitBreaker.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    console.warn("[Redis] Circuit breaker opened after", circuitBreaker.failures, "failures");
    circuitBreaker.isOpen = true;
  }
}

function recordSuccess(): void {
  if (circuitBreaker.failures > 0) {
    circuitBreaker.failures = 0;
    circuitBreaker.isOpen = false;
  }
}

// Clean up expired entries from memory cache periodically
function cleanupMemoryCache(): void {
  const now = Date.now();
  for (const [key, entry] of memoryCache.entries()) {
    if (entry.expiresAt && entry.expiresAt < now) {
      memoryCache.delete(key);
    }
  }
}

// Run cleanup every 5 minutes
if (typeof setInterval !== "undefined") {
  setInterval(cleanupMemoryCache, 5 * 60 * 1000);
}

/**
 * Cache client interface
 */
export interface CacheClient {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  exists(key: string): Promise<boolean>;
  keys(pattern: string): Promise<string[]>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
}

/**
 * Get value from cache
 */
async function get<T>(key: string): Promise<T | null> {
  const redis = getRedisClient();

  // Try Redis first if available and circuit is closed
  if (redis && !isCircuitOpen()) {
    try {
      const value = await redis.get<T>(key);
      recordSuccess();
      return value;
    } catch (error) {
      console.error("[Redis] GET error:", error);
      recordFailure();
    }
  }

  // Fallback to memory cache
  const entry = memoryCache.get(key);
  if (!entry) return null;

  // Check expiration
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    memoryCache.delete(key);
    return null;
  }

  try {
    return JSON.parse(entry.value) as T;
  } catch {
    return entry.value as T;
  }
}

/**
 * Set value in cache
 */
async function set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const redis = getRedisClient();
  const serialized = typeof value === "string" ? value : JSON.stringify(value);

  // Try Redis first if available and circuit is closed
  if (redis && !isCircuitOpen()) {
    try {
      if (ttlSeconds) {
        await redis.set(key, serialized, { ex: ttlSeconds });
      } else {
        await redis.set(key, serialized);
      }
      recordSuccess();
      return;
    } catch (error) {
      console.error("[Redis] SET error:", error);
      recordFailure();
    }
  }

  // Fallback to memory cache
  memoryCache.set(key, {
    value: serialized,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
}

/**
 * Delete keys from cache
 */
async function del(...keys: string[]): Promise<void> {
  const redis = getRedisClient();

  // Try Redis first if available and circuit is closed
  if (redis && !isCircuitOpen()) {
    try {
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      recordSuccess();
      return;
    } catch (error) {
      console.error("[Redis] DEL error:", error);
      recordFailure();
    }
  }

  // Fallback to memory cache
  for (const key of keys) {
    memoryCache.delete(key);
  }
}

/**
 * Check if key exists in cache
 */
async function exists(key: string): Promise<boolean> {
  const redis = getRedisClient();

  // Try Redis first if available and circuit is closed
  if (redis && !isCircuitOpen()) {
    try {
      const result = await redis.exists(key);
      recordSuccess();
      return result > 0;
    } catch (error) {
      console.error("[Redis] EXISTS error:", error);
      recordFailure();
    }
  }

  // Fallback to memory cache
  const entry = memoryCache.get(key);
  if (!entry) return false;

  // Check expiration
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    memoryCache.delete(key);
    return false;
  }

  return true;
}

/**
 * Get keys matching pattern (only works with Redis, memory fallback returns empty)
 */
async function keys(pattern: string): Promise<string[]> {
  const redis = getRedisClient();

  // Try Redis first if available and circuit is closed
  if (redis && !isCircuitOpen()) {
    try {
      const result = await redis.keys(pattern);
      recordSuccess();
      return result;
    } catch (error) {
      console.error("[Redis] KEYS error:", error);
      recordFailure();
    }
  }

  // Fallback: match pattern in memory cache (simple glob support)
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
  const matches: string[] = [];
  for (const key of memoryCache.keys()) {
    if (regex.test(key)) {
      matches.push(key);
    }
  }
  return matches;
}

/**
 * Increment a counter
 */
async function incr(key: string): Promise<number> {
  const redis = getRedisClient();

  // Try Redis first if available and circuit is closed
  if (redis && !isCircuitOpen()) {
    try {
      const result = await redis.incr(key);
      recordSuccess();
      return result;
    } catch (error) {
      console.error("[Redis] INCR error:", error);
      recordFailure();
    }
  }

  // Fallback to memory cache
  const entry = memoryCache.get(key);
  let value = 0;
  if (entry) {
    try {
      value = parseInt(entry.value, 10) || 0;
    } catch {
      value = 0;
    }
  }
  value++;
  memoryCache.set(key, { value: String(value), expiresAt: entry?.expiresAt || null });
  return value;
}

/**
 * Set expiration on a key
 */
async function expire(key: string, ttlSeconds: number): Promise<void> {
  const redis = getRedisClient();

  // Try Redis first if available and circuit is closed
  if (redis && !isCircuitOpen()) {
    try {
      await redis.expire(key, ttlSeconds);
      recordSuccess();
      return;
    } catch (error) {
      console.error("[Redis] EXPIRE error:", error);
      recordFailure();
    }
  }

  // Fallback to memory cache
  const entry = memoryCache.get(key);
  if (entry) {
    entry.expiresAt = Date.now() + ttlSeconds * 1000;
  }
}

/**
 * Publish message to channel (for SSE broadcasting)
 */
async function publish(channel: string, message: string): Promise<void> {
  const redis = getRedisClient();

  // Only works with Redis
  if (redis && !isCircuitOpen()) {
    try {
      await redis.publish(channel, message);
      recordSuccess();
      return;
    } catch (error) {
      console.error("[Redis] PUBLISH error:", error);
      recordFailure();
    }
  }

  // No-op for memory cache (SSE won't work across instances without Redis)
  console.warn("[Redis] PUBLISH called but Redis not available - SSE updates may not propagate");
}

/**
 * Cache client singleton
 */
export const cache: CacheClient = {
  get,
  set,
  del,
  exists,
  keys,
  incr,
  expire,
  publish,
};

/**
 * Check if Redis is available and healthy
 */
export async function isRedisHealthy(): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;

  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get cache stats for monitoring
 */
export function getCacheStats(): {
  redisAvailable: boolean;
  circuitBreakerOpen: boolean;
  memoryCacheSize: number;
  failures: number;
} {
  return {
    redisAvailable: getRedisClient() !== null,
    circuitBreakerOpen: circuitBreaker.isOpen,
    memoryCacheSize: memoryCache.size,
    failures: circuitBreaker.failures,
  };
}
