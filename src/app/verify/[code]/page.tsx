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

    if (publicKey.toBase58() !== expectedWallet) {
      setError(
        `Wrong wallet. Connect: ${expectedWallet.slice(0, 6)}...${expectedWallet.slice(-4)}`
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
        toast.error("Verification failed");
        return;
      }

      setStatus("success");
      toast.success("Telegram linked!");

      setTimeout(() => {
        router.push(`/${expectedWallet}/deals`);
      }, 2000);
    } catch (err) {
      setStatus("error");
      const errorMsg = err instanceof Error ? err.message : "Signing failed";
      setError(errorMsg);
      toast.error("Signing failed");
    }
  };

  useEffect(() => {
    if (publicKey && expectedWallet && publicKey.toBase58() !== expectedWallet) {
      setError(
        `Wrong wallet. Connect: ${expectedWallet.slice(0, 6)}...${expectedWallet.slice(-4)}`
      );
    } else {
      setError("");
    }
  }, [publicKey, expectedWallet]);

  return (
    <div className="fixed inset-0 bg-black/95 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="w-full h-full flex flex-col items-center justify-center px-6">

        {status === "loading" && (
          <div className="flex flex-col items-center">
            <Loader2 className="w-10 h-10 text-[#666] animate-spin" />
          </div>
        )}

        {status === "invalid" && (
          <div className="flex flex-col items-center text-center">
            <XCircle className="w-16 h-16 text-red-500 mb-6" />
            <h1 className="text-3xl font-semibold tracking-tight text-white">Invalid Code</h1>
            <p className="text-[#888] mt-3 text-lg">
              This link is invalid or has already been used.
            </p>
          </div>
        )}

        {status === "expired" && (
          <div className="flex flex-col items-center text-center">
            <AlertCircle className="w-16 h-16 text-yellow-500 mb-6" />
            <h1 className="text-3xl font-semibold tracking-tight text-white">Code Expired</h1>
            <p className="text-[#888] mt-3 text-lg">
              Request a new one from the Telegram bot.
            </p>
          </div>
        )}

        {status === "ready" && (
          <div className="flex flex-col items-center text-center max-w-sm w-full">
            <h1 className="text-4xl font-semibold tracking-tight text-white mb-2">
              Verify Wallet
            </h1>
            <p className="text-[#888] text-base tracking-tight mb-10">
              Sign a message to link Telegram
            </p>

            {!connected ? (
              <WalletMultiButton />
            ) : (
              <button
                onClick={handleVerify}
                disabled={!publicKey || publicKey.toBase58() !== expectedWallet}
                className="w-full bg-white text-black font-semibold text-lg tracking-tight py-4 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Sign & Verify
              </button>
            )}

            {error && (
              <p className="text-red-400 text-sm mt-4">{error}</p>
            )}
          </div>
        )}

        {status === "signing" && (
          <div className="flex flex-col items-center text-center">
            <Loader2 className="w-10 h-10 text-white animate-spin mb-6" />
            <h1 className="text-3xl font-semibold tracking-tight text-white">
              Waiting for signature...
            </h1>
            <p className="text-[#888] mt-3 text-lg">
              Approve in your wallet
            </p>
          </div>
        )}

        {status === "verifying" && (
          <div className="flex flex-col items-center text-center">
            <Loader2 className="w-10 h-10 text-white animate-spin mb-6" />
            <h1 className="text-3xl font-semibold tracking-tight text-white">Verifying...</h1>
          </div>
        )}

        {status === "success" && (
          <div className="flex flex-col items-center text-center">
            <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center mb-6">
              <CheckCircle className="w-12 h-12 text-green-500" />
            </div>
            <h1 className="text-4xl font-semibold tracking-tight text-white">Wallet Linked</h1>
            <p className="text-[#888] mt-4 text-lg flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Redirecting...
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center text-center">
            <XCircle className="w-16 h-16 text-red-500 mb-6" />
            <h1 className="text-3xl font-semibold tracking-tight text-white">
              Verification Failed
            </h1>
            <p className="text-red-400 mt-3 text-lg">{error}</p>
            <button
              onClick={() => setStatus("ready")}
              className="mt-6 text-[#888] hover:text-white transition-colors text-lg cursor-pointer"
            >
              Try Again
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
