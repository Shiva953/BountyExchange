"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useState,
  ReactNode,
} from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";

export interface Trader {
  id: number;
  address: string;
  name: string | null;
  imageUrl: string | null;
}

interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  trader: Trader | null;
  error: string | null;
  signIn: () => Promise<boolean>;
  signOut: () => void;
  walletAddress: string | null;
}

const AuthContext = createContext<AuthContextType | null>(null);

const SIGN_MESSAGE = "Sign in to Bounty Exchange";

export function AuthProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage, connected, disconnect } = useWallet();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [trader, setTrader] = useState<Trader | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset auth state when wallet disconnects
  useEffect(() => {
    if (!connected) {
      setIsAuthenticated(false);
      setTrader(null);
      setError(null);
    }
  }, [connected]);

  const signIn = useCallback(async () => {
    // Prevent multiple simultaneous sign-in attempts
    if (isLoading) {
      console.warn("Sign-in already in progress");
      return false;
    }

    // If already authenticated, don't sign in again
    if (isAuthenticated) {
      return true;
    }

    if (!publicKey || !signMessage) {
      setError("Wallet not connected or does not support signing");
      return false;
    }

    setIsLoading(true);
    setError(null);

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
        const errorMessage = data.error || data.details || "Authentication failed";
        console.error("Sign-in API error:", {
          status: response.status,
          error: errorMessage,
          details: data.details,
        });
        throw new Error(errorMessage);
      }

      // Verify we got trader data
      if (!data.trader) {
        throw new Error("Invalid response from server");
      }

      setIsAuthenticated(true);
      setTrader(data.trader);
      setIsLoading(false);
      return true;
    } catch (err) {
      console.error("Sign in error:", err);
      setIsAuthenticated(false);
      setTrader(null);
      
      // Provide user-friendly error messages
      let errorMessage = "Sign in failed";
      if (err instanceof Error) {
        if (err.message.includes("User rejected")) {
          errorMessage = "Signature request was cancelled";
        } else if (err.message.includes("Invalid signature")) {
          errorMessage = "Signature verification failed. Please try again.";
        } else {
          errorMessage = err.message;
        }
      }
      
      setError(errorMessage);
      setIsLoading(false);
      return false;
    }
  }, [publicKey, signMessage, isLoading, isAuthenticated]);

  const signOut = useCallback(() => {
    setIsAuthenticated(false);
    setTrader(null);
    setError(null);
    disconnect();
  }, [disconnect]);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        trader,
        error,
        signIn,
        signOut,
        walletAddress: publicKey?.toBase58() ?? null,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
