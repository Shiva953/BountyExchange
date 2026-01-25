"use client";

import { useRef, useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useDealsForTrader, DealWithMetadata } from "@/hooks/useDealsForTrader";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Target, ArrowUpDown } from "lucide-react";
import { getMarketCap, formatMarketCap } from "@/utils/getMarketCap";

// Using 9 decimals for stored amounts
const USDC_DECIMALS = 9;
const MONO_FONT = 'GeistMono, ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Monaco, "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace';

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

interface DealCardProps {
  deal: DealWithMetadata;
  onClick: (deal: DealWithMetadata) => void;
}

function DealCard({ deal, onClick }: DealCardProps) {
  const [imageError, setImageError] = useState(false);
  const [marketCap, setMarketCap] = useState<number | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const tokenName = deal.tokenMetadata?.name || "Unknown Token";
  const tokenSymbol = deal.tokenMetadata?.symbol || "???";
  const tokenImage = deal.tokenMetadata?.image || "";

  console.log("[DealCard] Token metadata:", { tokenName, tokenSymbol, tokenImage, fullMetadata: deal.tokenMetadata });

  useEffect(() => {
    getMarketCap(deal.token.toBase58()).then(setMarketCap);
  }, [deal.token]);

  const showFallback = !tokenImage || imageError;

  return (
    <div
      onClick={() => onClick(deal)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="flex-shrink-0 w-[340px] rounded-2xl p-5 border border-white/20 hover:border-white/30 cursor-pointer relative overflow-hidden"
      style={{ 
        background: 'radial-gradient(ellipse 150% 150% at top center, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.03) 40%, black 80%)',
        transition: 'border-color 300ms ease-in-out'
      }}
    >
      {/* Hover overlay for smooth transition */}
      <div
        className="absolute inset-0 rounded-2xl pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 150% 150% at top center, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.06) 40%, rgba(30,30,30,1) 80%)',
          opacity: isHovered ? 1 : 0,
          transition: 'opacity 600ms cubic-bezier(0.4, 0, 0.2, 1)'
        }}
      />
      <div className="relative z-10">
      {/* Header: Token info and Reward */}
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="relative">
            {showFallback ? (
              <div className="w-12 h-12 rounded-full bg-[#2a2a2a] flex items-center justify-center text-white text-lg font-bold">
                {tokenSymbol.charAt(0)}
              </div>
            ) : (
              <img
                src={tokenImage}
                alt={tokenName}
                className="w-12 h-12 rounded-full object-cover bg-[#2a2a2a]"
                onError={() => setImageError(true)}
              />
            )}
            <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-[#2a2a2a] rounded-full flex items-center justify-center border-2 border-[#1a1a1a]">
              <Target className="w-3 h-3 text-gray-400" />
            </div>
          </div>
          <div>
            <h3 className="text-white font-semibold text-lg">{tokenName}</h3>
            <div className="flex items-center gap-2">
              <p className="text-gray-500 text-sm tracking-tight">{tokenSymbol}</p>
              <span className="text-[#f5c4cb] text-[11px] font-extrabold">{formatMarketCap(marketCap)}</span>
              <span className="text-white/70 text-[11px] font-extrabold ml-[-4px]">MC</span>
            </div>
          </div>
        </div>
        <div className="text-right">
          <p className="text-gray-500 text-xs tracking-tight mb-1">Reward</p>
          <p className="text-[#f5a0ac] font-bold text-2xl" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em", textShadow: "0 0 20px rgba(245, 160, 172, 0.4)" }}>{formatUSDC(deal.rewardAmount.toNumber())}</p>
        </div>
      </div>

      {/* Stats: Target Volume, Min Buy, and Expires */}
      <div className={`flex justify-center mb-5 ${deal.minBuyVolume ? "gap-4" : "gap-8"}`}>
        <div className="text-center">
          <p className="text-gray-500 text-[11px] tracking-tight">Target Volume</p>
          <p className="text-white font-semibold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>{formatVolume(deal.targetVolume.toNumber())}</p>
        </div>
        {deal.minBuyVolume && (
          <div className="text-center">
            <p className="text-gray-500 text-[11px] tracking-tight">Min Buy</p>
            <p className="text-white font-semibold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>{formatVolume(deal.minBuyVolume.toNumber())}</p>
          </div>
        )}
        <div className="text-center">
          <p className="text-gray-500 text-[11px] tracking-tight">Expires in</p>
          <p className="text-white font-semibold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>{deal.expirationWindowInHours.toNumber()}h</p>
        </div>
      </div>

      {/* Footer: View button */}
      <div className="flex items-center justify-center">
        <Button
          className="bg-white text-black hover:bg-gray-200 font-semibold px-6 py-2 rounded-lg text-sm cursor-pointer transition-all"
          style={{ boxShadow: "0 0 12px rgba(255, 255, 255, 0.3)" }}
        >
          View
        </Button>
      </div>
      </div>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="flex-shrink-0 w-[340px] bg-[#1a1a1a] rounded-2xl p-5 border border-[#2a2a2a] animate-pulse">
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-[#2a2a2a]" />
          <div>
            <div className="h-5 w-24 bg-[#2a2a2a] rounded mb-2" />
            <div className="h-4 w-16 bg-[#2a2a2a] rounded" />
          </div>
        </div>
        <div className="text-right">
          <div className="h-3 w-12 bg-[#2a2a2a] rounded mb-2" />
          <div className="h-7 w-20 bg-[#2a2a2a] rounded" />
        </div>
      </div>
      <div className="flex gap-8 mb-5">
        <div>
          <div className="h-3 w-20 bg-[#2a2a2a] rounded mb-2" />
          <div className="h-6 w-16 bg-[#2a2a2a] rounded" />
        </div>
        <div>
          <div className="h-3 w-16 bg-[#2a2a2a] rounded mb-2" />
          <div className="h-6 w-12 bg-[#2a2a2a] rounded" />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div className="h-4 w-32 bg-[#2a2a2a] rounded" />
        <div className="h-9 w-20 bg-[#2a2a2a] rounded" />
      </div>
    </div>
  );
}

type SortOption = "reward_desc" | "reward_asc" | "volume_desc" | "volume_asc" | "expiry_asc" | "expiry_desc" | "min_buy_desc" | "min_buy_asc";

interface DealCarouselProps {
  searchQuery?: string;
}

export function DealCarousel({ searchQuery = "" }: DealCarouselProps) {
  const router = useRouter();
  const { publicKey } = useWallet();
  const { deals, loading, error } = useDealsForTrader();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [sortBy, setSortBy] = useState<SortOption>("reward_desc");
  const [showSortDropdown, setShowSortDropdown] = useState(false);

  // Filter and sort deals
  const filteredDeals = useMemo(() => {
    let result = [...deals];

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((deal) => {
        const tokenName = deal.tokenMetadata?.name?.toLowerCase() || "";
        const tokenSymbol = deal.tokenMetadata?.symbol?.toLowerCase() || "";
        const tokenAddress = deal.token.toBase58().toLowerCase();
        return tokenName.includes(query) || tokenSymbol.includes(query) || tokenAddress.includes(query);
      });
    }

    // Sort
    result.sort((a, b) => {
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

    return result;
  }, [deals, searchQuery, sortBy]);

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

  const handleCardClick = (deal: DealWithMetadata) => {
    router.push(`/deal/${deal.publicKey.toBase58()}`);
  };

  const scroll = (direction: "left" | "right") => {
    if (scrollContainerRef.current) {
      const scrollAmount = 360; // Card width + gap
      scrollContainerRef.current.scrollBy({
        left: direction === "left" ? -scrollAmount : scrollAmount,
        behavior: "smooth",
      });
    }
  };

  // Don't show carousel if wallet not connected
  if (!publicKey) {
    return null;
  }

  return (
    <div className="w-full mb-12">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-full border border-[#3a3a3a]">
            <Target className="w-4 h-4 text-white" />
          </div>
          <h2 className="text-white font-semibold text-lg tracking-tight">
            Available Bounties
          </h2>
        </div>

        {/* Sort Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowSortDropdown(!showSortDropdown)}
            className="flex items-center gap-2 px-3 py-1.5 bg-white/5 border border-zinc-800 rounded-full text-xs text-zinc-400 hover:bg-white/10 hover:text-white transition-all cursor-pointer tracking-tight"
          >
            <ArrowUpDown className="w-3 h-3" />
            {sortLabels[sortBy].split(":")[0]}
          </button>
          {showSortDropdown && (
            <div className="absolute right-0 top-full mt-2 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden z-20 min-w-[180px]">
              {(Object.keys(sortLabels) as SortOption[]).map((option) => (
                <button
                  key={option}
                  onClick={() => {
                    setSortBy(option);
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
      </div>

      {/* Carousel */}
      <div className="relative">
        {/* Navigation buttons */}
        {filteredDeals.length > 2 && (
          <>
            <button
              onClick={() => scroll("left")}
              className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-4 z-10 w-10 h-10 bg-[#2a2a2a] hover:bg-[#3a3a3a] rounded-full flex items-center justify-center text-white transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => scroll("right")}
              className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-4 z-10 w-10 h-10 bg-[#2a2a2a] hover:bg-[#3a3a3a] rounded-full flex items-center justify-center text-white transition-colors cursor-pointer"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </>
        )}

        {/* Cards container */}
        <div
          ref={scrollContainerRef}
          className="flex gap-5 overflow-x-auto scrollbar-hide pb-2"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {loading || error ? (
            <>
              <LoadingCard />
              <LoadingCard />
              <LoadingCard />
            </>
          ) : filteredDeals.length === 0 ? (
            <div className="flex-shrink-0 w-[340px] bg-[#1a1a1a] rounded-2xl p-5 border border-[#2a2a2a] border-dashed flex items-center justify-center min-h-[200px]">
              <p className="text-gray-500 text-lg font-medium">
                {searchQuery ? "No matching bounties" : "No bounties available"}
              </p>
            </div>
          ) : (
            filteredDeals.map((deal) => (
              <DealCard key={deal.publicKey.toBase58()} deal={deal} onClick={handleCardClick} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
