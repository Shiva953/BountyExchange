import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";
import { prisma } from "@/lib/prisma";
import { calculateTokenVolumeFast } from "@/utils/calculateTokenVolume";

/**
 * Syncs all accepted deals for a trader from on-chain to the database.
 * This is useful for:
 * 1. Backfilling deals that were accepted before the DB sync was implemented
 * 2. Manual sync for testing
 * 3. Recovery from any sync issues
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { traderAddress } = body;

    if (!traderAddress) {
      return NextResponse.json(
        { error: "Missing traderAddress" },
        { status: 400 }
      );
    }

    let traderPubkey: PublicKey;
    try {
      traderPubkey = new PublicKey(traderAddress);
    } catch {
      return NextResponse.json(
        { error: "Invalid trader address" },
        { status: 400 }
      );
    }

    console.log(`[SYNC] Starting sync for trader: ${traderAddress}`);

    const connection = new Connection(
      process.env.HELIUS_DEVNET_URL!
    );
    const program = getProgram(connection);

    // Fetch all deals where the trader field matches
    const allDeals = await program.account.deal.all([
      {
        memcmp: {
          offset: 80, // trader field offset
          bytes: traderPubkey.toBase58(),
        },
      },
    ]);

    console.log(`[SYNC] Found ${allDeals.length} total deals on-chain`);

    // Filter for accepted deals only
    const acceptedDeals = allDeals.filter((deal) => deal.account.isAccepted);
    console.log(`[SYNC] Found ${acceptedDeals.length} accepted deals`);

    if (acceptedDeals.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No accepted deals found for this trader",
        synced: 0,
      });
    }

    // Ensure trader exists in DB
    let trader = await prisma.trader.findUnique({
      where: { address: traderAddress },
    });

    if (!trader) {
      trader = await prisma.trader.create({
        data: { address: traderAddress },
      });
      console.log(`[SYNC] Created new trader in DB`);
    }

    const now = new Date();
    let syncedCount = 0;
    let totalVolumeCompleted = 0;
    let activeBounties = 0;

    // Sync each deal
    for (const deal of acceptedDeals) {
      const dealPubkey = deal.publicKey.toBase58();
      const dealAccount = deal.account;

      try {
        // Calculate when the deal expires
        // For deals that were already accepted, we need to estimate acceptedAt
        // Use createdAt + some buffer, or just use now for active deals
        const createdAt = new Date(Number(dealAccount.createdAt) * 1000);

        // Check if deal already exists in DB
        const existingDeal = await prisma.deal.findUnique({
          where: { publicKey: dealPubkey },
        });

        // Use existing acceptedAt if available, otherwise estimate
        const acceptedAt = existingDeal?.acceptedAt || createdAt;
        const expiresAt = new Date(
          acceptedAt.getTime() +
            Number(dealAccount.expirationWindowInHours) * 60 * 60 * 1000
        );

        // Calculate volume for this deal
        const startTime = Math.floor(acceptedAt.getTime() / 1000);
        const minBuyVolumeUSD = dealAccount.minBuyVolume
          ? Number(dealAccount.minBuyVolume) / 10 ** 9
          : undefined;

        let volumeCompleted = 0;

        // Only calculate volume for active deals
        if (dealAccount.isActive) {
          try {
            const volumeResult = await calculateTokenVolumeFast(
              traderAddress,
              dealAccount.token.toBase58(),
              startTime,
              undefined,
              minBuyVolumeUSD
            );

            if (volumeResult.success) {
              volumeCompleted = volumeResult.volumeUSD;
            }
          } catch (error) {
            console.error(`[SYNC] Error calculating volume for deal ${dealPubkey}:`, error);
          }

          activeBounties++;
        }

        // Determine outcome for completed deals
        let outcome: string | null = null;
        if (!dealAccount.isActive) {
          const targetVolumeUSD = Number(dealAccount.targetVolume) / 10 ** 9;
          // For completed deals, assume they met the target if marked as not active
          // In a real scenario, you'd check the actual volume at finalization
          outcome = existingDeal?.outcome || null;
        }

        // Upsert deal to DB
        await prisma.deal.upsert({
          where: { publicKey: dealPubkey },
          create: {
            publicKey: dealPubkey,
            dealId: dealAccount.dealId.toString(),
            creator: dealAccount.creator.toBase58(),
            token: dealAccount.token.toBase58(),
            traderId: trader.id,
            traderAddress: traderAddress,
            rewardAmount: Number(dealAccount.rewardAmount),
            targetVolume: Number(dealAccount.targetVolume),
            minBuyVolume: dealAccount.minBuyVolume
              ? Number(dealAccount.minBuyVolume)
              : null,
            expirationHours: Number(dealAccount.expirationWindowInHours),
            holdDurationHours: Number(dealAccount.holdDurationInHours),
            escrowVault: dealAccount.escrowVault.toBase58(),
            createdAt: createdAt,
            acceptedAt: acceptedAt,
            expiresAt: expiresAt,
            isActive: dealAccount.isActive,
            isAccepted: true,
            volumeCompleted: volumeCompleted,
            outcome: outcome,
          },
          update: {
            isActive: dealAccount.isActive,
            isAccepted: true,
            volumeCompleted: volumeCompleted,
          },
        });

        // Add to total volume
        if (dealAccount.isActive) {
          totalVolumeCompleted += volumeCompleted;
        } else {
          // For completed deals, add target volume (they completed)
          const targetVolumeUSD = Number(dealAccount.targetVolume) / 10 ** 9;
          totalVolumeCompleted += existingDeal?.volumeCompleted
            ? Number(existingDeal.volumeCompleted)
            : targetVolumeUSD;
        }

        syncedCount++;
        console.log(`[SYNC] Synced deal ${dealPubkey.slice(0, 8)}... volume: $${volumeCompleted.toFixed(2)}`);

        // Helius Dev plan: 50 req/s - reduced delay
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (error) {
        console.error(`[SYNC] Error syncing deal ${dealPubkey}:`, error);
      }
    }

    // Update trader stats
    await prisma.trader.update({
      where: { id: trader.id },
      data: {
        volumeCompleted: totalVolumeCompleted,
        activeBounties: activeBounties,
      },
    });

    console.log(`[SYNC] Updated trader stats: volume=$${totalVolumeCompleted.toFixed(2)}, active=${activeBounties}`);

    return NextResponse.json({
      success: true,
      message: `Synced ${syncedCount} deals for trader`,
      synced: syncedCount,
      totalDealsOnChain: acceptedDeals.length,
      volumeCompleted: totalVolumeCompleted,
      activeBounties: activeBounties,
    });
  } catch (error) {
    console.error("[SYNC] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to sync trader deals",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
