"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useState,
  useRef,
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
  isSessionRestored: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

const SIGN_MESSAGE = "Sign in to Bounty Exchange";
const AUTH_STORAGE_KEY = "bounty_exchange_auth";

interface StoredSession {
  walletAddress: string;
  trader: Trader;
  timestamp: number;
}

function getStoredSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!stored) return null;
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

function storeSession(walletAddress: string, trader: Trader): void {
  if (typeof window === "undefined") return;
  const session: StoredSession = {
    walletAddress,
    trader,
    timestamp: Date.now(),
  };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

function clearStoredSession(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage, connected, disconnect } = useWallet();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [trader, setTrader] = useState<Trader | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSessionRestored, setIsSessionRestored] = useState(false);
  const previousWalletRef = useRef<string | null>(null);

  // Restore session from localStorage on mount when wallet connects
  useEffect(() => {
    if (!connected || !publicKey) {
      setIsSessionRestored(true);
      return;
    }

    const currentWallet = publicKey.toBase58();
    const storedSession = getStoredSession();

    // If wallet changed, clear old session
    if (previousWalletRef.current && previousWalletRef.current !== currentWallet) {
      clearStoredSession();
      setIsAuthenticated(false);
      setTrader(null);
      setError(null);
    }

    previousWalletRef.current = currentWallet;

    // Restore session if it matches current wallet
    if (storedSession && storedSession.walletAddress === currentWallet) {
      setIsAuthenticated(true);
      setTrader(storedSession.trader);
      setError(null);
    }

    setIsSessionRestored(true);
  }, [connected, publicKey]);

  // Clear auth state when wallet disconnects
  useEffect(() => {
    if (!connected) {
      setIsAuthenticated(false);
      setTrader(null);
      setError(null);
      previousWalletRef.current = null;
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
      storeSession(publicKey.toBase58(), data.trader);
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
    clearStoredSession();
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
        isSessionRestored,
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
