import cron from "node-cron";
import { prisma } from "./prisma";
import { calculateTokenVolumeFast } from "@/utils/calculateTokenVolume";
import { cleanupFinalizedDeals } from "./dealSync";
import { sendDealNotification, sendSystemAlert } from "./telegram";

const FINALIZE_CHECK_INTERVAL = "* * * * *"; // Every minute
const TRADER_STATS_INTERVAL = "*/2 * * * *"; // Every 2 minutes - calculates volumes + aggregates
const CLEANUP_INTERVAL = "0 * * * *"; // Every hour

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;

// Finalization retry configuration
const FINALIZE_MAX_RETRIES = 5;
const FINALIZE_RETRY_DELAY_MS = 2000;

// Buffer time before expiration to attempt finalization (5 minutes)
const FINALIZATION_BUFFER_MS = 5 * 60 * 1000;

let isInitialized = false;

// Locks to prevent overlapping cron executions
let isTraderStatsSyncRunning = false;
let isFinalizationRunning = false;

// Track deals that are being finalized to avoid duplicate attempts
const pendingFinalizations = new Set<string>();

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
 * Calls the finalizeDeal API endpoint with retry logic
 */
async function callFinalizeDealAPI(
  dealPubkey: string,
  volumeAtEndTime: number,
  holdDurationAtEndTime: number
): Promise<{
  success: boolean;
  signature?: string;
  error?: string;
}> {
  for (let attempt = 1; attempt <= FINALIZE_MAX_RETRIES; attempt++) {
    try {
      const baseUrl =
        process.env.NEXT_PUBLIC_BASE_URL ||
        process.env.VERCEL_URL ||
        "http://localhost:3000";

      const response = await fetch(`${baseUrl}/api/finalizeDeal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealPubkey,
          volumeAtEndTime,
          holdDurationAtEndTime,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        return {
          success: true,
          signature: data.signature,
        };
      }

      // Check if error is retryable
      const isRetryable =
        response.status >= 500 ||
        data.error?.includes("blockhash") ||
        data.error?.includes("timeout");

      if (!isRetryable) {
        return {
          success: false,
          error: data.error || "Finalization failed",
        };
      }

      console.warn(
        `[CRON] Finalize API failed (attempt ${attempt}/${FINALIZE_MAX_RETRIES}): ${data.error}`
      );
    } catch (error) {
      console.error(
        `[CRON] Finalize API error (attempt ${attempt}/${FINALIZE_MAX_RETRIES}):`,
        error
      );
    }

    if (attempt < FINALIZE_MAX_RETRIES) {
      const delay = FINALIZE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return {
    success: false,
    error: `Failed after ${FINALIZE_MAX_RETRIES} attempts`,
  };
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
 * Checks for deals ready to finalize (met volume target, approaching expiration)
 * and deals that have expired (need to be marked as won/lost)
 */
export async function checkAndFinalizeDeals() {
  if (isFinalizationRunning) {
    console.log("[CRON] Finalization already running, skipping...");
    return;
  }

  isFinalizationRunning = true;
  console.log("[CRON] Checking deals for finalization...");

  try {
    const now = new Date();
    const bufferTime = new Date(now.getTime() + FINALIZATION_BUFFER_MS);

    // Find active deals that are either:
    // 1. About to expire (within buffer time) and have met volume target - FINALIZE
    // 2. Already expired - MARK AS LOST (can't finalize on-chain after expiration)
    const dealsToCheck = await prisma.deal.findMany({
      where: {
        isActive: true,
        isAccepted: true,
        expiresAt: {
          lte: bufferTime, // Either expired or about to expire
        },
      },
      include: {
        trader: true,
      },
    });

    console.log(`[CRON] Found ${dealsToCheck.length} deals to check for finalization`);

    for (const deal of dealsToCheck) {
      // Skip if already being processed
      if (pendingFinalizations.has(deal.publicKey)) {
        console.log(`[CRON] Skipping ${deal.publicKey.slice(0, 8)}... - already processing`);
        continue;
      }

      const targetVolumeUSD = Number(deal.targetVolume) / 10 ** 9;
      const volumeCompleted = Number(deal.volumeCompleted || 0);
      const rewardAmountUSD = Number(deal.rewardAmount) / 10 ** 9;
      const hasMetVolume = volumeCompleted >= targetVolumeUSD;
      const isExpired = deal.expiresAt && deal.expiresAt <= now;

      console.log(
        `[CRON] Deal ${deal.publicKey.slice(0, 8)}...: volume=${volumeCompleted.toFixed(2)}/${targetVolumeUSD.toFixed(2)}, expired=${isExpired}, metVolume=${hasMetVolume}`
      );

      try {
        pendingFinalizations.add(deal.publicKey);

        // the current hold duration check is non-existent, needs to be updated
        const holdDurationCompleted = Number(deal.holdDurationHours || 0);
        const requiredHoldDuration = Number(deal.holdDurationHours || 0);
        const hasMetHold = holdDurationCompleted >= requiredHoldDuration;
        const traderPassed = hasMetVolume && hasMetHold;

        if (traderPassed && !isExpired) {
          // Case 1: All requirements met, not yet expired - FINALIZE ON-CHAIN (trader wins)
          console.log(`[CRON] Attempting on-chain finalization for deal ${deal.publicKey.slice(0, 8)}... (PASS)`);

          const result = await callFinalizeDealAPI(
            deal.publicKey,
            volumeCompleted,
            holdDurationCompleted
          );

          if (result.success) {
            console.log(
              `[CRON] Deal ${deal.publicKey.slice(0, 8)}... finalized successfully! Signature: ${result.signature}`
            );

            await prisma.deal.update({
              where: { id: deal.id },
              data: {
                isActive: false,
                finalizedAt: now,
                outcome: "won",
                volumeCompleted: volumeCompleted,
              },
            });

            await updateTraderActiveBounties(deal.traderId);

            // Send Telegram notification
            await sendDealNotification({
              dealPubkey: deal.publicKey,
              traderAddress: deal.traderAddress,
              traderName: deal.trader?.name,
              rewardAmount: rewardAmountUSD,
              targetVolume: targetVolumeUSD,
              volumeCompleted: volumeCompleted,
              outcome: "won",
              signature: result.signature,
            });
          } else {
            console.error(
              `[CRON] Failed to finalize deal ${deal.publicKey.slice(0, 8)}...: ${result.error}`
            );

            // If it's close to expiration and we failed, send an alert
            const timeUntilExpiry = deal.expiresAt
              ? deal.expiresAt.getTime() - now.getTime()
              : 0;
            if (timeUntilExpiry < 60000) {
              // Less than 1 minute
              await sendSystemAlert(
                "Finalization Failed",
                `Deal ${deal.publicKey.slice(0, 8)}... failed to finalize: ${result.error}`,
                "error"
              );
            }
          }
        } else if (isExpired) {
          // Case 2: Deal has expired - FINALIZE ON-CHAIN (program determines outcome)
          // The program will route funds to trader (if passed) or creator (if failed)
          const expectedOutcome = traderPassed ? "won" : "lost";

          console.log(
            `[CRON] Deal ${deal.publicKey.slice(0, 8)}... expired - Expected outcome: ${expectedOutcome.toUpperCase()}`
          );
          console.log(
            `[CRON] Volume: ${volumeCompleted.toFixed(2)}/${targetVolumeUSD.toFixed(2)} (${hasMetVolume ? "MET" : "NOT MET"}), Hold: ${holdDurationCompleted}/${requiredHoldDuration}h (${hasMetHold ? "MET" : "NOT MET"})`
          );

          const result = await callFinalizeDealAPI(
            deal.publicKey,
            volumeCompleted,
            holdDurationCompleted
          );

          if (result.success) {
            console.log(
              `[CRON] Finalization successful for ${deal.publicKey.slice(0, 8)}... - Outcome: ${expectedOutcome.toUpperCase()}`
            );

            await prisma.deal.update({
              where: { id: deal.id },
              data: {
                isActive: false,
                finalizedAt: now,
                outcome: expectedOutcome,
                volumeCompleted: volumeCompleted,
              },
            });

            await updateTraderActiveBounties(deal.traderId);

            await sendDealNotification({
              dealPubkey: deal.publicKey,
              traderAddress: deal.traderAddress,
              traderName: deal.trader?.name,
              rewardAmount: rewardAmountUSD,
              targetVolume: targetVolumeUSD,
              volumeCompleted: volumeCompleted,
              outcome: expectedOutcome,
              signature: result.signature,
            });
          } else {
            console.error(
              `[CRON] Failed to finalize expired deal ${deal.publicKey.slice(0, 8)}...: ${result.error}`
            );

            // Mark as failed in DB only if on-chain finalization failed
            // This is a fallback - ideally all deals should be finalized on-chain
            await prisma.deal.update({
              where: { id: deal.id },
              data: {
                isActive: false,
                finalizedAt: now,
                outcome: expectedOutcome,
                volumeCompleted: volumeCompleted,
              },
            });

            await updateTraderActiveBounties(deal.traderId);

            // Send alert for failed finalization
            await sendSystemAlert(
              "Finalization Failed",
              `Expired deal ${deal.publicKey.slice(0, 8)}... failed to finalize on-chain: ${result.error}. Funds may be stuck in escrow.`,
              "error"
            );

            // Still send notification about the outcome
            await sendDealNotification({
              dealPubkey: deal.publicKey,
              traderAddress: deal.traderAddress,
              traderName: deal.trader?.name,
              rewardAmount: rewardAmountUSD,
              targetVolume: targetVolumeUSD,
              volumeCompleted: volumeCompleted,
              outcome: expectedOutcome,
            });
          }
        }
      } catch (error) {
        console.error(
          `[CRON] Error processing deal ${deal.publicKey}:`,
          error
        );
      } finally {
        pendingFinalizations.delete(deal.publicKey);
      }

      // Small delay between deals
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log("[CRON] Deal finalization check complete");
  } catch (error) {
    console.error("[CRON] Error in checkAndFinalizeDeals:", error);
  } finally {
    isFinalizationRunning = false;
  }
}

/**
 * Helper to update trader's active bounties count
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

        // Sum volume from COMPLETED deals (use actual volumeCompleted stored in DB)
        const volumeFromCompleted = completedDeals.reduce((sum, deal) => {
          // Always use the actual volumeCompleted - this is the real volume the trader did
          // For won deals, this will be >= targetVolume
          // For lost deals, this will be < targetVolume
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

  // Deal finalization check - every minute
  // This handles both deals ready to finalize and expired deals
  cron.schedule(FINALIZE_CHECK_INTERVAL, () => {
    checkAndFinalizeDeals().catch(console.error);
  });
  console.log(`[CRON] Scheduled finalization check: ${FINALIZE_CHECK_INTERVAL}`);

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

// Export the old function name for backwards compatibility
export const checkExpiredDeals = checkAndFinalizeDeals;
