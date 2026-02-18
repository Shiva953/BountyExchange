"use client";

import dynamic from "next/dynamic";
import { FC, ReactNode, useState, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

// Dynamic import to avoid SSR issues with wallet button
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false, loading: () => <div className="h-10 w-32 bg-white/10 rounded-lg animate-pulse" /> }
);

interface WalletGateProps {
  children: ReactNode;
}

// Check if there's a previously connected wallet in localStorage
const getStoredWalletName = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem("walletName");
  } catch {
    return null;
  }
};

export const WalletGate: FC<WalletGateProps> = ({ children }) => {
  const { connected, connecting } = useWallet();
  const [mounted, setMounted] = useState(false);
  const [isAutoConnecting, setIsAutoConnecting] = useState(false);
  const autoConnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Tracks whether the user was previously connected in this session.
  // Used to show a brief loading state during wallet account switches
  // instead of immediately flashing the "Connect Your Wallet" screen.
  const prevConnectedRef = useRef(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Prevent hydration mismatch and handle autoConnect timing
  useEffect(() => {
    setMounted(true);

    // Check if we have a stored wallet - if so, we're likely autoConnecting
    const storedWallet = getStoredWalletName();
    if (storedWallet) {
      setIsAutoConnecting(true);
      // Give autoConnect time to complete (handles slow extension injection in Brave)
      autoConnectTimeoutRef.current = setTimeout(() => {
        setIsAutoConnecting(false);
      }, 2000); // 2 second grace period for wallet extension to load
    }

    return () => {
      if (autoConnectTimeoutRef.current) {
        clearTimeout(autoConnectTimeoutRef.current);
      }
    };
  }, []);

  // Clear autoConnecting state when connection succeeds or fails definitively
  useEffect(() => {
    if (connected || connecting) {
      setIsAutoConnecting(false);
      if (autoConnectTimeoutRef.current) {
        clearTimeout(autoConnectTimeoutRef.current);
      }
    }
  }, [connected, connecting]);

  // Detect wallet switches: when the user was connected and `connected` drops
  // to false (e.g. Phantom emits disconnect during account switch), show a
  // brief loading state instead of immediately rendering the "Connect Your
  // Wallet" screen. This prevents the deal page from unmounting/remounting
  // during what is normally a sub-second transition.
  useEffect(() => {
    if (connected) {
      prevConnectedRef.current = true;
      setIsTransitioning(false);
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
    } else if (!connected && !connecting && prevConnectedRef.current && mounted) {
      // Was connected, now not — could be a wallet switch or intentional disconnect.
      // Show loading for up to 1s; if the wallet reconnects we clear it early.
      setIsTransitioning(true);
      transitionTimerRef.current = setTimeout(() => {
        setIsTransitioning(false);
        prevConnectedRef.current = false;
      }, 1000);
    }

    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
      }
    };
  }, [connected, connecting, mounted]);

  // Show loading until mounted (prevents hydration issues)
  if (!mounted) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
      </div>
    );
  }

  // Connecting, autoConnecting, or briefly transitioning between wallets
  if (connecting || isAutoConnecting || isTransitioning) {
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
