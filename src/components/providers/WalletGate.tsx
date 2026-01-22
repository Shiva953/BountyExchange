"use client";

import { FC, ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

interface WalletGateProps {
  children: ReactNode;
}

export const WalletGate: FC<WalletGateProps> = ({ children }) => {
  const { connected } = useWallet();

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

  return <>{children}</>;
};
