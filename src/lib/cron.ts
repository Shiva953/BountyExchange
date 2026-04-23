import cron from "node-cron";
import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { prisma } from "./prisma";
import { calculateTokenVolumeFast } from "@/utils/calculateTokenVolume";
import { cleanupFinalizedDeals } from "./dealSync";
import { sendDealNotification, sendSystemAlert } from "./telegram";
import { getProgram, PROGRAM_ID } from "@/program/instructions/createDeal";
import { BountyExchangeProgram } from "@/program/idl";
import {
  checkAndSendMilestoneNotifications,
  checkAndSendExpiryWarnings,
  sendFinalizationNotification,
  sendDailySummaries,
  sendNewBountyNotification,
} from "./notifications";

const FINALIZE_CHECK_INTERVAL = "* * * * *";
const TRADER_STATS_INTERVAL = "*/3 * * * *"; // Every 3 min (reduced from 2 to lower Helius load)
const RECONCILE_INTERVAL = "1-59/3 * * * *"; // Every 3 min, offset by 1 min to not overlap with stats sync
const NEW_BOUNTY_CHECK_INTERVAL = "* * * * *"; // Every 1 min (backup; primary path is event-driven via confirmDealCreated)
const CLEANUP_INTERVAL = "0 * * * *";

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;
const FINALIZE_MAX_RETRIES = 5;
const FINALIZE_RETRY_DELAY_MS = 2000;
const FINALIZATION_BUFFER_MS = 15 * 60 * 1000;

let isInitialized = false;
let isTraderStatsSyncRunning = false;
let isFinalizationRunning = false;
let isReconciliationRunning = false;
let isNewBountyCheckRunning = false;
let isCancelExpiredRunning = false;

const pendingFinalizations = new Set<string>();

/**
 * Sanitizes a wallet address by removing any query parameters (e.g. ?timeframe=24h)
 * that may have been accidentally stored in the database.
 */
function sanitizeAddress(address: string): string {
  const queryIndex = address.indexOf("?");
  return queryIndex === -1 ? address : address.slice(0, queryIndex);
}

/**
 * Safely fetches all deal accounts from on-chain, skipping any that fail to deserialize.
 * Some older deals may have a different layout (e.g. before minBuyVolume was added),
 * which causes Anchor's `deal.all()` to throw. This fetches raw accounts and
 * deserializes individually, skipping failures.
 */
