"use client";

import { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";
import { BN } from "@coral-xyz/anchor";

export interface DealAccount {
  publicKey: PublicKey;
  dealId: BN;
  creator: PublicKey;
  token: PublicKey;
  trader: PublicKey;
  rewardAmount: BN;
  targetVolume: BN;
  expirationWindowInHours: BN;
  holdDurationInHours: BN;
  escrowVault: PublicKey;
  bump: number;
  createdAt: BN;
  isActive: boolean;
  isAccepted: boolean;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  image: string;
}

export interface DealWithMetadata extends DealAccount {
  tokenMetadata: TokenMetadata | null;
}

// Use mainnet Helius for token metadata (tokens are mainnet even though program is on devnet)
const HELIUS_MAINNET_RPC = "https://mainnet.helius-rpc.com/?api-key=017f56ed-c6c1-480a-8c11-dbc09ab2358d";

// Jupiter API for token metadata (mainnet tokens) - no API key required
const JUPITER_TOKEN_API = "https://lite-api.jup.ag/tokens/v1/token";

async function fetchTokenMetadataFromJupiter(mintAddress: string): Promise<TokenMetadata | null> {
  try {
    console.log("[fetchTokenMetadataFromJupiter] Fetching from Jupiter for:", mintAddress);
    const response = await fetch(`${JUPITER_TOKEN_API}/${mintAddress}`);

    if (!response.ok) {
      console.log("[fetchTokenMetadataFromJupiter] Jupiter API returned status:", response.status);
      return null;
    }

    const data = await response.json();
    console.log("[fetchTokenMetadataFromJupiter] Jupiter response:", data);

    if (data && data.symbol) {
      const metadata = {
        name: data.name || data.symbol || "Unknown Token",
        symbol: data.symbol || "???",
        image: data.logoURI || data.icon || "",
      };
      console.log("[fetchTokenMetadataFromJupiter] Parsed metadata:", metadata);
      return metadata;
    }

    return null;
  } catch (error) {
    console.error("[fetchTokenMetadataFromJupiter] Error:", error);
    return null;
  }
}

async function fetchTokenMetadataFromHelius(mintAddress: string): Promise<TokenMetadata | null> {
  try {
    console.log("[fetchTokenMetadataFromHelius] Fetching from Helius for:", mintAddress);
    const response = await fetch(HELIUS_MAINNET_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "get-asset",
        method: "getAsset",
        params: {
          id: mintAddress,
          displayOptions: {
            showFungible: true,
          },
        },
      }),
    });

    const data = await response.json();
    console.log("[fetchTokenMetadataFromHelius] Helius response:", JSON.stringify(data, null, 2));

    if (data.error) {
      console.error("[fetchTokenMetadataFromHelius] Helius API error:", data.error);
      return null;
    }

    if (data.result) {
      const result = data.result;
      const content = result.content;

      const name =
        content?.metadata?.name ||
        result.token_info?.symbol ||
        "Unknown Token";

      const symbol =
        content?.metadata?.symbol ||
        result.token_info?.symbol ||
        "???";

      // Extract image from Helius response
      const image =
        content?.links?.image ||
        content?.files?.[0]?.cdn_uri ||
        content?.files?.[0]?.uri ||
        "";

      const metadata = { name, symbol, image };
      console.log("[fetchTokenMetadataFromHelius] Parsed metadata:", metadata);
      return metadata;
    }

    return null;
  } catch (error) {
    console.error("[fetchTokenMetadataFromHelius] Error:", error);
    return null;
  }
}

