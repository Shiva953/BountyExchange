import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Connection, PublicKey } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";

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
      console.log(`Database connection error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

export async function GET(request: NextRequest) {
  try {
    const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");
    const program = getProgram(connection);

    // Fetch all traders with name not null - with retry logic
    const traders = await retryWithBackoff(async () => {
      return await prisma.trader.findMany({
        where: {
          name: {
            not: null,
          },
        },
        orderBy: {
          id: "desc",
        },
      });
    });

    // For each trader, calculate their stats
    const tradersWithStats = await Promise.all(
      traders.map(async (trader) => {
        try {
          if (!trader.address) {
            throw new Error("Trader address is missing");
          }
          const traderPubkey = new PublicKey(trader.address);

          // Fetch all deals for this trader
          const allDeals = await program.account.deal.all([
            {
              memcmp: {
                offset: 80,
                bytes: traderPubkey.toBase58(),
              },
            },
          ]);

          // Filter for accepted deals only
          const acceptedDeals = allDeals.filter((deal) => deal.account.isAccepted);

          // Calculate total volume completed (sum of target volumes for completed deals)
          const completedDeals = acceptedDeals.filter((deal) => !deal.account.isActive);
          const totalVolumeCompleted = completedDeals.reduce((sum, deal) => {
            return sum + Number(deal.account.targetVolume) / 10 ** 9; // Convert from lamports to USDC
          }, 0);

          // Calculate average completion percentage across all active deals
          // For now, we'll use a simplified approach: if they have completed deals, show high completion
          // In a real implementation, you'd calculate actual progress for active deals
          let avgCompletion = 0;
          if (acceptedDeals.length > 0) {
            const completedCount = completedDeals.length;
            const activeCount = acceptedDeals.length - completedCount;
            // If all deals are completed, 100%, otherwise estimate based on completed ratio
            if (activeCount === 0) {
              avgCompletion = 100;
            } else {
              // For active deals, we'd need to fetch volume progress, but for now use a placeholder
              // This should be enhanced to actually calculate progress
              avgCompletion = Math.round((completedCount / acceptedDeals.length) * 100);
            }
          }

          return {
            id: trader.id,
            name: trader.name,
            address: trader.address,
            imageUrl: trader.imageUrl,
            volumeCompleted: totalVolumeCompleted,
            completionPercentage: avgCompletion,
            activeBounties: acceptedDeals.filter((deal) => deal.account.isActive).length,
          };
        } catch (error) {
          console.error(`Error processing trader ${trader.address}:`, error);
          // Return trader with default stats if there's an error
          return {
            id: trader.id,
            name: trader.name,
            address: trader.address,
            imageUrl: trader.imageUrl,
            volumeCompleted: 0,
            completionPercentage: 0,
            activeBounties: 0,
          };
        }
      })
    );

    return NextResponse.json({
      success: true,
      traders: tradersWithStats,
    });
  } catch (error) {
    console.error("Error fetching traders after retries:", error);
    
    // If it's still a database connection error after retries, return 500
    // Frontend will handle retries
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
