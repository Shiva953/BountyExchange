import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET: Check if a wallet is linked to Telegram
export async function GET(req: NextRequest) {
  const walletAddress = req.nextUrl.searchParams.get("wallet");

  if (!walletAddress) {
    return NextResponse.json({ error: "Wallet address required" }, { status: 400 });
  }

  try {
    const trader = await prisma.trader.findUnique({
      where: { address: walletAddress },
      select: {
        telegramUserId: true,
        telegramLinkedAt: true,
      },
    });

    if (!trader) {
      return NextResponse.json({
        linked: false,
        exists: false,
      });
    }

    return NextResponse.json({
      linked: !!trader.telegramUserId,
      exists: true,
      linkedAt: trader.telegramLinkedAt?.toISOString() || null,
    });
  } catch (error) {
    console.error("[TELEGRAM_STATUS] Error:", error);
    return NextResponse.json(
      { error: "Failed to check status" },
      { status: 500 }
    );
  }
}
