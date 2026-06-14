import cron from "node-cron";
import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { prisma } from "./prisma";
import { calculateTokenVolumeFast } from "@/utils/calculateTokenVolume";
import { cleanupFinalizedDeals } from "./dealSync";
import { sendDealNotification, sendSystemAlert } from "./telegram";
import { getProgram, PROGRAM_ID } from "@/program/instructions/createDeal";
import { buildFinalizeDealInstruction } from "@/program/instructions/finalizeDeal";
import { sendTransactionWithRetry as sendTxWithRetry } from "@/utils/sendTransactionWithRetry";
import { BountyExchangeProgram } from "@/program/idl";
import {
  checkAndSendMilestoneNotifications,
  checkAndSendExpiryWarnings,
  sendFinalizationNotification,
  sendDailySummaries,
  sendNewBountyNotification,
} from "./notifications";

// NOTE: Finalization is handled directly in the cron process rather than via the
// /api/deal/finalize HTTP endpoint. This is because Railway's request timeout (~30s)
// is too short for the full finalization flow (on-chain fetch + tx send + retries).
// The HTTP endpoint still exists and can be used if you upgrade to a plan with longer
// timeouts or migrate to a platform without this constraint.

const FINALIZE_CHECK_INTERVAL = "* * * * *";
const TRADER_STATS_INTERVAL = "*/3 * * * *";
const RECONCILE_INTERVAL = "1-59/3 * * * *";
const NEW_BOUNTY_CHECK_INTERVAL = "* * * * *";
const CLEANUP_INTERVAL = "0 * * * *";

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;
const FINALIZE_MAX_RETRIES = 5;
const FINALIZE_RETRY_DELAY_MS = 1000;
const FINALIZATION_BUFFER_MS = 15 * 60 * 1000;

// Program error code mappings from IDL
const PROGRAM_ERROR_MAP: Record<number, string> = {
  6003: "Deal is not active - may already be finalized",
  6006: "Deal has not been accepted",
  6009: "Deal has expired - cannot finalize",
  6010: "Volume requirement not met",
  6022: "Unauthorized crank - wrong keypair configured",
};

let isInitialized = false;
let isTraderStatsSyncRunning = false;
let isFinalizationRunning = false;
let isReconciliationRunning = false;
let isNewBountyCheckRunning = false;
let isCancelExpiredRunning = false;

const pendingFinalizations = new Set<string>();

// ─── Crank Keypair ───────────────────────────────────────────────────────────

