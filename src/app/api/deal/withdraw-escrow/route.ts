import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import { sendTransactionWithRetry as sendTxWithRetry } from "@/utils/sendTransactionWithRetry";
import { getProgram } from "@/program/instructions/createDeal";
import { buildWithdrawFromEscrowInstruction } from "@/program/instructions/withdrawFromEscrow";
import { prisma } from "@/lib/prisma";
import bs58 from "bs58";

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000;

interface WithdrawEscrowRequest {
  dealPubkey: string;
}

function getAdminKeypair(): Keypair | null {
  const privateKey = process.env.ADMIN_PRIVATE_KEY;
  if (!privateKey) {
    console.error("[WITHDRAW-ESCROW] ADMIN_PRIVATE_KEY not set in environment");
    return null;
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch (error) {
    console.error("[WITHDRAW-ESCROW] Failed to decode ADMIN_PRIVATE_KEY:", error);
    return null;
  }
}

const PROGRAM_ERROR_MAP: Record<number, string> = {
  6003: "Deal is not active",
  6020: "Unauthorized admin - wrong keypair configured",
  6021: "Cannot withdraw before bounty expiration period ends",
};

async function sendWithdrawTxWithRetry(
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

      const result = await sendTxWithRetry(connection, transaction, lastValidBlockHeight);

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
 * POST /api/deal/withdraw-escrow
 *
 * ADMIN-ONLY: Emergency withdrawal of stuck funds from escrow.
 * Requires ADMIN_PRIVATE_KEY env var matching the hardcoded ADMIN pubkey in the program.
 * The program enforces that withdrawals can only happen after the deal's expiration window.
 */
export async function POST(request: NextRequest) {
  try {
    const body: WithdrawEscrowRequest = await request.json();
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

    const adminKeypair = getAdminKeypair();
    if (!adminKeypair) {
      return NextResponse.json(
        { success: false, error: "Server not configured (missing admin key)" },
        { status: 500 }
      );
    }

    console.log(`[WITHDRAW-ESCROW] Starting withdrawal for deal: ${dealPubkey}`);
    console.log(`[WITHDRAW-ESCROW] Admin wallet: ${adminKeypair.publicKey.toBase58()}`);

    const connection = new Connection(process.env.HELIUS_DEVNET_URL!, "confirmed");
    const program = getProgram(connection);

    let dealAccount;
    try {
      dealAccount = await program.account.deal.fetch(dealPubkeyObj);
    } catch (error) {
      console.error("[WITHDRAW-ESCROW] Failed to fetch deal account:", error);
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

    const { instruction } = await buildWithdrawFromEscrowInstruction(
      connection,
      adminKeypair.publicKey,
      dealPubkeyObj,
      {
        dealId: dealAccount.dealId,
        creator: dealAccount.creator,
        escrowVault: dealAccount.escrowVault,
      }
    );

    const transaction = new Transaction().add(instruction);

    console.log("[WITHDRAW-ESCROW] Sending transaction...");
    const result = await sendWithdrawTxWithRetry(connection, transaction, [adminKeypair]);

    if (!result.success) {
      console.error("[WITHDRAW-ESCROW] Transaction failed:", result.error);
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    console.log(`[WITHDRAW-ESCROW] Transaction confirmed: ${result.signature}`);

    await prisma.deal.update({
      where: { publicKey: dealPubkey },
      data: {
        isActive: false,
        finalizedAt: new Date(),
      },
    });

    console.log(`[WITHDRAW-ESCROW] Deal ${dealPubkey} funds withdrawn successfully`);

    return NextResponse.json({
      success: true,
      signature: result.signature,
      creatorAddress: dealAccount.creator.toBase58(),
    });
  } catch (error) {
    console.error("[WITHDRAW-ESCROW] Unexpected error:", error);
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
