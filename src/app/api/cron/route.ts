import { NextRequest, NextResponse } from "next/server";
import {
  syncDealVolumes,
  checkExpiredDeals,
  syncTraderStats,
  runCleanup,
  markOrphanedDeals,
  reconcileOnChainState,
} from "@/lib/cron";

const CRON_SECRET = process.env.CRON_SECRET;

type CronJob = "sync-volumes" | "check-expired" | "sync-traders" | "cleanup" | "mark-orphaned" | "reconcile";

const jobHandlers: Record<CronJob, () => Promise<void>> = {
  "sync-volumes": syncDealVolumes,
  "check-expired": checkExpiredDeals,
  "sync-traders": syncTraderStats,
  cleanup: runCleanup,
  "mark-orphaned": markOrphanedDeals,
  reconcile: reconcileOnChainState,
};

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const job = searchParams.get("job") as CronJob | null;

  if (!job || !jobHandlers[job]) {
    return NextResponse.json(
      { error: "Invalid job. Use: sync-volumes, check-expired, sync-traders, cleanup, mark-orphaned, reconcile" },
      { status: 400 }
    );
  }

  try {
    console.log(`[CRON API] Running job: ${job}`);
    const startTime = Date.now();

    await jobHandlers[job]();

    const duration = Date.now() - startTime;
    console.log(`[CRON API] Job ${job} completed in ${duration}ms`);

    return NextResponse.json({
      success: true,
      job,
      durationMs: duration,
    });
  } catch (error) {
    console.error(`[CRON API] Job ${job} failed:`, error);
    return NextResponse.json(
      { error: "Job execution failed", details: String(error) },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
