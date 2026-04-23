import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import { sendTransactionWithRetry as sendTxWithRetry } from "@/utils/sendTransactionWithRetry";
import { getProgram } from "@/program/instructions/createDeal";
import { buildCancelExpiredDealInstruction } from "@/program/instructions/cancelExpiredDeal";
import { prisma } from "@/lib/prisma";
import bs58 from "bs58";

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000;

interface CancelExpiredDealRequest {
  dealPubkey: string;
}

function getCrankKeypair(): Keypair | null {
  const privateKey = process.env.CRANK_PRIVATE_KEY;
  if (!privateKey) {
    console.error("[CANCEL-EXPIRED] CRANK_PRIVATE_KEY not set in environment");
    return null;
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch (error) {
    console.error("[CANCEL-EXPIRED] Failed to decode CRANK_PRIVATE_KEY:", error);
    return null;
  }
}

const PROGRAM_ERROR_MAP: Record<number, string> = {
  6003: "Deal is not active - may already be cancelled",
  6004: "Deal has already been accepted - use finalizeDeal instead",
  6024: "Deal has not expired yet",
};

async function sendCancelTxWithRetry(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
  maxRetries: number = MAX_RETRIES
): Promise<{ signature: string; success: boolean; error?: string }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;

      transaction.sign(...signers);

      const result = await sendTxWithRetry(
        connection,
        transaction,
        lastValidBlockHeight
      );

      if (result.success) {
        return { signature: result.signature, success: true };
      }

      const programError = result.errorCode
        ? PROGRAM_ERROR_MAP[result.errorCode]
        : undefined;

      if (programError) {
        return { signature: result.signature, success: false, error: programError };
      }

      return {
        signature: result.signature,
        success: false,
        error: `Transaction failed with error code: ${result.errorCode}`,
      };
    } catch (error) {
      lastError = error as Error;

      const isBlockhashExpired =
        (error as Error).message?.includes("Transaction did not land") ||
        (error as Error).message?.includes("block height exceeded") ||
        (error as Error).message?.includes("Blockhash not found");

      if (isBlockhashExpired && attempt < maxRetries) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[CANCEL-EXPIRED] Tx didn't land on attempt ${attempt}/${maxRetries}, retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

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
 * POST /api/deal/cancel-expired
 *
 * Cancels an expired unaccepted deal on-chain, refunding the escrow to the creator.
 * The instruction is permissionless — the crank keypair just pays gas.
 * Called by the cron job for deals that expired without a trader accepting.
 */
export async function POST(request: NextRequest) {
  try {
    const body: CancelExpiredDealRequest = await request.json();
    const { dealPubkey } = body;

    if (!dealPubkey) {
      return NextResponse.json(
        { success: false, error: "Missing dealPubkey" },
        { status: 400 }
      );
    }

    let dealPubkeyObj: PublicKey;
    try {
      dealPubkeyObj = new PublicKey(dealPubkey);
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid deal pubkey" },
        { status: 400 }
      );
    }

    const crankKeypair = getCrankKeypair();
    if (!crankKeypair) {
      return NextResponse.json(
        { success: false, error: "Server not configured (missing crank key)" },
        { status: 500 }
      );
    }

    console.log(`[CANCEL-EXPIRED] Starting cancellation for deal: ${dealPubkey}`);

    const connection = new Connection(process.env.HELIUS_DEVNET_URL!, "confirmed");
    const program = getProgram(connection);

    let dealAccount;
    try {
      dealAccount = await program.account.deal.fetch(dealPubkeyObj);
    } catch (error) {
      console.error("[CANCEL-EXPIRED] Failed to fetch deal account:", error);
      return NextResponse.json(
        { success: false, error: "Deal not found on-chain" },
        { status: 404 }
      );
    }

    if (!dealAccount.isActive) {
      return NextResponse.json(
        { success: false, error: "Deal is not active" },
        { status: 400 }
      );
    }

    if (dealAccount.isAccepted) {
      return NextResponse.json(
        { success: false, error: "Deal has been accepted - use finalizeDeal instead" },
        { status: 400 }
      );
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAtSec =
      dealAccount.createdAt.toNumber() +
      dealAccount.expirationWindowInHours.toNumber() * 3600;

    if (nowSec < expiresAtSec) {
      return NextResponse.json(
        { success: false, error: "Deal has not expired yet" },
        { status: 400 }
      );
    }

    const { instruction } = await buildCancelExpiredDealInstruction(
      connection,
      crankKeypair.publicKey,
      dealPubkeyObj,
      {
        dealId: dealAccount.dealId,
        creator: dealAccount.creator,
        escrowVault: dealAccount.escrowVault,
      }
    );

    const transaction = new Transaction().add(instruction);

    console.log("[CANCEL-EXPIRED] Sending transaction...");
    const result = await sendCancelTxWithRetry(connection, transaction, [crankKeypair]);

    if (!result.success) {
      console.error("[CANCEL-EXPIRED] Transaction failed:", result.error);
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    console.log(`[CANCEL-EXPIRED] Transaction confirmed: ${result.signature}`);

    await prisma.deal.update({
      where: { publicKey: dealPubkey },
      data: {
        isActive: false,
        finalizedAt: new Date(),
        outcome: "expired_unfulfilled",
      },
    });

    console.log(`[CANCEL-EXPIRED] Deal ${dealPubkey} cancelled successfully`);

    return NextResponse.json({
      success: true,
      signature: result.signature,
      creatorAddress: dealAccount.creator.toBase58(),
    });
  } catch (error) {
    console.error("[CANCEL-EXPIRED] Unexpected error:", error);
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
