"use client";

import { FC, ReactNode, useMemo, useCallback, useEffect, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import {
  WalletError,
  WalletConnectionError,
} from "@solana/wallet-adapter-base";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";

import "@solana/wallet-adapter-react-ui/styles.css";

interface SolanaProviderProps {
  children: ReactNode;
}

export const SolanaProvider: FC<SolanaProviderProps> = ({ children }) => {
  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_HELIUS_DEVNET_URL!, []);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const onError = useCallback((error: WalletError) => {
    // WalletConnectionError with "Unexpected error" is a known benign issue
    // fired by autoConnect when the wallet extension isn't ready yet.
    if (
      error instanceof WalletConnectionError &&
      error.message === "Unexpected error"
    ) {
      return;
    }
    console.error("Wallet error:", error.message, error);
  }, []);

  // Prevent hydration mismatch - wallet detection must happen client-side only
  if (!mounted) {
    return null;
  }

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};