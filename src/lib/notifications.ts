/**
 * Notification dispatcher service for sending trader notifications
 */

import { prisma } from "./prisma";
import { sendToUser } from "./telegram-bot";
import { fetchTokenMetadata } from "@/utils/tokenMetadata";

// Types of notifications
type NotificationType =
  | "new_bounty"
  | "deal_accepted"
  | "milestone_25"
  | "milestone_50"
  | "milestone_75"
  | "milestone_90"
  | "expiry_24h"
  | "expiry_6h"
  | "expiry_1h"
  | "daily_summary"
  | "finalized_won"
  | "finalized_lost";

interface DealInfo {
  id: number;
  traderId: number;
  token: string;
  targetVolume: number;
  volumeCompleted: number;
  rewardAmount: number;
  expiresAt: Date | null;
}

// Check if notification already sent
async function wasNotificationSent(
  traderId: number,
  dealId: number,
  type: NotificationType
): Promise<boolean> {
  const existing = await prisma.notification_log.findUnique({
    where: {
      traderId_dealId_type: { traderId, dealId, type },
    },
  });
  return !!existing;
}

// Record sent notification
async function recordNotification(
  traderId: number,
  dealId: number,
  type: NotificationType,
  messageId?: number
) {
  try {
    await prisma.notification_log.create({
      data: {
        traderId,
        dealId,
        type,
        messageId: messageId?.toString(),
      },
    });
  } catch (error) {
    // Ignore duplicate errors
    console.log(`[NOTIFICATIONS] Already recorded ${type} for deal ${dealId}`);
  }
}

// Get trader with notification settings
async function getTraderForNotification(traderId: number) {
  return prisma.trader.findUnique({
    where: { id: traderId },
    include: { notificationSettings: true },
  });
}

// Helper: progress bar with colored emoji blocks
function makeProgressBar(percent: number): string {
  const filled = Math.min(10, Math.floor(percent / 10));
  const empty = 10 - filled;
  const filledChar = percent >= 90 ? "🟩" : percent >= 50 ? "🟨" : percent >= 25 ? "🟧" : "🟥";
  return filledChar.repeat(filled) + "⬜".repeat(empty);
}

