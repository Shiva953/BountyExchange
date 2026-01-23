// Cache for market cap data to avoid excessive API calls
const marketCapCache = new Map<string, { value: number | null; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export async function getMarketCap(mintAddress: string): Promise<number | null> {
  // Check cache first
  const cached = marketCapCache.get(mintAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.value;
  }

  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
    );
    if (!response.ok) {
      marketCapCache.set(mintAddress, { value: null, timestamp: Date.now() });
      return null;
    }

    const data = await response.json();
    if (data?.pairs?.length > 0) {
      // Find the pair where this token is the base token
      const pair = data.pairs.find(
        (p: { baseToken: { address: string } }) =>
          p.baseToken.address.toLowerCase() === mintAddress.toLowerCase()
      ) || data.pairs[0];

      const marketCap = pair.marketCap || pair.fdv || null;
      marketCapCache.set(mintAddress, { value: marketCap, timestamp: Date.now() });
      return marketCap;
    }

    marketCapCache.set(mintAddress, { value: null, timestamp: Date.now() });
    return null;
  } catch {
    marketCapCache.set(mintAddress, { value: null, timestamp: Date.now() });
    return null;
  }
}

export function formatMarketCap(marketCap: number | null): string {
  if (marketCap === null || marketCap === undefined) return "N/A";

  if (marketCap >= 1_000_000_000) {
    return `$${(marketCap / 1_000_000_000).toFixed(2)}B`;
  }
  if (marketCap >= 1_000_000) {
    return `$${(marketCap / 1_000_000).toFixed(2)}M`;
  }
  if (marketCap >= 1_000) {
    return `$${(marketCap / 1_000).toFixed(1)}K`;
  }
  return `$${marketCap.toFixed(0)}`;
}
