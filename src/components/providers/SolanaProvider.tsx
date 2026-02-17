"use client";

import { FC, ReactNode, useMemo, useCallback, useState, useEffect, useRef } from "react";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
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

// Detects when autoConnect leaves the adapter in a dirty state:
// wallet selected + not connected + not connecting.
// This happens when the wallet extension is locked during autoConnect —
// the "Unexpected error" is swallowed but the adapter keeps the wallet
// "selected", so every subsequent manual connect() call also fails silently
// (no modal shown, no feedback). Calling disconnect() resets all state
// including localStorage so the next click opens the modal fresh.
const WalletAutoConnectRecovery: FC = () => {
  const { wallet, connected, connecting, disconnect } = useWallet();
  const [pastAutoConnectWindow, setPastAutoConnectWindow] = useState(false);
  const didRecoverRef = useRef(false);

  useEffect(() => {
    // Slightly before WalletGate's 2000ms grace period so state is clean
    // before the connect button becomes visible to the user
    const timer = setTimeout(() => setPastAutoConnectWindow(true), 1800);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (connected) {
      // Connected successfully — no recovery needed
      didRecoverRef.current = true;
    }
  }, [connected]);

  useEffect(() => {
    if (
      pastAutoConnectWindow &&
      wallet !== null &&
      !connected &&
      !connecting &&
      !didRecoverRef.current
    ) {
      // Adapter is stuck: selected wallet but failed to connect.
      // disconnect() resets wallet→null, connected→false, and removes
      // walletName from localStorage, so next manual click shows the modal.
      didRecoverRef.current = true;
      console.warn("[WalletRecovery] autoConnect left adapter in dirty state — resetting", wallet.adapter.name);
      disconnect().catch(() => {});
    }
  }, [pastAutoConnectWindow, wallet, connected, connecting, disconnect]);

  return null;
};

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
    if (error instanceof WalletConnectionError) {
      if (error.message === "Unexpected error") {
        // Also clear localStorage here as a safety net — WalletAutoConnectRecovery
        // handles the in-memory adapter state via disconnect(), but clearing
        // localStorage prevents the adapter pre-selecting a stale wallet on
        // the next page load before recovery has a chance to fire.
        try {
          localStorage.removeItem("walletName");
        } catch {}
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
        <WalletAutoConnectRecovery />
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};