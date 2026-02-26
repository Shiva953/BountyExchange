"use client";

import { useEffect, useRef } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const hasAutoReset = useRef(false);

  useEffect(() => {
    console.error("[AppError]", error);
  }, [error]);

  // Auto-recover once per error boundary mount — handles wallet switch race conditions silently.
  // By 500ms the wallet transition is almost always complete, so reset() succeeds without user action.
  // If reset() throws again, the boundary remounts with a fresh ref and tries once more.
  // After the wallet finishes switching this resolves; if it's a real error the UI fallback below is shown.
  useEffect(() => {
    if (!hasAutoReset.current) {
      hasAutoReset.current = true;
      const timer = setTimeout(reset, 500);
      return () => clearTimeout(timer);
    }
  }, [reset]);

  const isWalletError =
    error.message?.toLowerCase().includes("wallet") ||
    error.message?.toLowerCase().includes("phantom") ||
    error.message?.toLowerCase().includes("solana");

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6">
      <div className="text-center max-w-md">
        <h1 className="text-white text-2xl font-bold tracking-tight mb-3">
          {isWalletError ? "Wallet Error" : "Something went wrong"}
        </h1>
        <p className="text-gray-400 text-sm tracking-tight mb-8">
          {isWalletError
            ? "A wallet connection error occurred. This can happen when switching accounts. Try reloading or reconnecting your wallet."
            : "An unexpected error occurred. Please reload the page."}
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
