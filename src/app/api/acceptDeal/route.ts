import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";
import {
  buildAcceptDealInstruction,
  logAcceptDealDetails,
} from "@/program/instructions/acceptDeal";
import { createApiError, withRetry } from "@/lib/errors";

interface AcceptDealRequestBody {
  trader: string;
  dealPubkey: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: AcceptDealRequestBody = await request.json();

    if (!body.trader || !body.dealPubkey) {
      return NextResponse.json(
        { error: "Missing required fields: trader and dealPubkey" },
        { status: 400 }
      );
    }

    let traderPubkey: PublicKey;
    let dealPubkey: PublicKey;

    try {
      traderPubkey = new PublicKey(body.trader);
      dealPubkey = new PublicKey(body.dealPubkey);
    } catch {
      return NextResponse.json(
        { error: "Invalid public key format" },
        { status: 400 }
      );
    }

    const connection = new Connection(process.env.HELIUS_DEVNET_URL!, "confirmed");
    const program = getProgram(connection);

    // Retry RPC calls with exponential backoff
    const dealAccount = await withRetry(
      () => program.account.deal.fetch(dealPubkey),
      { maxRetries: 3, initialDelay: 500 }
    );

    if (!dealAccount.isActive) {
      return NextResponse.json(
        { error: "Deal is not active" },
        { status: 400 }
      );
    }

    if (dealAccount.isAccepted) {
      return NextResponse.json(
        { error: "Deal has already been accepted" },
        { status: 400 }
      );
    }

    if (!dealAccount.trader.equals(traderPubkey)) {
      return NextResponse.json(
        { error: "You are not the intended trader for this deal" },
        { status: 403 }
      );
    }

    const { instruction } = await withRetry(
      () => buildAcceptDealInstruction(connection, traderPubkey, dealPubkey),
      { maxRetries: 3, initialDelay: 500 }
    );

    logAcceptDealDetails(traderPubkey, dealPubkey);

    const { blockhash, lastValidBlockHeight } = await withRetry(
      () => connection.getLatestBlockhash("confirmed"),
      { maxRetries: 3, initialDelay: 500 }
    );

    const transaction = new Transaction();
    transaction.add(instruction);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = traderPubkey;

    const serializedTransaction = transaction
      .serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      })
      .toString("base64");

    // Frontend calls /api/confirmDealAccepted after tx confirms to sync to DB

    return NextResponse.json({
      success: true,
      transaction: serializedTransaction,
      dealPubkey: dealPubkey.toBase58(),
      blockhash,
      lastValidBlockHeight,
    });
  } catch (error) {
    console.error("Error accepting deal:", error);
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
