export interface TokenMetadata {
  name: string;
  symbol: string;
  image: string;
}

const HELIUS_MAINNET_RPC =
  "https://mainnet.helius-rpc.com/?api-key=017f56ed-c6c1-480a-8c11-dbc09ab2358d";
const JUPITER_TOKEN_API = "https://lite-api.jup.ag/tokens/v1/token";

async function fetchTokenMetadataFromJupiter(
  mintAddress: string
): Promise<TokenMetadata | null> {
  try {
    const response = await fetch(`${JUPITER_TOKEN_API}/${mintAddress}`);
    if (!response.ok) return null;

    const data = await response.json();
    if (data && data.symbol) {
      return {
        name: data.name || data.symbol || "Unknown Token",
        symbol: data.symbol || "???",
        image: data.logoURI || data.icon || "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchTokenMetadataFromHelius(
  mintAddress: string
): Promise<TokenMetadata | null> {
  try {
    const response = await fetch(HELIUS_MAINNET_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "get-asset",
        method: "getAsset",
        params: {
          id: mintAddress,
          displayOptions: { showFungible: true },
        },
      }),
    });

    const data = await response.json();
    if (data.error) return null;

    if (data.result) {
      const result = data.result;
      const content = result.content;

      let image =
        content?.links?.image ||
        content?.files?.[0]?.cdn_uri ||
        content?.files?.[0]?.uri ||
        "";

      // If no image yet, try fetching from json_uri metadata
      if (!image && content?.json_uri) {
        try {
          const metadataResponse = await fetch(content.json_uri);
          if (metadataResponse.ok) {
            const metadataJson = await metadataResponse.json();
            image = metadataJson.image || "";
          }
        } catch {
          // Ignore fetch errors for json_uri
        }
      }

      return {
        name:
          content?.metadata?.name ||
          result.token_info?.symbol ||
          "Unknown Token",
        symbol: content?.metadata?.symbol || result.token_info?.symbol || "???",
        image,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchTokenMetadataFromDexScreener(
  mintAddress: string
): Promise<TokenMetadata | null> {
  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
    );
    if (!response.ok) return null;

    const data = await response.json();
    if (data?.pairs?.length > 0) {
      const pair = data.pairs[0];
      const tokenInfo = pair.baseToken.address === mintAddress
        ? pair.baseToken
        : pair.quoteToken;
      return {
        name: tokenInfo.name || "Unknown Token",
        symbol: tokenInfo.symbol || "???",
        image: pair.info?.imageUrl || "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchTokenMetadata(
  mintAddress: string
): Promise<TokenMetadata | null> {
  // Try Jupiter first
  let metadata = await fetchTokenMetadataFromJupiter(mintAddress);

  // Fall back to Helius if no image
  if (!metadata || !metadata.image) {
    const heliusMetadata = await fetchTokenMetadataFromHelius(mintAddress);
    if (heliusMetadata) {
      metadata = {
        name: metadata?.name || heliusMetadata.name,
        symbol: metadata?.symbol || heliusMetadata.symbol,
        image: metadata?.image || heliusMetadata.image,
      };
    }
  }

  // Fall back to DexScreener if still no image
  if (!metadata || !metadata.image) {
    const dexScreenerMetadata = await fetchTokenMetadataFromDexScreener(mintAddress);
    if (dexScreenerMetadata) {
      metadata = {
        name: metadata?.name || dexScreenerMetadata.name,
        symbol: metadata?.symbol || dexScreenerMetadata.symbol,
        image: metadata?.image || dexScreenerMetadata.image,
      };
    }
  }

  return metadata;
}
