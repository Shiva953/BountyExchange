/**
 * Telegram Bot Service for trader wallet linking and notifications
 */

import { prisma } from "./prisma";
import { Connection } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";
import { fetchTokenMetadata } from "@/utils/tokenMetadata";
import { calculateTokenVolumeFast } from "@/utils/calculateTokenVolume";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://devnet.helius-rpc.com/?api-key=e8dd8baa-d6a6-4cae-a097-3cd6cdcef462";
const BOT_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number };
    data: string;
  };
}

export async function sendToUser(
  telegramUserId: string,
  message: string,
  options?: {
    parseMode?: "HTML" | "Markdown";
    replyMarkup?: object;
  }
): Promise<{ success: boolean; messageId?: number }> {
  try {
    const response = await fetch(`${BOT_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramUserId,
        text: message,
        parse_mode: options?.parseMode ?? "HTML",
        disable_web_page_preview: true,
        reply_markup: options?.replyMarkup,
      }),
    });

    const data = await response.json();
    if (!data.ok) {
      console.error("[TG_BOT] Send failed:", data.description, "| error_code:", data.error_code);
      return { success: false };
    }
    console.log("[TG_BOT] Message sent successfully, messageId:", data.result.message_id);
    return { success: true, messageId: data.result.message_id };
  } catch (error) {
    console.error("[TG_BOT] Error:", error);
    return { success: false };
  }
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  try {
    await fetch(`${BOT_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text,
        show_alert: false,
      }),
    });
  } catch (error) {
    console.error("[TG_BOT] Error answering callback:", error);
  }
}

