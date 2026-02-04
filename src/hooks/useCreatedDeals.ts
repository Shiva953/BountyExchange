"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Connection } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";
import { BN } from "@coral-xyz/anchor";
import { fetchTokenMetadata, TokenMetadata } from "@/utils/tokenMetadata";

// Fetch escrow balances directly from on-chain
async function fetchEscrowBalances(
  connection: Connection,
  escrowVaults: PublicKey[]
): Promise<number> {
  if (escrowVaults.length === 0) return 0;

  let totalEscrow = 0;

  try {
    const balancePromises = escrowVaults.map(async (vault) => {
      try {
        const balance = await connection.getTokenAccountBalance(vault);
        return balance.value.uiAmount ?? 0;
      } catch {
        // Account might not exist or be closed
        return 0;
      }
    });

    const results = await Promise.all(balancePromises);
    totalEscrow = results.reduce((sum, bal) => sum + bal, 0);
  } catch (error) {
    console.error("Error fetching escrow balances:", error);
  }

  return totalEscrow;
}

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

// API response types
interface APIDeal {
  publicKey: string;
  dealId: string;
  creator: string;
  token: string;
  traderAddress: string;
  rewardAmount: number;
  targetVolume: number;
  minBuyVolume: number | null;
  expirationHours: number;
  holdDurationHours: number;
  escrowVault: string;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  isAccepted: boolean;
  volumeCompleted: number;
  outcome: string | null;
  status: "executing" | "satisfied" | "failed" | "awaiting";
  traderName: string | null;
  traderImageUrl: string | null;
}

interface APIResponse {
  success: boolean;
  deals: APIDeal[];
  stats: {
    totalEscrow: number;
    activeCampaigns: number;
    contractors: number;
  };
  error?: string;
}

// Check if a deal is expired (for on-chain deals without acceptance)
function isDealExpired(createdAt: number, expirationHours: number): boolean {
  const now = Date.now();
  const createdAtMs = createdAt * 1000;
  const expirationMs = expirationHours * 60 * 60 * 1000;
  const endTime = createdAtMs + expirationMs;
  return endTime <= now;
}

// Convert API deal to CreatedDealWithMetadata format
function apiDealToCreatedDeal(
  apiDeal: APIDeal,
  tokenMetadata: TokenMetadata | null
): CreatedDealWithMetadata {
  return {
    publicKey: new PublicKey(apiDeal.publicKey),
    dealId: new BN(apiDeal.dealId),
    creator: new PublicKey(apiDeal.creator),
    token: new PublicKey(apiDeal.token),
    trader: new PublicKey(apiDeal.traderAddress),
    rewardAmount: new BN(apiDeal.rewardAmount),
    targetVolume: new BN(apiDeal.targetVolume),
    minBuyVolume: apiDeal.minBuyVolume ? new BN(apiDeal.minBuyVolume) : null,
    expirationWindowInHours: new BN(apiDeal.expirationHours),
    holdDurationInHours: new BN(apiDeal.holdDurationHours),
    escrowVault: new PublicKey(apiDeal.escrowVault),
    bump: 0,
    createdAt: new BN(Math.floor(new Date(apiDeal.createdAt).getTime() / 1000)),
    isActive: apiDeal.isActive,
    isAccepted: apiDeal.isAccepted,
    tokenMetadata,
    traderName: apiDeal.traderName,
    status: apiDeal.status,
  };
}

// Token metadata cache to avoid repeated fetches
const tokenMetadataCache = new Map<string, TokenMetadata | null>();

async function getTokenMetadata(tokenMint: string): Promise<TokenMetadata | null> {
  if (tokenMetadataCache.has(tokenMint)) {
    return tokenMetadataCache.get(tokenMint) ?? null;
  }
  const metadata = await fetchTokenMetadata(tokenMint);
  tokenMetadataCache.set(tokenMint, metadata);
  return metadata;
}

