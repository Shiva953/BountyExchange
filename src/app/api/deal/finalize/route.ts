import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import { sendTransactionWithRetry as sendTxWithRetry } from "@/utils/sendTransactionWithRetry";
import { BN } from "@coral-xyz/anchor";
import { getProgram } from "@/program/instructions/createDeal";
import { buildFinalizeDealInstruction } from "@/program/instructions/finalizeDeal";
import { prisma } from "@/lib/prisma";
import bs58 from "bs58";

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000;

interface FinalizeDealRequest {
  dealPubkey: string;
  volumeAtEndTime?: number; // In USD, will be converted to raw units
  holdDurationAtEndTime?: number; // In hours
}

/**
 * Loads the crank keypair from environment variable.
 * The private key should be stored as a base58-encoded string.
 */
function getCrankKeypair(): Keypair | null {
  const privateKey = process.env.CRANK_PRIVATE_KEY;
  if (!privateKey) {
    console.error("[FINALIZE] CRANK_PRIVATE_KEY not set in environment");
    return null;
  }

  try {
    const secretKey = bs58.decode(privateKey);
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    console.error("[FINALIZE] Failed to decode CRANK_PRIVATE_KEY:", error);
    return null;
  }
}

// Program error code mappings from IDL
const PROGRAM_ERROR_MAP: Record<number, string> = {
  6003: "Deal is not active - may already be finalized",
  6006: "Deal has not been accepted",
  6009: "Deal has expired - cannot finalize",
  6010: "Volume requirement not met",
  6022: "Unauthorized crank - wrong keypair configured",
};

/**
 * Sends a transaction with retry logic for handling blockhash expiration.
 * Uses the shared sendTransactionWithRetry utility for send+confirm,
 * with an outer retry loop for blockhash expiration.
 */
