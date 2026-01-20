import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  buildCreateDealInstruction,
  logDealDetails,
  CreateDealArgs,
  USDC_MINT,
} from "@/program/instructions/createDeal";

// Helius devnet RPC endpoint
const HELIUS_RPC_URL = "https://devnet.helius-rpc.com/?api-key=017f56ed-c6c1-480a-8c11-dbc09ab2358d";

/**
 * Generates a unique deal ID using timestamp (ms) in high bits + random in low bits
 * This creates a u64 that is unique per millisecond with additional randomness
 */
function generateDealId(): BN {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 0xFFFF); // 16 bits of randomness
  // Shift timestamp left by 16 bits and add random to lower bits
  // This gives us: [48 bits timestamp][16 bits random] = unique u64
  const highBits = new BN(timestamp).shln(16);
  return highBits.or(new BN(random));
}

interface CreateDealRequestBody {
  payer: string;
  token: string;
  trader: string;
  rewardAmount: string; // In USDC decimals (6)
  targetVolume: string;
  expirationWindowInHours: string;
  holdDurationInHours: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: CreateDealRequestBody = await request.json();

    console.log("=== API: Create Deal Request ===");
    console.log("Request body:", JSON.stringify(body, null, 2));

    // Validate required fields
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
        console.error(`Missing required field: ${field}`);
        return NextResponse.json(
          { error: `Missing required field: ${field}` },
          { status: 400 }
        );
      }
    }

    // Parse public keys
    let payerPubkey: PublicKey;
    let tokenPubkey: PublicKey;
    let traderPubkey: PublicKey;

    try {
      payerPubkey = new PublicKey(body.payer);
      tokenPubkey = new PublicKey(body.token);
      traderPubkey = new PublicKey(body.trader);
    } catch (e) {
      console.error("Invalid public key:", e);
      return NextResponse.json(
        { error: "Invalid public key format" },
        { status: 400 }
      );
    }

    // Generate a unique deal ID
    const dealId = generateDealId();

    // Parse amounts - devnet USDC mint has 9 decimals
    // Frontend sends dollar amounts, so we multiply by 1e9
    const USDC_DECIMALS = 9;
    const rewardAmountRaw = parseFloat(body.rewardAmount);
    const targetVolumeRaw = parseFloat(body.targetVolume);

    if (isNaN(rewardAmountRaw) || isNaN(targetVolumeRaw)) {
      return NextResponse.json(
        { error: "Invalid amount format" },
        { status: 400 }
      );
    }

    // Convert to atomic units (devnet USDC has 9 decimals)
    const rewardAmount = new BN(Math.floor(rewardAmountRaw * 10 ** USDC_DECIMALS));
    const targetVolume = new BN(Math.floor(targetVolumeRaw * 10 ** USDC_DECIMALS));
    const expirationWindowInHours = new BN(body.expirationWindowInHours);
    const holdDurationInHours = new BN(body.holdDurationInHours);

    const args: CreateDealArgs = {
      dealId,
      token: tokenPubkey,
      trader: traderPubkey,
      rewardAmount,
      targetVolume,
      expirationWindowInHours,
      holdDurationInHours,
    };

    // Create connection to devnet
    const connection = new Connection(HELIUS_RPC_URL, "confirmed");

    // Build the instruction using Anchor program.methods
    const { instruction, dealPDA, escrowVault } = await buildCreateDealInstruction(
      connection,
      payerPubkey,
      args,
      USDC_MINT
    );

    // Log details for debugging
    logDealDetails(payerPubkey, args, dealPDA, escrowVault);

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    console.log("Blockhash:", blockhash);
    console.log("Last valid block height:", lastValidBlockHeight);

    // Build the transaction
    const transaction = new Transaction();
    transaction.add(instruction);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = payerPubkey;

    // Serialize the transaction for client signing
    const serializedTransaction = transaction
      .serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      })
      .toString("base64");

    console.log("Transaction serialized successfully");
    console.log("Serialized length:", serializedTransaction.length);

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
    console.error("=== API Error ===");
    console.error(error);
    return NextResponse.json(
      {
        error: "Failed to build transaction",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