export function useCreatedDeals() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [deals, setDeals] = useState<CreatedDealWithMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalEscrow, setTotalEscrow] = useState(0);
  const [activeCampaigns, setActiveCampaigns] = useState(0);
  const [contractors, setContractors] = useState(0);
  const previousWalletRef = useRef<string | null>(null);

  // Clear deals when wallet changes
  useEffect(() => {
    const currentWallet = publicKey?.toBase58() ?? null;
    if (previousWalletRef.current !== currentWallet) {
      setDeals([]);
      setError(null);
      setTotalEscrow(0);
      setActiveCampaigns(0);
      setContractors(0);
      previousWalletRef.current = currentWallet;
    }
  }, [publicKey]);

  const fetchDeals = useCallback(async () => {
    if (!publicKey) {
      setDeals([]);
      setTotalEscrow(0);
      setActiveCampaigns(0);
      setContractors(0);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Step 1: Fetch accepted deals from DB (fast)
      const dbDealsPromise = fetch(`/api/sponsor/deals?creator=${publicKey.toBase58()}`)
        .then((res) => res.json() as Promise<APIResponse>);

      // Step 2: Fetch on-chain deals to get awaiting (unaccepted) deals
      // This is needed because unaccepted deals are not in the DB
      const program = getProgram(connection);
      const onChainDealsPromise = program.account.deal.all([
        {
          memcmp: {
            offset: 16, // 8 bytes discriminator + 8 bytes dealId
            bytes: publicKey.toBase58(),
          },
        },
      ]);

      const [dbResponse, onChainDeals] = await Promise.all([dbDealsPromise, onChainDealsPromise]);

      // Process DB deals
      let dbDeals: CreatedDealWithMetadata[] = [];
      let dbActiveCampaigns = 0;
      let dbContractors = 0;

      if (dbResponse.success && dbResponse.deals) {
        // Get stats from DB (excluding escrow - will calculate from on-chain)
        dbActiveCampaigns = dbResponse.stats.activeCampaigns;
        dbContractors = dbResponse.stats.contractors;

        // Get unique token mints
        const tokenMints = [...new Set(dbResponse.deals.map((d) => d.token))];

        // Fetch token metadata in parallel
        const metadataResults = await Promise.all(
          tokenMints.map((mint) => getTokenMetadata(mint))
        );
        const metadataMap = new Map<string, TokenMetadata | null>();
        tokenMints.forEach((mint, i) => {
          metadataMap.set(mint, metadataResults[i]);
        });

        // Convert API deals to CreatedDealWithMetadata
        dbDeals = dbResponse.deals.map((apiDeal) =>
          apiDealToCreatedDeal(apiDeal, metadataMap.get(apiDeal.token) ?? null)
        );
      }

      // Process on-chain deals for awaiting (unaccepted) ones
      // Filter to only unaccepted, non-expired deals
      const dbDealPubkeys = new Set(dbDeals.map((d) => d.publicKey.toBase58()));
      const awaitingDeals: CreatedDealWithMetadata[] = [];

      for (const deal of onChainDeals) {
        const pubkeyStr = deal.publicKey.toBase58();

        // Skip if already in DB deals (accepted)
        if (dbDealPubkeys.has(pubkeyStr)) continue;

        // Skip if accepted (shouldn't happen but just in case)
        if (deal.account.isAccepted) continue;

        // Skip if expired
        const createdAt = deal.account.createdAt.toNumber();
        const expirationHours = deal.account.expirationWindowInHours.toNumber();
        if (isDealExpired(createdAt, expirationHours)) continue;

        // Fetch token metadata
        const tokenMint = deal.account.token.toBase58();
        const tokenMetadata = await getTokenMetadata(tokenMint);

        awaitingDeals.push({
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
          status: "awaiting",
        });
      }

      // Combine all deals
      const allDeals = [...dbDeals, ...awaitingDeals];

      // Calculate total escrow from on-chain (source of truth)
      // Only include escrow vaults from deals that should have locked funds:
      // - Executing deals (active, accepted, not expired)
      // - Awaiting deals (active, not accepted, not expired)
      const escrowVaultsToCheck = allDeals
        .filter((deal) => deal.status === "executing" || deal.status === "awaiting")
        .map((deal) => deal.escrowVault);

      const onChainEscrow = await fetchEscrowBalances(connection, escrowVaultsToCheck);
      setTotalEscrow(onChainEscrow);
      setActiveCampaigns(dbActiveCampaigns);
      setContractors(dbContractors);

      // Sort by createdAt descending
      allDeals.sort((a, b) => b.createdAt.toNumber() - a.createdAt.toNumber());

      setDeals(allDeals);
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

  return {
    deals,
    loading,
    error,
    totalEscrow,
    activeCampaigns,
    contractors,
    refetch: fetchDeals,
  };
}
