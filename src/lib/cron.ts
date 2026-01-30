import cron from "node-cron";
import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { prisma } from "./prisma";
import { calculateTokenVolumeFast } from "@/utils/calculateTokenVolume";
import { cleanupFinalizedDeals } from "./dealSync";
import { sendDealNotification, sendSystemAlert } from "./telegram";
import { getProgram, PROGRAM_ID } from "@/program/instructions/createDeal";
import { BountyExchangeProgram } from "@/program/idl";

const FINALIZE_CHECK_INTERVAL = "* * * * *"; // Every minute
const TRADER_STATS_INTERVAL = "*/2 * * * *"; // Every 2 minutes - calculates volumes + aggregates
const RECONCILE_INTERVAL = "*/5 * * * *"; // Every 5 minutes
const CLEANUP_INTERVAL = "0 * * * *"; // Every hour

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;

// Finalization retry configuration
const FINALIZE_MAX_RETRIES = 5;
const FINALIZE_RETRY_DELAY_MS = 2000;

// Buffer time before expiration to attempt finalization (60 minutes)
const FINALIZATION_BUFFER_MS = 60 * 60 * 1000;

let isInitialized = false;

// Locks to prevent overlapping cron executions
let isTraderStatsSyncRunning = false;
let isFinalizationRunning = false;
let isReconciliationRunning = false;

