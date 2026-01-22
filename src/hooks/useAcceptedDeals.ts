"use client";

import { useEffect, useState, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";
import { DealAccount, DealWithMetadata } from "./useDealsForTrader";
import { fetchTokenMetadata } from "@/utils/tokenMetadata";

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
          const tokenMetadata = await fetchTokenMetadata(deal.account.token.toBase58());
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
