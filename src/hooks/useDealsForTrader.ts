"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";
import { BN } from "@coral-xyz/anchor";
import { fetchTokenMetadata, TokenMetadata } from "@/utils/tokenMetadata";

export type { TokenMetadata };

export interface DealAccount {
  publicKey: PublicKey;
  dealId: BN;
  creator: PublicKey;
  token: PublicKey;
  trader: PublicKey;
  rewardAmount: BN;
  targetVolume: BN;
  minBuyVolume: BN | null;
  expirationWindowInHours: BN;
  holdDurationInHours: BN;
  escrowVault: PublicKey;
  bump: number;
  createdAt: BN;
  isActive: boolean;
  isAccepted: boolean;
}

export interface DealWithMetadata extends DealAccount {
  tokenMetadata: TokenMetadata | null;
  // DB-only fields (not available on-chain)
  outcome?: "won" | "lost" | "expired_unfulfilled" | null;
  volumeCompleted?: number;
  expiresAt?: Date | null;
  finalizedAt?: Date | null;
}

export function useDealsForTrader() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [deals, setDeals] = useState<DealWithMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousWalletRef = useRef<string | null>(null);
  const connectionRef = useRef(connection);
  const isFetchingRef = useRef(false);

  // Keep connection ref updated without causing re-renders
  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  // Clear deals only when switching to a DIFFERENT wallet (not when wallet temporarily becomes undefined)
  useEffect(() => {
    const currentWallet = publicKey?.toBase58() ?? null;
    // Only clear if switching to a different wallet, not if wallet becomes temporarily undefined
    if (currentWallet && previousWalletRef.current && previousWalletRef.current !== currentWallet) {
      setDeals([]);
      setError(null);
    }
    if (currentWallet) {
      previousWalletRef.current = currentWallet;
    }
  }, [publicKey]);

  const fetchDeals = useCallback(async () => {
    if (!publicKey) {
      // Don't clear deals when wallet is temporarily undefined - preserve existing data
      return;
    }

    // Prevent concurrent fetches
    if (isFetchingRef.current) {
      return;
    }
    isFetchingRef.current = true;

    setLoading(true);
    setError(null);

    try {
      const program = getProgram(connectionRef.current);

      const allDeals = await program.account.deal.all([
        {
          memcmp: {
            offset: 80,
            bytes: publicKey.toBase58(),
          },
        },
      ]);

      const now = Date.now();
      const openDeals = allDeals.filter((deal) => {
        if (!deal.account.isActive || deal.account.isAccepted) {
          return false;
        }
        // Filter out expired deals: createdAt + expirationWindowInHours < now
        const createdAtMs = deal.account.createdAt.toNumber() * 1000;
        const expirationMs =
          deal.account.expirationWindowInHours.toNumber() * 60 * 60 * 1000;
        const endTime = createdAtMs + expirationMs;
        return endTime > now;
      });
      const dealsWithMetadata: DealWithMetadata[] = await Promise.all(
        openDeals.map(async (deal) => {
          const tokenMetadata = await fetchTokenMetadata(deal.account.token.toBase58());
          return {
            publicKey: deal.publicKey,
            dealId: deal.account.dealId,
            creator: deal.account.creator,
            token: deal.account.token,
            trader: deal.account.trader,
            rewardAmount: deal.account.rewardAmount,
            targetVolume: deal.account.targetVolume,
            minBuyVolume: deal.account.minBuyVolume ?? null,
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
      // Don't clear deals on error - preserve existing data
    } finally {
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, [publicKey]); // Removed connection dependency - use ref instead

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  return { deals, loading, error, refetch: fetchDeals };
}
