"use client";

import { use, useState, useMemo, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTraderDeals } from "@/hooks/useTraderDeals";
import { useDealsForTrader, DealWithMetadata } from "@/hooks/useDealsForTrader";
import { Clock, TrendingUp, Zap, Search, ArrowUpDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useBatchVolumeProgress } from "@/hooks/useBatchVolumeProgress";
import { getMarketCap, formatMarketCap } from "@/utils/getMarketCap";

// Detect wallet switches to prevent render errors during transition
function useWalletTransition() {
  const { publicKey, connected } = useWallet();
  const prevWalletRef = useRef<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    const currentWallet = publicKey?.toBase58() ?? null;
    const prevWallet = prevWalletRef.current;

    // Detect wallet switch: connected with different wallet than before
    if (prevWallet && currentWallet && prevWallet !== currentWallet) {
      setIsTransitioning(true);
      // Clear after a tick to allow redirect to happen cleanly
      const timer = setTimeout(() => setIsTransitioning(false), 50);
      return () => clearTimeout(timer);
    }

    if (currentWallet) {
      prevWalletRef.current = currentWallet;
    } else if (!connected) {
      prevWalletRef.current = null;
    }
  }, [publicKey, connected]);

  return isTransitioning;
}

const MONO_FONT = 'GeistMono, ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Monaco, "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace';

interface MyDealsPageProps {
  params: Promise<{
    walletAddress: string;
  }>;
}

const USDC_DECIMALS = 9;

function formatUSDC(amount: bigint | number): string {
  const value = Number(amount) / 10 ** USDC_DECIMALS;
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  return `$${value.toLocaleString()}`;
}