async function fetchTokenMetadata(mint: PublicKey): Promise<TokenMetadata | null> {
  const mintAddress = mint.toBase58();
  console.log("[fetchTokenMetadata] Fetching metadata for mint:", mintAddress);

  // Try Jupiter first (has better logo coverage for mainnet tokens)
  let metadata = await fetchTokenMetadataFromJupiter(mintAddress);

  // If Jupiter didn't return an image, try Helius
  if (!metadata || !metadata.image) {
    console.log("[fetchTokenMetadata] Jupiter didn't have image, trying Helius...");
    const heliusMetadata = await fetchTokenMetadataFromHelius(mintAddress);

    if (heliusMetadata) {
      // Merge: prefer Jupiter name/symbol if available, use Helius image if Jupiter didn't have one
      metadata = {
        name: metadata?.name || heliusMetadata.name,
        symbol: metadata?.symbol || heliusMetadata.symbol,
        image: metadata?.image || heliusMetadata.image,
      };
    }
  }

  console.log("[fetchTokenMetadata] Final metadata:", metadata);
  return metadata;
}

export function useDealsForTrader() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [deals, setDeals] = useState<DealWithMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDeals = useCallback(async () => {
    console.log("[useDealsForTrader] fetchDeals called");
    console.log("[useDealsForTrader] Connected wallet:", publicKey?.toBase58() || "none");

    if (!publicKey) {
      console.log("[useDealsForTrader] No wallet connected, clearing deals");
      setDeals([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const program = getProgram(connection);
      console.log("[useDealsForTrader] Program ID:", program.programId.toBase58());

      // Fetch all deal accounts using memcmp filter for trader field
      // The trader field is at offset: 8 (discriminator) + 8 (dealId) + 32 (creator) + 32 (token) = 80 bytes
      console.log("[useDealsForTrader] Fetching deals with trader filter at offset 80");
      const allDeals = await program.account.deal.all([
        {
          memcmp: {
            offset: 80, // trader field offset
            bytes: publicKey.toBase58(),
          },
        },
      ]);

      console.log("[useDealsForTrader] Total deals found for trader:", allDeals.length);
      allDeals.forEach((deal, index) => {
        console.log(`[useDealsForTrader] Deal ${index}:`, {
          publicKey: deal.publicKey.toBase58(),
          dealId: deal.account.dealId.toString(),
          creator: deal.account.creator.toBase58(),
          token: deal.account.token.toBase58(),
          trader: deal.account.trader.toBase58(),
          rewardAmount: deal.account.rewardAmount.toString(),
          targetVolume: deal.account.targetVolume.toString(),
          expirationWindowInHours: deal.account.expirationWindowInHours.toString(),
          holdDurationInHours: deal.account.holdDurationInHours.toString(),
          isActive: deal.account.isActive,
          isAccepted: deal.account.isAccepted,
        });
      });

      // Filter for active and unaccepted deals
      const openDeals = allDeals.filter(
        (deal) => deal.account.isActive && !deal.account.isAccepted
      );
      console.log("[useDealsForTrader] Open deals (active & not accepted):", openDeals.length);

      // Fetch token metadata for each deal
      console.log("[useDealsForTrader] Fetching token metadata for", openDeals.length, "deals");
      const dealsWithMetadata: DealWithMetadata[] = await Promise.all(
        openDeals.map(async (deal) => {
          const tokenMetadata = await fetchTokenMetadata(deal.account.token);
          return {
            publicKey: deal.publicKey,
            dealId: deal.account.dealId,
            creator: deal.account.creator,
            token: deal.account.token,
            trader: deal.account.trader,
            rewardAmount: deal.account.rewardAmount,
            targetVolume: deal.account.targetVolume,
            expirationWindowInHours: deal.account.expirationWindowInHours,
            holdDurationInHours: deal.account.holdDurationInHours,
            escrowVault: deal.account.escrowVault,
            bump: deal.account.bump,
            createdAt: deal.account.createdAt,
            isActive: deal.account.isActive,
            isAccepted: deal.account.isAccepted,
            tokenMetadata,
          };
        })
      );

      console.log("[useDealsForTrader] Final deals with metadata:", dealsWithMetadata.length);
      setDeals(dealsWithMetadata);
    } catch (err) {
      console.error("[useDealsForTrader] Error fetching deals:", err);
      setError("Failed to fetch deals");
    } finally {
      setLoading(false);
      console.log("[useDealsForTrader] Fetch complete");
    }
  }, [connection, publicKey]);

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  return { deals, loading, error, refetch: fetchDeals };
}
