import cron from "node-cron";
import { prisma } from "./prisma";
import { calculateTokenVolumeFast } from "@/utils/calculateTokenVolume";
import { cleanupFinalizedDeals } from "./dealSync";

const FINALIZE_CHECK_INTERVAL = "* * * * *"; // Every minute
const TRADER_STATS_INTERVAL = "*/2 * * * *"; // Every 2 minutes - calculates volumes + aggregates
const CLEANUP_INTERVAL = "0 * * * *"; // Every hour

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;

let isInitialized = false;

// Locks to prevent overlapping cron executions
let isTraderStatsSyncRunning = false;
let isExpiredDealsCheckRunning = false;

/**
 * Retry helper with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  maxRetries = MAX_RETRIES
): Promise<T | null> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(
          `[CRON] ${context} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.error(
    `[CRON] ${context} failed after ${maxRetries} attempts:`,
    lastError
  );
  return null;
}

/**
 * Syncs volume progress for all active accepted deals
 */
export async function syncDealVolumes() {
  console.log("[CRON] Starting deal volume sync...");

  try {
    const activeDeals = await prisma.deal.findMany({
      where: {
        isActive: true,
        isAccepted: true,
      },
      include: {
        trader: true,
      },
    });

    console.log(`[CRON] Found ${activeDeals.length} active deals to sync`);

    for (const deal of activeDeals) {
      // Calculate volume from deal acceptance time
      const startTime = deal.acceptedAt
        ? Math.floor(deal.acceptedAt.getTime() / 1000)
        : undefined;

      const minBuyVolumeUSD = deal.minBuyVolume
        ? Number(deal.minBuyVolume) / 10 ** 9
        : undefined;

      const volumeResult = await withRetry(
        async () => {
          const result = await calculateTokenVolumeFast(
            deal.traderAddress,
            deal.token,
            startTime,
            undefined, // endTime - now
            minBuyVolumeUSD
          );
          if (!result.success) {
            throw new Error(result.error || "Volume calculation failed");
          }
          return result;
        },
        `Volume sync for deal ${deal.publicKey.slice(0, 8)}...`
      );

      if (volumeResult) {
        try {
          await prisma.deal.update({
            where: { id: deal.id },
            data: {
              volumeCompleted: volumeResult.volumeUSD,
            },
          });

          console.log(
            `[CRON] Updated deal ${deal.publicKey.slice(0, 8)}...: volume = $${volumeResult.volumeUSD.toFixed(2)}`
          );
        } catch (error) {
          console.error(
            `[CRON] Error updating deal ${deal.publicKey} in DB:`,
            error
          );
        }
      }

      // Small delay between deals to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    console.log("[CRON] Deal volume sync complete");
  } catch (error) {
    console.error("[CRON] Error in syncDealVolumes:", error);
  }
}

/**
 * Checks for expired deals and marks them as won/lost
 */
export async function checkExpiredDeals() {
  if (isExpiredDealsCheckRunning) {
    console.log("[CRON] Expired deals check already running, skipping...");
    return;
  }

  isExpiredDealsCheckRunning = true;
  console.log("[CRON] Checking for expired deals...");

  try {
    const now = new Date();

    // Find deals that have expired but are still marked as active
    const expiredDeals = await prisma.deal.findMany({
      where: {
        isActive: true,
        isAccepted: true,
        expiresAt: {
          lte: now,
        },
      },
      include: {
        trader: true,
      },
    });

    console.log(`[CRON] Found ${expiredDeals.length} expired deals`);

    for (const deal of expiredDeals) {
      try {
        const targetVolumeUSD = Number(deal.targetVolume) / 10 ** 9;
        const volumeCompleted = Number(deal.volumeCompleted || 0);
        const won = volumeCompleted >= targetVolumeUSD;

        // Update deal state
        await prisma.deal.update({
          where: { id: deal.id },
          data: {
            isActive: false,
            finalizedAt: now,
            outcome: won ? "won" : "lost",
          },
        });

        console.log(
          `[CRON] Deal ${deal.publicKey.slice(0, 8)}... expired - Outcome: ${won ? "WON" : "LOST"} (${volumeCompleted.toFixed(2)}/${targetVolumeUSD.toFixed(2)} USD)`
        );

        // TODO: Trigger Telegram notification here
        // await sendTelegramNotification(deal.trader, deal, won);

        // TODO: Call finalizeDeal on-chain if needed
        // This would require a server-side keypair to sign the transaction
      } catch (error) {
        console.error(
          `[CRON] Error processing expired deal ${deal.publicKey}:`,
          error
        );
      }
    }

    console.log("[CRON] Expired deal check complete");
  } catch (error) {
    console.error("[CRON] Error in checkExpiredDeals:", error);
  } finally {
    isExpiredDealsCheckRunning = false;
  }
}

/**
 * Syncs trader stats by calculating volume for each deal using calculateTokenVolumeFast.
 * This is the main comprehensive sync function that:
 * 1. For each trader, fetches their accepted deals
 * 2. For each ACTIVE deal, calculates fresh volume using calculateTokenVolumeFast
 * 3. Updates the deal's volumeCompleted in DB
 * 4. For COMPLETED deals, uses the stored volumeCompleted (was calculated when active)
 * 5. Aggregates and updates trader's volumeCompleted and activeBounties
 */
export async function syncTraderStats() {
  if (isTraderStatsSyncRunning) {
    console.log("[CRON] Trader stats sync already running, skipping...");
    return;
  }

  isTraderStatsSyncRunning = true;
  console.log("[CRON] Starting trader stats sync...");

  try {
    const traders = await prisma.trader.findMany();

    for (const trader of traders) {
      try {
        // Get all accepted deals for this trader
        const deals = await prisma.deal.findMany({
          where: {
            traderId: trader.id,
            isAccepted: true,
          },
        });

        const completedDeals = deals.filter((d) => !d.isActive);
        const activeDeals = deals.filter((d) => d.isActive);

        // Calculate volume for each ACTIVE deal using calculateTokenVolumeFast
        let volumeFromActive = 0;
        for (const deal of activeDeals) {
          const startTime = deal.acceptedAt
            ? Math.floor(deal.acceptedAt.getTime() / 1000)
            : undefined;

          const minBuyVolumeUSD = deal.minBuyVolume
            ? Number(deal.minBuyVolume) / 10 ** 9
            : undefined;

          const volumeResult = await withRetry(
            async () => {
              const result = await calculateTokenVolumeFast(
                deal.traderAddress,
                deal.token,
                startTime,
                undefined, // endTime - now
                minBuyVolumeUSD
              );
              if (!result.success) {
                throw new Error(result.error || "Volume calculation failed");
              }
              return result;
            },
            `Volume calc for deal ${deal.publicKey.slice(0, 8)}...`
          );

          if (volumeResult) {
            // Update deal's volumeCompleted in DB
            await prisma.deal.update({
              where: { id: deal.id },
              data: { volumeCompleted: volumeResult.volumeUSD },
            });

            volumeFromActive += volumeResult.volumeUSD;

            console.log(
              `[CRON] Deal ${deal.publicKey.slice(0, 8)}...: volume = $${volumeResult.volumeUSD.toFixed(2)}`
            );
          }

          // Small delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        // Sum volume from COMPLETED deals (use stored values)
        const volumeFromCompleted = completedDeals.reduce((sum, deal) => {
          // For won deals, they hit target. For lost deals, use tracked volume
          if (deal.outcome === "won") {
            return sum + Number(deal.targetVolume) / 10 ** 9;
          }
          return sum + Number(deal.volumeCompleted || 0);
        }, 0);

        const totalVolumeCompleted = volumeFromCompleted + volumeFromActive;
        const activeBounties = activeDeals.length;

        // Update trader stats
        await prisma.trader.update({
          where: { id: trader.id },
          data: {
            volumeCompleted: totalVolumeCompleted,
            activeBounties: activeBounties,
          },
        });

        console.log(
          `[CRON] Updated trader ${trader.name || trader.address.slice(0, 8)}...: volume=$${totalVolumeCompleted.toFixed(2)}, active=${activeBounties}`
        );
      } catch (error) {
        console.error(`[CRON] Error syncing trader ${trader.address}:`, error);
      }
    }

    console.log("[CRON] Trader stats sync complete");
  } catch (error) {
    console.error("[CRON] Error in syncTraderStats:", error);
  } finally {
    isTraderStatsSyncRunning = false;
  }
}

/**
 * Cleans up old finalized deals from the database
 */
export async function runCleanup() {
  console.log("[CRON] Starting cleanup of finalized deals...");
  try {
    // Delete deals finalized more than 24 hours ago
    const deletedCount = await cleanupFinalizedDeals(24);
    console.log(`[CRON] Cleanup complete, deleted ${deletedCount} deals`);
  } catch (error) {
    console.error("[CRON] Error in cleanup:", error);
  }
}

/**
 * Initialize all cron jobs
 */
export function initCronJobs() {
  if (isInitialized) {
    console.log("[CRON] Already initialized, skipping...");
    return;
  }

  console.log("[CRON] Initializing cron jobs...");

  // Expired deal check - every minute
  cron.schedule(FINALIZE_CHECK_INTERVAL, () => {
    checkExpiredDeals().catch(console.error);
  });
  console.log(`[CRON] Scheduled finalize check: ${FINALIZE_CHECK_INTERVAL}`);

  // Trader stats sync - every 2 minutes (calculates deal volumes + aggregates trader stats)
  cron.schedule(TRADER_STATS_INTERVAL, () => {
    syncTraderStats().catch(console.error);
  });
  console.log(`[CRON] Scheduled trader stats sync: ${TRADER_STATS_INTERVAL}`);

  // Cleanup old finalized deals - every hour
  cron.schedule(CLEANUP_INTERVAL, () => {
    runCleanup().catch(console.error);
  });
  console.log(`[CRON] Scheduled cleanup: ${CLEANUP_INTERVAL}`);

  isInitialized = true;
  console.log("[CRON] All cron jobs initialized successfully");
}
