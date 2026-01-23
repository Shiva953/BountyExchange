import { NextRequest, NextResponse } from "next/server";
import {
  calculateTokenVolume,
  calculateTokenVolumeFast,
} from "@/utils/calculateTokenVolume";

export async function GET(request: NextRequest) {
  console.log("\n[API] GET /api/getVolume");

  try {
    const { searchParams } = new URL(request.url);

    const walletAddress = searchParams.get("wallet");
    const tokenMint = searchParams.get("token");
    const useFast = searchParams.get("fast") !== "false";
    const maxTxns = parseInt(searchParams.get("maxTxns") || "500", 10);

    if (!walletAddress) {
      console.log("[API] Error: Missing wallet parameter");
      return NextResponse.json(
        { error: "Missing required parameter: wallet" },
        { status: 400 }
      );
    }

    if (!tokenMint) {
      console.log("[API] Error: Missing token parameter");
      return NextResponse.json(
        { error: "Missing required parameter: token" },
        { status: 400 }
      );
    }

    if (walletAddress.length < 32 || walletAddress.length > 44) {
      console.log("[API] Error: Invalid wallet address format");
      return NextResponse.json(
        { error: "Invalid wallet address format" },
        { status: 400 }
      );
    }

    if (tokenMint.length < 32 || tokenMint.length > 44) {
      console.log("[API] Error: Invalid token mint format");
      return NextResponse.json(
        { error: "Invalid token mint format" },
        { status: 400 }
      );
    }

    console.log(`[API] Wallet: ${walletAddress}`);
    console.log(`[API] Token: ${tokenMint}`);
    console.log(`[API] Method: ${useFast ? "fast" : "standard"}`);
    console.log(`[API] Max Transactions: ${maxTxns}`);

    const startTime = Date.now();

    const result = useFast
      ? await calculateTokenVolumeFast(walletAddress, tokenMint)
      : await calculateTokenVolume(walletAddress, tokenMint, maxTxns);

    const duration = Date.now() - startTime;
    console.log(`[API] Calculation completed in ${duration}ms`);

    if (!result.success) {
      console.log(`[API] Error: ${result.error}`);
      return NextResponse.json(
        {
          success: false,
          error: result.error,
        },
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
    console.error("[API] Unhandled error:", error);
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
  console.log("\n[API] POST /api/getVolume");

  try {
    const body = await request.json();

    const {
      wallet: walletAddress,
      token: tokenMint,
      fast = true,
      maxTxns = 500,
      startTime: startTimeParam,
      endTime: endTimeParam,
    } = body;

    if (!walletAddress) {
      console.log("[API] Error: Missing wallet in body");
      return NextResponse.json(
        { error: "Missing required field: wallet" },
        { status: 400 }
      );
    }

    if (!tokenMint) {
      console.log("[API] Error: Missing token in body");
      return NextResponse.json(
        { error: "Missing required field: token" },
        { status: 400 }
      );
    }

    const filterStartTime = startTimeParam ? Number(startTimeParam) : undefined;
    const filterEndTime = endTimeParam ? Number(endTimeParam) : undefined;

    console.log(`[API] Wallet: ${walletAddress}`);
    console.log(`[API] Token: ${tokenMint}`);
    console.log(`[API] Method: ${fast ? "fast" : "standard"}`);
    console.log(`[API] Max Transactions: ${maxTxns}`);
    console.log(`[API] Time Range: ${filterStartTime ? new Date(filterStartTime * 1000).toISOString() : 'beginning'} to ${filterEndTime ? new Date(filterEndTime * 1000).toISOString() : 'now'}`);

    const apiStartTime = Date.now();

    const result = fast
      ? await calculateTokenVolumeFast(walletAddress, tokenMint, filterStartTime, filterEndTime)
      : await calculateTokenVolume(walletAddress, tokenMint, maxTxns, filterStartTime, filterEndTime);

    const duration = Date.now() - apiStartTime;
    console.log(`[API] Calculation completed in ${duration}ms`);

    if (!result.success) {
      console.log(`[API] Error: ${result.error}`);
      return NextResponse.json(
        {
          success: false,
          error: result.error,
        },
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
        method: fast ? "fast" : "standard",
        durationMs: duration,
        timeRange: {
          startTime: filterStartTime || null,
          endTime: filterEndTime || null,
        },
      },
    });
  } catch (error) {
    console.error("[API] Unhandled error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}
