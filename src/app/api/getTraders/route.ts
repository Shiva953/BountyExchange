import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  isPrismaConnectionError,
  withRetry,
  createApiError,
} from "@/lib/errors";

export async function GET(_request: NextRequest) {
  try {
    const traders = await withRetry(async () => {
      return await prisma.trader.findMany({
        where: {
          name: {
            not: null,
          },
        },
        distinct: ["name"],
        orderBy: {
          id: "desc",
        },
      });
    });

    const tradersWithStats = traders.map((trader) => ({
      id: trader.id,
      name: trader.name?.split("?")[0] || trader.name,
      address: trader.address?.split("?")[0] || trader.address,
      imageUrl: trader.imageUrl,
      volumeCompleted: Number(trader.volumeCompleted || 0),
      activeBounties: trader.activeBounties || 0,
    }));

    return NextResponse.json(
      {
        success: true,
        traders: tradersWithStats,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      }
    );
  } catch (error) {
    console.error("Error fetching traders:", error);

    const apiError = createApiError(error);
    return NextResponse.json(
      {
        success: false,
        error: apiError.message,
        code: apiError.code,
        retryable: apiError.retryable,
        retryAfter: apiError.retryAfter,
      },
      { status: isPrismaConnectionError(error) ? 503 : 500 }
    );
  }
}
