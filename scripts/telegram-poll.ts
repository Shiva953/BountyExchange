/**
 * Local development polling script for Telegram bot
 *
 * Run with: npx ts-node --project tsconfig.json scripts/telegram-poll.ts
 * Or add to package.json: "bot:dev": "ts-node --project tsconfig.json scripts/telegram-poll.ts"
 *
 * This polls Telegram for updates instead of using webhooks,
 * allowing local testing without ngrok.
 */

import "dotenv/config";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const POLL_INTERVAL = 1000; // 1 second
const LOCAL_API_URL = "http://localhost:3000/api/telegram/webhook";

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN not set in .env");
  process.exit(1);
}

let lastUpdateId = 0;

async function getUpdates(): Promise<any[]> {
  try {
    const response = await fetch(
      `${BOT_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`
    );
    const data = await response.json();

    if (!data.ok) {
      console.error("❌ Failed to get updates:", data.description);
      return [];
    }

    return data.result || [];
  } catch (error) {
    console.error("❌ Error fetching updates:", error);
    return [];
  }
}

async function forwardToLocalAPI(update: any): Promise<void> {
  try {
    const response = await fetch(LOCAL_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });

    if (response.ok) {
      const messageText = update.message?.text || update.callback_query?.data || "callback";
      console.log(`✅ Processed: ${messageText.slice(0, 50)}`);
    } else {
      console.error(`❌ API error: ${response.status}`);
    }
  } catch (error) {
    console.error("❌ Failed to forward to local API:", error);
    console.log("   Make sure 'npm run dev' is running!");
  }
}

async function deleteWebhook(): Promise<void> {
  try {
    const response = await fetch(`${BOT_API}/deleteWebhook`);
    const data = await response.json();
    if (data.ok) {
      console.log("🔗 Webhook cleared (using polling mode)");
    }
  } catch (error) {
    console.error("Failed to delete webhook:", error);
  }
}

async function getBotInfo(): Promise<void> {
  try {
    const response = await fetch(`${BOT_API}/getMe`);
    const data = await response.json();
    if (data.ok) {
      console.log(`🤖 Bot: @${data.result.username}`);
    }
  } catch (error) {
    console.error("Failed to get bot info:", error);
  }
}

async function registerCommands(): Promise<void> {
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
      console.log("📋 Commands registered");
    }
  } catch (error) {
    console.error("Failed to register commands:", error);
  }
}

async function poll(): Promise<void> {
  console.log("\n🚀 Telegram Bot Polling Started");
  console.log("================================");

  await getBotInfo();
  await deleteWebhook();
  await registerCommands();

  console.log(`📡 Polling for updates...`);
  console.log(`🔗 Forwarding to: ${LOCAL_API_URL}`);
  console.log(`\n💡 Open Telegram and message your bot to test!\n`);

  while (true) {
    try {
      const updates = await getUpdates();

      for (const update of updates) {
        lastUpdateId = update.update_id;
        await forwardToLocalAPI(update);
      }
    } catch (error) {
      console.error("Poll error:", error);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\n👋 Stopping bot polling...");
  process.exit(0);
});

poll();
