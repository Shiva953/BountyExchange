import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendToUser } from "@/lib/telegram-bot";
import nacl from "tweetnacl";
import bs58 from "bs58";

// GET: Check if a verification code is valid
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.json({ error: "Code required" }, { status: 400 });
  }

  const verification = await prisma.wallet_verification.findUnique({
    where: { verifyCode: code },
  });

  if (!verification) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (verification.verified) {
    return NextResponse.json({ error: "already_used" }, { status: 400 });
  }

  if (verification.expiresAt < new Date()) {
    return NextResponse.json({ error: "expired" }, { status: 400 });
  }

  return NextResponse.json({
    walletAddress: verification.walletAddress,
    expiresAt: verification.expiresAt.toISOString(),
  });
}

// POST: Verify wallet ownership and link to Telegram
export async function POST(req: NextRequest) {
  try {
    const { code, walletAddress, signature, message } = await req.json();

    if (!code || !walletAddress || !signature || !message) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Find pending verification
    const verification = await prisma.wallet_verification.findUnique({
      where: { verifyCode: code },
    });

    if (!verification) {
      return NextResponse.json(
        { error: "Verification code not found" },
        { status: 404 }
      );
    }

    if (verification.verified) {
      return NextResponse.json(
        { error: "Code already used" },
        { status: 400 }
      );
    }

    if (verification.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "Verification code expired" },
        { status: 400 }
      );
    }

    if (verification.walletAddress !== walletAddress) {
      return NextResponse.json(
        { error: "Wallet address mismatch" },
        { status: 400 }
      );
    }

    // Verify signature
    let isValid = false;
    try {
      const messageBytes = bs58.decode(message);
      const signatureBytes = bs58.decode(signature);
      const publicKeyBytes = bs58.decode(walletAddress);

      isValid = nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKeyBytes
      );
    } catch (verifyError) {
      console.error("[VERIFY] Signature verification error:", verifyError);
      return NextResponse.json(
        { error: "Invalid signature format" },
        { status: 400 }
      );
    }

    if (!isValid) {
      return NextResponse.json(
        { error: "Signature verification failed" },
        { status: 400 }
      );
    }

    // Check if trader exists
    const trader = await prisma.trader.findUnique({
      where: { address: walletAddress },
    });

    if (!trader) {
      return NextResponse.json(
        { error: "Wallet not found in system" },
        { status: 404 }
      );
    }

    // Check if this telegram user is already linked to another wallet
    const existingLink = await prisma.trader.findFirst({
      where: {
        telegramUserId: verification.telegramUserId,
        NOT: { address: walletAddress },
      },
    });

    if (existingLink) {
      return NextResponse.json(
        { error: "Telegram account already linked to another wallet" },
        { status: 400 }
      );
    }

    // Link wallet to Telegram in a transaction
    await prisma.$transaction([
      prisma.trader.update({
        where: { address: walletAddress },
        data: {
          telegramUserId: verification.telegramUserId,
          telegramLinkedAt: new Date(),
        },
      }),
      prisma.wallet_verification.update({
        where: { id: verification.id },
        data: { verified: true },
      }),
      // Create default notification settings
      prisma.notification_settings.upsert({
        where: { traderId: trader.id },
        create: {
          traderId: trader.id,
        },
        update: {},
      }),
    ]);

    // Notify user via Telegram
    await sendToUser(
      verification.telegramUserId,
      `<b>Wallet Linked Successfully!</b>\n\n` +
        `<code>${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}</code>\n\n` +
        `You'll now receive notifications for your bounty deals.\n\n` +
        `Use /status to see your active deals.\n` +
        `Use /settings to customize notifications.`
    );

    console.log(
      `[VERIFY] Wallet ${walletAddress.slice(0, 8)}... linked to Telegram ${verification.telegramUserId}`
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[VERIFY] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
