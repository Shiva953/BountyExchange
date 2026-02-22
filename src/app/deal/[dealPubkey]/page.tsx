"use client";

import { useParams } from "next/navigation";
import { useEffect, useState, useMemo, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { sendTransactionWithRetry } from "@/utils/sendTransactionWithRetry";
import { signTransactionWithRetry } from "@/utils/signTransactionWithRetry";
import { getProgram } from "@/program/instructions/createDeal";
import { ArrowLeft, Clock, Target, Calendar, Check, Loader2, ArrowUpRight, RefreshCw } from "lucide-react";
import { useVolumeProgress } from "@/hooks/useVolumeProgress";
import { useDealSSE } from "@/hooks/useDealSSE";
import Link from "next/link";
import { toast } from "sonner";
import { fetchTokenMetadata, TokenMetadata } from "@/utils/tokenMetadata";
import { getMarketCap, formatMarketCap } from "@/utils/getMarketCap";

const MONO_FONT = 'GeistMono, ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Monaco, "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace';

interface DealData {
  publicKey: PublicKey;
  dealId: string;
  creator: PublicKey;
  token: PublicKey;
  trader: PublicKey;
  rewardAmount: number;
  targetVolume: number;
  minBuyVolume: number | null;
  expirationWindowInHours: number;
  holdDurationInHours: number;
  escrowVault: PublicKey;
  createdAt: number;
  isActive: boolean;
  isAccepted: boolean;
  tokenMetadata: TokenMetadata | null;
  outcome: boolean | null; // true = won, false = lost, null = not finalized
  volumeCompletedUsd: number | null; // Stored volume at finalization time
}

type ButtonState = "idle" | "loading" | "success";

const USDC_DECIMALS = 9;

function formatUSDC(amount: number): string {
  const value = amount / 10 ** USDC_DECIMALS;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatVolumeUSD(amount: number): string {
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (amount >= 1000) {
    return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
  return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatExpiryDate(createdAt: number, expirationWindowInHours: number): string {
  const expiryTime = new Date((createdAt + expirationWindowInHours * 3600) * 1000);
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  };
  return expiryTime.toLocaleString("en-US", options).replace(",", "");
}

function DealPageSkeleton() {
  return (
    <div className="min-h-screen bg-black pt-16 pl-20">
      <div className="max-w-5xl mx-auto px-6 py-12">
        {/* Header Skeleton */}
        <div className="flex items-center justify-between mb-10">
          <div className="h-5 w-32 bg-[#2a2a2a] rounded animate-pulse" />
          <div className="h-5 w-24 bg-[#2a2a2a] rounded animate-pulse" />
        </div>

        {/* Token Info & Reward Skeleton */}
        <div className="flex items-start justify-between mb-10">
          <div className="flex items-center gap-4">
            <div className="w-20 h-20 rounded-lg bg-[#2a2a2a] animate-pulse" />
            <div>
              <div className="h-8 w-40 bg-[#2a2a2a] rounded animate-pulse mb-2" />
              <div className="h-4 w-24 bg-[#2a2a2a] rounded animate-pulse" />
            </div>
          </div>
          <div className="text-right">
            <div className="h-3 w-24 bg-[#2a2a2a] rounded animate-pulse mb-2" />
            <div className="h-10 w-32 bg-[#2a2a2a] rounded animate-pulse" />
          </div>
        </div>

        {/* Stats Grid Skeleton */}
        <div className="grid grid-cols-4 gap-4 mb-10">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-[#111] rounded-xl p-4 border border-white/10">
              <div className="h-3 w-20 bg-[#2a2a2a] rounded animate-pulse mb-3" />
              <div className="h-6 w-16 bg-[#2a2a2a] rounded animate-pulse" />
            </div>
          ))}
        </div>

        {/* Progress Sections Skeleton */}
        <div className="space-y-6 mb-10">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="bg-[#111] rounded-xl p-6 border border-white/10">
              <div className="flex items-center justify-between mb-3">
                <div className="h-3 w-28 bg-[#2a2a2a] rounded animate-pulse" />
                <div className="h-4 w-10 bg-[#2a2a2a] rounded animate-pulse" />
              </div>
              <div className="flex items-center gap-4">
                <div className="h-7 w-32 bg-[#2a2a2a] rounded animate-pulse" />
                <div className="flex-1 h-1 bg-[#2a2a2a] rounded-full" />
              </div>
            </div>
          ))}
        </div>

        {/* Button Skeleton */}
        <div className="h-14 w-full bg-[#2a2a2a] rounded-xl animate-pulse" />
      </div>
    </div>
  );
}

