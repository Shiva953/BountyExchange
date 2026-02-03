/**
 * Sponsor Deals API
 * Returns all deals created by a sponsor from the database.
 * Much faster than direct on-chain queries since data is indexed.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const creator = searchParams.get("creator");

  if (!creator) {
    return NextResponse.json(
      { success: false, error: "creator parameter is required" },
      { status: 400 }
    );
  }

  try {
    const deals = await prisma.deal.findMany({
      where: {
        creator: creator,
      },
      include: {
        trader: {
          select: {
            name: true,
            imageUrl: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Calculate stats
    const now = new Date();
    let totalEscrowFromActive = 0;
    const uniqueTraders = new Set<string>();
    let activeCampaigns = 0;

    const formattedDeals = deals.map((deal) => {
      // Track unique traders
      if (deal.isAccepted) {
        uniqueTraders.add(deal.traderAddress);
      }

      // Determine status based on deal state
      // Escrow is only locked for deals that are:
      // 1. Active (not finalized)
      // 2. Accepted
      // 3. Not expired
      let status: "executing" | "satisfied" | "failed" | "awaiting" = "awaiting";
      let hasLockedEscrow = false;

      if (!deal.isActive) {
        // Deal has been finalized - no escrow locked
        status = deal.outcome === "won" ? "satisfied" : "failed";
        hasLockedEscrow = false;
      } else if (deal.isAccepted) {
        // Deal is active and accepted - check expiration
        const isExpired = deal.expiresAt ? deal.expiresAt <= now : false;
        if (isExpired) {
          // Expired but not yet finalized - escrow pending finalization
          status = "failed";
          hasLockedEscrow = false; // Escrow will be released on finalization
        } else {
          // Currently executing - escrow is locked
          status = "executing";
          activeCampaigns++;
          hasLockedEscrow = true;
        }
      }

      // Only count escrow for deals with locked funds
      if (hasLockedEscrow) {
        totalEscrowFromActive += Number(deal.rewardAmount) / 10 ** 9;
      }

      return {
        publicKey: deal.publicKey,
        dealId: deal.dealId,
        creator: deal.creator,
        token: deal.token,
        traderAddress: deal.traderAddress,
        rewardAmount: Number(deal.rewardAmount),
        targetVolume: Number(deal.targetVolume),
        minBuyVolume: deal.minBuyVolume ? Number(deal.minBuyVolume) : null,
        expirationHours: deal.expirationHours,
        holdDurationHours: deal.holdDurationHours,
        escrowVault: deal.escrowVault,
        createdAt: deal.createdAt.toISOString(),
        acceptedAt: deal.acceptedAt?.toISOString() ?? null,
        expiresAt: deal.expiresAt?.toISOString() ?? null,
        isActive: deal.isActive,
        isAccepted: deal.isAccepted,
        volumeCompleted: deal.volumeCompleted ? Number(deal.volumeCompleted) : 0,
        outcome: deal.outcome,
        status,
        traderName: deal.trader?.name ?? null,
        traderImageUrl: deal.trader?.imageUrl ?? null,
      };
    });

    return NextResponse.json({
      success: true,
      deals: formattedDeals,
      stats: {
        totalEscrow: totalEscrowFromActive,
        activeCampaigns,
        contractors: uniqueTraders.size,
      },
    });
  } catch (error) {
    console.error("[API] sponsor/deals error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch deals" },
      { status: 500 }
    );
  }
}
