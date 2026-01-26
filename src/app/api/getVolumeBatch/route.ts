import { NextRequest, NextResponse } from "next/server";
import { calculateTokenVolumeFast } from "@/utils/calculateTokenVolume";

interface VolumeRequest {
  wallet: string;
  token: string;
  startTime?: number;
  endTime?: number;
  minBuyVolume?: number;
  key: string;
}

interface VolumeResult {
  key: string;
  success: boolean;
  data?: {
    walletAddress: string;
    tokenMint: string;
    tokenAccount: string | null;
    totalSwapTransactions: number;
    totalVolume: number;
    volumeUSD: number;
    tokenPrice: number | null;
  };
  error?: string;
}

const MAX_CONCURRENT = 3;
const DELAY_BETWEEN_BATCHES_MS = 100;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { requests } = body as { requests: VolumeRequest[] };

    if (!requests || !Array.isArray(requests)) {
      return NextResponse.json(
        { error: "Missing or invalid 'requests' array in body" },
        { status: 400 }
      );
    }

    if (requests.length === 0) {
      return NextResponse.json({ success: true, results: [] });
    }

    if (requests.length > 20) {
      return NextResponse.json(
        { error: "Maximum 20 requests per batch" },
        { status: 400 }
      );
    }

    const apiStartTime = Date.now();
    const results: VolumeResult[] = [];

    const batches: VolumeRequest[][] = [];
    for (let i = 0; i < requests.length; i += MAX_CONCURRENT) {
      batches.push(requests.slice(i, i + MAX_CONCURRENT));
    }

    for (const batch of batches) {
      const batchPromises = batch.map(async (req): Promise<VolumeResult> => {
        try {
          const filterStartTime = req.startTime ? Number(req.startTime) : undefined;
          const filterEndTime = req.endTime ? Number(req.endTime) : undefined;
          const minBuyVolumeUSD = req.minBuyVolume ? Number(req.minBuyVolume) : undefined;

          const result = await calculateTokenVolumeFast(
            req.wallet,
            req.token,
            filterStartTime,
            filterEndTime,
            minBuyVolumeUSD
          );

          if (!result.success) {
            return { key: req.key, success: false, error: result.error };
          }

          return {
            key: req.key,
            success: true,
            data: {
              walletAddress: result.walletAddress!,
              tokenMint: result.tokenMint!,
              tokenAccount: result.tokenAccount,
              totalSwapTransactions: result.totalSwapTransactions!,
              totalVolume: result.totalVolume!,
              volumeUSD: result.volumeUSD!,
              tokenPrice: result.tokenPrice,
            },
          };
        } catch (err) {
          return {
            key: req.key,
            success: false,
            error: err instanceof Error ? err.message : "Unknown error",
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
      }
    }

    const duration = Date.now() - apiStartTime;

    return NextResponse.json({
      success: true,
      results,
      meta: {
        totalRequests: requests.length,
        successfulRequests: results.filter((r) => r.success).length,
        failedRequests: results.filter((r) => !r.success).length,
        durationMs: duration,
      },
    });
  } catch (error) {
    console.error("Error in getVolumeBatch:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}
