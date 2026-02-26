/**
 * Deal Volumes Polling Endpoint
 * Returns the current volumeCompleted for a list of deals from the database.
 * Used as a polling fallback when SSE is not available.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { dealPublicKeys } = body;

    if (!dealPublicKeys || !Array.isArray(dealPublicKeys) || dealPublicKeys.length === 0) {
      return NextResponse.json(
        { success: false, error: "dealPublicKeys array is required" },
        { status: 400 }
      );
    }

    // Limit to 50 deals per request
    const keys = dealPublicKeys.slice(0, 50);

    const deals = await prisma.deal.findMany({
      where: {
        publicKey: { in: keys },
      },
      select: {
        publicKey: true,
        volumeCompleted: true,
        targetVolume: true,
        isActive: true,
      },
    });

    const volumes = deals.map((deal) => ({
      publicKey: deal.publicKey,
      volumeCompleted: Number(deal.volumeCompleted),
      targetVolume: Number(deal.targetVolume) / 10 ** 9,
      isActive: deal.isActive,
    }));

    return NextResponse.json({
      success: true,
      volumes,
    });
  } catch (error) {
    console.error("[API] deals/volumes error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch volumes" },
      { status: 500 }
    );
  }
}
