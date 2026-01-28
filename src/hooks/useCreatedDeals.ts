"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Connection } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";
import { BN } from "@coral-xyz/anchor";
import { fetchTokenMetadata, TokenMetadata } from "@/utils/tokenMetadata";

export interface CreatedDealAccount {
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

export interface CreatedDealWithMetadata extends CreatedDealAccount {
  tokenMetadata: TokenMetadata | null;
  traderName?: string | null;
  status: "executing" | "satisfied" | "failed" | "awaiting";
}

// Check if a deal is expired
function isDealExpired(deal: CreatedDealAccount): boolean {
  const now = Date.now();
  const createdAtMs = deal.createdAt.toNumber() * 1000;
  const expirationMs = deal.expirationWindowInHours.toNumber() * 60 * 60 * 1000;
  const endTime = createdAtMs + expirationMs;
  return endTime <= now;
}

// Determine deal status
function getDealStatus(deal: CreatedDealAccount): "executing" | "satisfied" | "failed" | "awaiting" {
  // If deal is not active (finalized)
  if (!deal.isActive) {
    // We can't know from on-chain if it was satisfied or failed without checking finalization
    // For now, we'll mark inactive deals based on whether they were accepted
    // Satisfied = inactive + was accepted (trader completed conditions)
    // Failed = inactive + was accepted but failed to meet conditions
    // Since we can't distinguish on-chain, we'll need to rely on DB later
    // For now, mark all inactive as completed (could be satisfied or failed)
    return "satisfied"; // placeholder - will be refined with DB data
  }

  // Deal is still active
  if (!deal.isAccepted) {
    // Active but not accepted - awaiting acceptance
    return "awaiting";
  }

  // Active and accepted - check if expired
  if (isDealExpired(deal)) {
    // Expired but still active means finalization pending
    return "failed";
  }

  // Active, accepted, not expired - currently executing
  return "executing";
}

// Fetch escrow balances for multiple deals using proper token account parsing
async function fetchEscrowBalances(
  connection: Connection,
  escrowVaults: PublicKey[]
): Promise<Map<string, number>> {
  const balances = new Map<string, number>();

  if (escrowVaults.length === 0) return balances;

  try {
    // Fetch each token account balance individually using the RPC method
    const balancePromises = escrowVaults.map(async (vault) => {
      try {
        const balance = await connection.getTokenAccountBalance(vault);
        return {
          vault: vault.toBase58(),
          amount: balance.value.uiAmount ?? 0,
        };
      } catch (err) {
        // Account might not exist or be closed
        console.log(`Escrow vault ${vault.toBase58()} not found or empty`);
        return {
          vault: vault.toBase58(),
          amount: 0,
        };
      }
    });

    const results = await Promise.all(balancePromises);

    for (const result of results) {
      balances.set(result.vault, result.amount);
    }
  } catch (error) {
    console.error("Error fetching escrow balances:", error);
  }

  return balances;
}

export function useCreatedDeals() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [deals, setDeals] = useState<CreatedDealWithMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalEscrow, setTotalEscrow] = useState(0);
  const previousWalletRef = useRef<string | null>(null);

  // Clear deals when wallet changes
  useEffect(() => {
    const currentWallet = publicKey?.toBase58() ?? null;
    if (previousWalletRef.current !== currentWallet) {
      setDeals([]);
      setError(null);
      setTotalEscrow(0);
      previousWalletRef.current = currentWallet;
    }
  }, [publicKey]);

  const fetchDeals = useCallback(async () => {
    if (!publicKey) {
      setDeals([]);
      setTotalEscrow(0);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const program = getProgram(connection);

      // Filter by creator field (offset 16: 8 bytes discriminator + 8 bytes dealId)
      const allDeals = await program.account.deal.all([
        {
          memcmp: {
            offset: 16,
            bytes: publicKey.toBase58(),
          },
        },
      ]);

      // Map to CreatedDealAccount format
      const allDealAccounts: CreatedDealAccount[] = allDeals.map((deal) => ({
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
      }));

      // Filter out deals that were never accepted AND have expired
      // Only include:
      // 1. Accepted deals (regardless of expiry - they are executing/satisfied/failed)
      // 2. Not accepted deals that haven't expired yet (awaiting acceptance)
      const dealAccounts = allDealAccounts.filter((deal) => {
        // Always include accepted deals
        if (deal.isAccepted) return true;

        // For non-accepted deals, only include if not expired
        return !isDealExpired(deal);
      });

      // Fetch escrow balances for filtered deals only
      const escrowVaults = dealAccounts.map((d) => d.escrowVault);
      const escrowBalances = await fetchEscrowBalances(connection, escrowVaults);

      // Calculate total escrow
      let total = 0;
      escrowBalances.forEach((balance) => {
        total += balance;
      });
      setTotalEscrow(total);

      // Enrich with token metadata
      const dealsWithMetadata: CreatedDealWithMetadata[] = await Promise.all(
        dealAccounts.map(async (deal) => {
          const tokenMetadata = await fetchTokenMetadata(deal.token.toBase58());
          return {
            ...deal,
            tokenMetadata,
            status: getDealStatus(deal),
          };
        })
      );

      // Sort by createdAt descending (newest first)
      dealsWithMetadata.sort((a, b) => b.createdAt.toNumber() - a.createdAt.toNumber());

      setDeals(dealsWithMetadata);
    } catch (err) {
      console.error("Error fetching created deals:", err);
      setError("Failed to fetch deals");
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  // Calculate stats
  const stats = useMemo(() => {
    const now = Date.now();

    // Active campaigns: deals that are active, accepted, and not expired
    const activeCampaigns = deals.filter((deal) => {
      if (!deal.isActive || !deal.isAccepted) return false;
      const createdAtMs = deal.createdAt.toNumber() * 1000;
      const expirationMs = deal.expirationWindowInHours.toNumber() * 60 * 60 * 1000;
      const endTime = createdAtMs + expirationMs;
      return endTime > now;
    }).length;

    // Total contractors: unique traders who have ever accepted deals from this creator
    const uniqueTraders = new Set<string>();
    deals.forEach((deal) => {
      if (deal.isAccepted) {
        uniqueTraders.add(deal.trader.toBase58());
      }
    });
    const contractors = uniqueTraders.size;

    return {
      activeCampaigns,
      contractors,
    };
  }, [deals]);

  return {
    deals,
    loading,
    error,
    totalEscrow,
    activeCampaigns: stats.activeCampaigns,
    contractors: stats.contractors,
    refetch: fetchDeals,
  };
}
