"use client";

import { FC, ReactNode, useMemo, useCallback, useState, useEffect } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import {
  WalletError,
  WalletConnectionError,
  WalletNotReadyError,
  WalletNotConnectedError,
} from "@solana/wallet-adapter-base";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";

import "@solana/wallet-adapter-react-ui/styles.css";

interface SolanaProviderProps {
  children: ReactNode;
}

export const SolanaProvider: FC<SolanaProviderProps> = ({ children }) => {
  const [mounted, setMounted] = useState(false);

  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_HELIUS_DEVNET_URL!, []);

  // Initialize wallet adapters - empty array during SSR to prevent hydration issues
  const wallets = useMemo(
    () => {
      if (typeof window === "undefined") return [];
      return [
        new PhantomWalletAdapter(),
        new SolflareWalletAdapter(),
      ];
    },
    []
  );

  const onError = useCallback((error: WalletError) => {
    // Suppress known benign errors that occur during autoConnect
    if (error instanceof WalletConnectionError) {
      // "Unexpected error" fires when wallet extension isn't ready yet
      if (error.message === "Unexpected error") {
        return;
      }
    }

    // Suppress errors when wallet isn't ready (extension not loaded yet)
    if (error instanceof WalletNotReadyError) {
      return;
    }

    // Suppress "not connected" errors during initial load
    if (error instanceof WalletNotConnectedError) {
      return;
    }

    // Suppress generic connection errors that happen during page load
    if (error.message?.includes("User rejected") ||
        error.message?.includes("Connection closed")) {
      return;
    }

    console.error("Wallet error:", error.message, error);
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Always render providers to ensure useWallet() hooks work
  // But only enable autoConnect after mounting to prevent hydration issues
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider
        wallets={wallets}
        autoConnect={mounted}
        onError={onError}
      >
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};