async function editMessage(
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: object
) {
  try {
    await fetch(`${BOT_API}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }),
    });
  } catch (error) {
    console.error("[TG_BOT] Error editing message:", error);
  }
}

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

function createLoadingSpinner(chatId: string, messageId: number) {
  let frameIndex = 0;
  let stopped = false;

  const interval = setInterval(async () => {
    if (stopped) return;
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    await editMessage(chatId, messageId, `${frame} <i>Loading...</i>`);
    frameIndex++;
  }, 400);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

function generateVerifyCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function handleStart(telegramUserId: string, firstName: string, startParam?: string) {
  console.log(`[TG_BOT] handleStart called: userId=${telegramUserId}, startParam=${startParam}`);

  const existing = await prisma.trader.findFirst({
    where: { telegramUserId },
  });
  console.log(`[TG_BOT] Existing trader:`, existing ? existing.address : "none");

  if (existing) {
    await sendToUser(
      telegramUserId,
      `<b>Your wallet is already linked!</b>\n\n` +
        `<b>Wallet:</b>\n<code>${existing.address}</code>\n\n` +
        `Use /status to see your active deals.\n` +
        `Use /settings to configure notifications.\n` +
        `Use /unlink to disconnect.`
    );
    return;
  }

  if (startParam && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(startParam)) {
    await handleWalletSubmission(telegramUserId, startParam);
    return;
  }

  await sendToUser(
    telegramUserId,
    `🟢 <b>Welcome to Bounty Exchange, ${firstName}!</b>\n\n` +
      `To receive notifications about your deals, link your Solana wallet.\n\n` +
      `<b>Send me your wallet address</b> to get started.\n\n` +
      `<i>Example:</i> <code>7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU</code>`
  );
}

async function handleWalletSubmission(
  telegramUserId: string,
  walletAddress: string
) {
  console.log(`[TG_BOT] handleWalletSubmission called: userId=${telegramUserId}, wallet=${walletAddress.slice(0, 8)}...`);

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    console.log(`[TG_BOT] Invalid wallet format`);
    await sendToUser(telegramUserId, "Invalid wallet address format. Please send a valid Solana wallet address.");
    return;
  }

  let trader = await prisma.trader.findUnique({
    where: { address: walletAddress },
  });

  if (!trader) {
    trader = await prisma.trader.create({
      data: {
        address: walletAddress,
        activeBounties: 0,
        volumeCompleted: 0,
      },
    });
    console.log(`[TG_BOT] Created new trader record for ${walletAddress.slice(0, 8)}...`);
  }

  if (trader.telegramUserId) {
    if (trader.telegramUserId === telegramUserId) {
      await sendToUser(
        telegramUserId,
        `This wallet is already linked to your account!\n\n` +
          `Use /status to see your deals.`
      );
    } else {
      await sendToUser(
        telegramUserId,
        `This wallet is already linked to another Telegram account.\n\n` +
          `If you own this wallet, please unlink it from the other account first.`
      );
    }
    return;
  }

  const verifyCode = generateVerifyCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.wallet_verification.deleteMany({
    where: { telegramUserId },
  });

  await prisma.wallet_verification.create({
    data: {
      telegramUserId,
      walletAddress,
      verifyCode,
      expiresAt,
    },
  });

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/verify/${verifyCode}`;
  const isLocalhost = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");

  console.log(`[TG_BOT] Sending verification message with code: ${verifyCode}`);

  const result = isLocalhost
    ? await sendToUser(
        telegramUserId,
        `<b>Verification Required</b>\n\n` +
          `To prove you own this wallet, please sign a message on our website.\n\n` +
          `<b>Click here:</b> ${verifyUrl}\n\n` +
          `Code: <code>${verifyCode}</code>\n` +
          `Expires in 10 minutes.`
      )
    : await sendToUser(
        telegramUserId,
        `<b>Verification Required</b>\n\n` +
          `To prove you own this wallet, please sign a message on our website.\n\n` +
          `Code: <code>${verifyCode}</code>\n` +
          `Expires in 10 minutes.`,
        {
          replyMarkup: {
            inline_keyboard: [
              [{ text: "✓ Verify Wallet", url: verifyUrl }],
            ],
          },
        }
      );

  console.log(`[TG_BOT] Verification message send result:`, result);
}

async function handleStatus(telegramUserId: string) {
  const { wallet: walletAddress, dbError } = await getLinkedWallet(telegramUserId);

  if (dbError) {
    await sendToUser(
      telegramUserId,
      `🔴 <b>Database Error</b>\n\n` +
        `<i>Could not look up your linked wallet. The database may be temporarily unavailable.</i>\n` +
        `Please try again in a moment.`
    );
    return;
  }

  if (!walletAddress) {
    await sendToUser(
      telegramUserId,
      `No wallet linked. Use /start to link your wallet.`
    );
    return;
  }

  const loadingResult = await sendToUser(
    telegramUserId,
    `◐ <i>Loading...</i>`
  );

  const spinner = loadingResult.messageId
    ? createLoadingSpinner(telegramUserId, loadingResult.messageId)
    : null;

  const allTraderDeals = await fetchDealsForTrader(walletAddress);

  const activeDeals = allTraderDeals.filter(d => d.isActive && d.isAccepted && d.expiresAt.getTime() > Date.now());
  const expiredPending = allTraderDeals.filter(d => d.isActive && d.isAccepted && d.expiresAt.getTime() <= Date.now() && d.outcome === null);
  const finalizedDeals = allTraderDeals.filter(d => d.outcome !== null).slice(-5); // last 5 finalized

  console.log(`[TG_BOT:STATUS] Deals for ${walletAddress.slice(0, 8)}...: ${activeDeals.length} active, ${expiredPending.length} expired-pending, ${finalizedDeals.length} finalized`);

  if (activeDeals.length === 0 && expiredPending.length === 0 && finalizedDeals.length === 0) {
    spinner?.stop();
    if (loadingResult.messageId) {
      try {
        await fetch(`${BOT_API}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: telegramUserId, message_id: loadingResult.messageId }),
        });
      } catch {}
    }

    await sendToUser(
      telegramUserId,
      `🟡 <b>No Deals Found</b>\n\n` +
        `<i>You don't have any deals on-chain right now.</i>\n\n` +
        `Wallet: <code>${walletAddress}</code>`
    );
    return;
  }

  const allDisplayDeals = [...activeDeals, ...expiredPending, ...finalizedDeals];
  for (const deal of allDisplayDeals) {
    try {
      deal.tokenMetadata = await fetchTokenMetadata(deal.token);
    } catch {
      deal.tokenMetadata = null;
    }
  }

  const volumeResults: Map<string, { volumeUSD: number; percent: number }> = new Map();
  for (const deal of activeDeals) {
    try {
      const startTime = Math.floor(deal.createdAt.getTime() / 1000);
      const endTime = Math.floor(deal.expiresAt.getTime() / 1000);
      console.log(`[TG_BOT:STATUS] Calculating volume for deal ${deal.publicKey.slice(0, 8)}... token=${deal.token.slice(0, 8)}...`);
      const result = await calculateTokenVolumeFast(
        walletAddress,
        deal.token,
        startTime,
        endTime,
        deal.minBuyVolume ? deal.minBuyVolume : undefined
      );
      const volumeUSD = result.volumeUSD;
      const percent = deal.targetVolume > 0 ? (volumeUSD / (deal.targetVolume)) * 100 : 0;
      volumeResults.set(deal.publicKey, { volumeUSD, percent });
      console.log(`[TG_BOT:STATUS] Volume for ${deal.publicKey.slice(0, 8)}...: $${volumeUSD.toFixed(2)} (${percent.toFixed(1)}%)`);
    } catch (err) {
      console.error(`[TG_BOT:STATUS] Volume calc failed for deal ${deal.publicKey.slice(0, 8)}...:`, err);
      volumeResults.set(deal.publicKey, { volumeUSD: 0, percent: 0 });
    }
  }

  spinner?.stop();
  if (loadingResult.messageId) {
    try {
      await fetch(`${BOT_API}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: telegramUserId, message_id: loadingResult.messageId }),
      });
    } catch {}
  }

  let message = `🟢 <b>Your Deals</b>\n<i>Wallet: </i><code>${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}</code>\n`;

  if (activeDeals.length > 0) {
    message += `\n<b>📋 Active Deals (${activeDeals.length})</b>\n\n`;
    const dealLines = activeDeals.map((deal, i) => {
      const vol = volumeResults.get(deal.publicKey) || { volumeUSD: 0, percent: 0 };
      const progressBar = makeProgressBar(vol.percent);
      const timeBar = getTimeBar(deal.expiresAt);
      const timeLeft = formatTimeRemaining(deal.expiresAt);

      return (
        `<b>${i + 1}.</b> ${formatTokenDisplay(deal)}\n` +
        `   ${progressBar} ${vol.percent.toFixed(1)}%\n` +
        `   $${vol.volumeUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })} / $${deal.targetVolume.toLocaleString()}\n` +
        `   💰 Reward: <b>$${deal.rewardAmount.toLocaleString()}</b>\n` +
        `   ${timeBar} Expires: <i>${timeLeft}</i>`
      );
    });
    message += dealLines.join("\n\n");
  }

  if (expiredPending.length > 0) {
    message += `\n\n<b>⏳ Awaiting Finalization (${expiredPending.length})</b>\n\n`;
    const lines = expiredPending.map((deal, i) => {
      return (
        `🟠 <b>${i + 1}.</b> ${formatTokenDisplay(deal)}\n` +
        `   💰 $${deal.rewardAmount.toLocaleString()} reward\n` +
        `   <i>Expired — awaiting crank finalization</i>`
      );
    });
    message += lines.join("\n\n");
  }

  if (finalizedDeals.length > 0) {
    message += `\n\n<b>🏁 Recent Results</b>\n\n`;
    const lines = finalizedDeals.map((deal) => {
      const won = deal.outcome === true;
      const icon = won ? "🟢" : "🔴";
      const label = won ? "✅ PASSED" : "❌ FAILED";
      const volStr = deal.volumeCompletedUsd !== null ? `$${deal.volumeCompletedUsd.toLocaleString()}` : "N/A";
      return `${icon} ${formatTokenDisplay(deal)} — <b>${label}</b>\n   Vol: ${volStr} / $${deal.targetVolume.toLocaleString()} | 💰 $${deal.rewardAmount.toLocaleString()}`;
    });
    message += lines.join("\n");
  }

  await sendToUser(telegramUserId, message);
}

async function handleSettings(telegramUserId: string, messageId?: number, chatId?: string) {
  const trader = await prisma.trader.findFirst({
    where: { telegramUserId },
    include: { notificationSettings: true },
  });

  if (!trader) {
    await sendToUser(telegramUserId, `No wallet linked. Use /start first.`);
    return;
  }

  let settings = trader.notificationSettings;
  if (!settings) {
    settings = await prisma.notification_settings.create({
      data: {
        traderId: trader.id,
      },
    });
  }

  const on = "✅";
  const off = "❌";

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: `${settings.progressMilestones ? on : off} Progress (25/50/75/90%)`,
          callback_data: "toggle_progressMilestones",
        },
      ],
      [
        {
          text: `${settings.expiryWarnings ? on : off} Expiry Warnings`,
          callback_data: "toggle_expiryWarnings",
        },
      ],
      [
        {
          text: `${settings.dailySummary ? on : off} Daily Summary`,
          callback_data: "toggle_dailySummary",
        },
      ],
      [
        {
          text: `${settings.dealFinalized ? on : off} Win/Loss Results`,
          callback_data: "toggle_dealFinalized",
        },
      ],
    ],
  };

  const text = `<b>⚙️ Notification Settings</b>\n\nTap to toggle:`;

  if (messageId && chatId) {
    await editMessage(chatId, messageId, text, keyboard);
  } else {
    await sendToUser(telegramUserId, text, { replyMarkup: keyboard });
  }
}

async function handleUnlink(telegramUserId: string) {
  const trader = await prisma.trader.findFirst({
    where: { telegramUserId },
  });

  if (!trader) {
    await sendToUser(telegramUserId, `No wallet is currently linked.`);
    return;
  }

  await prisma.trader.update({
    where: { id: trader.id },
    data: { telegramUserId: null, telegramLinkedAt: null },
  });

  await prisma.notification_settings.deleteMany({
    where: { traderId: trader.id },
  });

  await sendToUser(
    telegramUserId,
    `🔴 <b>Wallet Unlinked</b>\n\n` +
      `<i>You will no longer receive notifications for your deals.</i>\n` +
      `Use /start to link a wallet again.`
  );
}

const settingNames: Record<string, string> = {
  dealAccepted: "Deal Accepted",
  progressMilestones: "Progress Updates",
  dailySummary: "Daily Summary",
  expiryWarnings: "Expiry Warnings",
  dealFinalized: "Win/Loss Results",
};

async function handleCallbackQuery(query: {
  id: string;
  from: { id: number };
  message?: { chat: { id: number }; message_id: number };
  data: string;
}) {
  const telegramUserId = query.from.id.toString();

  if (!query.data.startsWith("toggle_")) {
    await answerCallbackQuery(query.id);
    return;
  }

  const field = query.data.replace("toggle_", "") as
    | "dealAccepted"
    | "progressMilestones"
    | "dailySummary"
    | "expiryWarnings"
    | "dealFinalized";

  const trader = await prisma.trader.findFirst({
    where: { telegramUserId },
    include: { notificationSettings: true },
  });

  if (!trader || !trader.notificationSettings) {
    await answerCallbackQuery(query.id);
    return;
  }

  const currentValue = trader.notificationSettings[field];
  const newValue = !currentValue;

  await prisma.notification_settings.update({
    where: { traderId: trader.id },
    data: { [field]: newValue },
  });

  const settingName = settingNames[field] || field;
  const statusText = newValue ? "ON" : "OFF";
  await answerCallbackQuery(query.id, `${settingName}: ${statusText}`);

  if (query.message) {
    await handleSettings(
      telegramUserId,
      query.message.message_id,
      query.message.chat.id.toString()
    );
  }

  const emoji = newValue ? "✅" : "❌";
  const confirmResult = await sendToUser(
    telegramUserId,
    `${emoji} <b>${settingName}</b> is now <b>${statusText}</b>`
  );

  if (confirmResult.messageId) {
    setTimeout(async () => {
      try {
        await fetch(`${BOT_API}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: telegramUserId, message_id: confirmResult.messageId }),
        });
      } catch {}
    }, 5000);
  }
}

