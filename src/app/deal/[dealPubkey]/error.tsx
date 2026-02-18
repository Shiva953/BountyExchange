"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function DealError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[DealPageError]", error);
  }, [error]);

  const isWalletError =
    error.message?.toLowerCase().includes("wallet") ||
    error.message?.toLowerCase().includes("phantom") ||
    error.message?.toLowerCase().includes("solana") ||
    error.message?.toLowerCase().includes("public key") ||
    error.message?.toLowerCase().includes("publickey");

  return (
    <div className="min-h-screen bg-black pt-16 pl-20 flex items-center justify-center">
      <div className="text-center max-w-md px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-gray-400 hover:text-white transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="text-sm tracking-tight">Return to Market</span>
        </Link>

        <h1 className="text-white text-2xl font-bold tracking-tight mb-3">
          {isWalletError ? "Wallet connection error" : "Failed to load deal"}
        </h1>
        <p className="text-gray-400 text-sm tracking-tight mb-8">
          {isWalletError
            ? "This can happen when switching wallets mid-page. Try reconnecting your wallet, then reload."
            : "An error occurred while loading this deal. Please try again."}
        </p>

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => reset()}
            className="px-5 py-2.5 bg-white text-black text-sm font-semibold rounded-lg hover:bg-gray-200 transition-colors cursor-pointer"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-2.5 bg-white/10 text-white text-sm font-semibold rounded-lg hover:bg-white/20 transition-colors cursor-pointer"
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}
