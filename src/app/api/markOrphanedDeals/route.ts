import { NextRequest, NextResponse } from "next/server";
import { markOrphanedDeals } from "@/lib/cron";

const CRON_SECRET = process.env.CRON_SECRET;

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await markOrphanedDeals();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[API] markOrphanedDeals failed:", error);
    return NextResponse.json(
      { error: "Failed to mark orphaned deals", details: String(error) },
      { status: 500 }
    );
  }
}