interface OnChainDeal {
  publicKey: string;
  creator: string;
  trader: string;
  token: string;
  rewardAmount: number;
  targetVolume: number;
  minBuyVolume: number | null;
  expiresAt: Date;
  createdAt: Date;
  isActive: boolean;
  isAccepted: boolean;
  outcome: boolean | null;
  volumeCompletedUsd: number | null;
  tokenMetadata?: { name?: string; symbol?: string } | null;
}

async function fetchAllDealsOnChain(): Promise<OnChainDeal[]> {
  const startTime = Date.now();
  console.log(`[TG_BOT:CHAIN] Fetching all deal accounts... RPC: ${RPC_URL}`);

  try {
    const connection = new Connection(RPC_URL, "confirmed");
    const program = getProgram(connection);

    const fetchStart = Date.now();
    const allDeals = await program.account.deal.all();
    const fetchDuration = Date.now() - fetchStart;

    console.log(`[TG_BOT:CHAIN] Fetched ${allDeals.length} deal accounts in ${fetchDuration}ms`);

    if (allDeals.length === 0) {
      console.log(`[TG_BOT:CHAIN] No deal accounts found on-chain. Check program ID and RPC.`);
      return [];
    }

    const deals: OnChainDeal[] = [];

    for (const deal of allDeals) {
      const account = deal.account;
      const createdAtMs = account.createdAt.toNumber() * 1000;
      const expirationMs = account.expirationWindowInHours.toNumber() * 60 * 60 * 1000;

      deals.push({
        publicKey: deal.publicKey.toBase58(),
        creator: account.creator.toBase58(),
        trader: account.trader.toBase58(),
        token: account.token.toBase58(),
        rewardAmount: account.rewardAmount.toNumber() / 10 ** 9,
        targetVolume: account.targetVolume.toNumber() / 10 ** 9,
        minBuyVolume: account.minBuyVolume ? account.minBuyVolume.toNumber() / 10 ** 9 : null,
        expiresAt: new Date(createdAtMs + expirationMs),
        createdAt: new Date(createdAtMs),
        isActive: account.isActive,
        isAccepted: account.isAccepted,
        outcome: account.outcome ?? null,
        volumeCompletedUsd: account.volumeCompletedUsd ? account.volumeCompletedUsd.toNumber() / 10 ** 9 : null,
      });
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[TG_BOT:CHAIN] Parsed ${deals.length} deals in ${totalDuration}ms`);
    return deals;
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    console.error(`[TG_BOT:CHAIN] FATAL error after ${totalDuration}ms:`, error);
    return [];
  }
}

async function fetchDealsForTrader(walletAddress: string): Promise<OnChainDeal[]> {
  console.log(`[TG_BOT:CHAIN] Fetching deals for trader ${walletAddress.slice(0, 8)}...`);
  const allDeals = await fetchAllDealsOnChain();
  const traderDeals = allDeals.filter(d => d.trader === walletAddress);
  console.log(`[TG_BOT:CHAIN] Found ${traderDeals.length} deals for trader ${walletAddress.slice(0, 8)}...`);
  return traderDeals;
}

async function getLinkedWallet(telegramUserId: string): Promise<{ wallet: string | null; dbError: boolean }> {
  try {
    const trader = await prisma.trader.findFirst({
      where: { telegramUserId },
      select: { address: true },
    });
    return { wallet: trader?.address ?? null, dbError: false };
  } catch (error) {
    console.error(`[TG_BOT] DB error looking up wallet for TG user ${telegramUserId}:`, error);
    return { wallet: null, dbError: true };
  }
}

async function fetchAvailableBountiesOnChain(walletAddress: string): Promise<OnChainDeal[]> {
  const startTime = Date.now();
  console.log(`[TG_BOT:BOUNTIES] Starting on-chain fetch for trader ${walletAddress.slice(0, 8)}...`);

  const allDeals = await fetchAllDealsOnChain();

  let skippedInactive = 0;
  let skippedAccepted = 0;
  let skippedNotTargeted = 0;
  let skippedExpired = 0;

  const available: OnChainDeal[] = [];
  const now = new Date();

  for (const deal of allDeals) {
    if (!deal.isActive) { skippedInactive++; continue; }
    if (deal.isAccepted) { skippedAccepted++; continue; }
    // Skip expired bounties that were never accepted
    if (deal.expiresAt < now) { skippedExpired++; continue; }
    // Only show bounties targeted at this specific trader
    if (deal.trader !== walletAddress) { skippedNotTargeted++; continue; }

    console.log(`[TG_BOT:BOUNTIES] ✓ Available: ${deal.publicKey.slice(0, 8)}... | reward=$${deal.rewardAmount} target=$${deal.targetVolume}`);
    available.push(deal);
  }

  console.log(`[TG_BOT:BOUNTIES] Filter summary: ${available.length} available | ${skippedInactive} inactive | ${skippedAccepted} already accepted | ${skippedExpired} expired | ${skippedNotTargeted} not targeted at this trader`);

  // Sort by reward amount descending
  available.sort((a, b) => b.rewardAmount - a.rewardAmount);

  // Fetch token metadata for top 5
  const topBounties = available.slice(0, 5);
  for (const bounty of topBounties) {
    try {
      const metaStart = Date.now();
      bounty.tokenMetadata = await fetchTokenMetadata(bounty.token);
      console.log(`[TG_BOT:BOUNTIES] Token metadata for ${bounty.token.slice(0, 8)}...: ${bounty.tokenMetadata?.symbol || "none"} (${Date.now() - metaStart}ms)`);
    } catch (err) {
      console.log(`[TG_BOT:BOUNTIES] Failed to fetch metadata for ${bounty.token.slice(0, 8)}...:`, err);
      bounty.tokenMetadata = null;
    }
  }

  const totalDuration = Date.now() - startTime;
  console.log(`[TG_BOT:BOUNTIES] Complete: returning ${topBounties.length} bounties (total ${totalDuration}ms)`);
  return topBounties;
}

async function handleBounties(telegramUserId: string) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

  const { wallet: walletAddress, dbError } = await getLinkedWallet(telegramUserId);

  if (dbError) {
    await sendToUser(
      telegramUserId,
      `🔴 <b>Database Error</b>\n\n` +
        `<i>Could not look up your linked wallet.</i>\n` +
        `Please try again in a moment.`
    );
    return;
  }

  if (!walletAddress) {
    await sendToUser(
      telegramUserId,
      `No wallet linked. Use /start to link your wallet first.`
    );
    return;
  }

  console.log(`[TG_BOT:BOUNTIES] /bounties command from user ${telegramUserId} (wallet ${walletAddress.slice(0, 8)}...)`);
  const loadingResult = await sendToUser(
    telegramUserId,
    `◐ <i>Loading...</i>`
  );

  const spinner = loadingResult.messageId
    ? createLoadingSpinner(telegramUserId, loadingResult.messageId)
    : null;

  const bounties = await fetchAvailableBountiesOnChain(walletAddress);

  console.log(`[TG_BOT:BOUNTIES] /bounties found ${bounties.length} available bounties`);

  spinner?.stop();
  if (loadingResult.messageId) {
    try {
      await fetch(`${BOT_API}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: telegramUserId, message_id: loadingResult.messageId }),
      });
    } catch {}
  }

  if (bounties.length === 0) {
    await sendToUser(
      telegramUserId,
      `🟡 <b>No Available Bounties</b>\n\n` +
        `<i>There are no open bounties right now.</i>\n` +
        `Check back later or browse the website.`,
      {
        replyMarkup: {
          inline_keyboard: [
            [{ text: "🌐 Open in App", url: baseUrl }],
          ],
        },
      }
    );
    return;
  }

  const bountyLines = bounties.map((deal, i) => {
    const timeLeft = formatTimeRemaining(deal.expiresAt);
    const timeBar = getTimeBar(deal.expiresAt);
    const dealUrl = `${baseUrl}/deal/${deal.publicKey}`;

    return (
      `${timeBar} <b>${i + 1}.</b> ${formatTokenDisplay(deal)}\n` +
      `    💰 <b>$${deal.rewardAmount.toLocaleString()}</b> reward\n` +
      `    🎯 $${deal.targetVolume.toLocaleString()} target\n` +
      `    ⏳ <i>${timeLeft}</i>\n` +
      `    <a href="${dealUrl}">View Deal →</a>`
    );
  });

  await sendToUser(
    telegramUserId,
    `🟢 <b>Available Bounties (${bounties.length})</b>\n\n` +
      bountyLines.join("\n\n"),
    {
      replyMarkup: {
        inline_keyboard: [
          [{ text: "🌐 Open in App", url: baseUrl }],
        ],
      },
    }
  );
}

