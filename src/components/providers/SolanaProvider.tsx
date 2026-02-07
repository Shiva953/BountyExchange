"use client";

import { FC, ReactNode, useMemo, useCallback } from "react";
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
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";

import "@solana/wallet-adapter-react-ui/styles.css";

interface SolanaProviderProps {
  children: ReactNode;
}

export const SolanaProvider: FC<SolanaProviderProps> = ({ children }) => {
  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_HELIUS_DEVNET_URL!, []);

  // Initialize wallet adapters - these handle SSR gracefully
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
    ],
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

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};