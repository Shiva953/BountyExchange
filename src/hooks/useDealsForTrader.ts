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

const HELIUS_MAINNET_RPC = "https://mainnet.helius-rpc.com/?api-key=017f56ed-c6c1-480a-8c11-dbc09ab2358d";

const JUPITER_TOKEN_API = "https://lite-api.jup.ag/tokens/v1/token";

async function fetchTokenMetadataFromJupiter(mintAddress: string): Promise<TokenMetadata | null> {
  try {
    const response = await fetch(`${JUPITER_TOKEN_API}/${mintAddress}`);

    if (!response.ok) {
      return null;
    }

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
          displayOptions: {
            showFungible: true,
          },
        },
      }),
    });

    const data = await response.json();

    if (data.error) {
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

      const image =
        content?.links?.image ||
        content?.files?.[0]?.cdn_uri ||
        content?.files?.[0]?.uri ||
        "";

      return { name, symbol, image };
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

export function useDealsForTrader() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [deals, setDeals] = useState<DealWithMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDeals = useCallback(async () => {
    if (!publicKey) {
      setDeals([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const program = getProgram(connection);

      const allDeals = await program.account.deal.all([
        {
          memcmp: {
            offset: 80,
            bytes: publicKey.toBase58(),
          },
        },
      ]);

      const openDeals = allDeals.filter(
        (deal) => deal.account.isActive && !deal.account.isAccepted
      );
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

      setDeals(dealsWithMetadata);
    } catch {
      setError("Failed to fetch deals");
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  return { deals, loading, error, refetch: fetchDeals };
}
