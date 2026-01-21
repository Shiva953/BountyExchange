"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useDealsForTrader, DealWithMetadata } from "@/hooks/useDealsForTrader";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Clock, Target } from "lucide-react";

// Using 9 decimals for stored amounts
const USDC_DECIMALS = 9;

function formatUSDC(amount: bigint | number): string {
  const value = Number(amount) / 10 ** USDC_DECIMALS;
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}K`;
  }
  return `$${value.toLocaleString()}`;
}

function formatVolume(amount: bigint | number): string {
  const value = Number(amount) / 10 ** USDC_DECIMALS;
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}K`;
  }
  return `$${value.toLocaleString()}`;
}

interface DealCardProps {
  deal: DealWithMetadata;
  onClick: (deal: DealWithMetadata) => void;
}

function DealCard({ deal, onClick }: DealCardProps) {
  const [imageError, setImageError] = useState(false);
  const tokenName = deal.tokenMetadata?.name || "Unknown Token";
  const tokenSymbol = deal.tokenMetadata?.symbol || "???";
  const tokenImage = deal.tokenMetadata?.image || "";

  console.log("[DealCard] Token metadata:", { tokenName, tokenSymbol, tokenImage, fullMetadata: deal.tokenMetadata });

  const holdPercentage = 100; // Default to 100% as shown in the design
  const holdDuration = Number(deal.holdDurationInHours);
  const holdText = `${holdDuration} hour${holdDuration !== 1 ? 's' : ''}`;

  const showFallback = !tokenImage || imageError;

  return (
    <div
      onClick={() => onClick(deal)}
      className="flex-shrink-0 w-[340px] bg-black rounded-2xl p-5 border border-white/20 hover:border-white/30 transition-colors cursor-pointer"
      style={{ background: 'radial-gradient(ellipse 150% 150% at top center, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.03) 40%, black 80%)' }}
    >
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
            <p className="text-gray-500 text-sm tracking-tight">{tokenSymbol}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-gray-500 text-xs tracking-tight mb-1">Reward</p>
          <p className="text-[#c8ff00] font-bold text-2xl">{formatUSDC(deal.rewardAmount.toNumber())}</p>
        </div>
      </div>

      {/* Stats: Target Volume and Expires */}
      <div className="flex gap-8 mb-5">
        <div>
          <p className="text-gray-500 text-xs tracking-tight mb-1">Target Volume</p>
          <p className="text-white font-semibold text-xl">{formatVolume(deal.targetVolume.toNumber())}</p>
        </div>
        <div>
          <p className="text-gray-500 text-xs tracking-tight mb-1">Expires in</p>
          <p className="text-white font-semibold text-xl">{deal.expirationWindowInHours.toNumber()}h</p>
        </div>
      </div>

      {/* Footer: Hold info */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <Clock className="w-4 h-4" />
          <span>Hold {holdPercentage}% for {holdText}</span>
        </div>
        <Button
          className="bg-white text-black hover:bg-gray-200 font-semibold px-6 py-2 rounded-lg text-sm cursor-pointer"
        >
          View
        </Button>
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

export function DealCarousel() {
  const router = useRouter();
  const { publicKey } = useWallet();
  const { deals, loading, error } = useDealsForTrader();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

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
      <div className="flex items-center gap-3 mb-6">
        <div className="flex items-center justify-center w-8 h-8 rounded-full border border-[#3a3a3a]">
          <Target className="w-4 h-4 text-white" />
        </div>
        <h2 className="text-white font-semibold text-lg tracking-tight">
          Available Bounties
        </h2>
        <div className="flex-1 h-px bg-gradient-to-r from-[#3a3a3a] to-transparent ml-4" />
      </div>

      {/* Carousel */}
      <div className="relative">
        {/* Navigation buttons */}
        {deals.length > 2 && (
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
          {loading ? (
            <>
              <LoadingCard />
              <LoadingCard />
              <LoadingCard />
            </>
          ) : error ? (
            <div className="flex-shrink-0 w-[340px] bg-[#1a1a1a] rounded-2xl p-5 border border-red-500/30 flex items-center justify-center min-h-[200px]">
              <p className="text-red-400">{error}</p>
            </div>
          ) : deals.length === 0 ? (
            <div className="flex-shrink-0 w-[340px] bg-[#1a1a1a] rounded-2xl p-5 border border-[#2a2a2a] border-dashed flex items-center justify-center min-h-[200px]">
              <p className="text-gray-500 text-lg font-medium">No bounties available</p>
            </div>
          ) : (
            deals.map((deal) => (
              <DealCard key={deal.publicKey.toBase58()} deal={deal} onClick={handleCardClick} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
