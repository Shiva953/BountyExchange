"use client";

import { useState, useCallback, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { sendTransactionWithRetry } from "@/utils/sendTransactionWithRetry";
import { ArrowLeft, ArrowUpRight, CheckCircle2, Loader2, ChevronDown, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

interface Trader {
  id: number;
  name: string;
  address: string;
  imageUrl: string | null;
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

type TransactionStatus = "idle" | "building" | "signing" | "confirming" | "success" | "error";

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
  const [showTraderDropdown, setShowTraderDropdown] = useState(false);

  // Fetch traders when modal opens
  useEffect(() => {
    if (isOpen) {
      setTradersLoading(true);
      fetch("/api/getTraders")
        .then((res) => res.json())
        .then((data) => {
          if (data.success) {
            setTraders(data.traders);
          }
        })
        .catch((err) => console.error("Error fetching traders:", err))
        .finally(() => setTradersLoading(false));
    }
  }, [isOpen]);

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

  const isFormValid =
    formData.contractAddress &&
    formData.traderWallet &&
    formData.rewardAmount &&
    formData.volumeTarget &&
    formData.expirationWindow &&
    formData.holdDuration &&
    !minBuyVolumeError;

  const handleCreateBounty = useCallback(async () => {
    if (!publicKey || !signTransaction || !isFormValid) {
      toast.error("Please connect your wallet first");
      return;
    }

    setTxStatus("building");
    setTxSignature(null);

    try {
      const response = await fetch("/api/createDeal", {
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
          holdDurationInHours: formData.holdDuration,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to build transaction");
      }

      setTxStatus("signing");
      const transactionBuffer = Buffer.from(data.transaction, "base64");
      const transaction = Transaction.from(transactionBuffer);

      const signedTransaction = await signTransaction(transaction);

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

      // Confirm creator in DB (fire-and-forget, don't block success)
      fetch("/api/confirmDealCreated", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatorAddress: publicKey.toBase58() }),
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
        setTxStatus("idle");
        onClose();
      }, 1200);
    } catch (error) {
      setTxStatus("error");
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";

      // Check for RewardBelowMinimum error (code 6001)
      if (errorMessage.includes("6001") || errorMessage.includes("RewardBelowMinimum") || errorMessage.includes("Minimum reward amount")) {
        toast.error("Minimum reward amount is 200 USDC");
      // Check for SelfTargetedDeal error (code 6005)
      } else if (errorMessage.includes("6005") || errorMessage.includes("SelfTargetedDeal") || errorMessage.includes("targeting yourself")) {
        toast.error("Cannot create a bounty targeting yourself");
      // Check for MinBuyVolumeExceedsTarget error (code 6012)
      } else if (errorMessage.includes("6012") || errorMessage.includes("MinBuyVolumeExceedsTarget") || errorMessage.includes("Minimum buy volume must be less than")) {
        toast.error("Min buy size must be less than target volume");
      } else {
        toast.error(errorMessage);
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
    !isFormValid || !connected || ["building", "signing", "confirming"].includes(txStatus);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-7xl lg:max-w-[80rem] gap-4 p-6 bg-background rounded-none border-2 border-[#e84057]"
        style={{ fontFamily: 'GeistMono, ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Monaco, "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace' }}
      >
        <DialogHeader className="space-y-2">
          <DialogTitle className="text-2xl tracking-tight text-primary">Bounty configuration</DialogTitle>
                  </DialogHeader>

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onClose} className="gap-2 cursor-pointer tracking-tight font-sans">
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground tracking-tight font-sans">Draft status</span>
            <Badge
              variant={isFormValid ? "default" : "outline"}
              className={`font-sans ${isFormValid ? "bg-emerald-500 text-emerald-950" : ""}`}
            >
              {isFormValid ? "Valid" : "Incomplete"}
            </Badge>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[2.1fr_1fr]">
          <div className="space-y-4">
            <Card className="rounded-none border-solid border-[#e84057]/30 bg-[#e84057]/5">
              <CardHeader>
                <CardTitle className="text-base tracking-tight font-sans">Token & Trader</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="contractAddress" className="tracking-tight font-sans">Token CA</Label>
                  <Input
                    id="contractAddress"
                    // placeholder="Paste CA..."
                    value={formData.contractAddress}
                    onChange={(e) => handleInputChange("contractAddress", e.target.value)}
                    className="rounded-none"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="traderWallet" className="tracking-tight font-sans">Target Trader</Label>
                  <div className="relative">
                    <div className="flex gap-2">
                      <Input
                        id="traderWallet"
                        placeholder="Wallet address..."
                        value={formData.traderWallet}
                        onChange={(e) => handleInputChange("traderWallet", e.target.value)}
                        className="rounded-none flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setShowTraderDropdown(!showTraderDropdown)}
                        className="rounded-none px-3 cursor-pointer"
                      >
                        <Users className="w-4 h-4 mr-1" />
                        <ChevronDown className={`w-3 h-3 transition-transform ${showTraderDropdown ? "rotate-180" : ""}`} />
                      </Button>
                    </div>
                    {showTraderDropdown && (
                      <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-background border border-[#e84057]/30 shadow-lg">
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
                            className="w-full px-3 py-2 text-left hover:bg-[#e84057]/10 transition-colors cursor-pointer flex items-center gap-3"
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
              </CardContent>
            </Card>

            <Card className="rounded-none border-solid border-[#e84057]/30 bg-[#e84057]/5">
              <CardHeader>
                <CardTitle className="text-base tracking-tight font-sans">Reward & Conditions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="rewardAmount" className="tracking-tight font-sans">Reward ($)</Label>
                    <Input
                      id="rewardAmount"
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={formData.rewardAmount}
                      onChange={(e) => handleInputChange("rewardAmount", e.target.value)}
                      className="rounded-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="volumeTarget" className="tracking-tight font-sans">Target Volume ($)</Label>
                    <Input
                      id="volumeTarget"
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={formData.volumeTarget}
                      onChange={(e) => handleInputChange("volumeTarget", e.target.value)}
                      className="rounded-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="minBuyVolume" className="tracking-tight font-sans">Min Buy Size ($) <span className="text-muted-foreground text-xs">(optional)</span></Label>
                    <Input
                      id="minBuyVolume"
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={formData.minBuyVolume}
                      onChange={(e) => handleInputChange("minBuyVolume", e.target.value)}
                      className={`rounded-none ${minBuyVolumeError ? "border-destructive" : ""}`}
                    />
                    {minBuyVolumeError && (
                      <p className="text-xs text-destructive">{minBuyVolumeError}</p>
                    )}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="expirationWindow" className="tracking-tight font-sans">Expiration Window (hrs)</Label>
                    <Input
                      id="expirationWindow"
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={formData.expirationWindow}
                      onChange={(e) => handleInputChange("expirationWindow", e.target.value)}
                      className="rounded-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="holdDuration" className="tracking-tight font-sans">Hold Duration (hrs)</Label>
                    <Input
                      id="holdDuration"
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={formData.holdDuration}
                      onChange={(e) => handleInputChange("holdDuration", e.target.value)}
                      className="rounded-none"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card className="rounded-none border-solid border-[#e84057]/30 bg-[#e84057]/5">
              <CardHeader className="space-y-3">
                <div className="flex items-center gap-2 text-primary">
                  <CheckCircle2 className="size-4" />
                  <CardTitle className="text-sm tracking-tight">Bounty summary</CardTitle>
                </div>
                <CardDescription className="text-xs">
                  Review totals before initializing escrow.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm tracking-tight">
                    <span className="text-muted-foreground">Base reward</span>
                    <span className="font-semibold">${formData.rewardAmount || "0"}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm tracking-tight">
                    <span className="text-muted-foreground">Protocol tax (10%)</span>
                    <span className="font-semibold">${protocolTax}</span>
                  </div>
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <p className="text-xs tracking-tight text-muted-foreground">
                      Total Escrow
                    </p>
                    <p className="text-3xl font-bold leading-none tracking-tight">${totalEscrow}</p>
                  </div>
                  <Badge variant="secondary">Devnet</Badge>
                </div>

                <Button
                  size="lg"
                  className="w-full cursor-pointer tracking-tight"
                  disabled={isButtonDisabled}
                  onClick={handleCreateBounty}
                >
                  {["building", "signing", "confirming"].includes(txStatus) && (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  )}
                  {txStatus === "success" && <CheckCircle2 className="mr-2 size-4" />}
                  {getButtonText()}
                </Button>

                {txSignature && txStatus === "success" && (
                  <Button
                    variant="link"
                    asChild
                    className="px-0 text-sm font-semibold text-primary cursor-pointer tracking-tight"
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
              </CardContent>
            </Card>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
