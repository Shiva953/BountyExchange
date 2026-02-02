import { NextRequest, NextResponse } from "next/server";
import { processUpdate } from "@/lib/telegram-bot";

export async function POST(req: NextRequest) {
  // Optional: Verify webhook secret
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (
    process.env.TELEGRAM_WEBHOOK_SECRET &&
    secret !== process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    console.warn("[TELEGRAM_WEBHOOK] Invalid secret token");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const update = await req.json();
    console.log("[TELEGRAM_WEBHOOK] Received update:", update.update_id);

    // Process and wait for result to catch errors
    try {
      await processUpdate(update);
      console.log("[TELEGRAM_WEBHOOK] Update processed successfully");
    } catch (err) {
      console.error("[TELEGRAM_WEBHOOK] Error processing update:", err);
    }

    // Return to Telegram
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[TELEGRAM_WEBHOOK] Error parsing request:", error);
    return NextResponse.json(
      { error: "Failed to parse request" },
      { status: 400 }
    );
  }
}

// Health check for the webhook
export async function GET() {
  return NextResponse.json({
    status: "ok",
    endpoint: "telegram-webhook",
  });
}
