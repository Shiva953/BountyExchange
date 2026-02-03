/**
 * Token Price Utility
 * Fetches current token price from multiple sources with fallback.
 * Sources: Jupiter, DexScreener, Raydium, Birdeye, Pump.fun
 *
 * Uses two-tier caching:
 * 1. In-memory cache (fastest, process-local)
 * 2. Redis cache (shared across serverless instances)
 */

import { cache } from "@/lib/redis";

// In-memory cache for ultra-fast lookups within same process
const priceCache = new Map<string, { price: number | null; timestamp: number }>();
const CACHE_DURATION = 60 * 1000; // 60 seconds in-memory
const REDIS_CACHE_TTL = 120; // 2 minutes in Redis (slightly longer for cross-instance sharing)

async function tryJupiter(tokenMint: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.jup.ag/price/v2?ids=${tokenMint}`);
    if (response.ok) {
      const data = await response.json();
      const price = data?.data?.[tokenMint]?.price;
      if (price && price > 0) {
        console.log(`[getTokenPrice] Jupiter price: $${price}`);
        return price;
      }
    }
  } catch (error) {
    console.log(`[getTokenPrice] Jupiter API error: ${error}`);
  }
  return null;
}

async function tryDexScreener(tokenMint: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (response.ok) {
      const data = await response.json();
      if (data?.pairs?.length > 0) {
        const sortedPairs = data.pairs
          .filter((p: { baseToken: { address: string } }) =>
            p.baseToken.address.toLowerCase() === tokenMint.toLowerCase()
          )
          .sort((a: { liquidity?: { usd?: number } }, b: { liquidity?: { usd?: number } }) =>
            (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
          );
        const pair = sortedPairs[0] || data.pairs[0];
        const price = parseFloat(pair.priceUsd);
        if (price > 0) {
          console.log(`[getTokenPrice] DexScreener price: $${price}`);
          return price;
        }
      }
    }
  } catch (error) {
    console.log(`[getTokenPrice] DexScreener API error: ${error}`);
  }
  return null;
}

async function tryPumpFun(tokenMint: string): Promise<number | null> {
  try {
    const response = await fetch(`https://frontend-api.pump.fun/coins/${tokenMint}`);
    if (response.ok) {
      const data = await response.json();
      if (data?.market_cap && data?.total_supply) {
        const price = data.market_cap / data.total_supply;
        if (price > 0) {
          console.log(`[getTokenPrice] Pump.fun price: $${price}`);
          return price;
        }
      }
      if (data?.usd_market_cap && data?.total_supply) {
        const price = data.usd_market_cap / data.total_supply;
        if (price > 0) {
          console.log(`[getTokenPrice] Pump.fun price: $${price}`);
          return price;
        }
      }
    }
  } catch (error) {
    console.log(`[getTokenPrice] Pump.fun API error: ${error}`);
  }
  return null;
}

async function tryBirdeye(tokenMint: string): Promise<number | null> {
  try {
    const response = await fetch(`https://public-api.birdeye.so/defi/price?address=${tokenMint}`, {
      headers: { "X-Chain": "solana" },
    });
    if (response.ok) {
      const data = await response.json();
      const price = data?.data?.value;
      if (price && price > 0) {
        console.log(`[getTokenPrice] Birdeye price: $${price}`);
        return price;
      }
    }
  } catch (error) {
    console.log(`[getTokenPrice] Birdeye API error: ${error}`);
  }
  return null;
}

