/**
 * Token Price Utility
 * Fetches current token price from multiple sources with fallback.
 * Sources: Jupiter, DexScreener, Raydium, Birdeye, Pump.fun
 */

const priceCache = new Map<string, { price: number | null; timestamp: number }>();
const CACHE_DURATION = 60 * 1000;

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
 * Fetches current token price from multiple sources with fallback
 */
export async function getTokenPrice(tokenMint: string): Promise<number | null> {
  const cached = priceCache.get(tokenMint);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`[getTokenPrice] Cache hit for ${tokenMint}: $${cached.price}`);
    return cached.price;
  }

  console.log(`[getTokenPrice] Fetching price for token: ${tokenMint}`);

  let price: number | null = null;

  price = await tryJupiter(tokenMint);
  if (price) {
    priceCache.set(tokenMint, { price, timestamp: Date.now() });
    return price;
  }

  price = await tryDexScreener(tokenMint);
  if (price) {
    priceCache.set(tokenMint, { price, timestamp: Date.now() });
    return price;
  }

  price = await tryRaydium(tokenMint);
  if (price) {
    priceCache.set(tokenMint, { price, timestamp: Date.now() });
    return price;
  }

  price = await tryBirdeye(tokenMint);
  if (price) {
    priceCache.set(tokenMint, { price, timestamp: Date.now() });
    return price;
  }

  price = await tryPumpFun(tokenMint);
  if (price) {
    priceCache.set(tokenMint, { price, timestamp: Date.now() });
    return price;
  }

  console.log(`[getTokenPrice] Could not fetch token price for ${tokenMint}`);
  priceCache.set(tokenMint, { price: null, timestamp: Date.now() });
  return null;
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
