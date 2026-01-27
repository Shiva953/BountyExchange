"use client";

import { FC, ReactNode, useMemo, useCallback, useEffect, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletError } from "@solana/wallet-adapter-base";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";

import "@solana/wallet-adapter-react-ui/styles.css";

interface SolanaProviderProps {
  children: ReactNode;
}

export const SolanaProvider: FC<SolanaProviderProps> = ({ children }) => {
  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_HELIUS_RPC_URL!, []);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const onError = useCallback((error: WalletError) => {
    console.error("Wallet error:", error.message, error);
  }, []);

  // Prevent hydration mismatch - wallet detection must happen client-side only
  if (!mounted) {
    return null;
  }

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect={false} onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};