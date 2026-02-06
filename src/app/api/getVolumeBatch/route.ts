import { NextRequest, NextResponse } from "next/server";
import { calculateTokenVolumeCached } from "@/utils/calculateTokenVolume";
import { createApiError, isRPCError, withRetry } from "@/lib/errors";

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
  code?: string;
  retryable?: boolean;
}

// Increased from 3 to 10 for better throughput
// Each calculation now uses internal parallelization, so we can handle more concurrent requests
const MAX_CONCURRENT = 10;
const DELAY_BETWEEN_BATCHES_MS = 50;

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

          // Retry RPC errors with exponential backoff
          const result = await withRetry(
            async () => {
              const res = await calculateTokenVolumeCached(
                req.wallet,
                req.token,
                filterStartTime,
                filterEndTime,
                minBuyVolumeUSD
              );
              // Throw on RPC errors to trigger retry
              if (!res.success && res.error && isRPCError(new Error(res.error))) {
                throw new Error(res.error);
              }
              return res;
            },
            { maxRetries: 2, initialDelay: 500 }
          );

          if (!result.success) {
            const apiError = createApiError(new Error(result.error || "Unknown error"));
            return {
              key: req.key,
              success: false,
              error: apiError.message,
              code: apiError.code,
              retryable: apiError.retryable,
            } as VolumeResult;
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
          const apiError = createApiError(err);
          return {
            key: req.key,
            success: false,
            error: apiError.message,
            code: apiError.code,
            retryable: apiError.retryable,
          } as VolumeResult;
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
    const apiError = createApiError(error);
    return NextResponse.json(
      {
        success: false,
        error: apiError.message,
        code: apiError.code,
        retryable: apiError.retryable,
        retryAfter: apiError.retryAfter,
      },
      { status: 500 }
    );
  }
}
