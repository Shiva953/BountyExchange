"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { getProgram } from "@/program/instructions/createDeal";
import { DealWithMetadata } from "./useDealsForTrader";
import { fetchTokenMetadata, TokenMetadata } from "@/utils/tokenMetadata";
import { TraderDealResponse, TraderDataResponse } from "@/app/api/getTraderDeals/route";

export interface TraderData {
  name: string | null;
  imageUrl: string | null;
  volumeCompleted: number;
  activeBounties: number;
}

type DataSource = "db" | "onchain" | null;

const DB_RETRY_DELAY = 60000; // 60 seconds

export function useTraderDeals(walletAddress: string | null) {
  const { connection } = useConnection();
  const [deals, setDeals] = useState<DealWithMetadata[]>([]);
  const [traderData, setTraderData] = useState<TraderData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<DataSource>(null);
  const previousWalletRef = useRef<string | null>(null);
  const dbRetryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  // Clear deals immediately when wallet address changes
  useEffect(() => {
    if (previousWalletRef.current !== walletAddress) {
      setDeals([]);
      setTraderData(null);
      setError(null);
      setDataSource(null);
      previousWalletRef.current = walletAddress;
    }
  }, [walletAddress]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (dbRetryTimeoutRef.current) {
        clearTimeout(dbRetryTimeoutRef.current);
      }
    };
  }, []);

  // Convert DB deal response to DealWithMetadata format
  const convertDbDealToMetadata = useCallback(
    async (dbDeal: TraderDealResponse): Promise<DealWithMetadata> => {
      const tokenMetadata = await fetchTokenMetadata(dbDeal.token);
      return {
        publicKey: new PublicKey(dbDeal.publicKey),
        dealId: new BN(dbDeal.dealId),
        creator: new PublicKey(dbDeal.creator),
        token: new PublicKey(dbDeal.token),
        trader: new PublicKey(dbDeal.traderAddress),
        rewardAmount: new BN(dbDeal.rewardAmount),
        targetVolume: new BN(dbDeal.targetVolume),
        minBuyVolume: dbDeal.minBuyVolume ? new BN(dbDeal.minBuyVolume) : null,
        expirationWindowInHours: new BN(dbDeal.expirationHours),
        holdDurationInHours: new BN(dbDeal.holdDurationHours),
        escrowVault: new PublicKey(dbDeal.escrowVault),
        bump: 0, // Not stored in DB, but not used in UI
        createdAt: new BN(Math.floor(new Date(dbDeal.createdAt).getTime() / 1000)),
        isActive: dbDeal.isActive,
        isAccepted: dbDeal.isAccepted,
        tokenMetadata,
      };
    },
    []
  );

  // Fetch from database
  const fetchFromDb = useCallback(async (): Promise<{
    success: boolean;
    deals: DealWithMetadata[];
    trader: TraderData | null;
    retryable: boolean;
  }> => {
    if (!walletAddress) {
      return { success: true, deals: [], trader: null, retryable: false };
    }

    try {
      const response = await fetch(`/api/getTraderDeals?address=${walletAddress}`);
      const data = await response.json();

      if (!response.ok) {
        return {
          success: false,
          deals: [],
          trader: null,
          retryable: data.retryable ?? response.status === 500,
        };
      }

      if (!data.success) {
        return {
          success: false,
          deals: [],
          trader: null,
          retryable: data.retryable ?? false,
        };
      }

      // Convert deals from DB format to DealWithMetadata
      const convertedDeals = await Promise.all(
        (data.deals as TraderDealResponse[]).map(convertDbDealToMetadata)
      );

      // Extract trader data
      const traderResponse = data.trader as TraderDataResponse | null;
      const trader: TraderData | null = traderResponse
        ? {
            name: traderResponse.name,
            imageUrl: traderResponse.imageUrl,
            volumeCompleted: traderResponse.volumeCompleted,
            activeBounties: traderResponse.activeBounties,
          }
        : null;

      return { success: true, deals: convertedDeals, trader, retryable: false };
    } catch {
      return { success: false, deals: [], trader: null, retryable: true };
    }
  }, [walletAddress, convertDbDealToMetadata]);

  // Fetch from on-chain (fallback)
  const fetchFromOnChain = useCallback(async (): Promise<{
    success: boolean;
    deals: DealWithMetadata[];
    error: string | null;
  }> => {
    if (!walletAddress) {
      return { success: true, deals: [], error: null };
    }

    let walletPubkey: PublicKey;
    try {
      walletPubkey = new PublicKey(walletAddress);
    } catch {
      return { success: false, deals: [], error: "Invalid wallet address" };
    }

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

      return { success: true, deals: dealsWithMetadata, error: null };
    } catch {
      return { success: false, deals: [], error: "Failed to fetch deals from on-chain" };
    }
  }, [connection, walletAddress]);

  // Main fetch function with DB-first approach and on-chain fallback
  const fetchDeals = useCallback(
    async (isRetry = false) => {
      if (!walletAddress) {
        setDeals([]);
        setTraderData(null);
        return;
      }

      // Only show loading on initial fetch, not retries
      if (!isRetry) {
        setLoading(true);
      }
      setError(null);

      // Try DB first
      const dbResult = await fetchFromDb();

      if (!mountedRef.current) return;

      if (dbResult.success) {
        setDeals(dbResult.deals);
        setTraderData(dbResult.trader);
        setDataSource("db");
        setLoading(false);

        // Clear any pending retry since DB is now working
        if (dbRetryTimeoutRef.current) {
          clearTimeout(dbRetryTimeoutRef.current);
          dbRetryTimeoutRef.current = null;
        }
        return;
      }

      // DB failed - if retryable, schedule a retry after 60 seconds
      if (dbResult.retryable && !dbRetryTimeoutRef.current) {
        console.log(
          `[useTraderDeals] DB fetch failed, scheduling retry in ${DB_RETRY_DELAY / 1000}s`
        );
        dbRetryTimeoutRef.current = setTimeout(() => {
          dbRetryTimeoutRef.current = null;
          if (mountedRef.current) {
            fetchDeals(true); // Retry silently
          }
        }, DB_RETRY_DELAY);
      }

      // Fall back to on-chain fetching
      console.log("[useTraderDeals] Falling back to on-chain fetching");
      const onChainResult = await fetchFromOnChain();

      if (!mountedRef.current) return;

      if (onChainResult.success) {
        setDeals(onChainResult.deals);
        setDataSource("onchain");
        // Don't overwrite trader data if we already have it from a previous successful DB fetch
        setLoading(false);
      } else {
        setError(onChainResult.error);
        setLoading(false);
      }
    },
    [walletAddress, fetchFromDb, fetchFromOnChain]
  );

  // Initial fetch
  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  return {
    deals,
    traderData,
    loading,
    error,
    dataSource,
    refetch: () => fetchDeals(false),
  };
}
