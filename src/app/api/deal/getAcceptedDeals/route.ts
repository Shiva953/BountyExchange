import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getProgram } from "@/program/instructions/createDeal";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get("wallet");

    if (!walletAddress) {
      return NextResponse.json(
        { error: "Missing required query parameter: wallet" },
        { status: 400 }
      );
    }

    let walletPubkey: PublicKey;
    try {
      walletPubkey = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json(
        { error: "Invalid wallet address format" },
        { status: 400 }
      );
    }

    const connection = new Connection(process.env.HELIUS_DEVNET_URL!, "confirmed");
    const program = getProgram(connection);

    // Trader field offset in Deal account
    const allDeals = await program.account.deal.all([
      { memcmp: { offset: 80, bytes: walletPubkey.toBase58() } },
    ]);

    const acceptedDeals = allDeals
      .filter((deal) => deal.account.isAccepted)
      .map((deal) => ({
        publicKey: deal.publicKey.toBase58(),
        dealId: deal.account.dealId.toString(),
        creator: deal.account.creator.toBase58(),
        token: deal.account.token.toBase58(),
        trader: deal.account.trader.toBase58(),
        rewardAmount: deal.account.rewardAmount.toString(),
        targetVolume: deal.account.targetVolume.toString(),
        expirationWindowInHours: deal.account.expirationWindowInHours.toString(),
        holdDurationInHours: deal.account.holdDurationInHours.toString(),
        escrowVault: deal.account.escrowVault.toBase58(),
        bump: deal.account.bump,
        createdAt: deal.account.createdAt.toString(),
        isActive: deal.account.isActive,
        isAccepted: deal.account.isAccepted,
      }));

    return NextResponse.json({
      success: true,
      deals: acceptedDeals,
    });
  } catch (error) {
    console.error("Error fetching accepted deals:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch accepted deals",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
