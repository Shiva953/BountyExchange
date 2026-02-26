"use client";

import { useEffect, useRef, useState } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const hasAutoReset = useRef(false);
  // Start with spinner hidden error UI — only reveal if auto-reset doesn't clear it in time.
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    console.error("[AppError]", error);
  }, [error]);

  // Reveal the error UI after 500ms. If reset() succeeds before then, the component
  // unmounts and the user never sees the error screen at all.
  useEffect(() => {
    const timer = setTimeout(() => setShowError(true), 500);
    return () => clearTimeout(timer);
  }, []);

  // Auto-recover once per error boundary mount — handles wallet switch race conditions.
  // By 500ms the wallet transition is almost always complete, so reset() succeeds silently.
  useEffect(() => {
    if (!hasAutoReset.current) {
      hasAutoReset.current = true;
      const timer = setTimeout(reset, 500);
      return () => clearTimeout(timer);
    }
  }, [reset]);

  if (!showError) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
      </div>
    );
  }

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
