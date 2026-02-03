import { NextRequest, NextResponse } from "next/server";
import {
  calculateTokenVolume,
  calculateTokenVolumeCached,
} from "@/utils/calculateTokenVolume";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const walletAddress = searchParams.get("wallet");
    const tokenMint = searchParams.get("token");
    const useFast = searchParams.get("fast") !== "false";
    const maxTxns = parseInt(searchParams.get("maxTxns") || "500", 10);

    if (!walletAddress) {
      return NextResponse.json(
        { error: "Missing required parameter: wallet" },
        { status: 400 }
      );
    }

    if (!tokenMint) {
      return NextResponse.json(
        { error: "Missing required parameter: token" },
        { status: 400 }
      );
    }

    if (walletAddress.length < 32 || walletAddress.length > 44) {
      return NextResponse.json(
        { error: "Invalid wallet address format" },
        { status: 400 }
      );
    }

    if (tokenMint.length < 32 || tokenMint.length > 44) {
      return NextResponse.json(
        { error: "Invalid token mint format" },
        { status: 400 }
      );
    }

    const skipCache = searchParams.get("skipCache") === "true";
    const startTime = Date.now();

    // Use cached version for fast mode (default), fall back to uncached for standard mode
    const result = useFast
      ? await calculateTokenVolumeCached(walletAddress, tokenMint, undefined, undefined, undefined, { skipCache })
      : await calculateTokenVolume(walletAddress, tokenMint, maxTxns);

    const duration = Date.now() - startTime;

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        walletAddress: result.walletAddress,
        tokenMint: result.tokenMint,
        tokenAccount: result.tokenAccount,
        totalSwapTransactions: result.totalSwapTransactions,
        totalVolume: result.totalVolume,
        volumeUSD: result.volumeUSD,
        tokenPrice: result.tokenPrice,
        swaps: result.swaps.map((swap) => ({
          signature: swap.signature,
          timestamp: swap.timestamp,
          tokenAmount: swap.tokenAmount,
          source: swap.source,
        })),
      },
      meta: {
        method: useFast ? "fast" : "standard",
        durationMs: duration,
      },
    });
  } catch (error) {
    console.error("Error in getVolume:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      wallet: walletAddress,
      token: tokenMint,
      fast = true,
      maxTxns = 500,
      startTime: startTimeParam,
      endTime: endTimeParam,
      minBuyVolume: minBuyVolumeParam,
    } = body;

    if (!walletAddress) {
      return NextResponse.json(
        { error: "Missing required field: wallet" },
        { status: 400 }
      );
    }

    if (!tokenMint) {
      return NextResponse.json(
        { error: "Missing required field: token" },
        { status: 400 }
      );
    }

    const filterStartTime = startTimeParam ? Number(startTimeParam) : undefined;
    const filterEndTime = endTimeParam ? Number(endTimeParam) : undefined;
    const minBuyVolumeUSD = minBuyVolumeParam ? Number(minBuyVolumeParam) : undefined;
    const skipCache = body.skipCache === true;

    const apiStartTime = Date.now();

    // Use cached version for fast mode (default), fall back to uncached for standard mode
    const result = fast
      ? await calculateTokenVolumeCached(walletAddress, tokenMint, filterStartTime, filterEndTime, minBuyVolumeUSD, { skipCache })
      : await calculateTokenVolume(walletAddress, tokenMint, maxTxns, filterStartTime, filterEndTime, minBuyVolumeUSD);

    const duration = Date.now() - apiStartTime;

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        walletAddress: result.walletAddress,
        tokenMint: result.tokenMint,
        tokenAccount: result.tokenAccount,
        totalSwapTransactions: result.totalSwapTransactions,
        filteredSwapTransactions: result.filteredSwapTransactions,
        totalVolume: result.totalVolume,
        volumeUSD: result.volumeUSD,
        tokenPrice: result.tokenPrice,
        minBuyVolumeUSD: result.minBuyVolumeUSD,
        swaps: result.swaps.map((swap) => ({
          signature: swap.signature,
          timestamp: swap.timestamp,
          tokenAmount: swap.tokenAmount,
          source: swap.source,
        })),
      },
      meta: {
        method: fast ? "fast" : "standard",
        durationMs: duration,
        timeRange: {
          startTime: filterStartTime || null,
          endTime: filterEndTime || null,
        },
        minBuyVolumeUSD: minBuyVolumeUSD || null,
      },
    });
  } catch (error) {
    console.error("Error in getVolume POST:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}