async function tryRaydium(tokenMint: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api-v3.raydium.io/mint/price?mints=${tokenMint}`);
    if (response.ok) {
      const data = await response.json();
      const price = data?.data?.[tokenMint];
      if (price && price > 0) {
        console.log(`[getTokenPrice] Raydium price: $${price}`);
        return price;
      }
    }
  } catch (error) {
    console.log(`[getTokenPrice] Raydium API error: ${error}`);
  }
  return null;
}

/**
 * Fetches current token price from multiple sources in PARALLEL
 * Uses two-tier caching (in-memory + Redis) for serverless compatibility
 *
 * Performance: Sequential was 500ms-2s, parallel is 100-300ms
 */
export async function getTokenPrice(tokenMint: string): Promise<number | null> {
  // Tier 1: Check in-memory cache (fastest)
  const memCached = priceCache.get(tokenMint);
  if (memCached && Date.now() - memCached.timestamp < CACHE_DURATION) {
    return memCached.price;
  }

  // Tier 2: Check Redis cache (shared across serverless instances)
  const redisKey = `price:${tokenMint}`;
  try {
    const redisCached = await cache.get<{ price: number | null; timestamp: number }>(redisKey);
    if (redisCached && Date.now() - redisCached.timestamp < CACHE_DURATION) {
      // Populate in-memory cache for subsequent requests in same instance
      priceCache.set(tokenMint, redisCached);
      return redisCached.price;
    }
  } catch {
    // Redis failure is non-fatal, continue to fetch
  }

  // Tier 3: Fetch from APIs in parallel
  const sources = [
    { name: "Jupiter", fn: () => tryJupiter(tokenMint) },
    { name: "DexScreener", fn: () => tryDexScreener(tokenMint) },
    { name: "Raydium", fn: () => tryRaydium(tokenMint) },
    { name: "Birdeye", fn: () => tryBirdeye(tokenMint) },
    { name: "PumpFun", fn: () => tryPumpFun(tokenMint) },
  ];

  // Create promises that resolve to { price, source } or null
  const racePromises = sources.map(async ({ name, fn }) => {
    const price = await fn();
    if (price && price > 0) {
      return { price, source: name };
    }
    return null;
  });

  // Use Promise.allSettled to get all results, then find first success
  const results = await Promise.allSettled(racePromises);

  let price: number | null = null;

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      price = result.value.price;
      break;
    }
  }

  // Cache the result in both tiers
  const cacheEntry = { price, timestamp: Date.now() };
  priceCache.set(tokenMint, cacheEntry);

  // Store in Redis asynchronously (don't block on it)
  cache.set(redisKey, cacheEntry, REDIS_CACHE_TTL).catch(() => {
    // Ignore Redis errors - in-memory cache is sufficient fallback
  });

  return price;
}

/**
 * Fetches prices for multiple tokens in batch
 */
export async function getTokenPrices(
  tokenMints: string[]
): Promise<Map<string, number | null>> {
  const prices = new Map<string, number | null>();
  const uncachedMints: string[] = [];

  for (const mint of tokenMints) {
    const cached = priceCache.get(mint);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      prices.set(mint, cached.price);
    } else {
      uncachedMints.push(mint);
    }
  }

  if (uncachedMints.length === 0) {
    return prices;
  }

  try {
    const jupiterResponse = await fetch(
      `https://api.jup.ag/price/v2?ids=${uncachedMints.join(",")}`
    );
    if (jupiterResponse.ok) {
      const jupiterData = await jupiterResponse.json();
      for (const mint of uncachedMints) {
        const price = jupiterData?.data?.[mint]?.price;
        if (price && price > 0) {
          prices.set(mint, price);
          priceCache.set(mint, { price, timestamp: Date.now() });
        }
      }
    }
  } catch (error) {
    console.log(`[getTokenPrices] Jupiter batch API error: ${error}`);
  }

  const afterJupiter = uncachedMints.filter((mint) => !prices.has(mint));
  if (afterJupiter.length > 0) {
    try {
      const raydiumResponse = await fetch(
        `https://api-v3.raydium.io/mint/price?mints=${afterJupiter.join(",")}`
      );
      if (raydiumResponse.ok) {
        const raydiumData = await raydiumResponse.json();
        for (const mint of afterJupiter) {
          const price = raydiumData?.data?.[mint];
          if (price && price > 0) {
            prices.set(mint, price);
            priceCache.set(mint, { price, timestamp: Date.now() });
          }
        }
      }
    } catch (error) {
      console.log(`[getTokenPrices] Raydium batch API error: ${error}`);
    }
  }

  const remainingMints = uncachedMints.filter((mint) => !prices.has(mint));
  for (const mint of remainingMints) {
    const price = await getTokenPrice(mint);
    prices.set(mint, price);
  }

  return prices;
}

/**
 * Clears the price cache
 */
export function clearPriceCache(): void {
  priceCache.clear();
}
