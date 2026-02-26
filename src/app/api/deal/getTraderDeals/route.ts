import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { TraderDealResponse, TraderDataResponse } from "@/types/api";

export type { TraderDealResponse, TraderDataResponse };

// Helper function to check if error is a database connection error
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

// Retry function with exponential backoff
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

      // Only retry on database connection errors
      if (!isDbConnectionError(error)) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Calculate delay with exponential backoff: 500ms, 1000ms, 2000ms
      const delay = initialDelay * Math.pow(2, attempt);
      console.log(
        `Database connection error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}


export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const walletAddress = searchParams.get("address");

  if (!walletAddress) {
    return NextResponse.json(
      { success: false, error: "Missing address parameter" },
      { status: 400 }
    );
  }

  try {
    const result = await retryWithBackoff(async () => {
      // Fetch trader data
      const trader = await prisma.trader.findUnique({
        where: { address: walletAddress },
      });

      // Fetch all accepted deals for this trader
      const deals = await prisma.deal.findMany({
        where: {
          traderAddress: walletAddress,
          isAccepted: true,
        },
        orderBy: {
          acceptedAt: "desc",
        },
      });

      return { trader, deals };
    });

    const { trader, deals } = result;

    // Format trader data
    const traderData: TraderDataResponse | null = trader
      ? {
          id: trader.id,
          name: trader.name,
          address: trader.address,
          imageUrl: trader.imageUrl,
          volumeCompleted: Number(trader.volumeCompleted || 0),
          activeBounties: trader.activeBounties || 0,
        }
      : null;

    // Format deals data
    const dealsData: TraderDealResponse[] = deals.map((deal) => ({
      id: deal.id,
      publicKey: deal.publicKey,
      dealId: deal.dealId,
      creator: deal.creator,
      token: deal.token,
      traderAddress: deal.traderAddress,
      rewardAmount: deal.rewardAmount.toString(),
      targetVolume: deal.targetVolume.toString(),
      minBuyVolume: deal.minBuyVolume?.toString() ?? null,
      expirationHours: deal.expirationHours,
      holdDurationHours: deal.holdDurationHours,
      escrowVault: deal.escrowVault,
      createdAt: deal.createdAt.toISOString(),
      acceptedAt: deal.acceptedAt?.toISOString() ?? null,
      expiresAt: deal.expiresAt?.toISOString() ?? null,
      isActive: deal.isActive,
      isAccepted: deal.isAccepted,
      volumeCompleted: deal.volumeCompleted?.toString() ?? null,
      outcome: deal.outcome,
    }));

    return NextResponse.json({
      success: true,
      trader: traderData,
      deals: dealsData,
    });
  } catch (error) {
    console.error("Error fetching trader deals after retries:", error);

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
        error: "Failed to fetch trader deals",
        details: error instanceof Error ? error.message : "Unknown error",
        retryable: false,
      },
      { status: 500 }
    );
  }
}
