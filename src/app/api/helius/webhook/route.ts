import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isWebhookProcessed,
  markWebhookProcessed,
  getDealsForWallet,
} from "@/lib/volume-cache";
import {
  broadcastVolumeUpdate,
  broadcastMilestone,
  storePendingEvent,
} from "@/lib/sse-broadcaster";
import { getActiveWebhookId } from "@/lib/helius-webhooks";
import { checkAndSendMilestoneNotifications } from "@/lib/notifications";
import { getTokenPrices } from "@/utils/getTokenPrice";

const DEX_SOURCES = [
  "JUPITER",
  "RAYDIUM",
  "DFLOW",
  "ORCA",
  "METEORA",
  "PHOENIX",
  "LIFINITY",
  "OPENBOOK",
  "PUMP_FUN",
  "MOONSHOT",
];

interface HeliusTokenTransfer {
  mint: string;
  tokenAmount: number;
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
}

interface HeliusAccountData {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges: Array<{
    mint: string;
    rawTokenAmount: {
      decimals: number;
      tokenAmount: string;
    };
    tokenAccount: string;
    userAccount: string;
  }>;
}

interface HeliusWebhookPayload {
  signature: string;
  type: string;
  source: string;
  timestamp: number;
  feePayer: string;
  tokenTransfers?: HeliusTokenTransfer[];
  accountData?: HeliusAccountData[];
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
}

function extractSwapDetails(
  tx: HeliusWebhookPayload,
  walletAddress: string
): Array<{ tokenMint: string; tokenAmount: number; volumeUSD: number }> | null {
  if (tx.type !== "SWAP" || !DEX_SOURCES.includes(tx.source)) {
    return null;
  }

  const swaps: Array<{ tokenMint: string; tokenAmount: number; volumeUSD: number }> = [];
  const walletLower = walletAddress.toLowerCase();

  if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
    for (const transfer of tx.tokenTransfers) {
      if (transfer.toUserAccount?.toLowerCase() === walletLower) {
        const amount = Math.abs(transfer.tokenAmount || 0);
        if (amount > 0) {
          swaps.push({
            tokenMint: transfer.mint,
            tokenAmount: amount,
            volumeUSD: 0,
          });
        }
      }
    }
  }

  if (swaps.length === 0 && tx.accountData) {
    for (const account of tx.accountData) {
      for (const change of account.tokenBalanceChanges || []) {
        const userMatch =
          account.account?.toLowerCase() === walletLower ||
          change.userAccount?.toLowerCase() === walletLower;

        if (userMatch) {
          const decimals = change.rawTokenAmount?.decimals || 0;
          const rawAmount = parseFloat(change.rawTokenAmount?.tokenAmount || "0");

          if (rawAmount > 0) {
            const amount = rawAmount / Math.pow(10, decimals);
            swaps.push({
              tokenMint: change.mint,
              tokenAmount: amount,
              volumeUSD: 0,
            });
          }
        }
      }
    }
  }

  return swaps.length > 0 ? swaps : null;
}

