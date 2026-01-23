import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";

export interface Trader {
  id: number;
  address: string;
  name: string | null;
  imageUrl: string | null;
}

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  trader: Trader | null;
  error: string | null;
}

const SIGN_MESSAGE = "Sign in to Bounty Exchange";

export function useAuth() {
  const { publicKey, signMessage, connected, disconnect } = useWallet();
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    isLoading: false,
    trader: null,
    error: null,
  });

  // Reset auth state when wallet disconnects
  useEffect(() => {
    if (!connected) {
      setAuthState({
        isAuthenticated: false,
        isLoading: false,
        trader: null,
        error: null,
      });
    }
  }, [connected]);

  const signIn = useCallback(async () => {
    if (!publicKey || !signMessage) {
      setAuthState((prev) => ({
        ...prev,
        error: "Wallet not connected or does not support signing",
      }));
      return false;
    }

    setAuthState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      // Request signature from wallet
      const messageBytes = new TextEncoder().encode(SIGN_MESSAGE);
      const signature = await signMessage(messageBytes);
      const signatureBase58 = bs58.encode(signature);

      // Send to API for verification and user creation
      const response = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: publicKey.toBase58(),
          signature: signatureBase58,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Authentication failed");
      }

      setAuthState({
        isAuthenticated: true,
        isLoading: false,
        trader: data.trader,
        error: null,
      });

      return true;
    } catch (error) {
      console.error("Sign in error:", error);
      setAuthState({
        isAuthenticated: false,
        isLoading: false,
        trader: null,
        error: error instanceof Error ? error.message : "Sign in failed",
      });
      return false;
    }
  }, [publicKey, signMessage]);

  const signOut = useCallback(() => {
    setAuthState({
      isAuthenticated: false,
      isLoading: false,
      trader: null,
      error: null,
    });
    disconnect();
  }, [disconnect]);

  return {
    ...authState,
    signIn,
    signOut,
    walletAddress: publicKey?.toBase58() ?? null,
  };
}
