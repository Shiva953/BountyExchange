"use client";

import { useState, useEffect, useMemo } from "react";
import { Search, Grid3x3, Zap, ChevronLeft, ChevronRight } from "lucide-react";
import { Trader as BaseTrader } from "@/types/trader";

const MONO_FONT = 'GeistMono, ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Monaco, "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace';
const PAGE_SIZE = 6;

// Extends the shared Trader with the completionPercentage display field
interface Trader extends BaseTrader {
  completionPercentage: number;
}

function formatVolume(amount: number): string {
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (amount >= 1000) {
    return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
  return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-3)}`;
}

interface TraderCardProps {
  trader: Trader;
}

function TraderCard({ trader }: TraderCardProps) {
  return (
    <div className="relative rounded-2xl p-5 border border-white/10 bg-[#0a0a0a] hover:border-white/20 transition-all cursor-pointer">
      {/* Profile Picture */}
      <div className="relative mb-4">
        <div className="w-16 h-16 rounded-lg overflow-hidden bg-gradient-to-br from-zinc-600 to-zinc-800">
          {trader.imageUrl ? (
            <img
              src={trader.imageUrl}
              alt={trader.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white text-xl font-bold">
              {trader.name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        {/* Lightning bolt icon for active traders */}
        {trader.activeBounties > 0 && (
          <div className="absolute -top-1 -right-1 w-6 h-6 bg-yellow-500 rounded-full flex items-center justify-center border-2 border-[#0a0a0a]">
            <Zap className="w-3 h-3 text-black" fill="black" />
          </div>
        )}
      </div>

      {/* Trader Name */}
      <h3 className="text-white font-semibold text-base mb-1 tracking-tight">{trader.name}</h3>

      {/* Trader ID */}
      <p className="text-zinc-500 text-xs mb-4 tracking-tight font-mono">
        {truncateAddress(trader.address)}
      </p>

      {/* Completion Percentage - Top Right */}
      <div className="absolute top-5 right-5 text-right">
        <p className="text-zinc-500 text-xs tracking-tight mb-1">Completion %</p>
        <p className="text-white font-bold text-2xl" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>
          {trader.completionPercentage}%
        </p>
      </div>

      {/* Volume Completed */}
      <div className="mb-3">
        <p className="text-zinc-500 text-xs tracking-tight mb-1">Volume Completed</p>
        <p className="text-white font-bold text-lg" style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}>
          {formatVolume(trader.volumeCompleted)}
        </p>
      </div>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="relative rounded-2xl p-5 border border-white/10 bg-[#0a0a0a] animate-pulse">
      {/* Profile Picture Skeleton */}
      <div className="relative mb-4">
        <div className="w-16 h-16 rounded-lg bg-zinc-800" />
        <div className="absolute -top-1 -right-1 w-6 h-6 bg-zinc-800 rounded-full border-2 border-[#0a0a0a]" />
      </div>

      {/* Trader Name Skeleton */}
      <div className="h-5 w-24 bg-zinc-800 rounded mb-1" />

      {/* Trader ID Skeleton */}
      <div className="h-3 w-20 bg-zinc-800 rounded mb-4" />

      {/* Completion Percentage Skeleton - Top Right */}
      <div className="absolute top-5 right-5">
        <div className="h-7 w-12 bg-zinc-800 rounded" />
      </div>

      {/* Volume Completed Skeleton */}
      <div className="mb-3">
        <div className="h-3 w-28 bg-zinc-800 rounded mb-1" />
        <div className="h-6 w-20 bg-zinc-800 rounded" />
      </div>

      {/* Action Icon Skeleton - Bottom Right */}
      <div className="absolute bottom-5 right-5 w-8 h-8 rounded-lg bg-zinc-800" />
    </div>
  );
}

/** Returns the page numbers to render, inserting `null` as an ellipsis marker. */
function getPageWindows(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages: (number | null)[] = [];
  const addRange = (lo: number, hi: number) => {
    for (let i = lo; i <= hi; i++) pages.push(i);
  };

  // Always show first 2
  addRange(1, 2);

  const leftEdge = Math.max(3, current - 1);
  const rightEdge = Math.min(total - 2, current + 1);

  if (leftEdge > 3) pages.push(null); // left ellipsis
  addRange(leftEdge, rightEdge);
  if (rightEdge < total - 2) pages.push(null); // right ellipsis

  // Always show last 2
  addRange(total - 1, total);

  return pages;
}

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}

function Pagination({ currentPage, totalPages, totalItems, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, totalItems);
  const pages = getPageWindows(currentPage, totalPages);

  return (
    <div className="flex flex-col items-center gap-4 mt-8">
      {/* Count label */}
      <p className="text-zinc-500 text-xs tracking-tight">
        Showing <span className="text-zinc-300">{start}–{end}</span> of{" "}
        <span className="text-zinc-300">{totalItems}</span> traders
      </p>

      {/* Controls */}
      <div className="flex items-center gap-1.5">
        {/* Prev */}
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="flex items-center justify-center w-8 h-8 rounded-lg border border-white/10 text-zinc-400 hover:text-white hover:border-white/25 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-all"
          aria-label="Previous page"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {/* Page numbers */}
        {pages.map((page, idx) =>
          page === null ? (
            <span key={`ellipsis-${idx}`} className="w-8 text-center text-zinc-600 text-sm select-none">
              ···
            </span>
          ) : (
            <button
              key={page}
              onClick={() => onPageChange(page)}
              className={`w-8 h-8 rounded-lg text-sm font-medium cursor-pointer transition-all ${
                page === currentPage
                  ? "bg-white text-black"
                  : "border border-white/10 text-zinc-400 hover:text-white hover:border-white/25"
              }`}
            >
              {page}
            </button>
          )
        )}

        {/* Next */}
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="flex items-center justify-center w-8 h-8 rounded-lg border border-white/10 text-zinc-400 hover:text-white hover:border-white/25 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-all"
          aria-label="Next page"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export function TraderIndex() {
  const [traders, setTraders] = useState<Trader[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    const fetchTradersWithRetry = async (
      maxRetries: number = 3,
      initialDelay: number = 1000
    ) => {
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          setLoading(true);
          const response = await fetch("/api/getTraders");

          if (!response.ok) {
            const errorData = await response.json();

            if (errorData.retryable && attempt < maxRetries) {
              const delay = initialDelay * Math.pow(2, attempt);
              console.log(`Retrying fetch in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            }

            throw new Error(errorData.error || "Failed to fetch traders");
          }

          const data = await response.json();
          if (data.success) {
            setTraders(data.traders);
            setLoading(false);
            return;
          } else {
            throw new Error(data.error || "Failed to fetch traders");
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error("Unknown error");

          if (attempt === maxRetries) {
            console.error("Error fetching traders after retries:", lastError);
            setTraders([]);
            setLoading(false);
            return;
          }

          const delay = initialDelay * Math.pow(2, attempt);
          console.log(`Error fetching traders, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    };

    fetchTradersWithRetry();
  }, []);

  // Filter traders based on search query; reset to page 1 on new query
  const filteredTraders = useMemo(() => {
    if (!searchQuery.trim()) return traders;
    const query = searchQuery.toLowerCase();
    return traders.filter(
      (trader) =>
        trader.name.toLowerCase().includes(query) ||
        trader.address.toLowerCase().includes(query)
    );
  }, [traders, searchQuery]);

  // Reset to page 1 whenever the filtered set changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filteredTraders]);

  const totalPages = Math.ceil(filteredTraders.length / PAGE_SIZE);

  const pagedTraders = useMemo(
    () => filteredTraders.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredTraders, currentPage]
  );

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    // Scroll to top of the grid smoothly
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="w-full mb-12">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-full border border-white/10">
            <Grid3x3 className="w-4 h-4 text-white" />
          </div>
          <h2 className="text-white font-semibold text-lg tracking-tight">
            Trader Index
          </h2>
        </div>

        {/* Search Bar */}
        <div className="relative w-full max-w-md">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search traders..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/20 transition-colors tracking-tight"
          />
        </div>
      </div>

      {/* Trader Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {Array.from({ length: PAGE_SIZE }).map((_, i) => (
            <LoadingCard key={i} />
          ))}
        </div>
      ) : filteredTraders.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800 border-dashed rounded-2xl p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-4">
            <Grid3x3 className="w-8 h-8 text-zinc-600" />
          </div>
          <p className="text-zinc-500 text-lg tracking-tight">
            {searchQuery ? "No traders found" : "No traders available"}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {pagedTraders.map((trader) => (
              <TraderCard key={trader.id} trader={trader} />
            ))}
          </div>

          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={filteredTraders.length}
            onPageChange={handlePageChange}
          />
        </>
      )}
    </div>
  );
}
