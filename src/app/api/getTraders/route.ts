import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function isDbConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return (
    message.includes("Can't reach database server") ||
    message.includes("P1001") ||
    message.includes("connection") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT")
  );
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 500
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isDbConnectionError(error)) {
        throw error;
      }

      if (attempt === maxRetries) {
        break;
      }

      const delay = initialDelay * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export async function GET(_request: NextRequest) {
  try {
    const traders = await retryWithBackoff(async () => {
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
      name: trader.name?.split('?')[0] || trader.name,
      address: trader.address?.split('?')[0] || trader.address,
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

    if (isDbConnectionError(error)) {
      return NextResponse.json(
        {
          success: false,
          error: "Database connection failed",
          details: "Unable to reach database server after multiple retries",
          retryable: true,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch traders",
        details: error instanceof Error ? error.message : "Unknown error",
        retryable: false,
      },
      { status: 500 }
    );
  }
}
