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
import { clusterApiUrl } from "@solana/web3.js";

import "@solana/wallet-adapter-react-ui/styles.css";

interface SolanaProviderProps {
  children: ReactNode;
}

// Detects when the adapter is in a dirty state: wallet selected but not
// connected and not connecting. This happens when:
//   1. The wallet extension is locked during autoConnect (startup)
//   2. Phantom's MV3 service worker dies mid-session
//   3. After a wallet switch leaves the adapter stuck
//
// The previous approach used a one-shot didRecoverRef that was permanently
// set to true after first recovery, which caused the "button does nothing"
// bug: Phantom re-selects itself after disconnect(), recovery can't fire
// again, and WalletMultiButton silently calls connect() on the dead SW.
//
// New approach: 2-second debounce (handles the normal ~500ms wallet switch
// transition without false positives) + 5-second cooldown between recoveries
// (prevents an infinite loop when Phantom aggressively re-selects itself).
const WalletAutoConnectRecovery: FC = () => {
  const { wallet, connected, connecting, disconnect } = useWallet();
  const recoveryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastRecoveryTimeRef = useRef(0);

  useEffect(() => {
    const isDirtyState = wallet !== null && !connected && !connecting;

    if (isDirtyState) {
      // Debounce: only fire if stuck for 2s. During a normal wallet account
      // switch Phantom reconnects in <1s, cancelling this timer.
      recoveryTimerRef.current = setTimeout(() => {
        const now = Date.now();
        const msSinceLastRecovery = now - lastRecoveryTimeRef.current;
        // 5-second cooldown prevents looping when Phantom re-selects itself
        if (msSinceLastRecovery < 5000) return;

        lastRecoveryTimeRef.current = now;
        console.warn(
          "[WalletRecovery] adapter stuck in dirty state — resetting",
          wallet.adapter.name
        );
        disconnect().catch(() => {});
      }, 2000);
    } else {
      // State is healthy — cancel any pending recovery timer
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    }

    return () => {
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    };
  }, [wallet, connected, connecting, disconnect]);

  return null;
};

export const SolanaProvider: FC<SolanaProviderProps> = ({ children }) => {
  const [mounted, setMounted] = useState(false);

  const endpoint = useMemo(() => {
    const url = process.env.HELIUS_DEVNET_URL || "https://api.devnet.solana.com";
    return url;
  }, []);

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