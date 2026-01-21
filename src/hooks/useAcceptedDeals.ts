"use client";

import { useEffect, useState, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";
import { DealAccount, DealWithMetadata, TokenMetadata } from "./useDealsForTrader";

const HELIUS_MAINNET_RPC = "https://mainnet.helius-rpc.com/?api-key=017f56ed-c6c1-480a-8c11-dbc09ab2358d";
const JUPITER_TOKEN_API = "https://lite-api.jup.ag/tokens/v1/token";

async function fetchTokenMetadataFromJupiter(mintAddress: string): Promise<TokenMetadata | null> {
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

async function fetchTokenMetadataFromHelius(mintAddress: string): Promise<TokenMetadata | null> {
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
      return {
        name: content?.metadata?.name || result.token_info?.symbol || "Unknown Token",
        symbol: content?.metadata?.symbol || result.token_info?.symbol || "???",
        image: content?.links?.image || content?.files?.[0]?.cdn_uri || content?.files?.[0]?.uri || "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchTokenMetadata(mint: PublicKey): Promise<TokenMetadata | null> {
  const mintAddress = mint.toBase58();
  let metadata = await fetchTokenMetadataFromJupiter(mintAddress);

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
  return metadata;
}

export function useAcceptedDeals(walletAddress: string | null) {
  const { connection } = useConnection();
  const [deals, setDeals] = useState<DealWithMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDeals = useCallback(async () => {
    if (!walletAddress) {
      setDeals([]);
      return;
    }

    let walletPubkey: PublicKey;
    try {
      walletPubkey = new PublicKey(walletAddress);
    } catch {
      setError("Invalid wallet address");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const program = getProgram(connection);

      // Fetch all deals where the trader field matches the wallet address
      const allDeals = await program.account.deal.all([
        {
          memcmp: {
            offset: 80,
            bytes: walletPubkey.toBase58(),
          },
        },
      ]);

      // Filter for accepted deals only
      const acceptedDeals = allDeals.filter((deal) => deal.account.isAccepted);

      // Enrich with token metadata
      const dealsWithMetadata: DealWithMetadata[] = await Promise.all(
        acceptedDeals.map(async (deal) => {
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

      setDeals(dealsWithMetadata);
    } catch {
      setError("Failed to fetch accepted deals");
    } finally {
      setLoading(false);
    }
  }, [connection, walletAddress]);

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  return { deals, loading, error, refetch: fetchDeals };
}