// Helper: format time remaining
function formatTimeRemaining(expiresAt: Date): string {
  const diff = expiresAt.getTime() - Date.now();
  if (diff <= 0) return "Expired";

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

const USDC_DECIMALS = 9;

// Helper: format USD amount
function formatUSD(amount: number): string {
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Helper: get token ticker via metadata, with orb link
async function formatToken(token: string): Promise<string> {
  let ticker = token.slice(0, 6);
  try {
    const meta = await fetchTokenMetadata(token);
    if (meta?.symbol) ticker = meta.symbol;
    else if (meta?.name) ticker = meta.name;
  } catch {}
  return `<a href="https://orb.helius.dev/account/${token}"><b>${ticker}</b></a>`;
}

/**
 * Send milestone notification (25%, 50%, 75%, 90%)
 */
export async function sendMilestoneNotification(
  deal: DealInfo,
  milestone: 25 | 50 | 75 | 90
) {
  const type = `milestone_${milestone}` as NotificationType;

  const trader = await getTraderForNotification(deal.traderId);

  if (!trader?.telegramUserId) {
    return { sent: false, reason: "no_telegram" };
  }

  if (!trader.notificationSettings?.progressMilestones) {
    return { sent: false, reason: "disabled" };
  }

  if (await wasNotificationSent(deal.traderId, deal.id, type)) {
    return { sent: false, reason: "already_sent" };
  }

  const remaining = deal.targetVolume - deal.volumeCompleted;
  const timeLeft = deal.expiresAt
    ? formatTimeRemaining(deal.expiresAt)
    : "N/A";
  const progressBar = makeProgressBar(milestone);

  let emoji: string;
  let encouragement: string;

  if (milestone >= 90) {
    emoji = "🔥";
    encouragement = "Almost there! Final push!";
  } else if (milestone >= 75) {
    emoji = "💪";
    encouragement = "Great progress! Keep going!";
  } else if (milestone >= 50) {
    emoji = "📈";
    encouragement = "Halfway there!";
  } else {
    emoji = "🚀";
    encouragement = "Good start! Keep the momentum!";
  }

  const tokenDisplay = await formatToken(deal.token);

  const message =
    `${emoji} <b>${milestone}% Milestone Reached!</b>\n\n` +
    `<b>Token:</b> ${tokenDisplay}\n` +
    `<b>Progress:</b> ${progressBar} ${milestone}%\n` +
    `<b>Volume:</b> $${formatUSD(deal.volumeCompleted)} / $${formatUSD(deal.targetVolume)}\n` +
    `<b>Remaining:</b> $${formatUSD(remaining)}\n` +
    `<b>Time Left:</b> ${timeLeft}\n` +
    `<b>Reward:</b> $${formatUSD(deal.rewardAmount)}\n\n` +
    encouragement;

  const result = await sendToUser(trader.telegramUserId, message);

  if (result.success) {
    await recordNotification(deal.traderId, deal.id, type, result.messageId);
    console.log(
      `[NOTIFICATIONS] Sent ${type} to trader ${deal.traderId} for deal ${deal.id}`
    );
  }

  return { sent: result.success };
}

/**
 * Send expiry warning notification (24h, 6h, 1h)
 */
export async function sendExpiryWarning(
  deal: DealInfo & { expiresAt: Date },
  hoursRemaining: 24 | 6 | 1
) {
  const type = `expiry_${hoursRemaining}h` as NotificationType;

  const trader = await getTraderForNotification(deal.traderId);

  if (!trader?.telegramUserId) {
    return { sent: false, reason: "no_telegram" };
  }

  if (!trader.notificationSettings?.expiryWarnings) {
    return { sent: false, reason: "disabled" };
  }

  if (await wasNotificationSent(deal.traderId, deal.id, type)) {
    return { sent: false, reason: "already_sent" };
  }

  const percent = (deal.volumeCompleted / deal.targetVolume) * 100;
  const remaining = deal.targetVolume - deal.volumeCompleted;
  const progressBar = makeProgressBar(percent);

  let emoji: string;
  let urgency: string;

  if (hoursRemaining === 1) {
    emoji = "🚨";
    urgency = "FINAL HOUR!";
  } else if (hoursRemaining === 6) {
    emoji = "⚠️";
    urgency = "Time is running out!";
  } else {
    emoji = "⏰";
    urgency = "24 hours remaining";
  }

  const hitTarget = percent >= 100;
  const tokenDisplay = await formatToken(deal.token);

  const message =
    `${emoji} <b>Deal Expires in ${hoursRemaining} Hour${hoursRemaining > 1 ? "s" : ""}!</b>\n` +
    `<i>${urgency}</i>\n\n` +
    `<b>Token:</b> ${tokenDisplay}\n` +
    `<b>Progress:</b> ${progressBar} ${percent.toFixed(1)}%\n` +
    `<b>Volume:</b> $${formatUSD(deal.volumeCompleted)} / $${formatUSD(deal.targetVolume)}\n` +
    (hitTarget
      ? `\n✅ <b>Target reached!</b> Just hold until expiry.\n`
      : `<b>Still Need:</b> $${formatUSD(remaining)}\n`) +
    `<b>Reward at Stake:</b> $${formatUSD(deal.rewardAmount)}`;

  const result = await sendToUser(trader.telegramUserId, message);

  if (result.success) {
    await recordNotification(deal.traderId, deal.id, type, result.messageId);
    console.log(
      `[NOTIFICATIONS] Sent ${type} to trader ${deal.traderId} for deal ${deal.id}`
    );
  }

  return { sent: result.success };
}

/**
 * Send finalization notification (win/loss)
 */
export async function sendFinalizationNotification(
  deal: DealInfo,
  outcome: "won" | "lost",
  txSignature?: string
) {
  const type = outcome === "won" ? "finalized_won" : "finalized_lost";

  const trader = await getTraderForNotification(deal.traderId);

  if (!trader?.telegramUserId) {
    return { sent: false, reason: "no_telegram" };
  }

  if (!trader.notificationSettings?.dealFinalized) {
    return { sent: false, reason: "disabled" };
  }

  if (await wasNotificationSent(deal.traderId, deal.id, type as NotificationType)) {
    return { sent: false, reason: "already_sent" };
  }

  const percent = (deal.volumeCompleted / deal.targetVolume) * 100;
  const progressBar = makeProgressBar(percent);
  const tokenDisplay = await formatToken(deal.token);

  let message: string;

  if (outcome === "won") {
    const winBar = "🟩".repeat(10);
    message =
      `🟢 <b>DEAL PASSED!</b> 🟢\n\n` +
      `✅ Congratulations! You've completed the bounty.\n\n` +
      `<b>Token:</b> ${tokenDisplay}\n` +
      `<b>Final Volume:</b> ${winBar} ${percent.toFixed(1)}%\n` +
      `<b>Volume:</b> $${formatUSD(deal.volumeCompleted)} / $${formatUSD(deal.targetVolume)}\n\n` +
      `💰 <b>Reward Earned: $${formatUSD(deal.rewardAmount)}</b>\n\n` +
      `Funds have been transferred to your wallet!`;
  } else {
    const failBar = "🟥".repeat(Math.min(10, Math.floor(percent / 10))) + "⬛".repeat(10 - Math.min(10, Math.floor(percent / 10)));
    message =
      `🔴 <b>DEAL FAILED</b> 🔴\n\n` +
      `<b>Token:</b> ${tokenDisplay}\n` +
      `<b>Final Volume:</b> ${failBar} ${percent.toFixed(1)}%\n` +
      `<b>Volume:</b> $${formatUSD(deal.volumeCompleted)} / $${formatUSD(deal.targetVolume)}\n\n` +
      `❌ Volume target was not reached in time.\n\n` +
      `<b>Reward Lost:</b> $${formatUSD(deal.rewardAmount)}\n\n` +
      `Better luck next time — more bounties are waiting.`;
  }

  const replyMarkup = txSignature
    ? {
        inline_keyboard: [
          [{ text: "View Transaction", url: `https://explorer.solana.com/tx/${txSignature}?cluster=devnet` }],
        ],
      }
    : undefined;

  const result = await sendToUser(trader.telegramUserId, message, { replyMarkup });

  if (result.success) {
    await recordNotification(deal.traderId, deal.id, type as NotificationType, result.messageId);
    console.log(
      `[NOTIFICATIONS] Sent ${type} to trader ${deal.traderId} for deal ${deal.id}`
    );
  }

  return { sent: result.success };
}

/**
 * Send daily summary to all traders with active deals
 */
export async function sendDailySummaries() {
  const traders = await prisma.trader.findMany({
    where: {
      telegramUserId: { not: null },
      deals: {
        some: { isActive: true, isAccepted: true },
      },
    },
    include: {
      notificationSettings: true,
      deals: {
        where: { isActive: true, isAccepted: true },
        orderBy: { expiresAt: "asc" },
      },
    },
  });

  let sent = 0;
  let skipped = 0;

  for (const trader of traders) {
    if (!trader.telegramUserId) continue;
    if (!trader.notificationSettings?.dailySummary) {
      skipped++;
      continue;
    }
    if (trader.deals.length === 0) continue;

    const dealSummaries = await Promise.all(trader.deals.map(async (deal) => {
      const target = Number(deal.targetVolume) / 10 ** USDC_DECIMALS;
      const completed = Number(deal.volumeCompleted ?? 0);
      const percent = target > 0 ? (completed / target) * 100 : 0;
      const timeLeft = deal.expiresAt
        ? formatTimeRemaining(deal.expiresAt)
        : "N/A";
      const progressBar = makeProgressBar(percent);
      const tokenDisplay = await formatToken(deal.token);

      const status =
        percent >= 100 ? "✅" : percent >= 75 ? "🔥" : percent >= 50 ? "📈" : "⏳";

      return (
        `${status} ${tokenDisplay}\n` +
        `   ${progressBar} ${percent.toFixed(0)}%\n` +
        `   $${formatUSD(completed)} / $${formatUSD(target)}\n` +
        `   ⏰ ${timeLeft} | 💰 $${formatUSD(Number(deal.rewardAmount) / 10 ** USDC_DECIMALS)}`
      );
    }));

    const totalReward = trader.deals.reduce(
      (sum, d) => sum + Number(d.rewardAmount) / 10 ** USDC_DECIMALS,
      0
    );

    const date = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });

    const message =
      `📊 <b>Daily Summary</b>\n` +
      `<i>${date}</i>\n\n` +
      `<b>Active Deals:</b> ${trader.deals.length}\n` +
      `<b>Total Rewards at Stake:</b> $${formatUSD(totalReward)}\n\n` +
      dealSummaries.join("\n\n");

    const result = await sendToUser(trader.telegramUserId, message);
    if (result.success) {
      sent++;
    }

    // Rate limiting
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(
    `[NOTIFICATIONS] Daily summaries sent: ${sent}, skipped: ${skipped}`
  );
  return { sent, skipped };
}

/**
 * Check and send milestone notifications for a deal
 * Call this after updating volumeCompleted
 */
export async function checkAndSendMilestoneNotifications(
  deal: DealInfo,
  previousVolume: number
) {
  const target = deal.targetVolume;
  const previousPercent = (previousVolume / target) * 100;
  const newPercent = (deal.volumeCompleted / target) * 100;

  const milestones = [25, 50, 75, 90] as const;

  for (const milestone of milestones) {
    // Check if we just crossed this milestone
    if (previousPercent < milestone && newPercent >= milestone) {
      await sendMilestoneNotification(deal, milestone);
    }
  }
}

/**
 * Check and send expiry warnings for a deal
 * Call this periodically (e.g., every minute from cron)
 */
export async function checkAndSendExpiryWarnings(deal: DealInfo) {
  if (!deal.expiresAt) return;

  const hoursUntilExpiry =
    (deal.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);

  // Only send if within the window and hasn't been sent
  if (hoursUntilExpiry <= 24 && hoursUntilExpiry > 6) {
    await sendExpiryWarning({ ...deal, expiresAt: deal.expiresAt }, 24);
  } else if (hoursUntilExpiry <= 6 && hoursUntilExpiry > 1) {
    await sendExpiryWarning({ ...deal, expiresAt: deal.expiresAt }, 6);
  } else if (hoursUntilExpiry <= 1 && hoursUntilExpiry > 0) {
    await sendExpiryWarning({ ...deal, expiresAt: deal.expiresAt }, 1);
  }
}

interface NewBountyInfo {
  dealPubkey: string;
  token: string;
  targetVolume: number;
  rewardAmount: number;
  expiresAt: Date;
  creatorAddress: string;
}

/**
 * Send notification when a new bounty is available for a trader
 */
export async function sendNewBountyNotification(
  traderAddress: string,
  bounty: NewBountyInfo
) {
  const trader = await prisma.trader.findUnique({
    where: { address: traderAddress },
    include: { notificationSettings: true },
  });

  if (!trader?.telegramUserId) {
    return { sent: false, reason: "no_telegram" };
  }

  if (!trader.notificationSettings?.newBountyAvailable) {
    return { sent: false, reason: "disabled" };
  }

  // Use dealPubkey as a unique identifier for the notification
  // We store null for dealId since the deal isn't in our DB yet
  const existingLog = await prisma.notification_log.findFirst({
    where: {
      traderId: trader.id,
      type: "new_bounty",
      messageId: bounty.dealPubkey, // Using messageId field to store dealPubkey for uniqueness
    },
  });

  if (existingLog) {
    return { sent: false, reason: "already_sent" };
  }

  const timeLeft = formatTimeRemaining(bounty.expiresAt);
  const tokenDisplay = await formatToken(bounty.token);
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const dealUrl = `${baseUrl}/deal/${bounty.dealPubkey}`;

  const message =
    `🆕 <b>New Bounty Available!</b>\n\n` +
    `Someone just created a bounty for you!\n\n` +
    `<b>Token:</b> ${tokenDisplay}\n` +
    `<b>Target Volume:</b> $${formatUSD(bounty.targetVolume)}\n` +
    `<b>Reward:</b> 💰 <b>$${formatUSD(bounty.rewardAmount)}</b>\n` +
    `<b>Time to Complete:</b> ${timeLeft}\n\n` +
    `<a href="${dealUrl}">View & Accept Bounty →</a>`;

  const result = await sendToUser(trader.telegramUserId, message, {
    replyMarkup: {
      inline_keyboard: [[{ text: "🎯 View Bounty", url: dealUrl }]],
    },
  });

  if (result.success) {
    try {
      await prisma.notification_log.create({
        data: {
          traderId: trader.id,
          dealId: null,
          type: "new_bounty",
          messageId: bounty.dealPubkey, // Store dealPubkey for dedup
        },
      });
    } catch {
      // Ignore duplicate errors
    }
    console.log(
      `[NOTIFICATIONS] Sent new_bounty to trader ${trader.address.slice(0, 8)}... for deal ${bounty.dealPubkey.slice(0, 8)}...`
    );
  }

  return { sent: result.success };
}
