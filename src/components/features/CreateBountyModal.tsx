"use client";

import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { ArrowLeft, ArrowUpRight, CheckCircle2, Loader2, Target } from "lucide-react";
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
  DialogDescription,
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
  expirationWindow: string;
  holdDuration: string;
}

type TransactionStatus = "idle" | "building" | "signing" | "confirming" | "success" | "error";

export const CreateBountyModal = ({ isOpen, onClose }: CreateBountyModalProps) => {
  const { publicKey, signTransaction, connected } = useWallet();
  const { connection } = useConnection();

  const [txStatus, setTxStatus] = useState<TransactionStatus>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [formData, setFormData] = useState<BountyFormData>({
    contractAddress: "",
    traderWallet: "",
    rewardAmount: "",
    volumeTarget: "",
    expirationWindow: "",
    holdDuration: "",
  });

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

  const isFormValid =
    formData.contractAddress &&
    formData.traderWallet &&
    formData.rewardAmount &&
    formData.volumeTarget &&
    formData.expirationWindow &&
    formData.holdDuration;

  const handleCreateBounty = useCallback(async () => {
    if (!publicKey || !signTransaction || !isFormValid) {
      setTxError("Please connect your wallet first");
      return;
    }

    setTxStatus("building");
    setTxError(null);
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
      const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: data.blockhash,
          lastValidBlockHeight: data.lastValidBlockHeight,
        },
        "confirmed"
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

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
          expirationWindow: "",
          holdDuration: "",
        });
        setTxStatus("idle");
        onClose();
      }, 1200);
    } catch (error) {
      setTxStatus("error");
      setTxError(error instanceof Error ? error.message : "Unknown error occurred");
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

  const holdRatio =
    formData.holdDuration && formData.expirationWindow
      ? Math.round(
          (parseFloat(formData.holdDuration) / parseFloat(formData.expirationWindow)) * 100
        )
      : "";

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-7xl lg:max-w-[80rem] gap-4 p-6 bg-background">
        <DialogHeader className="space-y-2">
          <div className="flex items-center gap-2 text-primary">
            <Target className="size-5" />
            <DialogTitle className="text-2xl">Bounty configuration</DialogTitle>
          </div>
          <DialogDescription>Verified performance</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onClose} className="gap-2 cursor-pointer">
            <ArrowLeft className="size-4" />
            Abort configuration
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Draft status</span>
            <Badge
              variant={isFormValid ? "default" : "outline"}
              className={isFormValid ? "bg-emerald-500 text-emerald-950" : ""}
            >
              {isFormValid ? "Valid" : "Incomplete"}
            </Badge>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[2.1fr_1fr]">
          <div className="space-y-4">
            <Card className="border-dashed">
              <CardHeader>
                <CardTitle className="text-base">Token & Trader</CardTitle>
                <CardDescription>Define token contract and target trader.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="contractAddress">Token CA</Label>
                  <Input
                    id="contractAddress"
                    placeholder="Paste CA..."
                    value={formData.contractAddress}
                    onChange={(e) => handleInputChange("contractAddress", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="traderWallet">Target Trader</Label>
                  <Input
                    id="traderWallet"
                    placeholder="Wallet address..."
                    value={formData.traderWallet}
                    onChange={(e) => handleInputChange("traderWallet", e.target.value)}
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="border-dashed">
              <CardHeader>
                <CardTitle className="text-base">Reward & Conditions</CardTitle>
                <CardDescription>Set the reward, target volume, and timing.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="rewardAmount">Reward ($)</Label>
                    <Input
                      id="rewardAmount"
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={formData.rewardAmount}
                      onChange={(e) => handleInputChange("rewardAmount", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="volumeTarget">Target Volume ($)</Label>
                    <Input
                      id="volumeTarget"
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={formData.volumeTarget}
                      onChange={(e) => handleInputChange("volumeTarget", e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="expirationWindow">Expiration Window (hrs)</Label>
                    <Input
                      id="expirationWindow"
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={formData.expirationWindow}
                      onChange={(e) => handleInputChange("expirationWindow", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="holdDuration">Hold Duration (hrs)</Label>
                    <Input
                      id="holdDuration"
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={formData.holdDuration}
                      onChange={(e) => handleInputChange("holdDuration", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="holdRatio">Hold Ratio (%)</Label>
                    <Input id="holdRatio" value={holdRatio} placeholder="—" readOnly />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
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
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Base reward</span>
                    <span className="font-semibold">${formData.rewardAmount || "0"}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
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
                    <p className="text-3xl font-bold leading-none">${totalEscrow}</p>
                  </div>
                  <Badge variant="secondary">Devnet</Badge>
                </div>

                <Button
                  size="lg"
                  className="w-full cursor-pointer"
                  disabled={isButtonDisabled}
                  onClick={handleCreateBounty}
                >
                  {["building", "signing", "confirming"].includes(txStatus) && (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  )}
                  {txStatus === "success" && <CheckCircle2 className="mr-2 size-4" />}
                  {getButtonText()}
                </Button>

                {txError && (
                  <p className="text-sm text-destructive" role="alert">
                    {txError}
                  </p>
                )}

                {txSignature && txStatus === "success" && (
                  <Button
                    variant="link"
                    asChild
                    className="px-0 text-sm font-semibold text-primary cursor-pointer"
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
