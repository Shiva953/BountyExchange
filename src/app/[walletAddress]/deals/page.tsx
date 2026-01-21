"use client";

import { use } from "react";
import { useAcceptedDeals } from "@/hooks/useAcceptedDeals";

interface MyDealsPageProps {
  params: Promise<{
    walletAddress: string;
  }>;
}

export default function MyDealsPage({ params }: MyDealsPageProps) {
  const { walletAddress } = use(params);
  const { deals, loading, error } = useAcceptedDeals(walletAddress);

  return (
    <main className="min-h-screen pt-24 px-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white mb-2">
          My Accepted Deals
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-8 font-mono">
          {walletAddress.slice(0, 4)}...{walletAddress.slice(-4)}
        </p>

        {loading && (
          <div className="text-zinc-500 dark:text-zinc-400">
            Loading deals...
          </div>
        )}

        {error && (
          <div className="text-red-500">
            {error}
          </div>
        )}

        {!loading && !error && deals.length === 0 && (
          <div className="text-zinc-500 dark:text-zinc-400">
            No accepted deals found for this wallet.
          </div>
        )}

        {!loading && !error && deals.length > 0 && (
          <div className="space-y-4">
            {deals.map((deal) => (
              <div
                key={deal.publicKey.toBase58()}
                className="p-4 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"
              >
                <div className="flex items-center gap-3 mb-3">
                  {deal.tokenMetadata?.image && (
                    <img
                      src={deal.tokenMetadata.image}
                      alt={deal.tokenMetadata.symbol}
                      className="w-8 h-8 rounded-full"
                    />
                  )}
                  <div>
                    <div className="font-medium text-zinc-900 dark:text-white">
                      {deal.tokenMetadata?.name || "Unknown Token"}
                    </div>
                    <div className="text-sm text-zinc-500 dark:text-zinc-400">
                      {deal.tokenMetadata?.symbol || "???"}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-zinc-500 dark:text-zinc-400">Reward:</span>{" "}
                    <span className="text-zinc-900 dark:text-white">
                      {(Number(deal.rewardAmount) / 1e9).toLocaleString()} USDC
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500 dark:text-zinc-400">Target Volume:</span>{" "}
                    <span className="text-zinc-900 dark:text-white">
                      ${(Number(deal.targetVolume) / 1e9).toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500 dark:text-zinc-400">Hold Duration:</span>{" "}
                    <span className="text-zinc-900 dark:text-white">
                      {deal.holdDurationInHours.toString()}h
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500 dark:text-zinc-400">Status:</span>{" "}
                    <span className="text-green-500">Accepted</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
