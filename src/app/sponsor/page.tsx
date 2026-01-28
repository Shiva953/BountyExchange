"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCreatedDeals, CreatedDealWithMetadata } from "@/hooks/useCreatedDeals";
import { DollarSign, Zap, Users, Eye, Plus } from "lucide-react";
import { CreateBountyModal } from "@/components/features/CreateBountyModal";

const MONO_FONT = 'GeistMono, ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Monaco, "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace';
const USDC_DECIMALS = 9;

function formatUSDC(amount: number): string {
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (amount >= 1_000) {
    return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
  return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatReward(amount: bigint | number): string {
  const value = Number(amount) / 10 ** USDC_DECIMALS;
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-3)}`;
}

interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  loading?: boolean;
  highlight?: boolean;
}

function StatCard({ label, value, icon, loading = false, highlight = false }: StatCardProps) {
  return (
    <div
      className="rounded-xl p-5 border border-white/10"
      style={{ background: "#0a0a0a" }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-zinc-500 text-xs tracking-tight">{label}</span>
        <div className="text-zinc-600">{icon}</div>
      </div>
      {loading ? (
        <div className="h-9 w-24 bg-zinc-800 rounded animate-pulse" />
      ) : (
        <p
          className={`font-bold text-3xl ${highlight ? "text-[#c8e972]" : "text-white"}`}
          style={{ fontFamily: MONO_FONT, letterSpacing: "-0.05em" }}
        >
          {value}
        </p>
      )}
    </div>
  );
}

interface CampaignRowProps {
  deal: CreatedDealWithMetadata;
}

function CampaignRow({ deal }: CampaignRowProps) {
  const [imageError, setImageError] = useState(false);
  const tokenName = deal.tokenMetadata?.name || "Unknown";
  const tokenSymbol = deal.tokenMetadata?.symbol || "???";
  const tokenImage = deal.tokenMetadata?.image || "";
  const showFallback = !tokenImage || imageError;

  // Determine display status
  const getStatusDisplay = () => {
    switch (deal.status) {
      case "executing":
        return { text: "Executing", className: "text-[#c8e972]" };
      case "satisfied":
        return { text: "Satisfied", className: "text-green-400" };
      case "failed":
        return { text: "Failed", className: "text-red-400" };
      case "awaiting":
        return { text: "Awaiting Acceptance", className: "text-zinc-400 italic" };
      default:
        return { text: "Unknown", className: "text-zinc-500" };
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <div className="grid grid-cols-5 gap-4 items-center py-4 border-b border-white/5 last:border-b-0">
      {/* Asset Class */}
      <div className="flex items-center gap-3">
        {showFallback ? (
          <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center text-white text-sm font-bold">
            {tokenSymbol.charAt(0)}
          </div>
        ) : (
          <img
            src={tokenImage}
            alt={tokenName}
            className="w-10 h-10 rounded-full object-cover bg-zinc-800"
            onError={() => setImageError(true)}
          />
        )}
        <div>
          <p className="text-white font-medium text-sm tracking-tight">{tokenName}</p>
          <p className="text-zinc-500 text-xs tracking-tight">{tokenSymbol}</p>
        </div>
      </div>

      {/* Assigned Entity (Trader) */}
      <div>
        {deal.isAccepted ? (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-white text-sm font-mono tracking-tight">
              {truncateAddress(deal.trader.toBase58())}
            </span>
          </div>
        ) : (
          <span className="text-zinc-500 text-sm italic tracking-tight">Awaiting Acceptance</span>
        )}
      </div>

      {/* Cap Allocation (Reward) */}
      <div>
        <span
          className="text-white font-semibold text-sm"
          style={{ fontFamily: MONO_FONT, letterSpacing: "-0.03em" }}
        >
          {formatReward(deal.rewardAmount.toNumber())}
        </span>
      </div>

      {/* Audit Status */}
      <div>
        <span className={`text-sm font-medium tracking-tight ${statusDisplay.className}`}>
          {statusDisplay.text}
        </span>
      </div>

      {/* Terminal (View action) */}
      <div className="flex justify-end">
        <Link
          href={`/deal/${deal.publicKey.toBase58()}`}
          className="w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
        >
          <Eye className="w-4 h-4 text-zinc-400" />
        </Link>
      </div>
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="grid grid-cols-5 gap-4 items-center py-4 border-b border-white/5 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-zinc-800" />
        <div>
          <div className="h-4 w-20 bg-zinc-800 rounded mb-1" />
          <div className="h-3 w-12 bg-zinc-800 rounded" />
        </div>
      </div>
      <div className="h-4 w-24 bg-zinc-800 rounded" />
      <div className="h-4 w-16 bg-zinc-800 rounded" />
      <div className="h-4 w-20 bg-zinc-800 rounded" />
      <div className="flex justify-end">
        <div className="w-9 h-9 rounded-full bg-zinc-800" />
      </div>
    </div>
  );
}

export default function SponsorDeskPage() {
  const router = useRouter();
  const { connected } = useWallet();
  const { deals, loading, error, totalEscrow, activeCampaigns, contractors, refetch } = useCreatedDeals();
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Redirect to home if not connected
  useEffect(() => {
    if (!connected) {
      router.push("/");
    }
  }, [connected, router]);

  if (!connected) {
    return null;
  }

  return (
    <main className="min-h-screen pt-20 px-6 bg-black pl-28">
      <div className="max-w-6xl mt-6 mx-auto">
        {/* Header */}
        <h1
          className="text-white font-bold text-3xl mb-8"
          style={{ letterSpacing: "-0.03em" }}
        >
          Sponsor Desk
        </h1>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          <StatCard
            label="Asset Escrow"
            value={formatUSDC(totalEscrow)}
            icon={<DollarSign className="w-4 h-4" />}
            loading={loading}
          />
          <StatCard
            label="Active Campaigns"
            value={activeCampaigns}
            icon={<Zap className="w-4 h-4" />}
            loading={loading}
            highlight
          />
          <StatCard
            label="Contractors"
            value={contractors}
            icon={<Users className="w-4 h-4" />}
            loading={loading}
          />
          <StatCard
            label="Reliability"
            value="--"
            icon={<div className="w-4 h-4" />}
            loading={false}
          />
        </div>

        {/* Campaign Management */}
        <div
          className="rounded-2xl border border-white/10 overflow-hidden"
          style={{ background: "#0a0a0a" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-white/10">
            <div>
              <h2 className="text-white font-semibold text-lg tracking-tight">
                Campaign Management
              </h2>
              <p className="text-zinc-500 text-xs tracking-tight mt-1">
                Audit and allocate your deployed capital
              </p>
            </div>
            <button
              onClick={() => setIsModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-white hover:bg-zinc-200 text-black font-medium text-sm rounded-lg transition-colors cursor-pointer"
            >
              Deploy New Bounty
              <Plus className="w-4 h-4" />
            </button>
          </div>

          {/* Table Header */}
          <div className="grid grid-cols-5 gap-4 px-6 py-3 border-b border-white/10 bg-white/[0.02]">
            <span className="text-zinc-500 text-xs tracking-tight font-medium">Asset Class</span>
            <span className="text-zinc-500 text-xs tracking-tight font-medium">Assigned Entity</span>
            <span className="text-zinc-500 text-xs tracking-tight font-medium">Cap Allocation</span>
            <span className="text-zinc-500 text-xs tracking-tight font-medium">Audit Status</span>
            <span className="text-zinc-500 text-xs tracking-tight font-medium text-right">Terminal</span>
          </div>

          {/* Table Body */}
          <div className="px-6">
            {loading && (
              <>
                <LoadingRow />
                <LoadingRow />
                <LoadingRow />
              </>
            )}

            {error && (
              <div className="py-8 text-center">
                <p className="text-red-400 text-sm">{error}</p>
                <button
                  onClick={refetch}
                  className="mt-3 text-zinc-400 hover:text-white text-sm underline transition-colors"
                >
                  Try again
                </button>
              </div>
            )}

            {!loading && !error && deals.length === 0 && (
              <div className="py-12 text-center">
                <div className="w-14 h-14 rounded-full bg-zinc-800 flex items-center justify-center mx-auto mb-4">
                  <Zap className="w-7 h-7 text-zinc-600" />
                </div>
                <p className="text-zinc-500 text-base tracking-tight">No campaigns deployed yet</p>
                <p className="text-zinc-600 text-sm tracking-tight mt-1">
                  Deploy your first bounty to get started
                </p>
              </div>
            )}

            {!loading && !error && deals.length > 0 && (
              <>
                {deals.map((deal) => (
                  <CampaignRow key={deal.publicKey.toBase58()} deal={deal} />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Create Bounty Modal */}
      <CreateBountyModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          refetch(); // Refresh deals after modal closes
        }}
      />
    </main>
  );
}
