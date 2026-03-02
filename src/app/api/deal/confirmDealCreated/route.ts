import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { prisma } from "@/lib/prisma";
import { sendNewBountyNotification } from "@/lib/notifications";

/**
 * Called by the frontend AFTER a deal creation transaction is confirmed on-chain.
 * This ensures the creator exists in the database and immediately notifies the
 * targeted trader via Telegram (event-driven, no polling delay).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      creatorAddress,
      dealPubkey,
      traderAddress,
      token,
      targetVolume,
      rewardAmount,
      expirationWindowInHours,
    } = body;

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

    // If deal details are provided, immediately notify the targeted trader.
    // This eliminates the ~3-minute cron polling delay.
    if (dealPubkey && traderAddress && token && targetVolume != null && rewardAmount != null && expirationWindowInHours != null) {
      const expiresAt = new Date(Date.now() + Number(expirationWindowInHours) * 60 * 60 * 1000);

      sendNewBountyNotification(traderAddress, {
        dealPubkey,
        token,
        targetVolume: Number(targetVolume),
        rewardAmount: Number(rewardAmount),
        expiresAt,
        creatorAddress,
      }).catch((err) =>
        console.error("[CONFIRM] Failed to send new bounty notification:", err)
      );

      console.log(`[CONFIRM] Triggered immediate bounty notification for trader ${traderAddress} on deal ${dealPubkey}`);
    }

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