export default function DealPage() {
  const params = useParams();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const [deal, setDeal] = useState<DealData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buttonState, setButtonState] = useState<ButtonState>("idle");
  const [imageError, setImageError] = useState(false);
  const [marketCap, setMarketCap] = useState<number | null>(null);

  const dealPubkey = params.dealPubkey as string;

  // Real-time volume from SSE
  const [realtimeVolume, setRealtimeVolume] = useState<number | null>(null);

  useEffect(() => {
    async function fetchDeal() {
      if (!dealPubkey) return;

      setLoading(true);
      setError(null);

      try {
        const dealPublicKey = new PublicKey(dealPubkey);
        const program = getProgram(connection);
        const dealAccount = await program.account.deal.fetch(dealPublicKey);

        const tokenMetadata = await fetchTokenMetadata(dealAccount.token.toBase58());

        // Fetch market cap
        getMarketCap(dealAccount.token.toBase58()).then(setMarketCap);

        setDeal({
          publicKey: dealPublicKey,
          dealId: dealAccount.dealId.toString(),
          creator: dealAccount.creator,
          token: dealAccount.token,
          trader: dealAccount.trader,
          rewardAmount: dealAccount.rewardAmount.toNumber(),
          targetVolume: dealAccount.targetVolume.toNumber(),
          minBuyVolume: dealAccount.minBuyVolume ? dealAccount.minBuyVolume.toNumber() : null,
          expirationWindowInHours: dealAccount.expirationWindowInHours.toNumber(),
          holdDurationInHours: dealAccount.holdDurationInHours.toNumber(),
          escrowVault: dealAccount.escrowVault,
          createdAt: dealAccount.createdAt.toNumber(),
          isActive: dealAccount.isActive,
          isAccepted: dealAccount.isAccepted,
          tokenMetadata,
          outcome: dealAccount.outcome ?? null,
          volumeCompletedUsd: dealAccount.volumeCompletedUsd ? dealAccount.volumeCompletedUsd.toNumber() : null,
        });
      } catch (err) {
        console.error("Failed to fetch deal:", err);
        setError("Failed to load deal");
      } finally {
        setLoading(false);
      }
    }

    fetchDeal();
  }, [dealPubkey, connection]);

  // Fetch real volume progress when deal is accepted but NOT finalized
  // For finalized deals, we use the stored volumeCompletedUsd from the deal account
  // Must be called unconditionally (before any early returns) to follow Rules of Hooks
  // Memoize params to prevent unnecessary refetches
  const isFinalized = deal?.outcome !== null && deal?.outcome !== undefined;
  const volumeParams = useMemo(() => ({
    walletAddress: deal?.trader.toBase58() ?? "",
    tokenMint: deal?.token.toBase58() ?? "",
    startTime: deal?.createdAt,
    minBuyVolume: deal?.minBuyVolume ? deal.minBuyVolume / 10 ** USDC_DECIMALS : undefined,
    // Only fetch live volume for accepted deals that are NOT finalized
    enabled: Boolean(deal?.isAccepted) && !isFinalized,
  }), [deal?.trader, deal?.token, deal?.createdAt, deal?.minBuyVolume, deal?.isAccepted, isFinalized]);

  const { volumeUSD, loading: volumeLoading, refetch: refetchVolume } = useVolumeProgress(volumeParams);

  // SSE for real-time updates - memoize to prevent reconnection loops
  const dealPublicKeys = useMemo(() => dealPubkey ? [dealPubkey] : [], [dealPubkey]);
  const handleSSEVolumeUpdate = useCallback((dealKey: string, newVolumeUSD: number, progress: number) => {
    console.log(`[SSE] Volume update: ${dealKey.slice(0, 8)}... → $${newVolumeUSD.toFixed(2)} (${progress.toFixed(1)}%)`);
    setRealtimeVolume(newVolumeUSD);
  }, []);
  const handleSSEMilestone = useCallback((dealKey: string, milestone: 25 | 50 | 75 | 90) => {
    console.log(`[SSE] Milestone reached: ${dealKey.slice(0, 8)}... → ${milestone}%`);
  }, []);

  useDealSSE({
    dealPublicKeys,
    // Only enable SSE for accepted deals that are NOT finalized
    enabled: Boolean(deal?.isAccepted) && !isFinalized,
    onVolumeUpdate: handleSSEVolumeUpdate,
    onMilestone: handleSSEMilestone,
  });

  const handleAcceptBounty = async () => {
    if (!publicKey || !signTransaction || !deal || buttonState !== "idle") return;

    setButtonState("loading");

    try {
      const response = await fetch("/api/deal/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trader: publicKey.toBase58(),
          dealPubkey: deal.publicKey.toBase58(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to build transaction");
      }

      const transaction = Transaction.from(Buffer.from(data.transaction, "base64"));
      const signedTransaction = await signTransactionWithRetry(
        signTransaction,
        transaction,
        {
          maxAttempts: 3,
          retryDelayMs: 1500,
          onRetry: (attempt, maxAttempts) => {
            toast.warning(
              `Wallet disconnected — reconnecting (${attempt}/${maxAttempts - 1})...`,
              { id: "wallet-reconnect", duration: Infinity }
            );
          },
        }
      );
      toast.dismiss("wallet-reconnect");

      const result = await sendTransactionWithRetry(
        connection,
        signedTransaction,
        data.lastValidBlockHeight
      );

      if (!result.success) {
        throw new Error(`Transaction failed: error code ${result.errorCode}`);
      }

      const signature = result.signature;

      // accept_deal txn successful -> push deal to deal table 
      try {
        const syncResponse = await fetch("/api/confirmDealAccepted", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dealPubkey: deal.publicKey.toBase58(),
            signature,
          }),
        });
        const syncData = await syncResponse.json();
        if (!syncResponse.ok) {
          console.error("Failed to sync deal to database:", syncData);
        } else {
          console.log("Deal synced to database:", syncData);
        }
      } catch (syncError) {
        console.error("Failed to sync deal to database:", syncError);
      }

      setButtonState("success");

      toast.success(
        <div className="flex flex-col gap-1">
          <span className="font-medium">Bounty Accepted Successfully</span>
          <a
            href={`https://solscan.io/tx/${signature}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors"
          >
            View on Explorer
            <ArrowUpRight className="w-3 h-3" />
          </a>
        </div>
      );
    } catch (err) {
      toast.dismiss("wallet-reconnect");
      console.error("Failed to accept bounty:", err);
      setButtonState("idle");
      const errorMessage = err instanceof Error ? err.message : "Failed to accept bounty";
      const lowerMessage = errorMessage.toLowerCase();

      if (
        lowerMessage.includes("disconnected port") ||
        lowerMessage.includes("service worker") ||
        lowerMessage.includes("could not establish connection") ||
        lowerMessage.includes("receiving end does not exist")
      ) {
        toast.error("Wallet connection lost", {
          description: "Phantom's background service couldn't reconnect. Please refresh and try again.",
        });
      } else {
        toast.error(errorMessage);
      }
    }
  };

  if (loading) {
    return <DealPageSkeleton />;
  }

  if (error || !deal) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black pl-20">
        <div className="text-red-400">{error || "Deal not found"}</div>
      </div>
    );
  }

  const tokenName = deal.tokenMetadata?.name || "Unknown Token";
  const tokenSymbol = deal.tokenMetadata?.symbol || "???";
  const tokenImage = deal.tokenMetadata?.image || "";
  const showFallback = !tokenImage || imageError;

  const holdDuration = deal.holdDurationInHours;
  const holdText = `${holdDuration} hour${holdDuration !== 1 ? "s" : ""}`;

  // Calculate volume progress
  // For finalized deals: use the stored volumeCompletedUsd from on-chain (preserves value at finalization time)
  // For active deals: use realtime SSE if available, otherwise fall back to API fetch
  const targetVolumeUSD = deal.targetVolume / 10 ** USDC_DECIMALS;
  const dealIsFinalized = deal.outcome !== null && deal.outcome !== undefined;
  const currentVolume = dealIsFinalized && deal.volumeCompletedUsd !== null
    ? deal.volumeCompletedUsd / 10 ** USDC_DECIMALS  // Use stored volume for finalized deals
    : realtimeVolume !== null ? realtimeVolume : volumeUSD;  // Use live data for active deals
  const progressPercentage = Math.min(100, Math.round((currentVolume / targetVolumeUSD) * 100));

  // TODO: Implement hold duration tracking
  const holdProgressPercentage = 0;
  const currentHoldHours = 0;

  const getButtonContent = () => {
    switch (buttonState) {
      case "loading":
        return (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Accepting...</span>
          </>
        );
      case "success":
        return (
          <>
            <Check className="w-5 h-5" />
            <span>Bounty Accepted</span>
          </>
        );
      default:
        return <span>Accept Bounty Offer</span>;
    }
  };

  const getButtonStyles = () => {
    const baseStyles = "w-full font-semibold py-6 text-lg tracking-tight rounded-xl flex items-center justify-center gap-2 transition-all duration-300 cursor-pointer";

    switch (buttonState) {
      case "success":
        return `${baseStyles} bg-green-500 text-white hover:bg-green-600`;
      case "loading":
        return `${baseStyles} bg-gray-300 text-gray-600 cursor-not-allowed`;
      default:
        return `${baseStyles} bg-white text-black hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed`;
    }
  };

  return (
    <div className="min-h-screen bg-black pt-16">
      <div className="max-w-5xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <Link
            href="/"
            className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm tracking-tight">Return to Market</span>
          </Link>
          <div className="flex items-center gap-2">
            {deal.isActive ? (
              <>
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                <span className="text-green-500 text-sm font-medium tracking-tight">Bounty Live</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-red-500" />
                <span className="text-red-500 text-sm font-medium tracking-tight">Bounty Ended</span>
              </>
            )}
          </div>
        </div>

        {/* Token Info & Reward */}
        <div className="flex items-start justify-between mb-10">
          <div className="flex items-center gap-4">
            {showFallback ? (
              <div className="w-20 h-20 rounded-lg bg-[#2a2a2a] flex items-center justify-center text-white text-2xl font-bold">
                {tokenSymbol.charAt(0)}
              </div>
            ) : (
              <img
                src={tokenImage}
                alt={tokenName}
                className="w-20 h-20 rounded-lg object-cover bg-[#2a2a2a]"
                onError={() => setImageError(true)}
              />
            )}
            <div>
              <h1 className="text-white text-3xl font-bold tracking-tight">{tokenName}</h1>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-gray-500 text-sm tracking-tight">{tokenSymbol}</span>
                <span className="text-[#f5c4cb] text-[11px] font-extrabold">{formatMarketCap(marketCap)}</span>
                <span className="text-white/70 text-[11px] font-extrabold ml-[-4px]">MC</span>
              </div>
              <p className="text-gray-500 text-sm tracking-tight flex items-center gap-2">
                <a
                  href={`https://orb.helius.dev/account/${deal.token.toBase58()}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-gray-500 hover:text-white hover:underline transition-colors cursor-pointer"
                >
                  {deal.token.toBase58().slice(0, 4)}...{deal.token.toBase58().slice(-3)}
                  <ArrowUpRight className="w-4 h-4" />
                </a>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(deal.token.toBase58());
                    toast.success("Copied Address");
                  }}
                  className="text-gray-500 hover:text-white transition-colors cursor-pointer"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-gray-500 text-xs tracking-tight mb-1">Claimable Reward</p>
            <p className="text-[#f5a0ac] font-bold text-4xl" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em", textShadow: "0 0 20px rgba(245, 160, 172, 0.4)" }}>{formatUSDC(deal.rewardAmount)}</p>
          </div>
        </div>

        {/* Stats Grid */}
        <div className={`grid gap-4 mb-10 w-full ${deal.minBuyVolume ? "grid-cols-5" : "grid-cols-4"}`}>
          <div className="bg-[#111] rounded-xl p-4 border border-white/10">
            <div className="flex items-center gap-2 text-gray-500 text-xs tracking-tight mb-2">
              <Target className="w-3 h-3" />
              Target Volume
            </div>
            <p className="text-white font-semibold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>{formatUSDC(deal.targetVolume)}</p>
          </div>
          {deal.minBuyVolume && (
            <div className="bg-[#111] rounded-xl p-4 border border-white/10">
              <div className="flex items-center gap-2 text-gray-500 text-xs tracking-tight mb-2">
                <Target className="w-3 h-3" />
                Min Buy Size
              </div>
              <p className="text-white font-semibold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>{formatUSDC(deal.minBuyVolume)}</p>
            </div>
          )}
          <div className="bg-[#111] rounded-xl p-4 border border-white/10">
            <div className="flex items-center gap-2 text-gray-500 text-xs tracking-tight mb-2">
              <Clock className="w-3 h-3" />
              Hold Duration
            </div>
            <p className="text-white font-semibold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>{holdText}</p>
          </div>
          <div className="bg-[#111] rounded-xl p-4 border border-white/10">
            <div className="flex items-center gap-2 text-gray-500 text-xs tracking-tight mb-2">
              <Calendar className="w-3 h-3" />
              Expiry Deadline
            </div>
            <p className="text-white font-semibold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>
              {formatExpiryDate(deal.createdAt, deal.expirationWindowInHours)}
            </p>
          </div>
        </div>

        {/* Progress Sections - Only show when deal is accepted */}
        {deal.isAccepted && (
          <div className="space-y-6 mb-10">
            {/* Volume Progress */}
            <div className="bg-[#111] rounded-xl p-6 border border-white/10">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <p className="text-gray-500 text-xs tracking-tight">Bounty Goal: Volume</p>
                  {/* Only show refresh button for active (non-finalized) deals */}
                  {!dealIsFinalized && (
                    <button
                      onClick={() => refetchVolume()}
                      disabled={volumeLoading}
                      className="text-gray-500 hover:text-white transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      <RefreshCw className={`w-3 h-3 ${volumeLoading ? "animate-spin" : ""}`} />
                    </button>
                  )}
                </div>
                {volumeLoading && !dealIsFinalized ? (
                  <div className="h-5 w-10 bg-[#2a2a2a] rounded animate-pulse" />
                ) : (
                  <p className="text-white font-medium" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>
                    {progressPercentage}%
                  </p>
                )}
              </div>
              <div className="flex items-center gap-4">
                {volumeLoading && !dealIsFinalized ? (
                  <div className="h-8 w-40 bg-[#2a2a2a] rounded animate-pulse" />
                ) : (
                  <p className="text-white text-2xl font-bold" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>
                    {formatVolumeUSD(currentVolume)}
                    <span className="text-gray-500 text-lg font-normal ml-1">
                      /{formatUSDC(deal.targetVolume)}
                    </span>
                  </p>
                )}
                <div className="flex-1 h-2.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all"
                    style={{
                      width: `${progressPercentage}%`,
                      boxShadow: '0 0 12px rgba(16, 185, 129, 0.6), 0 0 4px rgba(16, 185, 129, 0.4)'
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Hold Duration Progress */}
            <div className="bg-[#111] rounded-xl p-6 border border-white/10">
              <div className="flex items-center justify-between mb-3">
                <p className="text-gray-500 text-xs tracking-tight">Bounty Goal: Hold Duration</p>
                <p className="text-white font-medium" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>{holdProgressPercentage}%</p>
              </div>
              <div className="flex items-center gap-4">
                <p className="text-white text-2xl font-bold" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>
                  {currentHoldHours}
                  <span className="text-gray-500 text-lg font-normal ml-1">/{holdText}</span>
                </p>
                <div className="flex-1 h-2.5 bg-[#1a1a1a] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all"
                    style={{
                      width: `${Math.min(holdProgressPercentage, 100)}%`,
                      boxShadow: '0 0 12px rgba(16, 185, 129, 0.6), 0 0 4px rgba(16, 185, 129, 0.4)'
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Accept Button - Only show when deal is not yet accepted */}
        {!deal.isAccepted && (
          <>
            <button
              onClick={handleAcceptBounty}
              disabled={buttonState !== "idle" || !publicKey || !deal.isActive}
              className={getButtonStyles()}
            >
              {getButtonContent()}
            </button>

            {!publicKey && (
              <p className="text-center text-gray-500 mt-4 text-sm tracking-tight">
                Connect your wallet to accept this bounty
              </p>
            )}
          </>
        )}
        {!deal.isActive && !deal.isAccepted && (
          <p className="text-center text-red-500 mt-4 text-sm tracking-tight">
            This bounty is no longer active
          </p>
        )}
      </div>
    </div>
  );
}
