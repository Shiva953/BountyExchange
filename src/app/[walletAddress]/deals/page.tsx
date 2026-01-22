"use client";

import { use, useState, useMemo } from "react";
import Link from "next/link";
import { useAcceptedDeals } from "@/hooks/useAcceptedDeals";
import { DealWithMetadata } from "@/hooks/useDealsForTrader";
import { Clock, TrendingUp, Zap } from "lucide-react";

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
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}K`;
  }
  return `$${value.toLocaleString()}`;
}

function formatVolume(amount: bigint | number): string {
  const value = Number(amount) / 10 ** USDC_DECIMALS;
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}K`;
  }
  return `$${value.toLocaleString()}`;
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

interface ProfileCardProps {
  walletAddress: string;
  activeBounties: number;
  volumeCompleted: number;
}

function ProfileCard({ walletAddress, activeBounties, volumeCompleted }: ProfileCardProps) {
  return (
    <div
      className="w-full rounded-2xl p-6 border border-white/10 mb-8"
      style={{
        background: "linear-gradient(135deg, rgba(40,40,40,0.8) 0%, rgba(20,20,20,0.9) 100%)",
      }}
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        {/* Left: Avatar and wallet info */}
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-zinc-600 to-zinc-800 flex items-center justify-center overflow-hidden">
              <img
                src={`https://api.dicebear.com/7.x/identicon/svg?seed=${walletAddress}`}
                alt="Profile"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-green-500 rounded-full border-2 border-zinc-900 flex items-center justify-center">
              <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            </div>
          </div>
          <div>
            <a
              href={`https://solscan.io/account/${walletAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-white font-bold text-2xl mb-1 font-mono tracking-tight hover:underline transition-all cursor-pointer"
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
              {truncateAddress(walletAddress)}
            </a>
            <span className="inline-block px-3 py-1 bg-[#c8ff00]/20 text-[#c8ff00] text-xs font-semibold rounded-full mx-3">
              Trader
            </span>
          </div>
        </div>

        {/* Right: Stats */}
        <div className="flex gap-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-[#c8ff00]" />
            </div>
            <div>
              <p className="text-zinc-500 text-xs tracking-tight">Volume Completed</p>
              <p className="text-white font-bold text-xl tracking-tight">{formatVolume(volumeCompleted)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
              <Zap className="w-5 h-5 text-[#c8ff00]" />
            </div>
            <div>
              <p className="text-zinc-500 text-xs tracking-tight">Active Bounties</p>
              <p className="text-white font-bold text-xl tracking-tight">{activeBounties}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface TabsProps {
  activeTab: "active" | "completed";
  onTabChange: (tab: "active" | "completed") => void;
  activeCount: number;
  completedCount: number;
}

function Tabs({ activeTab, onTabChange, activeCount, completedCount }: TabsProps) {
  return (
    <div className="flex gap-2 mb-6">
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
  );
}

interface DealCardProps {
  deal: DealWithMetadata;
  isCompleted?: boolean;
}

function DealCard({ deal, isCompleted = false }: DealCardProps) {
  const [imageError, setImageError] = useState(false);
  const tokenName = deal.tokenMetadata?.name || "Unknown Token";
  const tokenSymbol = deal.tokenMetadata?.symbol || "???";
  const tokenImage = deal.tokenMetadata?.image || "";

  const holdDuration = Number(deal.holdDurationInHours);
  const holdText = `${holdDuration} hour${holdDuration !== 1 ? "s" : ""}`;

  const showFallback = !tokenImage || imageError;

  // Mock progress - in a real scenario this would come from tracking
  const progress = isCompleted ? 100 : Math.floor(Math.random() * 80) + 10;
  const progressAmount = (Number(deal.targetVolume) / 10 ** USDC_DECIMALS) * (progress / 100);

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
            <p className="text-zinc-500 text-sm tracking-tight">{tokenSymbol}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-zinc-500 text-xs tracking-tight mb-1">Reward</p>
          <p className="text-[#c8ff00] font-bold text-2xl tracking-tight">
            {formatUSDC(deal.rewardAmount.toNumber())}
          </p>
        </div>
      </div>

      {/* Stats: Target Volume and Status */}
      <div className="grid grid-cols-2 gap-4 mb-5">
        <div className="bg-white/5 rounded-xl p-3">
          <p className="text-zinc-500 text-xs tracking-tight mb-1">Target Volume</p>
          <p className="text-white font-semibold text-lg tracking-tight">
            {formatVolume(deal.targetVolume.toNumber())}
          </p>
        </div>
        <div className="bg-white/5 rounded-xl p-3">
          <p className="text-zinc-500 text-xs tracking-tight mb-1">Status</p>
          <p className={`font-semibold text-lg tracking-tight ${isCompleted ? "text-green-400" : "text-[#c8ff00]"}`}>
            {isCompleted ? "Completed" : "Live"}
          </p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-zinc-400 text-sm tracking-tight">
            <Clock className="w-4 h-4" />
            <span>{isCompleted ? "Completed" : "In Progress"}</span>
          </div>
          <span className="text-zinc-400 text-sm tracking-tight">
            {formatVolume(progressAmount)} done
          </span>
        </div>
        <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              isCompleted ? "bg-green-500" : "bg-[#c8ff00]"
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 text-zinc-500 text-sm tracking-tight">
        <Clock className="w-4 h-4" />
        <span>Hold 80% for {holdText}</span>
      </div>
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

export default function MyDealsPage({ params }: MyDealsPageProps) {
  const { walletAddress } = use(params);
  const { deals, loading, error } = useAcceptedDeals(walletAddress);
  const [activeTab, setActiveTab] = useState<"active" | "completed">("active");

  // Filter deals based on active/completed status
  const { activeDeals, completedDeals } = useMemo(() => {
    const active = deals.filter((deal) => deal.isActive && deal.isAccepted);
    const completed = deals.filter((deal) => !deal.isActive && deal.isAccepted);
    return { activeDeals: active, completedDeals: completed };
  }, [deals]);

  const displayedDeals = activeTab === "active" ? activeDeals : completedDeals;

  return (
    <main className="min-h-screen pt-24 px-6 bg-black">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white tracking-tight">My Deals</h1>
        </div>

        {/* Profile Card */}
        <ProfileCard
          walletAddress={walletAddress}
          activeBounties={activeDeals.length}
          volumeCompleted={0} // Placeholder - will be implemented with transaction tracking
        />

        {/* Tabs */}
        <Tabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          activeCount={activeDeals.length}
          completedCount={completedDeals.length}
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
            {displayedDeals.map((deal) => (
              <DealCard
                key={deal.publicKey.toBase58()}
                deal={deal}
                isCompleted={activeTab === "completed"}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
