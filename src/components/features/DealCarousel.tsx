"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useDealsForTrader, DealWithMetadata } from "@/hooks/useDealsForTrader";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Target } from "lucide-react";

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
  const tokenName = deal.tokenMetadata?.name || "Unknown Token";
  const tokenSymbol = deal.tokenMetadata?.symbol || "???";
  const tokenImage = deal.tokenMetadata?.image || "";

  console.log("[DealCard] Token metadata:", { tokenName, tokenSymbol, tokenImage, fullMetadata: deal.tokenMetadata });

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
          <p className="text-[#f5a0ac] font-bold text-2xl" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em", textShadow: "0 0 20px rgba(245, 160, 172, 0.4)" }}>{formatUSDC(deal.rewardAmount.toNumber())}</p>
        </div>
      </div>

      {/* Stats: Target Volume and Expires */}
      <div className="flex justify-center gap-8 mb-5">
        <div className="text-center">
          <p className="text-gray-500 text-[11px] tracking-tight">Target Volume</p>
          <p className="text-white font-semibold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>{formatVolume(deal.targetVolume.toNumber())}</p>
        </div>
        <div className="text-center">
          <p className="text-gray-500 text-[11px] tracking-tight">Expires in</p>
          <p className="text-white font-semibold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>{deal.expirationWindowInHours.toNumber()}h</p>
        </div>
      </div>

      {/* Footer: View button */}
      <div className="flex items-center justify-center">
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

interface DealCarouselProps {
  searchQuery?: string;
}

export function DealCarousel({ searchQuery = "" }: DealCarouselProps) {
  const router = useRouter();
  const { publicKey } = useWallet();
  const { deals, loading, error } = useDealsForTrader();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Filter deals based on search query (token name, symbol, or address)
  const filteredDeals = deals.filter((deal) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    const tokenName = deal.tokenMetadata?.name?.toLowerCase() || "";
    const tokenSymbol = deal.tokenMetadata?.symbol?.toLowerCase() || "";
    const tokenAddress = deal.token.toBase58().toLowerCase();
    return tokenName.includes(query) || tokenSymbol.includes(query) || tokenAddress.includes(query);
  });

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
