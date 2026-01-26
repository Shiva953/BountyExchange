"use client";

import { use, useState, useMemo, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTraderDeals } from "@/hooks/useTraderDeals";
import { useDealsForTrader, DealWithMetadata } from "@/hooks/useDealsForTrader";
import { Clock, TrendingUp, Zap, Search, ArrowUpDown, Loader2 } from "lucide-react";
import { useBatchVolumeProgress } from "@/hooks/useBatchVolumeProgress";
import { getMarketCap, formatMarketCap } from "@/utils/getMarketCap";

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

function ProfileCard({ walletAddress, traderName, traderImageUrl, activeBounties, volumeCompleted, volumeLoading, isOwnProfile }: ProfileCardProps) {
  const [imageError, setImageError] = useState(false);

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
                <button className="px-3 py-1.5 bg-white hover:bg-zinc-200 rounded-sm text-xs text-black font-medium transition-all cursor-pointer">
                  Sync Telegram
                </button>
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


  useEffect(() => {
    getMarketCap(deal.token.toBase58()).then(setMarketCap);
  }, [deal.token]);

  const showFallback = !tokenImage || imageError;

  // Calculate progress from real volume data
  const targetVolumeUSD = Number(deal.targetVolume) / 10 ** USDC_DECIMALS;
  const progress = isCompleted ? 100 : Math.min(100, (volumeUSD / targetVolumeUSD) * 100);
  const progressAmount = isCompleted ? targetVolumeUSD : volumeUSD;

  return (
    <Link
      href={`/deal/${deal.publicKey.toBase58()}`}
      className="block bg-black rounded-2xl p-5 border border-white/10 hover:border-white/20 transition-colors cursor-pointer"
      style={{
        background:
          "radial-gradient(ellipse 150% 150% at top center, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 40%, black 80%)",
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
          <p className="text-[#f5a0ac] font-bold text-2xl" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em", textShadow: "0 0 20px rgba(245, 160, 172, 0.4)" }}>
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
          <p className={`font-semibold text-lg tracking-tight ${isCompleted ? "text-green-400" : "text-[#f5a0ac]"}`}>
            {isCompleted ? "Completed" : "Live"}
          </p>
        </div>
      </div>

      {/* Progress bar */}
      {showProgress && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-zinc-400 text-sm tracking-tight">
              {volumeLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <div className="h-4 w-16 bg-zinc-800 rounded animate-pulse" />
                </>
              ) : (
                <>
                  <Clock className="w-4 h-4" />
                  <span>{isCompleted ? "Completed" : "In Progress"}</span>
                </>
              )}
            </div>
            {volumeLoading ? (
              <div className="h-4 w-20 bg-zinc-800 rounded animate-pulse" />
            ) : (
              <span className="text-zinc-400 text-sm" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>
                {formatVolumeUSD(progressAmount)} done
              </span>
            )}
          </div>
          <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                isCompleted ? "bg-green-500" : "bg-[#f5a0ac]"
              }`}
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
  const { deals, traderData, loading, error } = useTraderDeals(walletAddress);
  const { deals: availableDeals, loading: availableLoading } = useDealsForTrader();
  const [activeTab, setActiveTab] = useState<"active" | "completed">("active");
  const [searchQuery, setSearchQuery] = useState("");
  const [rewardFilter, setRewardFilter] = useState<RewardFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("reward_desc");

  const isOwnProfile = publicKey?.toBase58() === walletAddress;

  // Track if user was on their own profile (to handle redirect on disconnect)
  const wasOwnProfileRef = useRef(false);
  useEffect(() => {
    if (isOwnProfile) {
      wasOwnProfileRef.current = true;
    }
  }, [isOwnProfile]);

  // Redirect to home page when wallet is disconnected while on own profile
  useEffect(() => {
    if (!connected && wasOwnProfileRef.current) {
      router.push("/");
    }
  }, [connected, router]);

  // Filter deals based on active/completed status, search, and reward filter
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

    const active = filterAndSort(deals.filter((deal) => deal.isActive && deal.isAccepted));
    const completed = filterAndSort(deals.filter((deal) => !deal.isActive && deal.isAccepted));
    return { activeDeals: active, completedDeals: completed };
  }, [deals, searchQuery, rewardFilter, sortBy]);

  const displayedDeals = activeTab === "active" ? activeDeals : completedDeals;

  // Create volume requests for all active and completed deals (batch fetch in parallel)
  // Include minBuyVolume converted from USDC decimals to USD for filtering
  const volumeRequests = useMemo(() => {
    const allDeals = [...activeDeals, ...completedDeals];
    return allDeals.map((deal) => ({
      walletAddress,
      tokenMint: deal.token.toBase58(),
      startTime: deal.createdAt.toNumber(),
      minBuyVolume: deal.minBuyVolume ? deal.minBuyVolume.toNumber() / 10 ** USDC_DECIMALS : undefined,
      key: deal.publicKey.toBase58(),
    }));
  }, [activeDeals, completedDeals, walletAddress]);

  // Batch fetch volumes for all deals in parallel
  const { volumes, loadingKeys } = useBatchVolumeProgress(volumeRequests, volumeRequests.length > 0);

  // Calculate total volume completed
  const totalVolumeCompleted = useMemo(() => {
    let total = 0;
    
    // For completed deals, use target volume (they're completed, so volume reached target)
    completedDeals.forEach((deal) => {
      const targetVolumeUSD = Number(deal.targetVolume) / 10 ** USDC_DECIMALS;
      total += targetVolumeUSD;
    });
    
    // For active deals, use actual tracked volume (if available)
    activeDeals.forEach((deal) => {
      const dealKey = deal.publicKey.toBase58();
      const volumeData = volumes.get(dealKey);
      if (volumeData) {
        total += volumeData.volumeUSD;
      }
    });
    
    return total;
  }, [activeDeals, completedDeals, volumes]);

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
