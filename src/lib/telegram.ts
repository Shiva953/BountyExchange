/**
 * Telegram notification service for deal outcome notifications
 */

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

interface DealNotification {
  dealPubkey: string;
  traderAddress: string;
  traderName?: string | null;
  tokenSymbol?: string;
  rewardAmount: number; // In USD
  targetVolume: number; // In USD
  volumeCompleted: number; // In USD
  outcome: "won" | "lost";
  signature?: string;
}

/**
 * Gets Telegram configuration from environment variables
 */
function getTelegramConfig(): TelegramConfig | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn(
      "[TELEGRAM] Bot token or chat ID not configured, notifications disabled"
    );
    return null;
  }

  return { botToken, chatId };
}

/**
 * Sends a message via Telegram Bot API
 */
async function sendTelegramMessage(
  config: TelegramConfig,
  message: string,
  parseMode: "HTML" | "Markdown" = "HTML"
): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error("[TELEGRAM] Failed to send message:", errorData);
      return false;
    }

    return true;
  } catch (error) {
    console.error("[TELEGRAM] Error sending message:", error);
    return false;
  }
}

/**
 * Formats a deal notification message
 */
function formatDealNotification(notification: DealNotification): string {
  const {
    dealPubkey,
    traderAddress,
    traderName,
    tokenSymbol,
    rewardAmount,
    targetVolume,
    volumeCompleted,
    outcome,
    signature,
  } = notification;

  const emoji = outcome === "won" ? "✅" : "❌";
  const statusText = outcome === "won" ? "PASSED" : "FAILED";
  const traderDisplay = traderName || `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
  const tokenDisplay = tokenSymbol || "token";
  const percentage = ((volumeCompleted / targetVolume) * 100).toFixed(1);

  const lines = [
    `${emoji} <b>Deal ${statusText}</b>`,
    ``,
    `<b>Trader:</b> ${traderDisplay}`,
    `<b>Token:</b> ${tokenDisplay}`,
    `<b>Reward:</b> $${rewardAmount.toFixed(2)} USDC`,
    ``,
    `<b>Volume:</b> $${volumeCompleted.toFixed(2)} / $${targetVolume.toFixed(2)} (${percentage}%)`,
    ``,
  ];

  if (outcome === "won") {
    lines.push(`💰 <b>Reward paid to trader!</b>`);
    if (signature) {
      lines.push(
        `<a href="https://solscan.io/tx/${signature}?cluster=devnet">View Transaction</a>`
      );
    }
  } else {
    lines.push(`📊 Volume target was not reached in time.`);
  }

  lines.push(
    ``,
    `<code>${dealPubkey.slice(0, 8)}...${dealPubkey.slice(-8)}</code>`
  );

  return lines.join("\n");
}

/**
 * Sends a deal outcome notification via Telegram
 */
export async function sendDealNotification(
  notification: DealNotification
): Promise<boolean> {
  const config = getTelegramConfig();
  if (!config) {
    return false;
  }

  const message = formatDealNotification(notification);
  const success = await sendTelegramMessage(config, message);

  if (success) {
    console.log(
      `[TELEGRAM] Sent ${notification.outcome} notification for deal ${notification.dealPubkey.slice(0, 8)}...`
    );
  }

  return success;
}

/**
 * Sends a batch notification for multiple deals
 */
export async function sendBatchDealNotifications(
  notifications: DealNotification[]
): Promise<{ sent: number; failed: number }> {
  const config = getTelegramConfig();
  if (!config) {
    return { sent: 0, failed: notifications.length };
  }

  let sent = 0;
  let failed = 0;

  for (const notification of notifications) {
    const message = formatDealNotification(notification);
    const success = await sendTelegramMessage(config, message);

    if (success) {
      sent++;
    } else {
      failed++;
    }

    // Rate limiting - Telegram allows ~30 messages per second
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(
    `[TELEGRAM] Batch notification complete: ${sent} sent, ${failed} failed`
  );
  return { sent, failed };
}

/**
 * Sends a system alert (for errors, warnings, etc.)
 */
export async function sendSystemAlert(
  title: string,
  message: string,
  severity: "info" | "warning" | "error" = "info"
): Promise<boolean> {
  const config = getTelegramConfig();
  if (!config) {
    return false;
  }

  const emoji =
    severity === "error" ? "🚨" : severity === "warning" ? "⚠️" : "ℹ️";

  const formattedMessage = [
    `${emoji} <b>${title}</b>`,
    ``,
    message,
    ``,
    `<i>${new Date().toISOString()}</i>`,
  ].join("\n");

  return sendTelegramMessage(config, formattedMessage);
}

/**
 * Tests the Telegram configuration by sending a test message
 */
export async function testTelegramConnection(): Promise<boolean> {
  const config = getTelegramConfig();
  if (!config) {
    console.error(
      "[TELEGRAM] Cannot test - missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID"
    );
    return false;
  }

  const testMessage = [
    `🧪 <b>Bounty Exchange Test</b>`,
    ``,
    `Telegram notifications are working!`,
    ``,
    `<i>${new Date().toISOString()}</i>`,
  ].join("\n");

  const success = await sendTelegramMessage(config, testMessage);

  if (success) {
    console.log("[TELEGRAM] Test message sent successfully");
  } else {
    console.error("[TELEGRAM] Failed to send test message");
  }

  return success;
}