function formatVolume(amount: bigint | number): string {
  const value = Number(amount) / 10 ** USDC_DECIMALS;
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  return `$${value.toLocaleString()}`;
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

function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

interface ProfileCardProps {
  walletAddress: string;
  traderName: string | null;
  traderImageUrl: string | null;
  activeBounties: number;
  volumeCompleted: number;
  volumeLoading: boolean;
  isOwnProfile: boolean;
}

const TELEGRAM_BOT_USERNAME = "deals_notifs_bot";

function ProfileCard({ walletAddress, traderName, traderImageUrl, activeBounties, volumeCompleted, volumeLoading, isOwnProfile }: ProfileCardProps) {
  const [imageError, setImageError] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<"loading" | "linked" | "not_linked">("loading");

  // Check if wallet is linked to Telegram
  useEffect(() => {
    if (!isOwnProfile) return;

    async function checkTelegramStatus() {
      try {
        const res = await fetch(`/api/telegram/status?wallet=${walletAddress}`);
        if (!res.ok) {
          // API error (e.g. DB down) — keep loading state, don't flip to not_linked
          console.error("[TG_STATUS] API returned", res.status);
          return;
        }
        const data = await res.json();
        setTelegramStatus(data.linked ? "linked" : "not_linked");
      } catch {
        // Network error — don't change state, keep whatever it was
        console.error("[TG_STATUS] Network error checking telegram status");
      }
    }

    checkTelegramStatus();

    // Re-check when user returns to the tab (e.g., after unlinking in Telegram)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkTelegramStatus();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [walletAddress, isOwnProfile]);

  const handleSyncTelegram = () => {
    // Open Telegram deep link with wallet address
    const deepLink = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${walletAddress}`;
    window.open(deepLink, "_blank");

    toast.info("Opening Telegram...", {
      description: "Complete verification in the bot, then return here to see updates.",
      duration: 5000,
    });

    // Start polling for status change
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/telegram/status?wallet=${walletAddress}`);
        const data = await res.json();
        if (data.linked) {
          setTelegramStatus("linked");
          clearInterval(pollInterval);
          toast.success("Telegram linked successfully!", {
            description: "You'll now receive notifications for your deals.",
          });
        }
      } catch {
        // Ignore errors during polling
      }
    }, 3000);

    // Stop polling after 5 minutes
    setTimeout(() => clearInterval(pollInterval), 5 * 60 * 1000);
  };

  // Use trader's image if available, otherwise fallback to generated avatar
  const displayImage = traderImageUrl && !imageError
    ? traderImageUrl
    : `https://api.dicebear.com/7.x/identicon/svg?seed=${walletAddress}`;

  // Use trader's name if available, otherwise show truncated address
  const displayName = traderName || truncateAddress(walletAddress);

  return (
    <div
      className="w-full rounded-2xl p-6 border border-white/10 mb-8"
      style={{
        background: "#0a0a0a",
      }}
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        {/* Left: Avatar and wallet info */}
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-zinc-600 to-zinc-800 flex items-center justify-center overflow-hidden">
              <img
                src={displayImage}
                alt="Profile"
                className="w-full h-full object-cover"
                onError={() => setImageError(true)}
              />
            </div>
            <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-green-500 rounded-full border-2 border-zinc-900 flex items-center justify-center">
              <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center">
              <a
                href={`https://solscan.io/account/${walletAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white font-semibold text-xl font-mono tracking-tight hover:underline transition-all cursor-pointer"
                style={{
                  textShadow: "0 0 0px rgba(255, 255, 255, 0)",
                  transition: "text-shadow 0.2s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.textShadow = "0 0 8px rgba(255, 255, 255, 0.4)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.textShadow = "0 0 0px rgba(255, 255, 255, 0)";
                }}
              >
                {displayName}
              </a>
              {traderName && (
                <span className="text-zinc-500 text-sm ml-2 font-mono">
                  ({truncateAddress(walletAddress)})
                </span>
              )}
              <span className="inline-block px-2.5 py-0.5 bg-[#f5a0ac]/20 text-[#f5a0ac] text-xs font-semibold rounded-full ml-3">
                Trader
              </span>
            </div>
            {isOwnProfile && (
              <div className="flex items-center gap-2">
                {telegramStatus === "loading" ? (
                  <button
                    disabled
                    className="px-3 py-1.5 bg-zinc-700 rounded-sm text-xs text-zinc-400 font-medium cursor-not-allowed"
                  >
                    Checking...
                  </button>
                ) : telegramStatus === "linked" ? (
                  <button
                    disabled
                    className="px-3 py-1.5 bg-green-500/20 border border-green-500/30 rounded-sm text-xs text-green-400 font-medium cursor-default flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Telegram Linked
                  </button>
                ) : (
                  <button
                    onClick={handleSyncTelegram}
                    className="px-3 py-1.5 bg-white hover:bg-zinc-200 rounded-sm text-xs text-black font-medium transition-all cursor-pointer"
                  >
                    Sync Telegram
                  </button>
                )}
                <button className="px-3 py-1.5 bg-white hover:bg-zinc-200 rounded-sm text-xs text-black font-medium transition-all cursor-pointer">
                  Edit Profile
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Stats */}
        <div className="flex gap-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-[#f5a0ac]" />
            </div>
            <div>
              <p className="text-zinc-500 text-xs tracking-tight">Volume Completed</p>
              {volumeLoading ? (
                <div className="h-7 w-20 bg-zinc-800 rounded animate-pulse" />
              ) : (
                <p className="text-white font-bold text-xl" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>{formatVolumeUSD(volumeCompleted)}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
              <Zap className="w-5 h-5 text-[#f5a0ac]" />
            </div>
            <div>
              <p className="text-zinc-500 text-xs tracking-tight">Active Bounties</p>
              <p className="text-white font-bold text-xl" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>{activeBounties}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type RewardFilter = "all" | "1k" | "5k" | "10k";
type SortOption = "reward_desc" | "reward_asc" | "volume_desc" | "volume_asc" | "expiry_asc" | "expiry_desc" | "min_buy_desc" | "min_buy_asc";

interface TabsProps {
  activeTab: "active" | "completed";
  onTabChange: (tab: "active" | "completed") => void;
  activeCount: number;
  completedCount: number;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  rewardFilter: RewardFilter;
  onRewardFilterChange: (filter: RewardFilter) => void;
  sortBy: SortOption;
  onSortChange: (sort: SortOption) => void;
}

function Tabs({ activeTab, onTabChange, activeCount, completedCount, searchQuery, onSearchChange, rewardFilter, onRewardFilterChange, sortBy, onSortChange }: TabsProps) {
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const [showSortDropdown, setShowSortDropdown] = useState(false);

  const filterLabels: Record<RewardFilter, string> = {
    all: "All",
    "1k": ">$1K",
    "5k": ">$5K",
    "10k": ">$10K",
  };

  const sortLabels: Record<SortOption, string> = {
    reward_desc: "Reward: High to Low",
    reward_asc: "Reward: Low to High",
    volume_desc: "Volume: High to Low",
    volume_asc: "Volume: Low to High",
    expiry_asc: "Expiry: Soonest",
    expiry_desc: "Expiry: Latest",
    min_buy_desc: "Min Buy: High to Low",
    min_buy_asc: "Min Buy: Low to High",
  };

  return (
    <div className="flex flex-col gap-4 mb-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex gap-2">
          <button
            onClick={() => onTabChange("active")}
            className={`px-6 py-2.5 rounded-full font-semibold text-sm tracking-tight transition-all cursor-pointer ${
              activeTab === "active"
                ? "bg-white text-black"
                : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
            }`}
          >
            Active ({activeCount})
          </button>
          <button
            onClick={() => onTabChange("completed")}
            className={`px-6 py-2.5 rounded-full font-semibold text-sm tracking-tight transition-all cursor-pointer ${
              activeTab === "completed"
                ? "bg-white text-black"
                : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
            }`}
          >
            Completed ({completedCount})
          </button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search by asset..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 pr-4 py-2 bg-white/5 border border-zinc-800 rounded-full text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600 w-48 tracking-tight"
          />
        </div>
      </div>

      {/* Filter Row */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Sort Dropdown */}
        <div className="relative">
          <button
            onClick={() => {
              setShowSortDropdown(!showSortDropdown);
              setShowFilterDropdown(false);
            }}
            className="flex items-center gap-2 px-3 py-1.5 bg-white/5 border border-zinc-800 rounded-full text-xs text-zinc-400 hover:bg-white/10 hover:text-white transition-all cursor-pointer tracking-tight"
          >
            <ArrowUpDown className="w-3 h-3" />
            {sortLabels[sortBy].split(":")[0]}
          </button>
          {showSortDropdown && (
            <div className="absolute left-0 top-full mt-2 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden z-20 min-w-[180px]">
              {(Object.keys(sortLabels) as SortOption[]).map((option) => (
                <button
                  key={option}
                  onClick={() => {
                    onSortChange(option);
                    setShowSortDropdown(false);
                  }}
                  className={`w-full px-4 py-2.5 text-xs text-left tracking-tight transition-colors cursor-pointer ${
                    sortBy === option
                      ? "bg-white/10 text-white"
                      : "text-zinc-400 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  {sortLabels[option]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Reward Filter Dropdown */}
        <div className="relative">
          <button
            onClick={() => {
              setShowFilterDropdown(!showFilterDropdown);
              setShowSortDropdown(false);
            }}
            className="flex items-center gap-2 px-3 py-1.5 bg-white/5 border border-zinc-800 rounded-full text-xs text-zinc-400 hover:bg-white/10 hover:text-white transition-all cursor-pointer tracking-tight"
          >
            Reward: {filterLabels[rewardFilter]}
          </button>
          {showFilterDropdown && (
            <div className="absolute left-0 top-full mt-2 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden z-20 min-w-[120px]">
              {(["all", "1k", "5k", "10k"] as RewardFilter[]).map((filter) => (
                <button
                  key={filter}
                  onClick={() => {
                    onRewardFilterChange(filter);
                    setShowFilterDropdown(false);
                  }}
                  className={`w-full px-4 py-2.5 text-xs text-left tracking-tight transition-colors cursor-pointer ${
                    rewardFilter === filter
                      ? "bg-white/10 text-white"
                      : "text-zinc-400 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  {filterLabels[filter]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface DealCardProps {
  deal: DealWithMetadata;
  isCompleted?: boolean;
  volumeUSD?: number;
  volumeLoading?: boolean;
  showProgress?: boolean;
}

function DealCard({ deal, isCompleted = false, volumeUSD = 0, volumeLoading = false, showProgress = true }: DealCardProps) {
  const [imageError, setImageError] = useState(false);
  const [marketCap, setMarketCap] = useState<number | null>(null);
  const tokenName = deal.tokenMetadata?.name || "Unknown Token";
  const tokenSymbol = deal.tokenMetadata?.symbol || "???";
  const tokenImage = deal.tokenMetadata?.image || "";

  // Get outcome from deal for completed deals
  // If no outcome from DB, derive from volume — but only once volume is loaded
  const targetVolumeForOutcome = Number(deal.targetVolume) / 10 ** USDC_DECIMALS;
  // Keep outcome as-is: undefined = no DB data (on-chain fallback), null = DB confirmed but not yet set
  const outcome = deal.outcome;
  const derivedOutcome = (() => {
    // Definitive outcome from DB — use it directly
    if (outcome === "won" || outcome === "lost") return outcome;
    if (!isCompleted) return undefined;
    // outcome is undefined: on-chain fallback, no DB data at all — can't derive
    if (outcome === undefined) return undefined;
    // outcome is null from DB (deal closed but outcome not yet written) — derive from volume
    if (volumeLoading && deal.volumeCompleted === undefined) return undefined;
    const vol = deal.volumeCompleted !== undefined ? deal.volumeCompleted : volumeUSD;
    return vol >= targetVolumeForOutcome ? "won" : "lost";
  })();
  const isPassed = derivedOutcome === "won";
  const isFailed = derivedOutcome === "lost";
  const outcomeLoading = isCompleted && !derivedOutcome;

  useEffect(() => {
    getMarketCap(deal.token.toBase58()).then(setMarketCap);
  }, [deal.token]);

  const showFallback = !tokenImage || imageError;

  // Calculate progress from real volume data
  const targetVolumeUSD = Number(deal.targetVolume) / 10 ** USDC_DECIMALS;
  // For completed deals, use the stored volumeCompleted if available
  const actualVolumeUSD = isCompleted && deal.volumeCompleted !== undefined
    ? deal.volumeCompleted
    : volumeUSD;
  const progress = isCompleted
    ? (isPassed ? 100 : Math.min(100, (actualVolumeUSD / targetVolumeUSD) * 100))
    : Math.min(100, (volumeUSD / targetVolumeUSD) * 100);
  const progressAmount = isCompleted ? actualVolumeUSD : volumeUSD;

  // Determine status styling based on outcome
  const getStatusDisplay = () => {
    if (!isCompleted) {
      return { text: "Live", className: "text-[#f5a0ac]" };
    }
    if (outcomeLoading) {
      return { text: "...", className: "text-zinc-500 animate-pulse" };
    }
    if (isPassed) {
      return { text: "PASS", className: "text-green-400" };
    }
    if (isFailed) {
      return { text: "FAIL", className: "text-red-400" };
    }
    return { text: "Completed", className: "text-zinc-400" };
  };

  const statusDisplay = getStatusDisplay();

  // Get progress bar color based on outcome
  const getProgressBarColor = () => {
    if (!isCompleted) return "bg-[#f5a0ac]";
    if (isPassed) return "bg-green-500";
    if (isFailed) return "bg-red-500";
    return "bg-zinc-500";
  };

  return (
    <Link
      href={`/deal/${deal.publicKey.toBase58()}`}
      className={`block bg-black rounded-2xl p-5 border transition-all duration-300 cursor-pointer ${
        isCompleted && isFailed
          ? "border-red-500/30 hover:border-red-500/50"
          : isCompleted && isPassed
          ? "border-green-500/30 hover:border-green-500/50"
          : "border-white/10 hover:border-white/20"
      }`}
      style={{
        background: isCompleted && isFailed
          ? "radial-gradient(ellipse 150% 150% at top center, rgba(239,68,68,0.08) 0%, rgba(239,68,68,0.02) 40%, black 80%)"
          : isCompleted && isPassed
          ? "radial-gradient(ellipse 150% 150% at top center, rgba(34,197,94,0.08) 0%, rgba(34,197,94,0.02) 40%, black 80%)"
          : "radial-gradient(ellipse 150% 150% at top center, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 40%, black 80%)",
      }}
    >
      {/* Header: Token info and Reward */}
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="relative">
            {showFallback ? (
              <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center text-white text-lg font-bold">
                {tokenSymbol.charAt(0)}
              </div>
            ) : (
              <img
                src={tokenImage}
                alt={tokenName}
                className="w-12 h-12 rounded-full object-cover bg-zinc-800"
                onError={() => setImageError(true)}
              />
            )}
            {/* Outcome badge on avatar */}
            {isCompleted && !outcomeLoading && (isPassed || isFailed) && (
              <div className={`absolute -bottom-1 -right-1 w-6 h-6 rounded-full border-2 border-black flex items-center justify-center ${
                isPassed ? "bg-green-500" : "bg-red-500"
              }`}>
                {isPassed ? (
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                )}
              </div>
            )}
          </div>
          <div>
            <h3 className="text-white font-semibold text-lg tracking-tight">{tokenName}</h3>
            <div className="flex items-center gap-2">
              <p className="text-zinc-500 text-sm tracking-tight">{tokenSymbol}</p>
              <span className="text-[#f5c4cb] text-[11px] font-extrabold">{formatMarketCap(marketCap)}</span>
              <span className="text-white/70 text-[11px] font-extrabold ml-[-4px]">MC</span>
            </div>
          </div>
        </div>
        <div className="text-right">
          <p className="text-zinc-500 text-xs tracking-tight mb-1">Reward</p>
          <p className={`font-bold text-2xl ${
            isCompleted && isPassed ? "text-green-400" : "text-[#f5a0ac]"
          }`} style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em", textShadow: isCompleted && isPassed ? "0 0 20px rgba(34, 197, 94, 0.4)" : "0 0 20px rgba(245, 160, 172, 0.4)" }}>
            {formatUSDC(deal.rewardAmount.toNumber())}
          </p>
        </div>
      </div>

      {/* Stats: Target Volume, Min Buy, and Status */}
      <div className={`grid gap-4 mb-5 ${deal.minBuyVolume ? "grid-cols-3" : "grid-cols-2"}`}>
        <div className="bg-white/5 rounded-xl p-3">
          <p className="text-zinc-500 text-xs tracking-tight mb-1">Target Volume</p>
          <p className="text-white font-semibold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>
            {formatVolume(deal.targetVolume.toNumber())}
          </p>
        </div>
        {deal.minBuyVolume && (
          <div className="bg-white/5 rounded-xl p-3">
            <p className="text-zinc-500 text-xs tracking-tight mb-1">Min Buy Size</p>
            <p className="text-white font-semibold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>
              {formatVolume(deal.minBuyVolume.toNumber())}
            </p>
          </div>
        )}
        <div className="bg-white/5 rounded-xl p-3">
          <p className="text-zinc-500 text-xs tracking-tight mb-1">Status</p>
          <p className={`font-semibold text-lg tracking-tight ${statusDisplay.className}`}>
            {statusDisplay.text}
          </p>
        </div>
      </div>

      {/* Progress bar */}
      {showProgress && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-zinc-400 text-sm tracking-tight">
              {volumeLoading && !(isCompleted && deal.volumeCompleted !== undefined) ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <div className="h-4 w-16 bg-zinc-800 rounded animate-pulse" />
                </>
              ) : (
                <>
                  <Clock className="w-4 h-4" />
                  <span>{isCompleted ? (isPassed ? "Target reached" : "Target missed") : "In Progress"}</span>
                </>
              )}
            </div>
            {volumeLoading && !(isCompleted && deal.volumeCompleted !== undefined) ? (
              <div className="h-4 w-20 bg-zinc-800 rounded animate-pulse" />
            ) : (
              <span className="text-zinc-400 text-sm" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>
                {formatVolumeUSD(progressAmount)} / {formatVolumeUSD(targetVolumeUSD)}
              </span>
            )}
          </div>
          <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${getProgressBarColor()}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Footer */}
      {!showProgress && (
        <div className="flex items-center justify-center">
          <span
            className="bg-white text-black hover:bg-gray-200 font-semibold px-6 py-2 rounded-lg text-sm cursor-pointer transition-all"
            style={{ boxShadow: "0 0 12px rgba(255, 255, 255, 0.3)" }}
          >
            View
          </span>
        </div>
      )}
    </Link>
  );
}

function LoadingCard() {
  return (
    <div className="bg-zinc-900 rounded-2xl p-5 border border-zinc-800 animate-pulse">
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-zinc-800" />
          <div>
            <div className="h-5 w-24 bg-zinc-800 rounded mb-2" />
            <div className="h-4 w-16 bg-zinc-800 rounded" />
          </div>
        </div>
        <div className="text-right">
          <div className="h-3 w-12 bg-zinc-800 rounded mb-2" />
          <div className="h-7 w-20 bg-zinc-800 rounded" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 mb-5">
        <div className="bg-zinc-800 rounded-xl h-16" />
        <div className="bg-zinc-800 rounded-xl h-16" />
      </div>
      <div className="h-2 bg-zinc-800 rounded-full mb-4" />
      <div className="flex items-center justify-between">
        <div className="h-4 w-32 bg-zinc-800 rounded" />
        <div className="h-4 w-24 bg-zinc-800 rounded" />
      </div>
    </div>
  );
}

function ProfileCardSkeleton() {
  return (
    <div
      className="w-full rounded-2xl p-6 border border-white/10 mb-8 animate-pulse"
      style={{ background: "#0a0a0a" }}
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        {/* Left: Avatar and wallet info skeleton */}
        <div className="flex items-center gap-4">
          <div className="w-20 h-20 rounded-full bg-zinc-800" />
          <div className="flex flex-col gap-2">
            <div className="h-6 w-32 bg-zinc-800 rounded" />
            <div className="h-4 w-24 bg-zinc-800 rounded" />
          </div>
        </div>

        {/* Right: Stats skeleton */}
        <div className="flex gap-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-zinc-800" />
            <div>
              <div className="h-3 w-24 bg-zinc-800 rounded mb-2" />
              <div className="h-6 w-16 bg-zinc-800 rounded" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-zinc-800" />
            <div>
              <div className="h-3 w-24 bg-zinc-800 rounded mb-2" />
              <div className="h-6 w-8 bg-zinc-800 rounded" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MyDealsPage({ params }: MyDealsPageProps) {
  const { walletAddress } = use(params);
  const router = useRouter();
  const { publicKey, connected } = useWallet();
  const isWalletTransitioning = useWalletTransition();

  // Check wallet match BEFORE calling other hooks to prevent errors during wallet switch
  const currentWalletAddress = publicKey?.toBase58();
  const isOwnProfile = currentWalletAddress === walletAddress;

  // During wallet transition or when viewing another wallet's page, skip data fetching
  const shouldFetchData = !isWalletTransitioning && (isOwnProfile || !connected);

  const { deals, traderData, loading, error } = useTraderDeals(shouldFetchData ? walletAddress : null);
  const { deals: availableDeals, loading: availableLoading } = useDealsForTrader();
  const [activeTab, setActiveTab] = useState<"active" | "completed">("active");
  const [completedSubTab, setCompletedSubTab] = useState<"all" | "pass" | "fail">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [rewardFilter, setRewardFilter] = useState<RewardFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("reward_desc");

  // Track if user was on their own profile (to handle redirect on disconnect)
  const wasOwnProfileRef = useRef(false);
  useEffect(() => {
    if (isOwnProfile) {
      wasOwnProfileRef.current = true;
    }
  }, [isOwnProfile]);

  // Handle navigation based on wallet connection state changes
  useEffect(() => {
    // Case 1: Wallet disconnected while on own profile.
    // Delay the redirect to distinguish a real disconnect from a wallet switch
    // (wallet adapters often briefly disconnect before reconnecting with the new wallet).
    // The cleanup function cancels the timer if a new wallet connects before it fires.
    if (!connected && !publicKey && wasOwnProfileRef.current) {
      const timer = setTimeout(() => {
        router.push("/");
      }, 1200);
      return () => clearTimeout(timer);
    }

    // Case 2: A wallet is connected but we're not on our own profile page.
    if (connected && publicKey && !isOwnProfile) {
      if (wasOwnProfileRef.current) {
        // Was on own profile → wallet switched → go to new wallet's deals page
        router.push(`/${currentWalletAddress}/deals`);
      } else {
        // Directly navigated to another wallet's page → go home
        router.push("/");
      }
    }
  }, [connected, publicKey, isOwnProfile, router, currentWalletAddress]);

  // Unfiltered lists for lifetime stats (not affected by search/filter)
  const { allActiveDeals, allCompletedDeals } = useMemo(() => {
    const now = Date.now() / 1000;
    const BUFFER_SEC = 60 * 60; // 60 minutes — matches cron finalization buffer

    const active = deals.filter((deal) => {
      if (!deal.isActive || !deal.isAccepted) return false;
      const expiresAt = deal.createdAt.toNumber() + deal.expirationWindowInHours.toNumber() * 3600;
      return now < expiresAt + BUFFER_SEC;
    });

    const completed = deals.filter((deal) => {
      if (!deal.isAccepted) return false;
      if (!deal.isActive) {
        if (deal.outcome === "expired_unfulfilled") return false;
        return true;
      }
      return false;
    });

    return { allActiveDeals: active, allCompletedDeals: completed };
  }, [deals]);

  // Filter deals based on active/completed status, search, and reward filter (for display)
  const { activeDeals, completedDeals } = useMemo(() => {
    const filterAndSort = (dealsList: DealWithMetadata[]) => {
      let filtered = dealsList;

      // Apply search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        filtered = filtered.filter((deal) => {
          const tokenName = deal.tokenMetadata?.name?.toLowerCase() || "";
          const tokenSymbol = deal.tokenMetadata?.symbol?.toLowerCase() || "";
          const tokenAddress = deal.token.toBase58().toLowerCase();
          return tokenName.includes(query) || tokenSymbol.includes(query) || tokenAddress.includes(query);
        });
      }

      // Apply reward filter
      const rewardThresholds: Record<RewardFilter, number> = {
        all: 0,
        "1k": 1000 * 10 ** USDC_DECIMALS,
        "5k": 5000 * 10 ** USDC_DECIMALS,
        "10k": 10000 * 10 ** USDC_DECIMALS,
      };
      const threshold = rewardThresholds[rewardFilter];
      if (threshold > 0) {
        filtered = filtered.filter((deal) => deal.rewardAmount.toNumber() > threshold);
      }

      // Sort based on selected option
      filtered = [...filtered].sort((a, b) => {
        switch (sortBy) {
          case "reward_desc":
            return b.rewardAmount.toNumber() - a.rewardAmount.toNumber();
          case "reward_asc":
            return a.rewardAmount.toNumber() - b.rewardAmount.toNumber();
          case "volume_desc":
            return b.targetVolume.toNumber() - a.targetVolume.toNumber();
          case "volume_asc":
            return a.targetVolume.toNumber() - b.targetVolume.toNumber();
          case "expiry_asc":
            return a.expirationWindowInHours.toNumber() - b.expirationWindowInHours.toNumber();
          case "expiry_desc":
            return b.expirationWindowInHours.toNumber() - a.expirationWindowInHours.toNumber();
          case "min_buy_desc":
            return (b.minBuyVolume?.toNumber() ?? 0) - (a.minBuyVolume?.toNumber() ?? 0);
          case "min_buy_asc":
            return (a.minBuyVolume?.toNumber() ?? 0) - (b.minBuyVolume?.toNumber() ?? 0);
          default:
            return 0;
        }
      });

      return filtered;
    };

    return {
      activeDeals: filterAndSort(allActiveDeals),
      completedDeals: filterAndSort(allCompletedDeals),
    };
  }, [allActiveDeals, allCompletedDeals, searchQuery, rewardFilter, sortBy]);

  // Helper to derive outcome for a deal (same logic as DealCard)
  const getDerivedOutcome = (deal: DealWithMetadata): "won" | "lost" | undefined => {
    if (deal.outcome === "won" || deal.outcome === "lost") return deal.outcome;
    // If no outcome from DB, derive from volumeCompleted
    if (deal.volumeCompleted !== undefined) {
      const targetVolumeUSD = Number(deal.targetVolume) / 10 ** USDC_DECIMALS;
      return deal.volumeCompleted >= targetVolumeUSD ? "won" : "lost";
    }
    return undefined;
  };

  // Filter completed deals by sub-tab
  const filteredCompletedDeals = useMemo(() => {
    if (completedSubTab === "all") return completedDeals;
    return completedDeals.filter((deal) => {
      const outcome = getDerivedOutcome(deal);
      if (completedSubTab === "pass") return outcome === "won";
      if (completedSubTab === "fail") return outcome === "lost";
      return true;
    });
  }, [completedDeals, completedSubTab]);

  const displayedDeals = activeTab === "active" ? activeDeals : filteredCompletedDeals;

  // Volume requests for active deals only - completed deals already have volumeCompleted in DB
  const volumeRequests = useMemo(() => {
    return allActiveDeals.map((deal) => ({
      walletAddress,
      tokenMint: deal.token.toBase58(),
      startTime: deal.createdAt.toNumber(),
      minBuyVolume: deal.minBuyVolume ? deal.minBuyVolume.toNumber() / 10 ** USDC_DECIMALS : undefined,
      key: deal.publicKey.toBase58(),
      targetVolume: Number(deal.targetVolume) / 10 ** USDC_DECIMALS,
    }));
  }, [allActiveDeals, walletAddress]);

  // Batch fetch volumes for all deals in parallel
  const { volumes, loadingKeys } = useBatchVolumeProgress(volumeRequests, volumeRequests.length > 0);

  // Calculate total LIFETIME volume completed (uses unfiltered lists)
  const totalVolumeCompleted = useMemo(() => {
    let total = 0;

    // For ALL completed deals, use the actual volumeCompleted stored in DB
    allCompletedDeals.forEach((deal) => {
      // Use volumeCompleted if available (from DB), otherwise fall back to target for won deals
      if (deal.volumeCompleted !== undefined) {
        total += deal.volumeCompleted;
      } else if (deal.outcome === "won") {
        // Fallback: if won but no volumeCompleted stored, use target
        const targetVolumeUSD = Number(deal.targetVolume) / 10 ** USDC_DECIMALS;
        total += targetVolumeUSD;
      }
      // For lost deals without volumeCompleted, we add 0 (they didn't complete the target)
    });

    // For ALL active deals, use actual tracked volume (if available)
    allActiveDeals.forEach((deal) => {
      const dealKey = deal.publicKey.toBase58();
      const volumeData = volumes.get(dealKey);
      if (volumeData) {
        total += volumeData.volumeUSD;
      }
    });

    return total;
  }, [allActiveDeals, allCompletedDeals, volumes]);

  // Don't render during wallet transition to prevent errors
  if (isWalletTransitioning) {
    return (
      <main className="min-h-screen pt-24 px-6 bg-black pl-28">
        <div className="max-w-6xl mt-6 mx-auto">
          <div className="flex items-center justify-center min-h-[50vh]">
            <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
          </div>
        </div>
      </main>
    );
  }

  // Don't render content if viewing another wallet's deals page (redirect in progress)
  if (connected && publicKey && !isOwnProfile) {
    return null;
  }

  return (
    <main className="min-h-screen pt-24 px-6 bg-black pl-28">
      <div className="max-w-6xl mt-6 mx-auto">
        {/* Profile Card */}
        {loading ? (
          <ProfileCardSkeleton />
        ) : (
          <ProfileCard
            walletAddress={walletAddress}
            traderName={traderData?.name ?? null}
            traderImageUrl={traderData?.imageUrl ?? null}
            activeBounties={activeDeals.length}
            volumeCompleted={totalVolumeCompleted}
            volumeLoading={loadingKeys.size > 0}
            isOwnProfile={isOwnProfile}
          />
        )}

        {/* Available Bounties Section - Only for own profile */}
        {isOwnProfile && (
          <div className="mb-10">
            <h2 className="text-white font-semibold text-xl tracking-tight mb-4">Available Bounties</h2>
            {availableLoading && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                <LoadingCard />
                <LoadingCard />
              </div>
            )}
            {!availableLoading && availableDeals.length === 0 && (
              <div className="bg-zinc-900/50 border border-zinc-800 border-dashed rounded-2xl p-8 text-center">
                <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-3">
                  <Zap className="w-6 h-6 text-zinc-600" />
                </div>
                <p className="text-zinc-500 text-base tracking-tight">No available bounties</p>
                <p className="text-zinc-600 text-sm tracking-tight mt-1">
                  Check back later for new opportunities
                </p>
              </div>
            )}
            {!availableLoading && availableDeals.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {availableDeals.map((deal) => (
                  <DealCard
                    key={deal.publicKey.toBase58()}
                    deal={deal}
                    isCompleted={false}
                    showProgress={false}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <Tabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          activeCount={activeDeals.length}
          completedCount={completedDeals.length}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          rewardFilter={rewardFilter}
          onRewardFilterChange={setRewardFilter}
          sortBy={sortBy}
          onSortChange={setSortBy}
        />

        {/* Completed sub-tabs */}
        {activeTab === "completed" && completedDeals.length > 0 && (
          <div className="flex gap-2 mb-5">
            {(["all", "pass", "fail"] as const).map((tab) => {
              const count = tab === "all"
                ? completedDeals.length
                : tab === "pass"
                ? completedDeals.filter((d) => getDerivedOutcome(d) === "won").length
                : completedDeals.filter((d) => getDerivedOutcome(d) === "lost").length;
              const label = tab === "all" ? "All" : tab === "pass" ? "Pass" : "Fail";
              return (
                <button
                  key={tab}
                  onClick={() => setCompletedSubTab(tab)}
                  className={`px-4 py-1.5 rounded-full text-xs font-semibold tracking-tight transition-all duration-200 cursor-pointer ${
                    completedSubTab === tab
                      ? tab === "pass"
                        ? "bg-green-500/20 text-green-400 border border-green-500/30"
                        : tab === "fail"
                        ? "bg-red-500/20 text-red-400 border border-red-500/30"
                        : "bg-white/10 text-white border border-white/20"
                      : "bg-white/5 text-zinc-500 hover:bg-white/10 hover:text-zinc-300 border border-transparent"
                  }`}
                >
                  {label} ({count})
                </button>
              );
            })}
          </div>
        )}

        {/* Content */}
        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            <LoadingCard />
            <LoadingCard />
            <LoadingCard />
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-6 text-center">
            <p className="text-red-400">{error}</p>
          </div>
        )}

        {!loading && !error && displayedDeals.length === 0 && (
          <div className="bg-zinc-900/50 border border-zinc-800 border-dashed rounded-2xl p-12 text-center">
            <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-4">
              <Zap className="w-8 h-8 text-zinc-600" />
            </div>
            <p className="text-zinc-500 text-lg tracking-tight">
              No {activeTab} deals found
            </p>
            <p className="text-zinc-600 text-sm tracking-tight mt-2">
              {activeTab === "active"
                ? "Accept some bounties to see them here"
                : "Complete some bounties to see them here"}
            </p>
          </div>
        )}

        {!loading && !error && displayedDeals.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {displayedDeals.map((deal) => {
              const dealKey = deal.publicKey.toBase58();
              const volumeData = volumes.get(dealKey);
              const isVolumeLoading = loadingKeys.has(dealKey);
              return (
                <DealCard
                  key={dealKey}
                  deal={deal}
                  isCompleted={activeTab === "completed"}
                  volumeUSD={volumeData?.volumeUSD ?? 0}
                  volumeLoading={isVolumeLoading}
                />
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
