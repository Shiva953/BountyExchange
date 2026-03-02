"use client";

import { useState, useCallback, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { sendTransactionWithRetry } from "@/utils/sendTransactionWithRetry";
import { signTransactionWithRetry } from "@/utils/signTransactionWithRetry";
import { extractApiError, type ApiError } from "@/hooks/useApiError";
import { Trader } from "@/types/trader";
import { ArrowLeft, ArrowUpRight, CheckCircle2, Loader2, ChevronDown, Users, RefreshCw, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

interface CreateBountyModalProps {
  isOpen: boolean;
  onClose: () => void;
}


interface BountyFormData {
  contractAddress: string;
  traderWallet: string;
  rewardAmount: string;
  volumeTarget: string;
  minBuyVolume: string;
  expirationWindow: string;
  holdDuration: string;
}

type TransactionStatus = "idle" | "building" | "signing" | "reconnecting" | "confirming" | "success" | "error";

// Anchor program error codes mapping
const PROGRAM_ERROR_MESSAGES: Record<number, string> = {
  6000: "Invalid fee wallet",
  6001: "Minimum reward amount is 200 USDC",
  6002: "Only the targeted trader can accept this deal",
  6003: "Deal is not active",
  6004: "Deal has already been accepted",
  6005: "Cannot create a bounty targeting yourself",
  6006: "Deal has not been accepted yet",
  6007: "Invalid creator account",
  6008: "Invalid escrow vault",
  6009: "Deal has expired",
  6010: "Volume requirement not met",
  6011: "Hold duration requirement not met",
  6012: "Minimum buy volume must be less than target volume",
  6013: "Token account owner does not match expected owner",
  6014: "Duplicate accounts not allowed",
  6015: "Expiration window must be at least 1 hour",
  6016: "Hold duration must be at least 1 hour",
  6017: "Expiration window exceeds maximum of 30 days",
  6018: "Hold duration exceeds maximum of 30 days",
  6019: "Target volume exceeds maximum",
  6020: "Only admin can call this function",
  6021: "Cannot withdraw before bounty expiration period ends",
};

// Extract error code from error message and return user-friendly message
const getProgramErrorMessage = (errorMessage: string): string | null => {
  const codeMatch = errorMessage.match(/(?:error code[:\s]*|custom program error[:\s]*0x)(\d+|[0-9a-fA-F]+)/i);
  if (codeMatch) {
    const code = codeMatch[1].startsWith('0x') || /^[a-fA-F]/.test(codeMatch[1])
      ? parseInt(codeMatch[1], 16)
      : parseInt(codeMatch[1], 10);
    return PROGRAM_ERROR_MESSAGES[code] || null;
  }
  // Also check for direct error code mentions like "6001"
  for (const [code, message] of Object.entries(PROGRAM_ERROR_MESSAGES)) {
    if (errorMessage.includes(code)) {
      return message;
    }
  }
  return null;
};

export const CreateBountyModal = ({ isOpen, onClose }: CreateBountyModalProps) => {
  const { publicKey, signTransaction, connected } = useWallet();
  const { connection } = useConnection();

  const [txStatus, setTxStatus] = useState<TransactionStatus>("idle");
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [formData, setFormData] = useState<BountyFormData>({
    contractAddress: "",
    traderWallet: "",
    rewardAmount: "",
    volumeTarget: "",
    minBuyVolume: "",
    expirationWindow: "",
    holdDuration: "",
  });
  const [traders, setTraders] = useState<Trader[]>([]);
  const [tradersLoading, setTradersLoading] = useState(false);
  const [tradersError, setTradersError] = useState<ApiError | null>(null);
  const [showTraderDropdown, setShowTraderDropdown] = useState(false);
  const [holdDurationUnit, setHoldDurationUnit] = useState<"min" | "hrs">("hrs");

  // Fetch traders with retry logic
  const fetchTraders = useCallback(async () => {
    setTradersLoading(true);
    setTradersError(null);

    try {
      const res = await fetch("/api/getTraders");

      if (!res.ok) {
        const apiError = await extractApiError(res);
        setTradersError(apiError);
        if (apiError.retryable) {
          toast.error(apiError.message, { description: "Retrying..." });
          // Auto-retry after delay
          setTimeout(() => fetchTraders(), apiError.retryAfter || 2000);
        } else {
          toast.error(apiError.message);
        }
        return;
      }

      const data = await res.json();
      if (data.success) {
        setTraders(data.traders);
      } else if (data.retryable) {
        setTradersError({
          message: data.error || "Failed to load traders",
          code: data.code || "UNKNOWN",
          retryable: true,
          retryAfter: data.retryAfter,
        });
      }
    } catch (err) {
      console.error("Error fetching traders:", err);
      const isNetwork = err instanceof Error &&
        (err.message.includes("fetch") || err.message.includes("network"));
      setTradersError({
        message: isNetwork ? "Connection failed" : "Failed to load traders",
        code: isNetwork ? "CONNECTION_ERROR" : "UNKNOWN",
        retryable: isNetwork,
        retryAfter: 2000,
      });
    } finally {
      setTradersLoading(false);
    }
  }, []);

  // Fetch traders when modal opens
  useEffect(() => {
    if (isOpen) {
      fetchTraders();
    }
  }, [isOpen, fetchTraders]);

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  const handleInputChange = (field: keyof BountyFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const protocolTax = formData.rewardAmount
    ? (parseFloat(formData.rewardAmount) * 0.1).toFixed(2)
    : "0";
  const totalEscrow = formData.rewardAmount
    ? (parseFloat(formData.rewardAmount) * 1.1).toFixed(2)
    : "0";

  // Validate minBuyVolume < targetVolume if minBuyVolume is provided
  const minBuyVolumeError = formData.minBuyVolume && formData.volumeTarget
    ? parseFloat(formData.minBuyVolume) >= parseFloat(formData.volumeTarget)
      ? "Min buy size must be less than target volume"
      : null
    : null;

  // Validate hold duration meets minimum (60 min or 1 hr)
  const holdDurationError = formData.holdDuration
    ? holdDurationUnit === "min"
      ? parseFloat(formData.holdDuration) < 60
        ? "Minimum 60 minutes"
        : null
      : parseFloat(formData.holdDuration) < 1
        ? "Minimum 1 hour"
        : null
    : null;

  const isFormValid =
    formData.contractAddress &&
    formData.traderWallet &&
    formData.rewardAmount &&
    formData.volumeTarget &&
    formData.expirationWindow &&
    !minBuyVolumeError &&
    !holdDurationError;

  const handleCreateBounty = useCallback(async () => {
    if (!publicKey || !signTransaction || !isFormValid) {
      toast.error("Please connect your wallet first");
      return;
    }

    setTxStatus("building");
    setTxSignature(null);

    try {
      const response = await fetch("/api/deal/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payer: publicKey.toBase58(),
          token: formData.contractAddress,
          trader: formData.traderWallet,
          rewardAmount: formData.rewardAmount,
          targetVolume: formData.volumeTarget,
          minBuyVolume: formData.minBuyVolume || undefined,
          expirationWindowInHours: formData.expirationWindow,
          holdDurationInHours: formData.holdDuration
            ? (holdDurationUnit === "min" ? parseFloat(formData.holdDuration) / 60 : parseFloat(formData.holdDuration))
            : 1, // Default to 1 hour minimum when not provided
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Handle connection/RPC errors with better messages
        if (data.code === "CONNECTION_ERROR") {
          throw new Error("Connection failed. Please check your network and try again.");
        } else if (data.code === "RPC_FORBIDDEN" || data.code === "RPC_ERROR") {
          throw new Error("Service temporarily unavailable. Please try again.");
        }
        throw new Error(data.error || "Failed to build transaction");
      }

      setTxStatus("signing");
      const transactionBuffer = Buffer.from(data.transaction, "base64");
      const transaction = Transaction.from(transactionBuffer);

      const signedTransaction = await signTransactionWithRetry(
        signTransaction,
        transaction,
        {
          maxAttempts: 3,
          retryDelayMs: 1500,
          onRetry: (attempt, maxAttempts) => {
            setTxStatus("reconnecting");
            toast.warning(
              `Wallet disconnected — reconnecting (${attempt}/${maxAttempts - 1})...`,
              { id: "wallet-reconnect", duration: Infinity }
            );
          },
        }
      );
      toast.dismiss("wallet-reconnect");

      setTxStatus("confirming");
      const result = await sendTransactionWithRetry(
        connection,
        signedTransaction,
        data.lastValidBlockHeight
      );

      if (!result.success) {
        throw new Error(`Transaction failed: error code ${result.errorCode}`);
      }

      const signature = result.signature;

      // Confirm creator in DB and immediately notify the targeted trader (fire-and-forget)
      fetch("/api/deal/confirmDealCreated", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorAddress: publicKey.toBase58(),
          dealPubkey: data.dealPDA,
          traderAddress: formData.traderWallet,
          token: formData.contractAddress,
          targetVolume: parseFloat(formData.volumeTarget),
          rewardAmount: parseFloat(formData.rewardAmount),
          expirationWindowInHours: parseFloat(formData.expirationWindow),
        }),
      }).catch((err) => console.error("Failed to confirm creator:", err));

      setTxStatus("success");
      setTxSignature(signature);

      toast.success(
        <div className="flex flex-col gap-1">
          <span className="font-medium">Bounty Created Successfully</span>
          <a
            href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors"
          >
            View on Explorer
            <ArrowUpRight className="w-3 h-3" />
          </a>
        </div>
      );

      setTimeout(() => {
        setFormData({
          contractAddress: "",
          traderWallet: "",
          rewardAmount: "",
          volumeTarget: "",
          minBuyVolume: "",
          expirationWindow: "",
          holdDuration: "",
        });
        setHoldDurationUnit("hrs");
        setTxStatus("idle");
        onClose();
      }, 1200);
    } catch (error) {
      setTxStatus("error");
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      const lowerMessage = errorMessage.toLowerCase();

      toast.dismiss("wallet-reconnect");

      // Check for wallet service worker disconnection (Phantom MV3)
      if (
        lowerMessage.includes("disconnected port") ||
        lowerMessage.includes("service worker") ||
        lowerMessage.includes("could not establish connection") ||
        lowerMessage.includes("receiving end does not exist")
      ) {
        toast.error("Wallet connection lost", {
          description: "Phantom's background service couldn't reconnect. Please refresh and try again.",
        });
      // Check for connection/network errors
      } else if (lowerMessage.includes("connection") || lowerMessage.includes("network") || lowerMessage.includes("fetch failed")) {
        toast.error("Connection failed", { description: "Please check your network and try again." });
      // Check for RPC service errors
      } else if (lowerMessage.includes("service") || lowerMessage.includes("unavailable") || lowerMessage.includes("rpc")) {
        toast.error("Service temporarily unavailable", { description: "Please try again in a moment." });
      } else {
        // Check for program error codes and show human-readable message
        const programError = getProgramErrorMessage(errorMessage);
        if (programError) {
          toast.error(programError);
        } else {
          toast.error(errorMessage);
        }
      }
    }
  }, [publicKey, signTransaction, isFormValid, formData, connection, onClose]);

  const getButtonText = () => {
    if (!connected) return "Connect wallet";
    switch (txStatus) {
      case "building":
        return "Building transaction...";
      case "signing":
        return "Sign in wallet...";
      case "reconnecting":
        return "Reconnecting to wallet...";
      case "confirming":
        return "Confirming...";
      case "success":
        return "Success!";
      case "error":
        return "Try again";
      default:
        return "Initialize bounty";
    }
  };

  const isButtonDisabled =
    !isFormValid || !connected || ["building", "signing", "reconnecting", "confirming"].includes(txStatus);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-6xl lg:max-w-[72rem] gap-2 p-4 bg-zinc-950 rounded-2xl border border-zinc-800">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-xl tracking-tight text-white font-semibold font-sans">Bounty configuration</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5 cursor-pointer tracking-tight font-sans text-zinc-400 hover:text-white h-8 px-2">
            <ArrowLeft className="size-3.5" />
            Back
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 tracking-tight font-sans">Draft status</span>
            <Badge
              variant={isFormValid ? "default" : "outline"}
              className={`font-sans text-xs ${isFormValid ? "bg-[#b4d429] text-black hover:bg-[#b4d429]" : "border-zinc-600 text-zinc-400"}`}
            >
              {isFormValid ? "Valid" : "Incomplete"}
            </Badge>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[2.1fr_1fr]">
          <div className="space-y-2">
            <Card className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700">
                    <Users className="w-3.5 h-3.5 text-zinc-400" />
                  </div>
                  <span className="text-sm font-semibold tracking-tight font-sans">Token & trader</span>
                </div>
                <Badge className="bg-white text-black hover:bg-white font-semibold text-[10px] px-2 py-0 font-sans">
                  Required
                </Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-0.5">
                  <Label htmlFor="contractAddress" className="text-xs text-zinc-400 tracking-tight font-sans">Token CA</Label>
                  <Input
                    id="contractAddress"
                    placeholder="Paste contract address..."
                    value={formData.contractAddress}
                    onChange={(e) => handleInputChange("contractAddress", e.target.value)}
                    className="rounded-lg bg-zinc-800 border-zinc-700 h-9 text-sm"
                  />
                </div>
                <div className="space-y-0.5">
                  <Label htmlFor="traderWallet" className="text-xs text-zinc-400 tracking-tight font-sans">Target trader</Label>
                  <div className="relative">
                    <div className="flex gap-2">
                      <Input
                        id="traderWallet"
                        placeholder="Wallet address..."
                        value={formData.traderWallet}
                        onChange={(e) => handleInputChange("traderWallet", e.target.value)}
                        className="rounded-lg bg-zinc-800 border-zinc-700 h-9 text-sm flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setShowTraderDropdown(!showTraderDropdown)}
                        className="rounded-lg bg-zinc-800 border-zinc-700 px-2 cursor-pointer h-9"
                      >
                        <Users className="w-3.5 h-3.5 mr-1" />
                        <ChevronDown className={`w-3 h-3 transition-transform ${showTraderDropdown ? "rotate-180" : ""}`} />
                      </Button>
                    </div>
                    {showTraderDropdown && (
                      <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-zinc-900 border border-zinc-700 rounded-lg shadow-lg">
                        {tradersLoading ? (
                          <>
                            {[1, 2, 3, 4].map((i) => (
                              <div key={i} className="w-full px-3 py-2 flex items-center gap-3 animate-pulse">
                                <div className="w-6 h-6 rounded-full bg-zinc-700" />
                                <div className="flex-1">
                                  <div className="h-4 w-24 bg-zinc-700 rounded mb-1" />
                                  <div className="h-3 w-20 bg-zinc-800 rounded" />
                                </div>
                              </div>
                            ))}
                          </>
                        ) : tradersError ? (
                          <div className="px-3 py-4 text-center">
                            <div className="flex items-center justify-center gap-2 text-sm text-destructive mb-2">
                              <AlertCircle className="w-4 h-4" />
                              {tradersError.message}
                            </div>
                            {tradersError.retryable && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => fetchTraders()}
                                className="gap-2"
                              >
                                <RefreshCw className="w-3 h-3" />
                                Retry
                              </Button>
                            )}
                          </div>
                        ) : traders.length === 0 ? (
                          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                            No traders found
                          </div>
                        ) : (
                          traders.map((trader) => (
                          <button
                            key={trader.id}
                            type="button"
                            onClick={() => {
                              handleInputChange("traderWallet", trader.address);
                              setShowTraderDropdown(false);
                            }}
                            className="w-full px-3 py-2 text-left hover:bg-zinc-800 transition-colors cursor-pointer flex items-center gap-3"
                          >
                            {trader.imageUrl ? (
                              <img
                                src={trader.imageUrl}
                                alt={trader.name}
                                className="w-6 h-6 rounded-full object-cover"
                              />
                            ) : (
                              <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center text-xs font-bold">
                                {trader.name?.charAt(0).toUpperCase()}
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{trader.name}</p>
                              <p className="text-xs text-muted-foreground font-mono truncate">
                                {trader.address.slice(0, 4)}...{trader.address.slice(-4)}
                              </p>
                            </div>
                          </button>
                        ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </Card>

            {/* Required section - Bounty details */}
            <Card className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700">
                    <span className="text-sm">$</span>
                  </div>
                  <span className="text-sm font-semibold tracking-tight font-sans">Bounty details</span>
                </div>
                <Badge className="bg-white text-black hover:bg-white font-semibold text-[10px] px-2 py-0 font-sans">
                  Required
                </Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-2 mb-2">
                <div className="space-y-0.5">
                  <Label htmlFor="rewardAmount" className="text-xs text-zinc-400 tracking-tight font-sans">Reward amount ($)</Label>
                  <Input
                    id="rewardAmount"
                    type="number"
                    inputMode="decimal"
                    placeholder="5000"
                    value={formData.rewardAmount}
                    onChange={(e) => handleInputChange("rewardAmount", e.target.value)}
                    className="rounded-lg bg-zinc-800 border-zinc-700 h-9 text-sm font-semibold"
                  />
                </div>
                <div className="space-y-0.5">
                  <Label htmlFor="volumeTarget" className="text-xs text-zinc-400 tracking-tight font-sans">Volume target ($)</Label>
                  <Input
                    id="volumeTarget"
                    type="number"
                    inputMode="decimal"
                    placeholder="2000"
                    value={formData.volumeTarget}
                    onChange={(e) => handleInputChange("volumeTarget", e.target.value)}
                    className="rounded-lg bg-zinc-800 border-zinc-700 h-9 text-sm font-semibold"
                  />
                </div>
              </div>
              <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-2">
                <div className="flex items-center justify-between mb-1">
                  <Label htmlFor="expirationWindow" className="text-xs text-zinc-400 tracking-tight font-sans">Expiration window</Label>
                  <span className="text-xs text-zinc-500 font-sans">Time to complete</span>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    id="expirationWindow"
                    type="number"
                    inputMode="decimal"
                    placeholder="72"
                    value={formData.expirationWindow}
                    onChange={(e) => handleInputChange("expirationWindow", e.target.value)}
                    className="rounded-lg bg-zinc-900 border-zinc-700 h-9 text-sm font-semibold w-20"
                  />
                  <span className="text-xs text-zinc-400 font-semibold">hrs</span>
                </div>
              </div>
            </Card>

            {/* Optional section - Trade settings */}
            <Card className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700">
                    <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                    </svg>
                  </div>
                  <span className="text-sm font-semibold tracking-tight font-sans">Trade settings</span>
                </div>
                <Badge variant="outline" className="border-zinc-600 text-zinc-400 font-semibold text-[10px] px-2 py-0 font-sans">
                  Optional
                </Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-0.5">
                  <Label htmlFor="holdDuration" className="text-xs text-zinc-400 tracking-tight font-sans">Hold duration</Label>
                  <div className="relative">
                    <Input
                      id="holdDuration"
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={formData.holdDuration}
                      onChange={(e) => handleInputChange("holdDuration", e.target.value)}
                      className={`rounded-lg bg-zinc-800 border-zinc-700 h-9 text-sm font-semibold pr-20 ${holdDurationError ? "border-destructive" : ""}`}
                    />
                    <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center bg-zinc-700 rounded h-7 p-0.5">
                      <button
                        type="button"
                        onClick={() => setHoldDurationUnit("min")}
                        className={`px-2 h-6 rounded text-[10px] font-semibold transition-colors cursor-pointer ${holdDurationUnit === "min" ? "bg-white text-black" : "text-zinc-400 hover:text-zinc-200"}`}
                      >
                        MIN
                      </button>
                      <button
                        type="button"
                        onClick={() => setHoldDurationUnit("hrs")}
                        className={`px-2 h-6 rounded text-[10px] font-semibold transition-colors cursor-pointer ${holdDurationUnit === "hrs" ? "bg-white text-black" : "text-zinc-400 hover:text-zinc-200"}`}
                      >
                        HRS
                      </button>
                    </div>
                  </div>
                  {holdDurationError && (
                    <p className="text-xs text-destructive">{holdDurationError}</p>
                  )}
                </div>
                <div className="space-y-0.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="minBuyVolume" className="text-xs text-zinc-400 tracking-tight font-sans">Min buy size ($)</Label>
                    <span className="text-xs text-zinc-500 font-sans">Per tx</span>
                  </div>
                  <Input
                    id="minBuyVolume"
                    type="number"
                    inputMode="decimal"
                    placeholder="0"
                    value={formData.minBuyVolume}
                    onChange={(e) => handleInputChange("minBuyVolume", e.target.value)}
                    className={`rounded-lg bg-zinc-800 border-zinc-700 h-9 text-sm font-semibold ${minBuyVolumeError ? "border-destructive" : ""}`}
                  />
                  {minBuyVolumeError && (
                    <p className="text-xs text-destructive">{minBuyVolumeError}</p>
                  )}
                </div>
              </div>
            </Card>
          </div>

          <div className="space-y-2">
            <Card className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-3">
              <div className="flex items-center gap-2 mb-2">
                <div className="flex items-center justify-center w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700">
                  <CheckCircle2 className="w-3.5 h-3.5 text-zinc-400" />
                </div>
                <div>
                  <span className="text-sm font-semibold tracking-tight font-sans">Bounty summary</span>
                  <p className="text-xs text-zinc-500">Review before initializing.</p>
                </div>
              </div>
              <div className="space-y-1.5 rounded-lg bg-zinc-800/50 p-2 border border-zinc-700 mb-2">
                <div className="flex items-center justify-between text-xs tracking-tight">
                  <span className="text-zinc-400">Base reward</span>
                  <span className="font-semibold">${formData.rewardAmount || "0"}</span>
                </div>
                <div className="flex items-center justify-between text-xs tracking-tight">
                  <span className="text-zinc-400">Protocol tax (10%)</span>
                  <span className="font-semibold">${protocolTax}</span>
                </div>
              </div>

              <Separator className="bg-zinc-700 mb-2" />

              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="text-xs tracking-tight text-zinc-500">Total escrow</p>
                  <p className="text-xl font-bold leading-none tracking-tight">${totalEscrow}</p>
                </div>
                <Badge variant="secondary" className="bg-zinc-800 text-zinc-300 text-[10px]">Devnet</Badge>
              </div>

              <Button
                size="sm"
                className="w-full cursor-pointer tracking-tighter rounded-lg h-9 bg-white text-black hover:bg-zinc-200 font-semibold text-sm font-sans"
                disabled={isButtonDisabled}
                onClick={handleCreateBounty}
              >
                {["building", "signing", "reconnecting", "confirming"].includes(txStatus) && (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                )}
                {txStatus === "success" && <CheckCircle2 className="mr-1.5 size-3.5" />}
                {getButtonText()}
              </Button>

              {txSignature && txStatus === "success" && (
                <Button
                  variant="link"
                  asChild
                  className="px-0 text-xs font-semibold text-[#b4d429] cursor-pointer tracking-tight h-auto py-0 mt-1"
                >
                  <a
                    href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on Explorer
                  </a>
                </Button>
              )}
            </Card>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