function getCrankKeypair(): Keypair | null {
  const privateKey = process.env.CRANK_PRIVATE_KEY;
  if (!privateKey) {
    console.error("[CRON] CRANK_PRIVATE_KEY not set in environment");
    return null;
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch (error) {
    console.error("[CRON] Failed to decode CRANK_PRIVATE_KEY:", error);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeAddress(address: string): string {
  const queryIndex = address.indexOf("?");
  return queryIndex === -1 ? address : address.slice(0, queryIndex);
}

async function fetchAllDealsOnChain(
  program: Program<BountyExchangeProgram>,
  connection: Connection,
  memcmpFilters?: { offset: number; bytes: string }[]
) {
  const filters: Array<
  { dataSize: number } |
  { memcmp: { offset: number; bytes: string } }
> = [
  {
    dataSize: program.account.deal.size,
  },
];

  if (memcmpFilters) {
    for (const f of memcmpFilters) {
      filters.push({ memcmp: f });
    }
  }

  const rawAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters,
  });

  const deals: {
    publicKey: PublicKey;
    account: Awaited<ReturnType<typeof program.account.deal.fetch>>;
  }[] = [];

  for (const raw of rawAccounts) {
    try {
      const decoded = program.coder.accounts.decode("deal", raw.account.data);
      deals.push({ publicKey: raw.pubkey, account: decoded });
    } catch {
      console.warn(
        `[CRON] Skipping undeserializable deal account: ${raw.pubkey.toBase58().slice(0, 8)}...`
      );
    }
  }

  return deals;
}

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

async function updateTraderActiveBounties(traderId: number) {
  const activeCount = await prisma.deal.count({
    where: { traderId, isActive: true, isAccepted: true },
  });
  await prisma.trader.update({
    where: { id: traderId },
    data: { activeBounties: activeCount },
  });
}

// ─── Core Finalization (runs directly in cron process) ───────────────────────

/**
 * Sends a finalize_deal transaction with retry logic for blockhash expiration.
 * Runs entirely in-process — no HTTP round-trip.
 */
async function sendFinalizeTxWithRetry(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
  maxRetries: number = FINALIZE_MAX_RETRIES
): Promise<{ signature: string; success: boolean; error?: string }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      transaction.sign(...signers);

      const result = await sendTxWithRetry(
        connection,
        transaction,
        lastValidBlockHeight
      );

      if (result.success) {
        return { signature: result.signature, success: true };
      }

      const programError = result.errorCode
        ? PROGRAM_ERROR_MAP[result.errorCode]
        : undefined;

      if (programError) {
        return { signature: result.signature, success: false, error: programError };
      }

      return {
        signature: result.signature,
        success: false,
        error: `Transaction failed with error code: ${result.errorCode}`,
      };
    } catch (error) {
      lastError = error as Error;

      const isBlockhashExpired =
        lastError.message?.includes("Transaction did not land") ||
        lastError.message?.includes("block height exceeded") ||
        lastError.message?.includes("Blockhash not found");

      if (isBlockhashExpired && attempt < maxRetries) {
        const delay = FINALIZE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(
          `[CRON:FINALIZE] Blockhash expired on attempt ${attempt}/${maxRetries}, retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      console.error(`[CRON:FINALIZE] Tx failed on attempt ${attempt}:`, error);
      if (attempt < maxRetries) {
        const delay = FINALIZE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  return {
    signature: "",
    success: false,
    error: lastError?.message || "Transaction failed after max retries",
  };
}

/**
 * Executes on-chain finalization for a single deal directly in the cron process.
 * Returns the tx signature on success or an error string on failure.
 */
async function executeFinalizeDeal(
  connection: Connection,
  crankKeypair: Keypair,
  dealPubkey: string,
  volumeAtEndTime: number,
  holdDurationAtEndTime: number
): Promise<{ success: boolean; signature?: string; error?: string }> {
  const dealPubkeyObj = new PublicKey(dealPubkey);
  const program = getProgram(connection);

  let dealAccount;
  try {
    dealAccount = await program.account.deal.fetch(dealPubkeyObj);
  } catch (error) {
    return { success: false, error: `Failed to fetch deal on-chain: ${error}` };
  }

  if (!dealAccount.isActive) {
    return { success: false, error: "Deal is not active (already finalized?)" };
  }
  if (!dealAccount.isAccepted) {
    return { success: false, error: "Deal has not been accepted" };
  }

  const volumeRaw = new BN(Math.floor(volumeAtEndTime * 10 ** 9));
  const holdDurationRaw = new BN(holdDurationAtEndTime);

  console.log(
    `[CRON:FINALIZE] Building ix for ${dealPubkey.slice(0, 8)}... — volume=$${volumeAtEndTime.toFixed(2)}, hold=${holdDurationAtEndTime}h`
  );

  const { instruction } = await buildFinalizeDealInstruction(
    connection,
    crankKeypair.publicKey,
    dealPubkeyObj,
    {
      dealId: dealAccount.dealId,
      creator: dealAccount.creator,
      trader: dealAccount.trader,
      escrowVault: dealAccount.escrowVault,
    },
    {
      volumeAtEndTime: volumeRaw,
      holdDurationAtEndTime: holdDurationRaw,
    }
  );

  const transaction = new Transaction().add(instruction);
  return sendFinalizeTxWithRetry(connection, transaction, [crankKeypair]);
}

// ─── Finalization Cron ───────────────────────────────────────────────────────

export async function checkAndFinalizeDeals() {
  if (isFinalizationRunning) {
    console.log("[CRON] Finalization already running, skipping...");
    return;
  }

  isFinalizationRunning = true;
  console.log("[CRON] Checking deals for finalization (on-chain source)...");

  try {
    const crankKeypair = getCrankKeypair();
    if (!crankKeypair) {
      console.error("[CRON] Cannot finalize — CRANK_PRIVATE_KEY missing");
      return;
    }

    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);

    const connection = new Connection(process.env.HELIUS_DEVNET_URL!, "confirmed");
    const program = getProgram(connection);

    const allOnChainDeals = await fetchAllDealsOnChain(program, connection);
    const activeAcceptedDeals = allOnChainDeals.filter(
      (d) => d.account.isActive && d.account.isAccepted
    );

    // Load DB volume for all active deals in one query
    const dbDealsForVolume = await prisma.deal.findMany({
      where: {
        publicKey: { in: activeAcceptedDeals.map((d) => d.publicKey.toBase58()) },
      },
      select: { publicKey: true, volumeCompleted: true, targetVolume: true },
    });
    const dbDealVolumeMap = new Map(
      dbDealsForVolume.map((d) => [
        d.publicKey,
        { volumeCompleted: Number(d.volumeCompleted || 0) },
      ])
    );

    // Determine which deals need finalization:
    // 1. Approaching/past expiry (within 15 min buffer or up to 1h past)
    // 2. Volume target already met per cached DB value (early finalization)
    const dealsToCheck: typeof activeAcceptedDeals = [];

    for (const deal of activeAcceptedDeals) {
      const createdAt = deal.account.createdAt.toNumber();
      const expirationHours = deal.account.expirationWindowInHours.toNumber();
      const expiresAtSec = createdAt + expirationHours * 3600;
      const bufferSec = FINALIZATION_BUFFER_MS / 1000;

      const isNearExpiry =
        nowSec >= expiresAtSec - bufferSec &&
        nowSec <= expiresAtSec + 3600;

      const pubkey = deal.publicKey.toBase58();
      const dbVol = dbDealVolumeMap.get(pubkey);
      const targetVolumeUSD = Number(deal.account.targetVolume) / 10 ** 9;
      const cachedVolume = dbVol ? dbVol.volumeCompleted : 0;
      const hasMetVolumeInCache = cachedVolume >= targetVolumeUSD;

      if (isNearExpiry || hasMetVolumeInCache) {
        dealsToCheck.push(deal);
      }
    }

    console.log(
      `[CRON] ${dealsToCheck.length} deals to check for finalization (${activeAcceptedDeals.length} total active)`
    );

    for (const onChainDeal of dealsToCheck) {
      const pubkey = onChainDeal.publicKey.toBase58();
      const account = onChainDeal.account;

      if (pendingFinalizations.has(pubkey)) {
        console.log(`[CRON] Skipping ${pubkey.slice(0, 8)}... — already processing`);
        continue;
      }

      // Skip if escrow vault is already closed (already finalized on-chain)
      const escrowVaultInfo = await connection.getAccountInfo(account.escrowVault);
      if (!escrowVaultInfo) {
        console.log(`[CRON] Skipping ${pubkey.slice(0, 8)}... — escrow already closed`);
        continue;
      }

      const createdAtSec = account.createdAt.toNumber();
      const expirationHours = account.expirationWindowInHours.toNumber();
      const expiresAtSec = createdAtSec + expirationHours * 3600;
      const isExpired = nowSec >= expiresAtSec;

      const targetVolumeUSD = Number(account.targetVolume) / 10 ** 9;
      const rewardAmountUSD = Number(account.rewardAmount) / 10 ** 9;
      const traderAddress = account.trader.toBase58();
      const minBuyVolumeUSD = account.minBuyVolume
        ? Number(account.minBuyVolume) / 10 ** 9
        : undefined;

      // Use cached DB volume, but fetch fresh from Helius if:
      // - deal is expired (need exact final number), OR
      // - cached volume is within 10% of target (need confirmation)
      const dbDealForVolume = await prisma.deal.findUnique({
        where: { publicKey: pubkey },
      });
      const dbVolume = dbDealForVolume ? Number(dbDealForVolume.volumeCompleted || 0) : 0;
      const needsFreshVolume = isExpired || dbVolume >= targetVolumeUSD * 0.9;

      let volumeCompleted = dbVolume;
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
          // Fall back to cached DB volume
        }
      }

      const hasMetVolume = volumeCompleted >= targetVolumeUSD;
      const holdDurationCompleted = Number(account.holdDurationInHours) || 0;
      const hasMetHold = holdDurationCompleted >= Number(account.holdDurationInHours);
      const traderPassed = hasMetVolume && hasMetHold;

      // Only finalize if: volume met (early win) OR deal is expired (win or lose)
      const shouldFinalize = (traderPassed && !isExpired) || isExpired;
      if (!shouldFinalize) {
        console.log(
          `[CRON] Deal ${pubkey.slice(0, 8)}...: volume=${volumeCompleted.toFixed(2)}/${targetVolumeUSD.toFixed(2)}, not yet ready`
        );
        continue;
      }

      const expectedOutcome = traderPassed ? "won" : "lost";
      console.log(
        `[CRON] Finalizing ${pubkey.slice(0, 8)}... — outcome=${expectedOutcome}, expired=${isExpired}, volume=${volumeCompleted.toFixed(2)}/${targetVolumeUSD.toFixed(2)}`
      );

      try {
        pendingFinalizations.add(pubkey);

        const result = await executeFinalizeDeal(
          connection,
          crankKeypair,
          pubkey,
          volumeCompleted,
          holdDurationCompleted
        );

        if (result.success) {
          console.log(
            `[CRON] ✅ Finalized ${pubkey.slice(0, 8)}... → ${expectedOutcome.toUpperCase()} | sig: ${result.signature?.slice(0, 12)}...`
          );

          try {
            const dbDeal = await prisma.deal.findUnique({ where: { publicKey: pubkey } });
            if (dbDeal) {
              await prisma.deal.update({
                where: { publicKey: pubkey },
                data: {
                  isActive: false,
                  finalizedAt: now,
                  outcome: expectedOutcome,
                  volumeCompleted,
                },
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
            console.error(
              `[CRON] DB update failed for ${pubkey.slice(0, 8)}... (reconciler will fix):`,
              dbError
            );
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
          console.error(
            `[CRON] ❌ Finalization failed for ${pubkey.slice(0, 8)}...: ${result.error}`
          );
          const timeUntilExpiry = expiresAtSec - nowSec;
          if (isExpired || timeUntilExpiry < 120) {
            await sendSystemAlert(
              "Finalization Failed",
              `Deal ${pubkey.slice(0, 8)}... failed to finalize: ${result.error}. Will retry next run.`,
              "error"
            );
          }
        }
      } catch (error) {
        console.error(`[CRON] Unexpected error finalizing ${pubkey}:`, error);
      } finally {
        pendingFinalizations.delete(pubkey);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log("[CRON] Deal finalization check complete");
  } catch (error) {
    console.error("[CRON] Error in checkAndFinalizeDeals:", error);
  } finally {
    isFinalizationRunning = false;
  }
}

// ─── Cancel Expired (unaccepted) Deals ───────────────────────────────────────

async function checkAndCancelExpiredDeals() {
  if (isCancelExpiredRunning) {
    console.log("[CRON] Cancel-expired already running, skipping...");
    return;
  }

  isCancelExpiredRunning = true;
  console.log("[CRON] Checking for expired unaccepted deals...");

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL ||
      process.env.VERCEL_URL ||
      "http://localhost:3000";

    const connection = new Connection(process.env.HELIUS_DEVNET_URL!, "confirmed");
    const program = getProgram(connection);

    const allOnChainDeals = await fetchAllDealsOnChain(program, connection);
    const expiredUnaccepted = allOnChainDeals.filter((d) => {
      if (!d.account.isActive || d.account.isAccepted) return false;
      const expiresAtSec =
        d.account.createdAt.toNumber() +
        d.account.expirationWindowInHours.toNumber() * 3600;
      return nowSec >= expiresAtSec;
    });

    console.log(
      `[CRON] Found ${expiredUnaccepted.length} expired unaccepted deals to cancel`
    );

    for (const deal of expiredUnaccepted) {
      const pubkey = deal.publicKey.toBase58();

      const escrowVaultInfo = await connection.getAccountInfo(deal.account.escrowVault);
      if (!escrowVaultInfo) {
        console.log(`[CRON] Skipping ${pubkey.slice(0, 8)}... — escrow already closed`);
        continue;
      }

      console.log(`[CRON] Cancelling expired deal ${pubkey.slice(0, 8)}...`);

      // Cancel-expired is simpler (no volume logic), keep it as HTTP for now.
      // If it also hits timeouts, move the cancel instruction inline same as finalize.
      try {
        const response = await fetch(`${baseUrl}/api/deal/cancel-expired`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealPubkey: pubkey }),
        });

        const text = await response.text();
        if (!text) {
          console.error(`[CRON] Cancel-expired returned empty response (${response.status}) for ${pubkey.slice(0, 8)}...`);
          continue;
        }

        const data = JSON.parse(text);
        if (response.ok && data.success) {
          console.log(
            `[CRON] Cancelled ${pubkey.slice(0, 8)}... sig: ${data.signature?.slice(0, 12)}...`
          );
        } else {
          console.error(
            `[CRON] Failed to cancel ${pubkey.slice(0, 8)}...: ${data.error}`
          );
        }
      } catch (error) {
        console.error(`[CRON] Cancel-expired error for ${pubkey.slice(0, 8)}...:`, error);
      }
    }
  } catch (error) {
    console.error("[CRON] Error in checkAndCancelExpiredDeals:", error);
  } finally {
    isCancelExpiredRunning = false;
  }
}

// ─── Volume Sync ─────────────────────────────────────────────────────────────

export async function syncDealVolumes() {
  console.log("[CRON] Starting deal volume sync...");

  try {
    const activeDeals = await prisma.deal.findMany({
      where: { isActive: true, isAccepted: true },
      include: { trader: true },
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
          if (!result.success) throw new Error(result.error || "Volume calculation failed");
          return result;
        },
        `Volume sync for deal ${deal.publicKey.slice(0, 8)}...`
      );

      if (volumeResult) {
        try {
          await prisma.deal.update({
            where: { id: deal.id },
            data: { volumeCompleted: volumeResult.volumeUSD },
          });
          console.log(
            `[CRON] Updated deal ${deal.publicKey.slice(0, 8)}...: volume = $${volumeResult.volumeUSD.toFixed(2)}`
          );
        } catch (error) {
          console.error(`[CRON] Error updating deal ${deal.publicKey} in DB:`, error);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log("[CRON] Deal volume sync complete");
  } catch (error) {
    console.error("[CRON] Error in syncDealVolumes:", error);
  }
}

// ─── Trader Stats Sync ────────────────────────────────────────────────────────

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
          where: { traderId: trader.id, isAccepted: true },
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
              if (!result.success) throw new Error(result.error || "Volume calculation failed");
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

            // Volume met check — checkAndFinalizeDeals (runs every 1 min) will pick
            // this up on its next tick via the updated DB value. No duplicate finalization.
            if (newVolume >= targetVolume) {
              console.log(
                `[CRON] 🎯 Volume target met for ${deal.publicKey.slice(0, 8)}... — finalization will trigger on next checkAndFinalizeDeals run`
              );
            }

            const dealInfo = {
              id: deal.id,
              traderId: deal.traderId,
              token: deal.token,
              targetVolume,
              volumeCompleted: newVolume,
              rewardAmount,
              expiresAt: deal.expiresAt,
            };

            await checkAndSendMilestoneNotifications(dealInfo, previousVolume);
            await checkAndSendExpiryWarnings(dealInfo);
          }

          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const volumeFromCompleted = completedDeals.reduce(
          (sum, d) => sum + Number(d.volumeCompleted || 0),
          0
        );
        const totalVolumeCompleted = volumeFromCompleted + volumeFromActive;

        await prisma.trader.update({
          where: { id: trader.id },
          data: {
            volumeCompleted: totalVolumeCompleted,
            activeBounties: activeDeals.length,
          },
        });

        console.log(
          `[CRON] Updated trader ${trader.name || trader.address.slice(0, 8)}...: volume=$${totalVolumeCompleted.toFixed(2)}, active=${activeDeals.length}`
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

// ─── Reconciliation ───────────────────────────────────────────────────────────

export async function reconcileOnChainState() {
  if (isReconciliationRunning) {
    console.log("[CRON] Reconciliation already running, skipping...");
    return;
  }

  isReconciliationRunning = true;
  console.log("[CRON] Starting on-chain reconciliation...");

  try {
    const connection = new Connection(process.env.HELIUS_DEVNET_URL!, "confirmed");
    const program = getProgram(connection);
    const traders = await prisma.trader.findMany();
    let totalSynced = 0;
    let totalCreated = 0;

    for (const trader of traders) {
      try {
        const cleanAddress = sanitizeAddress(trader.address);
        const onChainDeals = await fetchAllDealsOnChain(program, connection, [
          { offset: 80, bytes: cleanAddress },
        ]);

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
            const expiresAt = new Date(
              createdAt.getTime() +
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
                minBuyVolume: account.minBuyVolume ? Number(account.minBuyVolume) : null,
                expirationHours: Number(account.expirationWindowInHours),
                holdDurationHours: Number(account.holdDurationInHours),
                escrowVault: account.escrowVault.toBase58(),
                createdAt,
                acceptedAt: createdAt,
                expiresAt,
                isActive: account.isActive,
                isAccepted: true,
                volumeCompleted,
                outcome,
                finalizedAt: !account.isActive ? new Date() : null,
              },
            });

            totalCreated++;
            console.log(
              `[CRON] Reconcile: Created missing deal ${pubkey.slice(0, 8)}... (outcome: ${outcome})`
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
              data: { isActive: false, finalizedAt: new Date(), outcome, volumeCompleted },
            });
            await updateTraderActiveBounties(trader.id);
            totalSynced++;
            console.log(
              `[CRON] Reconcile: Synced finalized deal ${pubkey.slice(0, 8)}... → ${outcome}`
            );
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
            if (
              onChainOutcome &&
              (dbDeal.outcome !== onChainOutcome || Math.abs(onChainVolume - dbVolume) > 0.01)
            ) {
              await prisma.deal.update({
                where: { id: dbDeal.id },
                data: { volumeCompleted: onChainVolume, outcome: onChainOutcome },
              });
              totalSynced++;
              console.log(
                `[CRON] Reconcile: Fixed stale deal ${pubkey.slice(0, 8)}...: ${dbDeal.outcome} → ${onChainOutcome}`
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
        `[CRON] Reconciliation complete: ${totalSynced} synced, ${totalCreated} created`
      );
      await sendSystemAlert(
        "Reconciliation Complete",
        `Synced ${totalSynced} stale deal(s), created ${totalCreated} missing deal(s) from on-chain.`,
        "warning"
      );
    } else {
      console.log("[CRON] Reconciliation complete: DB is in sync");
    }
  } catch (error) {
    console.error("[CRON] Error in reconcileOnChainState:", error);
  } finally {
    isReconciliationRunning = false;
  }
}

// ─── Orphaned Deal Cleanup ────────────────────────────────────────────────────

export async function markOrphanedDeals() {
  console.log("[CRON] Checking for orphaned deals...");

  try {
    const now = new Date();
    const orphanThreshold = new Date(now.getTime() - 60 * 60 * 1000);

    const orphanedDeals = await prisma.deal.findMany({
      where: {
        isActive: true,
        isAccepted: true,
        expiresAt: { lte: orphanThreshold },
      },
      include: { trader: true },
    });

    if (orphanedDeals.length === 0) {
      console.log("[CRON] No orphaned deals found");
      return;
    }

    console.log(`[CRON] Found ${orphanedDeals.length} orphaned deals`);

    for (const deal of orphanedDeals) {
      try {
        await prisma.deal.update({
          where: { id: deal.id },
          data: { isActive: false, outcome: "expired_unfulfilled", finalizedAt: now },
        });
        if (deal.traderId) await updateTraderActiveBounties(deal.traderId);
        console.log(`[CRON] Marked ${deal.publicKey.slice(0, 8)}... as expired_unfulfilled`);
      } catch (error) {
        console.error(`[CRON] Error marking orphaned deal ${deal.publicKey}:`, error);
      }
    }

    await sendSystemAlert(
      "Orphaned Deals Detected",
      `Marked ${orphanedDeals.length} orphaned deal(s) as expired_unfulfilled. These need admin reclaim on-chain.`,
      "warning"
    );
  } catch (error) {
    console.error("[CRON] Error in markOrphanedDeals:", error);
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

export async function runCleanup() {
  console.log("[CRON] Starting cleanup of finalized deals...");
  try {
    const deletedCount = await cleanupFinalizedDeals(24);
    console.log(`[CRON] Cleanup complete, deleted ${deletedCount} deals`);
  } catch (error) {
    console.error("[CRON] Error in cleanup:", error);
  }
}

// ─── New Bounty Notifications ─────────────────────────────────────────────────

export async function checkAndNotifyNewBounties() {
  if (isNewBountyCheckRunning) {
    console.log("[CRON] New bounty check already running, skipping...");
    return;
  }

  isNewBountyCheckRunning = true;
  console.log("[CRON] Checking for new bounties to notify...");

  try {
    const connection = new Connection(process.env.HELIUS_DEVNET_URL!, "confirmed");
    const program = getProgram(connection);
    const allOnChainDeals = await fetchAllDealsOnChain(program, connection);

    const now = Date.now();
    const availableBounties = allOnChainDeals.filter((d) => {
      if (!d.account.isActive || d.account.isAccepted) return false;
      const createdAt = d.account.createdAt.toNumber() * 1000;
      const expiresAt =
        createdAt + d.account.expirationWindowInHours.toNumber() * 60 * 60 * 1000;
      return expiresAt > now;
    });

    console.log(`[CRON] Found ${availableBounties.length} available bounties on-chain`);

    let notified = 0;
    let skipped = 0;

    for (const bounty of availableBounties) {
      const traderAddress = bounty.account.trader.toBase58();
      const dealPubkey = bounty.publicKey.toBase58();
      const createdAt = bounty.account.createdAt.toNumber() * 1000;
      const expiresAt = new Date(
        createdAt + bounty.account.expirationWindowInHours.toNumber() * 60 * 60 * 1000
      );

      const result = await sendNewBountyNotification(traderAddress, {
        dealPubkey,
        token: bounty.account.token.toBase58(),
        targetVolume: Number(bounty.account.targetVolume) / 10 ** 9,
        rewardAmount: Number(bounty.account.rewardAmount) / 10 ** 9,
        expiresAt,
        creatorAddress: bounty.account.creator.toBase58(),
      });

      if (result.sent) notified++;
      else skipped++;

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    console.log(`[CRON] New bounty check complete: ${notified} notified, ${skipped} skipped`);
  } catch (error) {
    console.error("[CRON] Error in checkAndNotifyNewBounties:", error);
  } finally {
    isNewBountyCheckRunning = false;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initCronJobs() {
  if (isInitialized) {
    console.log("[CRON] Already initialized, skipping...");
    return;
  }

  console.log("[CRON] Initializing cron jobs...");

  // Every 1 min: finalize deals (volume met or expired) — runs in-process, no HTTP
  cron.schedule(FINALIZE_CHECK_INTERVAL, () => {
    checkAndFinalizeDeals().catch(console.error);
  });

  // Every 1 min: cancel expired unaccepted deals (still via HTTP, simpler flow)
  cron.schedule(FINALIZE_CHECK_INTERVAL, () => {
    checkAndCancelExpiredDeals().catch(console.error);
  });

  // Every 3 min: sync volume into DB (feeds the finalization trigger above)
  cron.schedule(TRADER_STATS_INTERVAL, () => {
    syncTraderStats().catch(console.error);
  });

  // Every 3 min (offset): reconcile DB with on-chain state
  cron.schedule(RECONCILE_INTERVAL, () => {
    reconcileOnChainState().catch(console.error);
  });

  // Every 1 min: notify traders of new bounties
  cron.schedule(NEW_BOUNTY_CHECK_INTERVAL, () => {
    checkAndNotifyNewBounties().catch(console.error);
  });

  // Every hour: mark deals orphaned >1h past expiry
  cron.schedule(CLEANUP_INTERVAL, () => {
    markOrphanedDeals().catch(console.error);
  });

  // Every hour at :30: clean up old finalized deals from DB
  cron.schedule("30 * * * *", () => {
    runCleanup().catch(console.error);
  });

  // Daily at 9am: send daily summaries
  cron.schedule("0 9 * * *", () => {
    sendDailySummaries().catch(console.error);
  });

  isInitialized = true;
  console.log("[CRON] All cron jobs initialized successfully");
}

export const checkExpiredDeals = checkAndFinalizeDeals;