export async function POST(req: NextRequest) {
  console.log("[HELIUS_WEBHOOK] ========== WEBHOOK RECEIVED ==========");
  console.log("[HELIUS_WEBHOOK] Timestamp:", new Date().toISOString());

  const secret = req.headers.get("x-helius-secret") || req.headers.get("authorization");
  const expectedSecret = process.env.HELIUS_WEBHOOK_SECRET;

  if (expectedSecret && secret !== expectedSecret && secret !== `Bearer ${expectedSecret}`) {
    console.warn("[HELIUS_WEBHOOK] Invalid secret");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await req.json();
    const transactions: HeliusWebhookPayload[] = Array.isArray(payload) ? payload : [payload];

    console.log(`[HELIUS_WEBHOOK] Received ${transactions.length} transaction(s)`);

    let processed = 0;
    let skipped = 0;

    for (const tx of transactions) {
      if (await isWebhookProcessed(tx.signature)) {
        skipped++;
        continue;
      }

      await markWebhookProcessed(tx.signature);

      const walletAddress = tx.feePayer;
      if (!walletAddress) continue;

      const swaps = extractSwapDetails(tx, walletAddress);
      if (!swaps || swaps.length === 0) continue;

      const cachedDeals = await getDealsForWallet(walletAddress);

      const dbDeals = await prisma.deal.findMany({
        where: {
          traderAddress: walletAddress,
          isActive: true,
          isAccepted: true,
        },
        select: {
          id: true,
          publicKey: true,
          traderId: true,
          token: true,
          targetVolume: true,
          rewardAmount: true,
          acceptedAt: true,
          expiresAt: true,
        },
      });

      const dealMap = new Map<string, {
        dealPubkey: string;
        tokenMint: string;
        startTime: number;
        expiresAt: number;
        targetVolume: number;
        traderId: number;
        dealId: number;
        rewardAmount: number;
      }>();

      for (const cached of cachedDeals) {
        dealMap.set(cached.dealPubkey, {
          ...cached,
          targetVolume: 0,
          traderId: 0,
          dealId: 0,
          rewardAmount: 0,
        });
      }

      for (const db of dbDeals) {
        dealMap.set(db.publicKey, {
          dealPubkey: db.publicKey,
          tokenMint: db.token,
          startTime: db.acceptedAt ? Math.floor(db.acceptedAt.getTime() / 1000) : 0,
          expiresAt: db.expiresAt ? db.expiresAt.getTime() : 0,
          targetVolume: Number(db.targetVolume) / 10 ** 9,
          traderId: db.traderId,
          dealId: db.id,
          rewardAmount: Number(db.rewardAmount) / 10 ** 9,
        });
      }

      const uniqueTokenMints = [...new Set(swaps.map(s => s.tokenMint))];
      const tokenPrices = await getTokenPrices(uniqueTokenMints);

      for (const swap of swaps) {
        const tokenPrice = tokenPrices.get(swap.tokenMint) || null;
        swap.volumeUSD = tokenPrice ? swap.tokenAmount * tokenPrice : 0;
      }

      for (const swap of swaps) {
        for (const deal of dealMap.values()) {
          if (deal.tokenMint.toLowerCase() !== swap.tokenMint.toLowerCase()) continue;
          if (tx.timestamp < deal.startTime || (deal.expiresAt > 0 && tx.timestamp * 1000 > deal.expiresAt)) continue;

          const dbDeal = await prisma.deal.findUnique({
            where: { publicKey: deal.dealPubkey },
            select: { volumeCompleted: true },
          });
          const previousVolume = Number(dbDeal?.volumeCompleted ?? 0);
          const newVolume = previousVolume + swap.volumeUSD;

          console.log(
            `[HELIUS_WEBHOOK] Match: ${tx.signature.slice(0, 8)}... → Deal ${deal.dealPubkey.slice(0, 8)}... ($${previousVolume.toFixed(2)} + $${swap.volumeUSD.toFixed(2)} = $${newVolume.toFixed(2)})`
          );

          const progress = deal.targetVolume > 0 ? (newVolume / deal.targetVolume) * 100 : 0;

          await broadcastVolumeUpdate(deal.dealPubkey, walletAddress, newVolume, 0, deal.targetVolume);

          await storePendingEvent(deal.dealPubkey, {
            type: "volume_update",
            dealPublicKey: deal.dealPubkey,
            data: {
              volumeUSD: newVolume,
              totalVolume: 0,
              progress,
              timestamp: Date.now(),
            },
          });

          if (deal.traderId > 0 && deal.dealId > 0) {
            const milestones = [25, 50, 75, 90] as const;
            const previousPercent = deal.targetVolume > 0 ? (previousVolume / deal.targetVolume) * 100 : 0;

            for (const milestone of milestones) {
              if (previousPercent < milestone && progress >= milestone) {
                await broadcastMilestone(deal.dealPubkey, walletAddress, milestone, newVolume, progress);

                await checkAndSendMilestoneNotifications(
                  {
                    id: deal.dealId,
                    traderId: deal.traderId,
                    token: deal.tokenMint,
                    targetVolume: deal.targetVolume,
                    volumeCompleted: newVolume,
                    rewardAmount: deal.rewardAmount,
                    expiresAt: deal.expiresAt > 0 ? new Date(deal.expiresAt) : null,
                  },
                  previousVolume
                );

                console.log(`[HELIUS_WEBHOOK] Milestone ${milestone}% reached for deal ${deal.dealPubkey.slice(0, 8)}...`);
              }
            }
          }

          try {
            await prisma.deal.update({
              where: { publicKey: deal.dealPubkey },
              data: { volumeCompleted: newVolume },
            });
          } catch (dbError) {
            console.error(`[HELIUS_WEBHOOK] DB update failed for ${deal.dealPubkey}:`, dbError);
          }

          processed++;
        }
      }
    }

    console.log(`[HELIUS_WEBHOOK] Processed: ${processed}, Skipped: ${skipped}`);

    return NextResponse.json({ ok: true, processed, skipped });
  } catch (error) {
    console.error("[HELIUS_WEBHOOK] Error:", error);
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function GET() {
  const webhookId = getActiveWebhookId();
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.VERCEL_URL;

  return NextResponse.json({
    status: "ok",
    endpoint: "helius-webhook",
    timestamp: Date.now(),
    config: {
      webhookIdConfigured: !!webhookId,
      webhookIdPrefix: webhookId ? webhookId.slice(0, 8) + "..." : null,
      apiKeyConfigured: !!process.env.HELIUS_API_KEY,
      secretConfigured: !!process.env.HELIUS_WEBHOOK_SECRET,
      expectedWebhookUrl: baseUrl ? `${baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`}/api/helius/webhook` : null,
    },
    message: !webhookId
      ? "HELIUS_WEBHOOK_ID not set - call POST /api/helius/manage with {action:'sync'}"
      : "Webhook configured",
  });
}
