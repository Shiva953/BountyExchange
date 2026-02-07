import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";
import { prisma } from "@/lib/prisma";
import { registerTraderForWebhook } from "@/lib/helius-webhooks";
import { cacheDealForWallet } from "@/lib/volume-cache";

/**
 * Called by the frontend AFTER a deal acceptance transaction is confirmed on-chain.
 * This syncs the accepted deal to the database.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { dealPubkey, signature } = body;

    if (!dealPubkey) {
      return NextResponse.json(
        { error: "Missing dealPubkey" },
        { status: 400 }
      );
    }

    let dealPubkeyObj: PublicKey;
    try {
      dealPubkeyObj = new PublicKey(dealPubkey);
    } catch {
      return NextResponse.json(
        { error: "Invalid deal pubkey" },
        { status: 400 }
      );
    }

    console.log(`[CONFIRM] Confirming deal acceptance: ${dealPubkey}`);
    if (signature) {
      console.log(`[CONFIRM] Transaction signature: ${signature}`);
    }

    const connection = new Connection(
      process.env.HELIUS_DEVNET_URL!,
      "confirmed"
    );
    const program = getProgram(connection);

    // If we have a signature, first confirm the transaction landed on this RPC node
    // This ensures we're not reading stale state from a different node in the cluster
    if (signature) {
      console.log(`[CONFIRM] Waiting for transaction to be confirmed on this RPC node...`);
      try {
        const confirmation = await connection.confirmTransaction(signature, "confirmed");
        if (confirmation.value.err) {
          console.error(`[CONFIRM] Transaction failed:`, confirmation.value.err);
          return NextResponse.json(
            { error: "Transaction failed on-chain" },
            { status: 400 }
          );
        }
        console.log(`[CONFIRM] Transaction confirmed on this RPC node`);
      } catch (confirmError) {
        console.error(`[CONFIRM] Error confirming transaction:`, confirmError);
        // Continue anyway - the transaction might have already been confirmed
      }
    }

    // Fetch deal from on-chain to verify it's actually accepted
    // Retry a few times in case RPC hasn't caught up yet
    let dealAccount;
    let attempts = 0;
    const maxAttempts = 8;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        dealAccount = await program.account.deal.fetch(dealPubkeyObj);
        if (dealAccount.isAccepted) {
          console.log(`[CONFIRM] Deal verified as accepted on attempt ${attempts}`);
          break;
        }
        console.log(`[CONFIRM] Deal not yet accepted on attempt ${attempts}, retrying...`);
      } catch (fetchError) {
        console.log(`[CONFIRM] Failed to fetch deal on attempt ${attempts}:`, fetchError);
      }

      if (attempts < maxAttempts) {
        // Exponential backoff: 500ms, 1s, 1.5s, 2s, 2.5s, 3s, 3.5s
        const delay = 500 + (attempts - 1) * 500;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    if (!dealAccount || !dealAccount.isAccepted) {
      return NextResponse.json(
        { error: "Deal is not yet accepted on-chain after retries" },
        { status: 400 }
      );
    }

    const traderAddress = dealAccount.trader.toBase58();

    // Ensure trader exists in DB
    let trader = await prisma.trader.findUnique({
      where: { address: traderAddress },
    });

    if (!trader) {
      trader = await prisma.trader.create({
        data: { address: traderAddress },
      });
      console.log(`[CONFIRM] Created new trader: ${traderAddress}`);
    }

    const now = new Date();
    const createdAt = new Date(Number(dealAccount.createdAt) * 1000);
    const expiresAt = new Date(
      now.getTime() +
        Number(dealAccount.expirationWindowInHours) * 60 * 60 * 1000
    );

    // Upsert deal to DB
    const deal = await prisma.deal.upsert({
      where: { publicKey: dealPubkey },
      create: {
        publicKey: dealPubkey,
        dealId: dealAccount.dealId.toString(),
        creator: dealAccount.creator.toBase58(),
        token: dealAccount.token.toBase58(),
        traderId: trader.id,
        traderAddress: traderAddress,
        rewardAmount: Number(dealAccount.rewardAmount),
        targetVolume: Number(dealAccount.targetVolume),
        minBuyVolume: dealAccount.minBuyVolume
          ? Number(dealAccount.minBuyVolume)
          : null,
        expirationHours: Number(dealAccount.expirationWindowInHours),
        holdDurationHours: Number(dealAccount.holdDurationInHours),
        escrowVault: dealAccount.escrowVault.toBase58(),
        createdAt: createdAt,
        acceptedAt: now,
        expiresAt: expiresAt,
        isActive: true,
        isAccepted: true,
        volumeCompleted: 0, // Will be updated by cron
      },
      update: {
        isAccepted: true,
        acceptedAt: now,
        expiresAt: expiresAt,
        isActive: dealAccount.isActive,
      },
    });

    // Update trader's active bounties count
    const activeCount = await prisma.deal.count({
      where: {
        traderId: trader.id,
        isActive: true,
        isAccepted: true,
      },
    });

    await prisma.trader.update({
      where: { id: trader.id },
      data: { activeBounties: activeCount },
    });

    console.log(`[CONFIRM] Deal synced successfully, expires at: ${expiresAt}`);

    // Register trader with Helius webhook for real-time swap tracking
    try {
      await registerTraderForWebhook(traderAddress);
      console.log(`[CONFIRM] Registered trader ${traderAddress.slice(0, 8)}... with Helius webhook`);
    } catch (webhookError) {
      // Non-fatal - webhook registration is best-effort
      console.error(`[CONFIRM] Failed to register trader with webhook:`, webhookError);
    }

    // Cache deal for webhook lookup (enables real-time volume updates)
    try {
      await cacheDealForWallet(
        traderAddress,
        dealAccount.token.toBase58(),
        dealPubkey,
        Math.floor(now.getTime() / 1000),
        expiresAt.getTime()
      );
      console.log(`[CONFIRM] Cached deal ${dealPubkey.slice(0, 8)}... for webhook processing`);
    } catch (cacheError) {
      console.error(`[CONFIRM] Failed to cache deal for wallet:`, cacheError);
    }

    return NextResponse.json({
      success: true,
      deal: {
        id: deal.id,
        publicKey: deal.publicKey,
        expiresAt: deal.expiresAt,
      },
    });
  } catch (error) {
    console.error("[CONFIRM] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to confirm deal acceptance",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
