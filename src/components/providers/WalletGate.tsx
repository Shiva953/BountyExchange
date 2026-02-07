"use client";

import dynamic from "next/dynamic";
import { FC, ReactNode, useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

// Dynamic import to avoid SSR issues with wallet button
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false, loading: () => <div className="h-10 w-32 bg-white/10 rounded-lg animate-pulse" /> }
);

interface WalletGateProps {
  children: ReactNode;
}

export const WalletGate: FC<WalletGateProps> = ({ children }) => {
  const { connected, connecting, wallet } = useWallet();
  const [mounted, setMounted] = useState(false);

  // Prevent hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  // Show loading until mounted (prevents hydration issues)
  if (!mounted) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
      </div>
    );
  }

  // Connecting - show loading
  if (connecting) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6">
        <div className="text-center max-w-md">
          <h1 className="text-white text-3xl font-bold tracking-tight mb-4">
            Connecting...
          </h1>
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
        </div>
      </div>
    );
  }

  // Not connected - show connect wallet
  if (!connected) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6">
        <div className="text-center max-w-md">
          <h1 className="text-white text-3xl font-bold tracking-tight mb-4">
            Connect Your Wallet
          </h1>
          <p className="text-gray-400 text-sm tracking-tight mb-8">
            Connect your Solana wallet to access the bounty marketplace.
          </p>
          <WalletMultiButton />
        </div>
      </div>
    );
  }

  // Connected - render children
  return <>{children}</>;
};
