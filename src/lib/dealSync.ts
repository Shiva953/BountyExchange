/**
 * Deal Sync Helpers
 *
 * Functions to sync deal state between on-chain and database.
 * Only ACCEPTED deals are stored in the database.
 */

import { prisma } from "./prisma";
import { Connection, PublicKey } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";
import { registerTraderForWebhook } from "./helius-webhooks";
import { cacheDealForWallet } from "./volume-cache";

/**
 * Syncs an accepted deal from on-chain to database.
 * Called when a trader accepts a deal - fetches full deal data from chain.
 */
export async function syncDealAccepted(dealPubkey: string) {
  console.log("[DEAL SYNC] Syncing accepted deal from on-chain:", dealPubkey);

  try {
    const connection = new Connection(
      process.env.HELIUS_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL!
    );
    const program = getProgram(connection);

    // Fetch deal from on-chain
    const dealPubkeyObj = new PublicKey(dealPubkey);
    const dealAccount = await program.account.deal.fetch(dealPubkeyObj);

    if (!dealAccount.isAccepted) {
      console.log("[DEAL SYNC] Deal not yet accepted on-chain, skipping");
      return null;
    }

    const traderAddress = dealAccount.trader.toBase58();

    let trader = await prisma.trader.findUnique({
      where: { address: traderAddress },
    });

    if (!trader) {
      trader = await prisma.trader.create({
        data: { address: traderAddress },
      });
      console.log("[DEAL SYNC] Created new trader:", traderAddress);
    }

    const now = new Date();
    const createdAt = new Date(Number(dealAccount.createdAt) * 1000);
    const expiresAt = new Date(
      now.getTime() + Number(dealAccount.expirationWindowInHours) * 60 * 60 * 1000
    );

    // pushing the accepted deal to the db
    const deal = await prisma.deal.upsert({
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
        acceptedAt: now,
        expiresAt: expiresAt,
        isActive: true,
        isAccepted: true,
      },
      update: {
        isAccepted: true,
        acceptedAt: now,
        expiresAt: expiresAt,
      },
    });

    // Update trader's active bounties count
    await updateTraderActiveBounties(trader.id);

    // Register trader with Helius webhook for real-time swap tracking
    try {
      await registerTraderForWebhook(traderAddress);
      console.log("[DEAL SYNC] Registered trader with Helius webhook");
    } catch (webhookError) {
      console.error("[DEAL SYNC] Failed to register trader with webhook:", webhookError);
    }

    // Cache deal for webhook lookup
    try {
      await cacheDealForWallet(
        traderAddress,
        dealAccount.token.toBase58(),
        dealPubkey,
        Math.floor(now.getTime() / 1000),
        expiresAt.getTime()
      );
      console.log("[DEAL SYNC] Cached deal for webhook processing");
    } catch (cacheError) {
      console.error("[DEAL SYNC] Failed to cache deal:", cacheError);
    }

    console.log("[DEAL SYNC] Deal synced, expires at:", expiresAt);
    return deal;
  } catch (error) {
    console.error("[DEAL SYNC] Error syncing accepted deal:", error);
    throw error;
  }
}

/**
 * Updates a deal record when it's finalized (won or lost)
 */
export async function syncDealFinalized(
  dealPubkey: string,
  volumeAtEnd: number,
  won: boolean
) {
  console.log("[DEAL SYNC] Syncing finalized deal:", dealPubkey);

  try {
    const deal = await prisma.deal.findUnique({
      where: { publicKey: dealPubkey },
    });

    if (!deal) {
      console.error("[DEAL SYNC] Deal not found for finalization:", dealPubkey);
      return;
    }

    const updatedDeal = await prisma.deal.update({
      where: { id: deal.id },
      data: {
        isActive: false,
        finalizedAt: new Date(),
        volumeCompleted: volumeAtEnd,
        outcome: won ? "won" : "lost",
      },
    });

    // Update trader stats
    await updateTraderStats(deal.traderId);

    console.log("[DEAL SYNC] Deal finalized:", won ? "WON" : "LOST");
    return updatedDeal;
  } catch (error) {
    console.error("[DEAL SYNC] Error syncing finalized deal:", error);
    throw error;
  }
}

/**
 * Deletes finalized deals that are older than the specified hours.
 * Called by cron job to clean up old deals.
 */
export async function cleanupFinalizedDeals(olderThanHours: number = 24) {
  console.log(`[DEAL SYNC] Cleaning up deals finalized more than ${olderThanHours}h ago`);

  try {
    const cutoffDate = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

    const result = await prisma.deal.deleteMany({
      where: {
        isActive: false,
        finalizedAt: {
          lte: cutoffDate,
        },
        // Don't delete expired_unfulfilled deals - they still have funds stuck on-chain
        // and need admin reclaim before cleanup
        outcome: {
          not: "expired_unfulfilled",
        },
      },
    });

    console.log(`[DEAL SYNC] Deleted ${result.count} old finalized deals`);
    return result.count;
  } catch (error) {
    console.error("[DEAL SYNC] Error cleaning up deals:", error);
    throw error;
  }
}

/**
 * Updates a trader's active bounties count
 */
async function updateTraderActiveBounties(traderId: number) {
  const activeCount = await prisma.deal.count({
    where: {
      traderId: traderId,
      isActive: true,
      isAccepted: true,
    },
  });

  await prisma.trader.update({
    where: { id: traderId },
    data: { activeBounties: activeCount },
  });
}

/**
 * Updates all trader stats from their deals
 */
export async function updateTraderStats(traderId: number) {
  const deals = await prisma.deal.findMany({
    where: {
      traderId: traderId,
      isAccepted: true,
    },
  });

  const completedDeals = deals.filter((d) => !d.isActive);
  const activeDeals = deals.filter((d) => d.isActive);

  // Calculate total volume
  const volumeFromCompleted = completedDeals.reduce((sum, deal) => {
    if (deal.outcome === "won") {
      return sum + Number(deal.targetVolume) / 10 ** 9;
    }
    return sum + Number(deal.volumeCompleted || 0);
  }, 0);

  const volumeFromActive = activeDeals.reduce((sum, deal) => {
    return sum + Number(deal.volumeCompleted || 0);
  }, 0);

  await prisma.trader.update({
    where: { id: traderId },
    data: {
      volumeCompleted: volumeFromCompleted + volumeFromActive,
      activeBounties: activeDeals.length,
    },
  });
}