// Track deals that are being finalized to avoid duplicate attempts
const pendingFinalizations = new Set<string>();

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
      // Skip accounts that fail to deserialize (old layout, corrupted, etc.)
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
      process.env.HELIUS_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL!,
      "confirmed"
    );
    const program = getProgram(connection);

    // Fetch all on-chain deals with current IDL size, then filter in JS
    const allOnChainDeals = await fetchAllDealsOnChain(program, connection);
    const activeAcceptedDeals = allOnChainDeals.filter(
      (d) => d.account.isActive && d.account.isAccepted
    );

    // Filter to deals within ±60 min of their expiry time
    const dealsToCheck = activeAcceptedDeals.filter((d) => {
      const createdAt = d.account.createdAt.toNumber();
      const expirationHours = d.account.expirationWindowInHours.toNumber();
      const expiresAtSec = createdAt + expirationHours * 3600;
      const bufferSec = FINALIZATION_BUFFER_MS / 1000;
      // Must be within [expiry - buffer, expiry + buffer]
      return nowSec >= expiresAtSec - bufferSec && nowSec <= expiresAtSec + bufferSec;
    });

    console.log(
      `[CRON] Found ${dealsToCheck.length} on-chain deals near/past expiry (from ${activeAcceptedDeals.length} total active)`
    );

    for (const onChainDeal of dealsToCheck) {
      const pubkey = onChainDeal.publicKey.toBase58();
      const account = onChainDeal.account;

      if (pendingFinalizations.has(pubkey)) {
        console.log(`[CRON] Skipping ${pubkey.slice(0, 8)}... - already processing`);
        continue;
      }

      // Verify escrow vault still exists on-chain (if closed, deal was already finalized)
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

      // Calculate volume fresh from Helius — not from DB
      let volumeCompleted = 0;
      const minBuyVolumeUSD = account.minBuyVolume
        ? Number(account.minBuyVolume) / 10 ** 9
        : undefined;

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
      }

      const hasMetVolume = volumeCompleted >= targetVolumeUSD;

      // Hold duration check — currently non-existent, needs to be updated
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
          // Case 1: All requirements met, not yet expired — trader wins
          console.log(`[CRON] Attempting on-chain finalization for deal ${pubkey.slice(0, 8)}... (PASS)`);

          const result = await callFinalizeDealAPI(pubkey, volumeCompleted, holdDurationCompleted);

          if (result.success) {
            console.log(`[CRON] Deal ${pubkey.slice(0, 8)}... finalized! Signature: ${result.signature}`);

            // Best-effort DB update — if DB is down, reconciliation cron catches it later
            try {
              const dbDeal = await prisma.deal.findUnique({ where: { publicKey: pubkey } });
              if (dbDeal) {
                await prisma.deal.update({
                  where: { publicKey: pubkey },
                  data: { isActive: false, finalizedAt: now, outcome: "won", volumeCompleted },
                });
                await updateTraderActiveBounties(dbDeal.traderId);
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
          // Case 2: Deal expired — finalize with computed outcome
          const expectedOutcome = traderPassed ? "won" : "lost";

          console.log(`[CRON] Deal ${pubkey.slice(0, 8)}... expired - Expected: ${expectedOutcome.toUpperCase()}`);
          console.log(
            `[CRON] Volume: ${volumeCompleted.toFixed(2)}/${targetVolumeUSD.toFixed(2)} (${hasMetVolume ? "MET" : "NOT MET"})`
          );

          const result = await callFinalizeDealAPI(pubkey, volumeCompleted, holdDurationCompleted);

          if (result.success) {
            console.log(`[CRON] Finalized ${pubkey.slice(0, 8)}... → ${expectedOutcome.toUpperCase()}`);

            // Best-effort DB update
            try {
              const dbDeal = await prisma.deal.findUnique({ where: { publicKey: pubkey } });
              if (dbDeal) {
                await prisma.deal.update({
                  where: { publicKey: pubkey },
                  data: { isActive: false, finalizedAt: now, outcome: expectedOutcome, volumeCompleted },
                });
                await updateTraderActiveBounties(dbDeal.traderId);
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
 * Reconciles DB state with on-chain state.
 * Handles two cases:
 * 1. Deals finalized on-chain but DB wasn't updated (e.g. DB was down during finalization)
 * 2. Deals created+accepted on-chain but never added to DB (e.g. DB was down during acceptance)
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
      process.env.HELIUS_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL!,
      "confirmed"
    );
    const program = getProgram(connection);

    // Get all traders from DB
    const traders = await prisma.trader.findMany();
    let totalSynced = 0;
    let totalCreated = 0;

    for (const trader of traders) {
      try {
        // Fetch all on-chain deals for this trader (safe — skips undeserializable accounts)
        const onChainDeals = await fetchAllDealsOnChain(program, connection, [{
          offset: 80, // trader field offset
          bytes: trader.address,
        }]);

        const acceptedOnChain = onChainDeals.filter((d) => d.account.isAccepted);

        if (acceptedOnChain.length === 0) continue;

        // Get all DB deals for this trader
        const dbDeals = await prisma.deal.findMany({
          where: { traderId: trader.id, isAccepted: true },
        });
        const dbDealMap = new Map(dbDeals.map((d) => [d.publicKey, d]));

        for (const onChainDeal of acceptedOnChain) {
          const pubkey = onChainDeal.publicKey.toBase58();
          const account = onChainDeal.account;
          const dbDeal = dbDealMap.get(pubkey);

          if (!dbDeal) {
            // Case 2: Deal exists on-chain but not in DB — create it
            const createdAt = new Date(Number(account.createdAt) * 1000);
            // Estimate acceptedAt as createdAt since we don't know the exact time
            const acceptedAt = createdAt;
            const expiresAt = new Date(
              acceptedAt.getTime() +
                Number(account.expirationWindowInHours) * 60 * 60 * 1000
            );

            // If deal is already finalized on-chain, calculate volume to determine outcome
            let volumeCompleted = 0;
            let outcome: string | null = null;

            if (!account.isActive) {
              // Deal was finalized — calculate volume to determine pass/fail
              const startTime = Math.floor(acceptedAt.getTime() / 1000);
              const endTime = Math.floor(expiresAt.getTime() / 1000);
              const minBuyVolumeUSD = account.minBuyVolume
                ? Number(account.minBuyVolume) / 10 ** 9
                : undefined;

              try {
                const volumeResult = await calculateTokenVolumeFast(
                  trader.address,
                  account.token.toBase58(),
                  startTime,
                  endTime,
                  minBuyVolumeUSD
                );

                if (volumeResult.success) {
                  volumeCompleted = volumeResult.volumeUSD;
                }
              } catch (error) {
                console.error(
                  `[CRON] Reconcile: Volume calc failed for ${pubkey.slice(0, 8)}...:`,
                  error
                );
              }

              const targetVolumeUSD = Number(account.targetVolume) / 10 ** 9;
              outcome = volumeCompleted >= targetVolumeUSD ? "won" : "lost";
            }

            await prisma.deal.create({
              data: {
                publicKey: pubkey,
                dealId: account.dealId.toString(),
                creator: account.creator.toBase58(),
                token: account.token.toBase58(),
                traderId: trader.id,
                traderAddress: trader.address,
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
              `[CRON] Reconcile: Created missing deal ${pubkey.slice(0, 8)}... for trader ${trader.address.slice(0, 8)}...`
            );
          } else if (dbDeal.isActive && !account.isActive) {
            // Case 1: On-chain finalized but DB still says active — sync it
            // We don't know the exact outcome from on-chain alone, so derive from volume
            const targetVolumeUSD = Number(dbDeal.targetVolume) / 10 ** 9;
            const volumeCompleted = Number(dbDeal.volumeCompleted || 0);
            const outcome = volumeCompleted >= targetVolumeUSD ? "won" : "lost";

            await prisma.deal.update({
              where: { id: dbDeal.id },
              data: {
                isActive: false,
                finalizedAt: new Date(),
                outcome: outcome,
              },
            });

            await updateTraderActiveBounties(trader.id);

            totalSynced++;
            console.log(
              `[CRON] Reconcile: Synced finalized deal ${pubkey.slice(0, 8)}... → ${outcome}`
            );
          }

          // Small delay to avoid RPC rate limiting
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
    // Consider deals orphaned if they expired more than 1 hour ago and are still active
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

  // Reconcile DB with on-chain state - every 5 minutes
  cron.schedule(RECONCILE_INTERVAL, () => {
    reconcileOnChainState().catch(console.error);
  });
  console.log(`[CRON] Scheduled on-chain reconciliation: ${RECONCILE_INTERVAL}`);

  // Mark orphaned deals - every hour (deals expired >1h ago that were never finalized)
  cron.schedule(CLEANUP_INTERVAL, () => {
    markOrphanedDeals().catch(console.error);
  });
  console.log(`[CRON] Scheduled orphaned deal check: ${CLEANUP_INTERVAL}`);

  // Cleanup old finalized deals - every hour (offset by 30 min)
  cron.schedule("30 * * * *", () => {
    runCleanup().catch(console.error);
  });
  console.log(`[CRON] Scheduled cleanup: 30 * * * *`);

  isInitialized = true;
  console.log("[CRON] All cron jobs initialized successfully");
}

// Export the old function name for backwards compatibility
export const checkExpiredDeals = checkAndFinalizeDeals;