async function sendFinalizeTxWithRetry(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
  maxRetries: number = MAX_RETRIES
): Promise<{ signature: string; success: boolean; error?: string }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Get fresh blockhash for each attempt
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;

      // Sign with all signers
      transaction.sign(...signers);

      const result = await sendTxWithRetry(
        connection,
        transaction,
        lastValidBlockHeight
      );

      if (result.success) {
        return { signature: result.signature, success: true };
      }

      // Check for specific program errors via error code
      const programError = result.errorCode
        ? PROGRAM_ERROR_MAP[result.errorCode]
        : undefined;

      if (programError) {
        return {
          signature: result.signature,
          success: false,
          error: programError,
        };
      }

      return {
        signature: result.signature,
        success: false,
        error: `Transaction failed with error code: ${result.errorCode}`,
      };
    } catch (error) {
      lastError = error as Error;

      // "Transaction did not land" means block height exceeded
      const isBlockhashExpired =
        (error as Error).message?.includes("Transaction did not land") ||
        (error as Error).message?.includes("block height exceeded") ||
        (error as Error).message?.includes("Blockhash not found");

      if (isBlockhashExpired && attempt < maxRetries) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(
          `[FINALIZE] Transaction didn't land on attempt ${attempt}/${maxRetries}, retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      console.error(
        `[FINALIZE] Transaction failed on attempt ${attempt}:`,
        error
      );

      if (attempt < maxRetries) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  return {
    signature: "",
    success: false,
    error: lastError?.message || "Transaction failed after max retries",
  };
}

/**
 * POST /api/deal/finalize
 *
 * Finalizes a deal on-chain using a permissionless crank pattern.
 * This endpoint is designed to be called by the cron job when a deal
 * has met its volume requirements and is ready for payout.
 *
 * The crank keypair pays for transaction fees but the reward goes to the trader.
 */
export async function POST(request: NextRequest) {
  try {
    const body: FinalizeDealRequest = await request.json();
    const { dealPubkey, volumeAtEndTime, holdDurationAtEndTime } = body;

    if (!dealPubkey) {
      return NextResponse.json(
        { success: false, error: "Missing dealPubkey" },
        { status: 400 }
      );
    }

    // Validate deal pubkey
    let dealPubkeyObj: PublicKey;
    try {
      dealPubkeyObj = new PublicKey(dealPubkey);
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid deal pubkey" },
        { status: 400 }
      );
    }

    // Get crank keypair
    const crankKeypair = getCrankKeypair();
    if (!crankKeypair) {
      return NextResponse.json(
        {
          success: false,
          error: "Server not configured for finalization (missing crank key)",
        },
        { status: 500 }
      );
    }

    console.log(`[FINALIZE] Starting finalization for deal: ${dealPubkey}`);
    console.log(`[FINALIZE] Crank wallet: ${crankKeypair.publicKey.toBase58()}`);

    const connection = new Connection(
      process.env.HELIUS_DEVNET_URL!,
      "confirmed"
    );

    const program = getProgram(connection);

    // Fetch deal from on-chain
    let dealAccount;
    try {
      dealAccount = await program.account.deal.fetch(dealPubkeyObj);
    } catch (error) {
      console.error("[FINALIZE] Failed to fetch deal account:", error);
      return NextResponse.json(
        { success: false, error: "Deal not found on-chain" },
        { status: 404 }
      );
    }

    // Verify deal state
    if (!dealAccount.isActive) {
      console.log("[FINALIZE] Deal is not active - may already be finalized");
      return NextResponse.json(
        { success: false, error: "Deal is not active" },
        { status: 400 }
      );
    }

    if (!dealAccount.isAccepted) {
      console.log("[FINALIZE] Deal has not been accepted");
      return NextResponse.json(
        { success: false, error: "Deal has not been accepted" },
        { status: 400 }
      );
    }

    // Get deal from DB for volume info if not provided
    let finalVolumeAtEndTime = volumeAtEndTime;
    let finalHoldDurationAtEndTime = holdDurationAtEndTime;

    if (finalVolumeAtEndTime === undefined) {
      const dbDeal = await prisma.deal.findUnique({
        where: { publicKey: dealPubkey },
      });

      if (dbDeal) {
        // Volume in DB is stored in USD
        finalVolumeAtEndTime = Number(dbDeal.volumeCompleted || 0);
      } else {
        // If no DB record, use 0 (will likely fail volume check)
        finalVolumeAtEndTime = 0;
      }
    }

    // For hold duration, we default to the required duration (assuming it's met)
    // In a real implementation, this would be calculated from actual token holdings
    if (finalHoldDurationAtEndTime === undefined) {
      finalHoldDurationAtEndTime = Number(dealAccount.holdDurationInHours);
    }

    console.log(`[FINALIZE] Volume at end time: $${finalVolumeAtEndTime}`);
    console.log(
      `[FINALIZE] Hold duration at end time: ${finalHoldDurationAtEndTime} hours`
    );
    console.log(
      `[FINALIZE] Target volume: $${Number(dealAccount.targetVolume) / 10 ** 9}`
    );
    console.log(
      `[FINALIZE] Required hold duration: ${Number(dealAccount.holdDurationInHours)} hours`
    );

    // Convert volume from USD to raw units (9 decimals)
    const volumeRaw = new BN(Math.floor(finalVolumeAtEndTime * 10 ** 9));
    const holdDurationRaw = new BN(finalHoldDurationAtEndTime);

    // Determine expected outcome based on volume AND hold duration requirements
    const targetVolumeUSD = Number(dealAccount.targetVolume) / 10 ** 9;
    const requiredHoldDuration = Number(dealAccount.holdDurationInHours);
    const volumeMet = finalVolumeAtEndTime >= targetVolumeUSD;
    const holdMet = finalHoldDurationAtEndTime >= requiredHoldDuration;
    const traderPassed = volumeMet && holdMet;

    console.log(
      `[FINALIZE] Requirements check - Volume: ${finalVolumeAtEndTime.toFixed(2)}/${targetVolumeUSD.toFixed(2)} (${volumeMet ? "MET" : "NOT MET"}), Hold: ${finalHoldDurationAtEndTime}/${requiredHoldDuration}h (${holdMet ? "MET" : "NOT MET"})`
    );
    console.log(
      `[FINALIZE] Expected outcome: ${traderPassed ? "PASS (trader wins)" : "FAIL (creator refunded)"}`
    );

    // Build the finalize instruction
    const { instruction } = await buildFinalizeDealInstruction(
      connection,
      crankKeypair.publicKey,
      dealPubkeyObj,
      {
        dealId: dealAccount.dealId,
        creator: dealAccount.creator,
        trader: dealAccount.trader,
        escrowVault: dealAccount.escrowVault,
      },
      {
        volumeAtEndTime: volumeRaw,
        holdDurationAtEndTime: holdDurationRaw,
      }
    );

    // Create and send transaction
    const transaction = new Transaction().add(instruction);

    console.log("[FINALIZE] Sending transaction...");
    const result = await sendFinalizeTxWithRetry(connection, transaction, [
      crankKeypair,
    ]);

    if (!result.success) {
      console.error("[FINALIZE] Transaction failed:", result.error);

      // Update DB to mark finalization attempt failed
      await prisma.deal.update({
        where: { publicKey: dealPubkey },
        data: {
          // Keep as active, cron will retry
        },
      });

      return NextResponse.json(
        {
          success: false,
          error: result.error,
        },
        { status: 500 }
      );
    }

    console.log(`[FINALIZE] Transaction confirmed: ${result.signature}`);

    // Determine final outcome based on requirements
    const finalOutcome = traderPassed ? "won" : "lost";

    // Update DB
    const now = new Date();
    await prisma.deal.update({
      where: { publicKey: dealPubkey },
      data: {
        isActive: false,
        finalizedAt: now,
        outcome: finalOutcome,
        volumeCompleted: finalVolumeAtEndTime,
      },
    });

    // Update trader's active bounties count
    const dbDeal = await prisma.deal.findUnique({
      where: { publicKey: dealPubkey },
      include: { trader: true },
    });

    if (dbDeal) {
      const activeCount = await prisma.deal.count({
        where: {
          traderId: dbDeal.traderId,
          isActive: true,
          isAccepted: true,
        },
      });

      await prisma.trader.update({
        where: { id: dbDeal.traderId },
        data: { activeBounties: activeCount },
      });
    }

    console.log(
      `[FINALIZE] Deal ${dealPubkey} finalized successfully! Outcome: ${finalOutcome.toUpperCase()}`
    );

    return NextResponse.json({
      success: true,
      signature: result.signature,
      outcome: finalOutcome,
      volumeCompleted: finalVolumeAtEndTime,
      holdDurationCompleted: finalHoldDurationAtEndTime,
      traderAddress: dealAccount.trader.toBase58(),
      creatorAddress: dealAccount.creator.toBase58(),
    });
  } catch (error) {
    console.error("[FINALIZE] Unexpected error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
