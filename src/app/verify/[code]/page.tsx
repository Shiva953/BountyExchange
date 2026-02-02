"use client";

import { useParams, useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useState, useEffect } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import { Loader2, CheckCircle, XCircle, AlertCircle } from "lucide-react";
import { toast } from "sonner";

type VerifyStatus =
  | "loading"
  | "ready"
  | "signing"
  | "verifying"
  | "success"
  | "error"
  | "expired"
  | "invalid";

export default function VerifyPage() {
  const params = useParams();
  const router = useRouter();
  const code = params.code as string;
  const { publicKey, signMessage, connected } = useWallet();

  const [status, setStatus] = useState<VerifyStatus>("loading");
  const [error, setError] = useState<string>("");
  const [expectedWallet, setExpectedWallet] = useState<string>("");

  // Check if the verification code is valid
  useEffect(() => {
    async function checkCode() {
      try {
        const response = await fetch(`/api/telegram/verify?code=${code}`);
        const data = await response.json();

        if (!response.ok) {
          if (data.error === "expired") {
            setStatus("expired");
          } else if (data.error === "not_found") {
            setStatus("invalid");
          } else {
            setStatus("error");
            setError(data.error || "Unknown error");
          }
          return;
        }

        setExpectedWallet(data.walletAddress);
        setStatus("ready");
      } catch {
        setStatus("error");
        setError("Failed to check verification code");
      }
    }

    checkCode();
  }, [code]);

  const handleVerify = async () => {
    if (!publicKey || !signMessage) {
      setError("Please connect your wallet first");
      return;
    }

    // Check if connected wallet matches expected wallet
    if (publicKey.toBase58() !== expectedWallet) {
      setError(
        `Wrong wallet connected. Please connect the wallet: ${expectedWallet.slice(0, 6)}...${expectedWallet.slice(-4)}`
      );
      return;
    }

    setStatus("signing");
    setError("");

    try {
      const timestamp = Date.now();
      const messageText = `Verify wallet for Bounty Exchange\nCode: ${code}\nTimestamp: ${timestamp}`;
      const messageBytes = new TextEncoder().encode(messageText);

      const signature = await signMessage(messageBytes);

      setStatus("verifying");

      const response = await fetch("/api/telegram/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          walletAddress: publicKey.toBase58(),
          signature: bs58.encode(signature),
          message: bs58.encode(messageBytes),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setStatus("error");
        setError(data.error || "Verification failed");
        toast.error("Verification failed", {
          description: data.error || "Please try again",
        });
        return;
      }

      setStatus("success");
      toast.success("Telegram linked successfully!", {
        description: "You'll now receive notifications for your deals.",
      });

      // Redirect to deals page after a delay
      setTimeout(() => {
        router.push(`/${expectedWallet}/deals`);
      }, 2000);
    } catch (err) {
      setStatus("error");
      const errorMsg = err instanceof Error ? err.message : "Signing failed";
      setError(errorMsg);
      toast.error("Signing failed", {
        description: "Please try again",
      });
    }
  };

  // Reset error when wallet changes
  useEffect(() => {
    if (publicKey && expectedWallet && publicKey.toBase58() !== expectedWallet) {
      setError(
        `Wrong wallet. Please connect: ${expectedWallet.slice(0, 6)}...${expectedWallet.slice(-4)}`
      );
    } else {
      setError("");
    }
  }, [publicKey, expectedWallet]);

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-[#111] border border-[#222] rounded-xl p-8">
        <h1 className="text-2xl font-semibold text-white text-center mb-2">
          Link Telegram Account
        </h1>
        <p className="text-[#888] text-center mb-8">
          Sign a message to verify wallet ownership
        </p>

        {/* Loading State */}
        {status === "loading" && (
          <div className="flex flex-col items-center py-8">
            <Loader2 className="w-8 h-8 text-[#888] animate-spin" />
            <p className="text-[#888] mt-4">Checking verification code...</p>
          </div>
        )}

        {/* Invalid Code */}
        {status === "invalid" && (
          <div className="flex flex-col items-center py-8">
            <XCircle className="w-12 h-12 text-red-500" />
            <p className="text-white mt-4 font-medium">Invalid Code</p>
            <p className="text-[#888] mt-2 text-center">
              This verification link is invalid or has already been used.
            </p>
          </div>
        )}

        {/* Expired Code */}
        {status === "expired" && (
          <div className="flex flex-col items-center py-8">
            <AlertCircle className="w-12 h-12 text-yellow-500" />
            <p className="text-white mt-4 font-medium">Code Expired</p>
            <p className="text-[#888] mt-2 text-center">
              This verification code has expired. Please request a new one from
              the Telegram bot.
            </p>
          </div>
        )}

        {/* Ready to Verify */}
        {status === "ready" && (
          <div className="space-y-6">
            <div className="bg-[#1a1a1a] rounded-lg p-4">
              <p className="text-[#888] text-sm mb-1">Wallet to verify:</p>
              <p className="text-white font-mono text-sm break-all">
                {expectedWallet}
              </p>
            </div>

            {!connected ? (
              <div className="flex flex-col items-center gap-4">
                <p className="text-[#888] text-sm">
                  Connect your wallet to continue
                </p>
                <WalletMultiButton />
              </div>
            ) : (
              <button
                onClick={handleVerify}
                disabled={!publicKey || publicKey.toBase58() !== expectedWallet}
                className="w-full bg-white text-black font-medium py-3 px-4 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Sign & Verify
              </button>
            )}

            {error && (
              <p className="text-red-400 text-sm text-center">{error}</p>
            )}
          </div>
        )}

        {/* Signing State */}
        {status === "signing" && (
          <div className="flex flex-col items-center py-8">
            <Loader2 className="w-8 h-8 text-white animate-spin" />
            <p className="text-white mt-4">Waiting for signature...</p>
            <p className="text-[#888] mt-2 text-sm">
              Please approve the message in your wallet
            </p>
          </div>
        )}

        {/* Verifying State */}
        {status === "verifying" && (
          <div className="flex flex-col items-center py-8">
            <Loader2 className="w-8 h-8 text-white animate-spin" />
            <p className="text-white mt-4">Verifying signature...</p>
          </div>
        )}

        {/* Success State */}
        {status === "success" && (
          <div className="flex flex-col items-center py-8">
            <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
              <CheckCircle className="w-10 h-10 text-green-500" />
            </div>
            <p className="text-white text-xl font-semibold">Wallet Linked!</p>
            <p className="text-[#888] mt-3 text-center">
              Your wallet is now connected to Telegram.
            </p>
            <div className="mt-4 bg-[#1a1a1a] rounded-lg p-4 w-full">
              <p className="text-[#888] text-sm text-center">
                You&apos;ll receive notifications for:
              </p>
              <ul className="mt-2 space-y-1 text-sm text-white">
                <li className="flex items-center gap-2">
                  <span className="text-green-400">✓</span> Volume milestones (25%, 50%, 75%, 90%)
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-green-400">✓</span> Expiry warnings (24h, 6h, 1h)
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-green-400">✓</span> Win/loss results
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-green-400">✓</span> Daily summary
                </li>
              </ul>
            </div>
            <p className="text-[#666] mt-4 text-sm flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              Redirecting to your deals...
            </p>
          </div>
        )}

        {/* Error State */}
        {status === "error" && (
          <div className="flex flex-col items-center py-8">
            <XCircle className="w-12 h-12 text-red-500" />
            <p className="text-white mt-4 font-medium">Verification Failed</p>
            <p className="text-red-400 mt-2 text-center">{error}</p>
            <button
              onClick={() => setStatus("ready")}
              className="mt-4 text-[#888] hover:text-white transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Code Display */}
        {(status === "ready" || status === "error") && (
          <div className="mt-6 pt-6 border-t border-[#222]">
            <p className="text-[#666] text-xs text-center">
              Verification code: <span className="font-mono">{code}</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