async function fetchAllDealsOnChain(
  program: Program<BountyExchangeProgram>,
  connection: Connection,
  memcmpFilters?: { offset: number; bytes: string }[]
) {
  const filters: Array<{ dataSize: number } | { memcmp: { offset: number; bytes: string } }> = [
    { dataSize: program.account.deal.size },
  ];
  if (memcmpFilters) {
    for (const f of memcmpFilters) {
      filters.push({ memcmp: f });
    }
  }

  const rawAccounts = await connection.getProgramAccounts(PROGRAM_ID, { filters });

  const deals: { publicKey: PublicKey; account: Awaited<ReturnType<typeof program.account.deal.fetch>> }[] = [];

  for (const raw of rawAccounts) {
    try {
      const decoded = program.coder.accounts.decode("deal", raw.account.data);
      deals.push({ publicKey: raw.pubkey, account: decoded });
    } catch {
      console.warn(`[CRON] Skipping undeserializable deal account: ${raw.pubkey.toBase58().slice(0, 8)}...`);
    }
  }

  return deals;
}

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

      const response = await fetch(`${baseUrl}/api/deal/finalize`, {
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
      const startTime = deal.acceptedAt
        ? Math.floor(deal.acceptedAt.getTime() / 1000)
        : undefined;

      const minBuyVolumeUSD = deal.minBuyVolume
        ? Number(deal.minBuyVolume) / 10 ** 9
        : undefined;

      const volumeResult = await withRetry(
        async () => {
          const result = await calculateTokenVolumeFast(
            sanitizeAddress(deal.traderAddress),
            deal.token,
            startTime,
            undefined,
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

      // Helius Dev plan: 50 req/s - reduced delay
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log("[CRON] Deal volume sync complete");
  } catch (error) {
    console.error("[CRON] Error in syncDealVolumes:", error);
  }
}

/**
 * Checks for deals ready to finalize (met volume target, approaching expiration)
 * and deals that have expired (need to be finalized as won/lost).
 *
 * Reads ALL active accepted deals from on-chain (source of truth), calculates
 * volume fresh via Helius, then executes finalize_deal ixn. DB is only written
 * to AFTER a successful on-chain finalization.
 *
 * This ensures the cron works even if the DB is down — the only requirement
 * is on-chain reads + Helius volume API.
 */
export async function checkAndFinalizeDeals() {
  if (isFinalizationRunning) {
    console.log("[CRON] Finalization already running, skipping...");
    return;
  }

  isFinalizationRunning = true;
  console.log("[CRON] Checking deals for finalization (on-chain source)...");

  try {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);

    const connection = new Connection(
      process.env.HELIUS_DEVNET_URL!,
      "confirmed"
    );
    const program = getProgram(connection);

    const allOnChainDeals = await fetchAllDealsOnChain(program, connection);
    const activeAcceptedDeals = allOnChainDeals.filter(
      (d) => d.account.isActive && d.account.isAccepted
    );

    // First, get all deals that need finalization checking:
    // 1. Deals within 15 min of expiry (buffer window)
    // 2. Deals that have met volume target (for early finalization)
    // 3. Expired deals (up to 1 hour past expiry - beyond that, markOrphanedDeals handles them)
    const dealsToCheck: typeof activeAcceptedDeals = [];

    // Get DB deals for volume checking (to detect early finalization candidates)
    const dbDealsForVolume = await prisma.deal.findMany({
      where: {
        publicKey: { in: activeAcceptedDeals.map(deal => deal.publicKey.toBase58()) },
      },
      select: { publicKey: true, volumeCompleted: true, targetVolume: true },
    });
    const dbDealVolumeMap = new Map(
      dbDealsForVolume.map(deal => [deal.publicKey, { volumeCompleted: Number(deal.volumeCompleted || 0) }])
    );

    for (const onChainDealCandidate of activeAcceptedDeals) {
      const createdAt = onChainDealCandidate.account.createdAt.toNumber();
      const expirationHours = onChainDealCandidate.account.expirationWindowInHours.toNumber();
      const expiresAtSec = createdAt + expirationHours * 3600;
      const bufferSec = FINALIZATION_BUFFER_MS / 1000;
      const oneHourSec = 60 * 60;

      // Check if deal is in the expiry buffer window (15 min before to 1 hour after)
      const isNearExpiry = nowSec >= expiresAtSec - bufferSec && nowSec <= expiresAtSec + oneHourSec;

      // Check if deal has met volume target (early finalization candidate)
      const pubkey = onChainDealCandidate.publicKey.toBase58();
      const dbDealVolume = dbDealVolumeMap.get(pubkey);
      const targetVolumeUSD = Number(onChainDealCandidate.account.targetVolume) / 10 ** 9;
      const volumeCompleted = dbDealVolume ? dbDealVolume.volumeCompleted : 0;
      const hasMetVolume = volumeCompleted >= targetVolumeUSD;

      if (isNearExpiry || hasMetVolume) {
        dealsToCheck.push(onChainDealCandidate);
      }
    }

    console.log(
      `[CRON] Found ${dealsToCheck.length} deals to check for finalization (${activeAcceptedDeals.length} total active) — includes volume-met early finalization candidates`
    );

    for (const onChainDeal of dealsToCheck) {
      const pubkey = onChainDeal.publicKey.toBase58();
      const account = onChainDeal.account;

      if (pendingFinalizations.has(pubkey)) {
        console.log(`[CRON] Skipping ${pubkey.slice(0, 8)}... - already processing`);
        continue;
      }

      const escrowVaultInfo = await connection.getAccountInfo(account.escrowVault);
      if (!escrowVaultInfo) {
        console.log(`[CRON] Skipping ${pubkey.slice(0, 8)}... - escrow vault already closed (deal already finalized on-chain)`);
        continue;
      }

      const createdAtSec = account.createdAt.toNumber();
      const expirationHours = account.expirationWindowInHours.toNumber();
      const expiresAtSec = createdAtSec + expirationHours * 3600;
      const isExpired = nowSec >= expiresAtSec;

      const targetVolumeUSD = Number(account.targetVolume) / 10 ** 9;
      const rewardAmountUSD = Number(account.rewardAmount) / 10 ** 9;
      const traderAddress = account.trader.toBase58();

      let volumeCompleted = 0;
      const minBuyVolumeUSD = account.minBuyVolume
        ? Number(account.minBuyVolume) / 10 ** 9
        : undefined;

      // First check DB for cached volume (updated by syncTraderStats every 3 min)
      const dbDealForVolume = await prisma.deal.findUnique({ where: { publicKey: pubkey } });
      const dbVolume = dbDealForVolume ? Number(dbDealForVolume.volumeCompleted || 0) : 0;

      // Only call Helius if:
      // 1. Deal is expired (need exact final volume), OR
      // 2. DB volume is within 10% of target (need fresh data to confirm pass/fail)
      const needsFreshVolume = isExpired || (dbVolume >= targetVolumeUSD * 0.9);

      if (needsFreshVolume) {
        try {
          const volumeResult = await calculateTokenVolumeFast(
            traderAddress,
            account.token.toBase58(),
            createdAtSec,
            isExpired ? expiresAtSec : undefined,
            minBuyVolumeUSD
          );
          if (volumeResult.success) {
            volumeCompleted = volumeResult.volumeUSD;
          }
        } catch (error) {
          console.error(`[CRON] Volume calc failed for ${pubkey.slice(0, 8)}...:`, error);
          // Fall back to DB volume if Helius fails
          volumeCompleted = dbVolume;
        }
      } else {
        // Use cached DB volume - not close to target, no need for fresh data
        volumeCompleted = dbVolume;
      }

      const hasMetVolume = volumeCompleted >= targetVolumeUSD;

      const holdDurationCompleted = Number(account.holdDurationInHours) || 0;
      const requiredHoldDuration = Number(account.holdDurationInHours) || 0;
      const hasMetHold = holdDurationCompleted >= requiredHoldDuration;
      const traderPassed = hasMetVolume && hasMetHold;

      console.log(
        `[CRON] Deal ${pubkey.slice(0, 8)}...: volume=${volumeCompleted.toFixed(2)}/${targetVolumeUSD.toFixed(2)}, expired=${isExpired}, metVolume=${hasMetVolume}`
      );

      try {
        pendingFinalizations.add(pubkey);

        if (traderPassed && !isExpired) {
          console.log(`[CRON] Attempting on-chain finalization for deal ${pubkey.slice(0, 8)}... (PASS)`);

          const result = await callFinalizeDealAPI(pubkey, volumeCompleted, holdDurationCompleted);

          if (result.success) {
            console.log(`[CRON] Deal ${pubkey.slice(0, 8)}... finalized! Signature: ${result.signature}`);

            try {
              const dbDeal = await prisma.deal.findUnique({ where: { publicKey: pubkey } });
              if (dbDeal) {
                await prisma.deal.update({
                  where: { publicKey: pubkey },
                  data: { isActive: false, finalizedAt: now, outcome: "won", volumeCompleted },
                });
                await updateTraderActiveBounties(dbDeal.traderId);

                await sendFinalizationNotification(
                  {
                    id: dbDeal.id,
                    traderId: dbDeal.traderId,
                    token: dbDeal.token,
                    targetVolume: targetVolumeUSD,
                    volumeCompleted,
                    rewardAmount: rewardAmountUSD,
                    expiresAt: dbDeal.expiresAt,
                  },
                  "won",
                  result.signature
                );
              }
            } catch (dbError) {
              console.error(`[CRON] DB update failed for ${pubkey.slice(0, 8)}... (will be reconciled):`, dbError);
            }

            await sendDealNotification({
              dealPubkey: pubkey,
              traderAddress,
              traderName: null,
              rewardAmount: rewardAmountUSD,
              targetVolume: targetVolumeUSD,
              volumeCompleted,
              outcome: "won",
              signature: result.signature,
            });
          } else {
            console.error(`[CRON] Failed to finalize deal ${pubkey.slice(0, 8)}...: ${result.error}`);
            const timeUntilExpiry = expiresAtSec - nowSec;
            if (timeUntilExpiry < 60) {
              await sendSystemAlert(
                "Finalization Failed",
                `Deal ${pubkey.slice(0, 8)}... failed to finalize: ${result.error}`,
                "error"
              );
            }
          }
        } else if (isExpired) {
          const expectedOutcome = traderPassed ? "won" : "lost";

          console.log(`[CRON] Deal ${pubkey.slice(0, 8)}... expired - Expected: ${expectedOutcome.toUpperCase()}`);
          console.log(
            `[CRON] Volume: ${volumeCompleted.toFixed(2)}/${targetVolumeUSD.toFixed(2)} (${hasMetVolume ? "MET" : "NOT MET"})`
          );

          const result = await callFinalizeDealAPI(pubkey, volumeCompleted, holdDurationCompleted);

          if (result.success) {
            console.log(`[CRON] Finalized ${pubkey.slice(0, 8)}... → ${expectedOutcome.toUpperCase()}`);

            try {
              const dbDeal = await prisma.deal.findUnique({ where: { publicKey: pubkey } });
              if (dbDeal) {
                await prisma.deal.update({
                  where: { publicKey: pubkey },
                  data: { isActive: false, finalizedAt: now, outcome: expectedOutcome, volumeCompleted },
                });
                await updateTraderActiveBounties(dbDeal.traderId);

                await sendFinalizationNotification(
                  {
                    id: dbDeal.id,
                    traderId: dbDeal.traderId,
                    token: dbDeal.token,
                    targetVolume: targetVolumeUSD,
                    volumeCompleted,
                    rewardAmount: rewardAmountUSD,
                    expiresAt: dbDeal.expiresAt,
                  },
                  expectedOutcome as "won" | "lost",
                  result.signature
                );
              }
            } catch (dbError) {
              console.error(`[CRON] DB update failed for ${pubkey.slice(0, 8)}... (will be reconciled):`, dbError);
            }

            await sendDealNotification({
              dealPubkey: pubkey,
              traderAddress,
              traderName: null,
              rewardAmount: rewardAmountUSD,
              targetVolume: targetVolumeUSD,
              volumeCompleted,
              outcome: expectedOutcome,
              signature: result.signature,
            });
          } else {
            console.error(`[CRON] Failed to finalize expired deal ${pubkey.slice(0, 8)}...: ${result.error}`);
            await sendSystemAlert(
              "Finalization Failed",
              `Expired deal ${pubkey.slice(0, 8)}... failed on-chain: ${result.error}. Will retry next run.`,
              "error"
            );
          }
        }
      } catch (error) {
        console.error(`[CRON] Error processing deal ${pubkey}:`, error);
      } finally {
        pendingFinalizations.delete(pubkey);
      }

      // Helius Dev plan: 50 req/s - reduced delay
      await new Promise((resolve) => setTimeout(resolve, 50));
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
        const deals = await prisma.deal.findMany({
          where: {
            traderId: trader.id,
            isAccepted: true,
          },
        });

        const completedDeals = deals.filter((d) => !d.isActive);
        const activeDeals = deals.filter((d) => d.isActive);

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
                sanitizeAddress(deal.traderAddress),
                deal.token,
                startTime,
                undefined,
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
            const previousVolume = Number(deal.volumeCompleted || 0);
            const newVolume = volumeResult.volumeUSD;
            const targetVolume = Number(deal.targetVolume) / 10 ** 9;
            const rewardAmount = Number(deal.rewardAmount) / 10 ** 9;

            await prisma.deal.update({
              where: { id: deal.id },
              data: { volumeCompleted: newVolume },
            });

            volumeFromActive += newVolume;

            console.log(
              `[CRON] Deal ${deal.publicKey.slice(0, 8)}...: volume = $${newVolume.toFixed(2)} / $${targetVolume.toFixed(2)}`
            );

            // ─── EARLY FINALIZATION: Trigger when volume target is met ───
            const hasMetVolume = newVolume >= targetVolume;
            const isNotExpired = deal.expiresAt && deal.expiresAt.getTime() > Date.now();
            const notAlreadyProcessing = !pendingFinalizations.has(deal.publicKey);

            if (hasMetVolume && isNotExpired && notAlreadyProcessing) {
              console.log(
                `[CRON] 🎯 Volume target met for deal ${deal.publicKey.slice(0, 8)}... ($${newVolume.toFixed(2)} >= $${targetVolume.toFixed(2)}) — triggering early finalization`
              );

              try {
                pendingFinalizations.add(deal.publicKey);

                // Hold duration: use the required value (same pattern as checkAndFinalizeDeals)
                const holdDuration = Number(deal.holdDurationHours) || 0;

                const result = await callFinalizeDealAPI(
                  deal.publicKey,
                  newVolume,
                  holdDuration
                );

                if (result.success) {
                  console.log(
                    `[CRON] ✅ Early finalization successful for deal ${deal.publicKey.slice(0, 8)}... — signature: ${result.signature}`
                  );

                  // Update DB
                  await prisma.deal.update({
                    where: { id: deal.id },
                    data: {
                      isActive: false,
                      finalizedAt: new Date(),
                      outcome: "won",
                      volumeCompleted: newVolume,
                    },
                  });

                  await updateTraderActiveBounties(deal.traderId);

                  // Send TG notification
                  await sendFinalizationNotification(
                    {
                      id: deal.id,
                      traderId: deal.traderId,
                      token: deal.token,
                      targetVolume,
                      volumeCompleted: newVolume,
                      rewardAmount,
                      expiresAt: deal.expiresAt,
                    },
                    "won",
                    result.signature
                  );

                  // Send system notification
                  await sendDealNotification({
                    dealPubkey: deal.publicKey,
                    traderAddress: deal.traderAddress,
                    traderName: null,
                    rewardAmount,
                    targetVolume,
                    volumeCompleted: newVolume,
                    outcome: "won",
                    signature: result.signature,
                  });

                  // Skip further processing for this deal (it's finalized)
                  continue;
                } else {
                  console.error(
                    `[CRON] ❌ Early finalization failed for deal ${deal.publicKey.slice(0, 8)}...: ${result.error}`
                  );
                  // Don't fail the whole sync — just log and continue with notifications
                }
              } catch (error) {
                console.error(
                  `[CRON] ❌ Error during early finalization for deal ${deal.publicKey.slice(0, 8)}...:`,
                  error
                );
              } finally {
                pendingFinalizations.delete(deal.publicKey);
              }
            }
            // ─── END EARLY FINALIZATION ───

            const dealInfo = {
              id: deal.id,
              traderId: deal.traderId,
              token: deal.token,
              targetVolume: targetVolume,
              volumeCompleted: newVolume,
              rewardAmount,
              expiresAt: deal.expiresAt,
            };

            await checkAndSendMilestoneNotifications(dealInfo, previousVolume);
            await checkAndSendExpiryWarnings(dealInfo);
          }

          // Helius Dev plan: 50 req/s - reduced delay
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const volumeFromCompleted = completedDeals.reduce((sum, deal) => {
          return sum + Number(deal.volumeCompleted || 0);
        }, 0);

        const totalVolumeCompleted = volumeFromCompleted + volumeFromActive;
        const activeBounties = activeDeals.length;

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
 * Reconciles DB state with on-chain state.
 *
 * IMPORTANT: For finalized deals, outcome and volumeCompletedUsd are read DIRECTLY
 * from on-chain state. We do NOT recalculate volume — it was captured at finalization
 * time with the correct token price.
 *
 * Cases handled:
 * 1. Deals finalized on-chain but DB wasn't updated (e.g. DB was down during finalization)
 * 2. Deals created+accepted on-chain but never added to DB (e.g. DB was down during acceptance)
 * 3. Active deals — update volume progress for progress bars
 * 4. Both completed — sync from on-chain if DB values are stale
 *
 * Only checks traders that have DB records. For each trader, fetches their on-chain deals
 * and compares against DB state. Cheap operation — only reads on-chain accounts, no txns.
 */
export async function reconcileOnChainState() {
  if (isReconciliationRunning) {
    console.log("[CRON] Reconciliation already running, skipping...");
    return;
  }

  isReconciliationRunning = true;
  console.log("[CRON] Starting on-chain reconciliation...");

  try {
    const connection = new Connection(
      process.env.HELIUS_DEVNET_URL!,
      "confirmed"
    );
    const program = getProgram(connection);

    const traders = await prisma.trader.findMany();
    let totalSynced = 0;
    let totalCreated = 0;

    for (const trader of traders) {
      try {
        const cleanAddress = sanitizeAddress(trader.address);
        const onChainDeals = await fetchAllDealsOnChain(program, connection, [{
          offset: 80,
          bytes: cleanAddress,
        }]);

        const acceptedOnChain = onChainDeals.filter((d) => d.account.isAccepted);

        const dbDeals = await prisma.deal.findMany({
          where: { traderId: trader.id, isAccepted: true },
        });
        const dbDealMap = new Map(dbDeals.map((d) => [d.publicKey, d]));

        if (acceptedOnChain.length === 0) continue;

        for (const onChainDeal of acceptedOnChain) {
          const pubkey = onChainDeal.publicKey.toBase58();
          const account = onChainDeal.account;
          const dbDeal = dbDealMap.get(pubkey);

          if (!dbDeal) {
            const createdAt = new Date(Number(account.createdAt) * 1000);
            const acceptedAt = createdAt;
            const expiresAt = new Date(
              acceptedAt.getTime() +
                Number(account.expirationWindowInHours) * 60 * 60 * 1000
            );

            let volumeCompleted = 0;
            let outcome: string | null = null;

            if (!account.isActive) {
              if (account.outcome !== null && account.outcome !== undefined) {
                outcome = account.outcome ? "won" : "lost";
              }
              if (account.volumeCompletedUsd) {
                volumeCompleted = Number(account.volumeCompletedUsd) / 10 ** 9;
              }
            }

            await prisma.deal.create({
              data: {
                publicKey: pubkey,
                dealId: account.dealId.toString(),
                creator: account.creator.toBase58(),
                token: account.token.toBase58(),
                traderId: trader.id,
                traderAddress: cleanAddress,
                rewardAmount: Number(account.rewardAmount),
                targetVolume: Number(account.targetVolume),
                minBuyVolume: account.minBuyVolume
                  ? Number(account.minBuyVolume)
                  : null,
                expirationHours: Number(account.expirationWindowInHours),
                holdDurationHours: Number(account.holdDurationInHours),
                escrowVault: account.escrowVault.toBase58(),
                createdAt: createdAt,
                acceptedAt: acceptedAt,
                expiresAt: expiresAt,
                isActive: account.isActive,
                isAccepted: true,
                volumeCompleted: volumeCompleted,
                outcome: outcome,
                finalizedAt: !account.isActive ? new Date() : null,
              },
            });

            totalCreated++;
            console.log(
              `[CRON] Reconcile: Created missing deal ${pubkey.slice(0, 8)}... for trader ${trader.address.slice(0, 8)}... (outcome: ${outcome}, volume: ${volumeCompleted.toFixed(2)})`
            );
          } else if (dbDeal.isActive && !account.isActive) {
            let volumeCompleted = 0;
            let outcome: string | null = null;

            if (account.outcome !== null && account.outcome !== undefined) {
              outcome = account.outcome ? "won" : "lost";
            }
            if (account.volumeCompletedUsd) {
              volumeCompleted = Number(account.volumeCompletedUsd) / 10 ** 9;
            }

            await prisma.deal.update({
              where: { id: dbDeal.id },
              data: {
                isActive: false,
                finalizedAt: new Date(),
                outcome: outcome,
                volumeCompleted: volumeCompleted,
              },
            });

            await updateTraderActiveBounties(trader.id);

            totalSynced++;
            console.log(
              `[CRON] Reconcile: Synced finalized deal ${pubkey.slice(0, 8)}... → ${outcome} (volume: ${volumeCompleted.toFixed(2)})`
            );
          } else if (dbDeal.isActive && account.isActive) {
            // Active deals: syncTraderStats already updates volumeCompleted every 2 min
            // No need to recalculate here - just skip to avoid redundant Helius calls
          } else if (!dbDeal.isActive && !account.isActive) {
            let onChainOutcome: string | null = null;
            let onChainVolume = 0;

            if (account.outcome !== null && account.outcome !== undefined) {
              onChainOutcome = account.outcome ? "won" : "lost";
            }
            if (account.volumeCompletedUsd) {
              onChainVolume = Number(account.volumeCompletedUsd) / 10 ** 9;
            }

            const dbVolume = Number(dbDeal.volumeCompleted || 0);

            if (onChainOutcome && (dbDeal.outcome !== onChainOutcome || Math.abs(onChainVolume - dbVolume) > 0.01)) {
              await prisma.deal.update({
                where: { id: dbDeal.id },
                data: {
                  volumeCompleted: onChainVolume,
                  outcome: onChainOutcome,
                },
              });
              totalSynced++;
              console.log(
                `[CRON] Reconcile: Fixed stale deal ${pubkey.slice(0, 8)}...: ${dbVolume.toFixed(2)} → ${onChainVolume.toFixed(2)}, ${dbDeal.outcome} → ${onChainOutcome}`
              );
            }
          }

          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(
          `[CRON] Reconcile error for trader ${trader.address.slice(0, 8)}...:`,
          error
        );
      }
    }

    if (totalSynced > 0 || totalCreated > 0) {
      console.log(
        `[CRON] Reconciliation complete: ${totalSynced} stale deals synced, ${totalCreated} missing deals created`
      );
      await sendSystemAlert(
        "Reconciliation Complete",
        `Synced ${totalSynced} stale deal(s), created ${totalCreated} missing deal(s) from on-chain.`,
        "warning"
      );
    } else {
      console.log("[CRON] Reconciliation complete: DB is in sync with on-chain");
    }
  } catch (error) {
    console.error("[CRON] Error in reconcileOnChainState:", error);
  } finally {
    isReconciliationRunning = false;
  }
}

/**
 * Marks orphaned deals as expired_unfulfilled.
 * These are deals that expired long ago but were never finalized on-chain
 * (e.g. cron was not running at the time, or deals predate the finalization logic).
 * We mark them with a distinct outcome so the UI shows them as "Expired" rather than "Active",
 * without falsely claiming won/lost (since on-chain state was never updated).
 */
export async function markOrphanedDeals() {
  console.log("[CRON] Checking for orphaned deals...");

  try {
    const now = new Date();
    const orphanThreshold = new Date(now.getTime() - 60 * 60 * 1000);

    const orphanedDeals = await prisma.deal.findMany({
      where: {
        isActive: true,
        isAccepted: true,
        expiresAt: {
          lte: orphanThreshold,
        },
      },
      include: {
        trader: true,
      },
    });

    if (orphanedDeals.length === 0) {
      console.log("[CRON] No orphaned deals found");
      return;
    }

    console.log(`[CRON] Found ${orphanedDeals.length} orphaned deals to mark as expired_unfulfilled`);

    for (const deal of orphanedDeals) {
      try {
        await prisma.deal.update({
          where: { id: deal.id },
          data: {
            isActive: false,
            outcome: "expired_unfulfilled",
            finalizedAt: now,
          },
        });

        if (deal.traderId) {
          await updateTraderActiveBounties(deal.traderId);
        }

        console.log(
          `[CRON] Marked deal ${deal.publicKey.slice(0, 8)}... as expired_unfulfilled (expired at ${deal.expiresAt?.toISOString()})`
        );
      } catch (error) {
        console.error(`[CRON] Error marking orphaned deal ${deal.publicKey}:`, error);
      }
    }

    await sendSystemAlert(
      "Orphaned Deals Detected",
      `Marked ${orphanedDeals.length} orphaned deal(s) as expired_unfulfilled. These need admin reclaim on-chain.`,
      "warning"
    );

    console.log("[CRON] Orphaned deal check complete");
  } catch (error) {
    console.error("[CRON] Error in markOrphanedDeals:", error);
  }
}

/**
 * Cleans up old finalized deals from the database
 */
export async function runCleanup() {
  console.log("[CRON] Starting cleanup of finalized deals...");
  try {
    const deletedCount = await cleanupFinalizedDeals(24);
    console.log(`[CRON] Cleanup complete, deleted ${deletedCount} deals`);
  } catch (error) {
    console.error("[CRON] Error in cleanup:", error);
  }
}

/**
 * Checks for new unaccepted bounties on-chain and notifies targeted traders.
 * Only notifies traders who have Telegram linked and newBountyAvailable enabled.
 */
export async function checkAndNotifyNewBounties() {
  if (isNewBountyCheckRunning) {
    console.log("[CRON] New bounty check already running, skipping...");
    return;
  }

  isNewBountyCheckRunning = true;
  console.log("[CRON] Checking for new bounties to notify...");

  try {
    const connection = new Connection(
      process.env.HELIUS_DEVNET_URL!,
      "confirmed"
    );
    const program = getProgram(connection);

    // Fetch all on-chain deals
    const allOnChainDeals = await fetchAllDealsOnChain(program, connection);

    // Filter to unaccepted, active deals that haven't expired
    const now = Date.now();
    const availableBounties = allOnChainDeals.filter((d) => {
      if (!d.account.isActive || d.account.isAccepted) return false;
      const createdAt = d.account.createdAt.toNumber() * 1000;
      const expirationMs = d.account.expirationWindowInHours.toNumber() * 60 * 60 * 1000;
      const expiresAt = createdAt + expirationMs;
      return expiresAt > now;
    });

    console.log(`[CRON] Found ${availableBounties.length} available bounties on-chain`);

    let notified = 0;
    let skipped = 0;

    for (const bounty of availableBounties) {
      const traderAddress = bounty.account.trader.toBase58();
      const dealPubkey = bounty.publicKey.toBase58();

      const createdAt = bounty.account.createdAt.toNumber() * 1000;
      const expirationMs = bounty.account.expirationWindowInHours.toNumber() * 60 * 60 * 1000;
      const expiresAt = new Date(createdAt + expirationMs);

      const result = await sendNewBountyNotification(traderAddress, {
        dealPubkey,
        token: bounty.account.token.toBase58(),
        targetVolume: Number(bounty.account.targetVolume) / 10 ** 9,
        rewardAmount: Number(bounty.account.rewardAmount) / 10 ** 9,
        expiresAt,
        creatorAddress: bounty.account.creator.toBase58(),
      });

      if (result.sent) {
        notified++;
      } else {
        skipped++;
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log(`[CRON] New bounty check complete: ${notified} notified, ${skipped} skipped`);
  } catch (error) {
    console.error("[CRON] Error in checkAndNotifyNewBounties:", error);
  } finally {
    isNewBountyCheckRunning = false;
  }
}

/**
 * Calls the cancel-expired API endpoint for a single deal
 */
async function callCancelExpiredDealAPI(dealPubkey: string): Promise<{
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

      const response = await fetch(`${baseUrl}/api/deal/cancel-expired`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealPubkey }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        return { success: true, signature: data.signature };
      }

      const isRetryable =
        response.status >= 500 ||
        data.error?.includes("blockhash") ||
        data.error?.includes("timeout");

      if (!isRetryable) {
        return { success: false, error: data.error || "Cancellation failed" };
      }

      console.warn(
        `[CRON] Cancel-expired API failed (attempt ${attempt}/${FINALIZE_MAX_RETRIES}): ${data.error}`
      );
    } catch (error) {
      console.error(
        `[CRON] Cancel-expired API error (attempt ${attempt}/${FINALIZE_MAX_RETRIES}):`,
        error
      );
    }

    if (attempt < FINALIZE_MAX_RETRIES) {
      const delay = FINALIZE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return { success: false, error: `Failed after ${FINALIZE_MAX_RETRIES} attempts` };
}

/**
 * Finds all active, unaccepted, expired deals on-chain and cancels them,
 * refunding the escrow back to the creator.
 */
async function checkAndCancelExpiredDeals() {
  if (isCancelExpiredRunning) {
    console.log("[CRON] Cancel-expired already running, skipping...");
    return;
  }

  isCancelExpiredRunning = true;
  console.log("[CRON] Checking for expired unaccepted deals...");

  try {
    const nowSec = Math.floor(Date.now() / 1000);

    const connection = new Connection(process.env.HELIUS_DEVNET_URL!, "confirmed");
    const program = getProgram(connection);

    // Only look at active, NOT accepted deals
    const allOnChainDeals = await fetchAllDealsOnChain(program, connection);
    const expiredUnaccepted = allOnChainDeals.filter((d) => {
      if (!d.account.isActive || d.account.isAccepted) return false;
      const expiresAtSec =
        d.account.createdAt.toNumber() +
        d.account.expirationWindowInHours.toNumber() * 3600;
      return nowSec >= expiresAtSec;
    });

    console.log(`[CRON] Found ${expiredUnaccepted.length} expired unaccepted deals to cancel`);

    for (const deal of expiredUnaccepted) {
      const pubkey = deal.publicKey.toBase58();

      // Skip if escrow is already closed (already cancelled on-chain)
      const escrowVaultInfo = await connection.getAccountInfo(deal.account.escrowVault);
      if (!escrowVaultInfo) {
        console.log(`[CRON] Skipping ${pubkey.slice(0, 8)}... - escrow already closed`);
        continue;
      }

      console.log(`[CRON] Cancelling expired deal ${pubkey.slice(0, 8)}...`);
      const result = await callCancelExpiredDealAPI(pubkey);

      if (result.success) {
        console.log(
          `[CRON] Cancelled deal ${pubkey.slice(0, 8)}... sig: ${result.signature?.slice(0, 12)}...`
        );
      } else {
        console.error(`[CRON] Failed to cancel deal ${pubkey.slice(0, 8)}...: ${result.error}`);
      }
    }
  } catch (error) {
    console.error("[CRON] Error in checkAndCancelExpiredDeals:", error);
  } finally {
    isCancelExpiredRunning = false;
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

  cron.schedule(FINALIZE_CHECK_INTERVAL, () => {
    checkAndFinalizeDeals().catch(console.error);
  });

  cron.schedule(FINALIZE_CHECK_INTERVAL, () => {
    checkAndCancelExpiredDeals().catch(console.error);
  });

  cron.schedule(TRADER_STATS_INTERVAL, () => {
    syncTraderStats().catch(console.error);
  });

  cron.schedule(RECONCILE_INTERVAL, () => {
    reconcileOnChainState().catch(console.error);
  });

  cron.schedule(NEW_BOUNTY_CHECK_INTERVAL, () => {
    checkAndNotifyNewBounties().catch(console.error);
  });

  cron.schedule(CLEANUP_INTERVAL, () => {
    markOrphanedDeals().catch(console.error);
  });

  cron.schedule("30 * * * *", () => {
    runCleanup().catch(console.error);
  });

  cron.schedule("0 9 * * *", () => {
    sendDailySummaries().catch(console.error);
  });

  isInitialized = true;
  console.log("[CRON] All cron jobs initialized successfully");
}

export const checkExpiredDeals = checkAndFinalizeDeals;