async function handleHelp(telegramUserId: string) {
  await sendToUser(
    telegramUserId,
    `🟢 <b>Bounty Exchange Bot</b>\n\n` +
      `<b>Commands:</b>\n` +
      `/start — Link your wallet\n` +
      `/status — View your active deals\n` +
      `/bounties — Browse available bounties\n` +
      `/settings — Notification preferences\n` +
      `/unlink — Disconnect your wallet\n` +
      `/help — Show this message\n\n` +
      `<b>Notifications you'll receive:</b>\n` +
      `🟢 Progress milestones <i>(25%, 50%, 75%, 90%)</i>\n` +
      `🟠 Expiry warnings <i>(24h, 6h, 1h before)</i>\n` +
      `📊 Daily summary of active deals\n` +
      `🏁 Win/loss results when deals finalize`
  );
}

export async function processUpdate(update: TelegramUpdate) {
  try {
    if (update.message?.text) {
      const { text, from, chat } = update.message;
      const telegramUserId = from.id.toString();

      if (chat.type !== "private") return;

      const command = text.toLowerCase().trim();

      if (command === "/start" || command.startsWith("/start ")) {
        const startParam = text.trim().split(/\s+/)[1]; // Get wallet after /start
        await handleStart(telegramUserId, from.first_name, startParam);
      } else if (command === "/status") {
        await handleStatus(telegramUserId);
      } else if (command === "/bounties") {
        await handleBounties(telegramUserId);
      } else if (command === "/settings") {
        await handleSettings(telegramUserId);
      } else if (command === "/unlink") {
        await handleUnlink(telegramUserId);
      } else if (command === "/help") {
        await handleHelp(telegramUserId);
      } else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text.trim())) {
        await handleWalletSubmission(telegramUserId, text.trim());
      } else {
        await sendToUser(
          telegramUserId,
          `I don't understand that command.\n\n` +
            `Send /help to see available commands, or send your wallet address to link it.`
        );
      }
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (error) {
    console.error("[TG_BOT] Error processing update:", error);
  }
}

