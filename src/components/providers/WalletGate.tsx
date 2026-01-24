"use client";

import { FC, ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useAuth } from "./AuthProvider";

interface WalletGateProps {
  children: ReactNode;
}

export const WalletGate: FC<WalletGateProps> = ({ children }) => {
  const { connected } = useWallet();
  const { isAuthenticated, isLoading, error, signIn, isSessionRestored } = useAuth();

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

  // Waiting for session restoration from localStorage
  if (!isSessionRestored) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
      </div>
    );
  }

  // Connected but authenticating (signing message)
  if (isLoading) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6">
        <div className="text-center max-w-md">
          <h1 className="text-white text-3xl font-bold tracking-tight mb-4">
            Sign In
          </h1>
          <p className="text-gray-400 text-sm tracking-tight mb-8">
            Please sign the message in your wallet to continue...
          </p>
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
        </div>
      </div>
    );
  }

  // Connected but not authenticated - show sign in button (user must click)
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6">
        <div className="text-center max-w-md">
          <h1 className="text-white text-3xl font-bold tracking-tight mb-4">
            Sign In Required
          </h1>
          <p className="text-gray-400 text-sm tracking-tight mb-4">
            Sign a message to verify your wallet ownership.
          </p>
          {error && (
            <p className="text-red-400 text-sm mb-4">{error}</p>
          )}
          <button
            onClick={() => signIn()}
            className="bg-white text-black px-6 py-3 rounded-lg font-medium hover:bg-gray-200 transition-colors"
          >
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};
