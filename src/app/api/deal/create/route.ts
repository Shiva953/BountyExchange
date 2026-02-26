import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  buildCreateDealInstruction,
  logDealDetails,
  CreateDealArgs,
  USDC_MINT,
} from "@/program/instructions/createDeal";
import { createApiError, withRetry } from "@/lib/errors";

function generateDealId(): BN {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 0xFFFF);
  const highBits = new BN(timestamp).shln(16);
  return highBits.or(new BN(random));
}

interface CreateDealRequestBody {
  payer: string;
  token: string;
  trader: string;
  rewardAmount: string;
  targetVolume: string;
  minBuyVolume?: string;
  expirationWindowInHours: string;
  holdDurationInHours: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: CreateDealRequestBody = await request.json();

    const requiredFields: (keyof CreateDealRequestBody)[] = [
      "payer",
      "token",
      "trader",
      "rewardAmount",
      "targetVolume",
      "expirationWindowInHours",
      "holdDurationInHours",
    ];

    for (const field of requiredFields) {
      if (!body[field]) {
        return NextResponse.json(
          { error: `Missing required field: ${field}` },
          { status: 400 }
        );
      }
    }

    let payerPubkey: PublicKey;
    let tokenPubkey: PublicKey;
    let traderPubkey: PublicKey;

    try {
      payerPubkey = new PublicKey(body.payer);
      tokenPubkey = new PublicKey(body.token);
      traderPubkey = new PublicKey(body.trader);
    } catch {
      return NextResponse.json(
        { error: "Invalid public key format" },
        { status: 400 }
      );
    }

    const dealId = generateDealId();
    const USDC_DECIMALS = 9;
    const rewardAmountRaw = parseFloat(body.rewardAmount);
    const targetVolumeRaw = parseFloat(body.targetVolume);

    if (isNaN(rewardAmountRaw) || isNaN(targetVolumeRaw)) {
      return NextResponse.json(
        { error: "Invalid amount format" },
        { status: 400 }
      );
    }

    const rewardAmount = new BN(Math.floor(rewardAmountRaw * 10 ** USDC_DECIMALS));
    const targetVolume = new BN(Math.floor(targetVolumeRaw * 10 ** USDC_DECIMALS));
    const expirationWindowInHours = new BN(body.expirationWindowInHours);
    const holdDurationInHours = new BN(body.holdDurationInHours);

    let minBuyVolume: BN | null = null;
    if (body.minBuyVolume) {
      const minBuyVolumeRaw = parseFloat(body.minBuyVolume);
      if (!isNaN(minBuyVolumeRaw) && minBuyVolumeRaw > 0) {
        minBuyVolume = new BN(Math.floor(minBuyVolumeRaw * 10 ** USDC_DECIMALS));
      }
    }

    const args: CreateDealArgs = {
      dealId,
      token: tokenPubkey,
      trader: traderPubkey,
      rewardAmount,
      targetVolume,
      minBuyVolume,
      expirationWindowInHours,
      holdDurationInHours,
    };

    const connection = new Connection(process.env.HELIUS_DEVNET_URL!, "confirmed");

    // Retry RPC calls with exponential backoff
    const { instruction, dealPDA, escrowVault } = await withRetry(
      () => buildCreateDealInstruction(connection, payerPubkey, args, USDC_MINT),
      { maxRetries: 3, initialDelay: 500 }
    );

    logDealDetails(payerPubkey, args, dealPDA, escrowVault);

    const { blockhash, lastValidBlockHeight } = await withRetry(
      () => connection.getLatestBlockhash("confirmed"),
      { maxRetries: 3, initialDelay: 500 }
    );

    const transaction = new Transaction();
    transaction.add(instruction);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payerPubkey;

    const serializedTransaction = transaction
      .serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      })
      .toString("base64");

    return NextResponse.json({
      success: true,
      transaction: serializedTransaction,
      dealId: dealId.toString(),
      dealPDA: dealPDA.toBase58(),
      escrowVault: escrowVault.toBase58(),
      blockhash,
      lastValidBlockHeight,
    });
  } catch (error) {
    console.error("Error creating deal:", error);
    const apiError = createApiError(error);
    return NextResponse.json(
      {
        error: apiError.message,
        code: apiError.code,
        retryable: apiError.retryable,
        retryAfter: apiError.retryAfter,
      },
      { status: 500 }
    );
  }
}