function formatTokenDisplay(deal: OnChainDeal): string {
  const ticker = deal.tokenMetadata?.symbol || deal.tokenMetadata?.name || deal.token.slice(0, 6);
  return `<a href="https://orb.helius.dev/account/${deal.token}"><b>${ticker}</b></a>`;
}

function makeProgressBar(percent: number): string {
  const filled = Math.min(10, Math.floor(percent / 10));
  const empty = 10 - filled;
  const filledChar = percent >= 90 ? "🟩" : percent >= 50 ? "🟨" : percent >= 25 ? "🟧" : "🟥";
  const bar = filledChar.repeat(filled) + "⬜".repeat(empty);
  return bar;
}

function getTimeBar(expiresAt: Date): string {
  const hoursLeft = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursLeft <= 1) return "🔴";
  if (hoursLeft <= 6) return "🟠";
  if (hoursLeft <= 24) return "🟡";
  return "🟢";
}

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

export async function registerBotCommands(): Promise<boolean> {
  try {
    const commands = [
      { command: "start", description: "Link your wallet" },
      { command: "status", description: "View your active deals" },
      { command: "bounties", description: "Browse available bounties" },
      { command: "settings", description: "Notification preferences" },
      { command: "unlink", description: "Disconnect your wallet" },
      { command: "help", description: "Show help" },
    ];

    const response = await fetch(`${BOT_API}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });

    const data = await response.json();
    if (data.ok) {
      console.log("[TG_BOT] Commands registered successfully");
      return true;
    }
    console.error("[TG_BOT] Failed to register commands:", data.description);
    return false;
  } catch (error) {
    console.error("[TG_BOT] Error registering commands:", error);
    return false;
  }
}

export async function testBotConnection(): Promise<boolean> {
  try {
    const response = await fetch(`${BOT_API}/getMe`);
    const data = await response.json();
    if (data.ok) {
      console.log(`[TG_BOT] Connected as @${data.result.username}`);
      await registerBotCommands();
      return true;
    }
    console.error("[TG_BOT] Connection failed:", data.description);
    return false;
  } catch (error) {
    console.error("[TG_BOT] Connection error:", error);
    return false;
  }
}
