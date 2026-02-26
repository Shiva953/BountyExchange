import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { prisma } from "@/lib/prisma";

/**
 * Called by the frontend AFTER a deal creation transaction is confirmed on-chain.
 * This ensures the creator exists in the database.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { creatorAddress } = body;

    if (!creatorAddress) {
      return NextResponse.json(
        { error: "Missing creatorAddress" },
        { status: 400 }
      );
    }

    // Validate address format
    try {
      new PublicKey(creatorAddress);
    } catch {
      return NextResponse.json(
        { error: "Invalid creator address" },
        { status: 400 }
      );
    }

    // Ensure creator exists in DB (lazy user creation)
    const trader = await prisma.trader.upsert({
      where: { address: creatorAddress },
      create: { address: creatorAddress },
      update: {},
    });

    console.log(`[CONFIRM] Creator confirmed: ${creatorAddress}`);

    return NextResponse.json({
      success: true,
      trader: {
        id: trader.id,
        address: trader.address,
      },
    });
  } catch (error) {
    console.error("[CONFIRM] Error confirming deal creator:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to confirm deal creator",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
