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

/**
 * Validates cron request authentication.
 * Accepts:
 * 1. Authorization header: Bearer <CRON_SECRET>
 * 2. Query parameter: secret=<CRON_SECRET>
 * 3. Railway cron requests (user-agent contains "Railway" or has x-railway header)
 */
function isAuthorized(request: NextRequest): { authorized: boolean; method: string } {
  const authHeader = request.headers.get("authorization");
  const userAgent = request.headers.get("user-agent") || "";
  const railwayHeader = request.headers.get("x-railway-cron");
  const { searchParams } = new URL(request.url);
  const secretParam = searchParams.get("secret");

  // Check Authorization header
  if (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) {
    return { authorized: true, method: "auth-header" };
  }

  // Check query parameter
  if (CRON_SECRET && secretParam === CRON_SECRET) {
    return { authorized: true, method: "query-param" };
  }

  // Check Railway cron headers/user-agent
  if (railwayHeader || userAgent.toLowerCase().includes("railway")) {
    return { authorized: true, method: "railway-cron" };
  }

  // Log debug info for failed auth
  console.log(`[CRON API] Auth failed - UA: ${userAgent}, Railway header: ${railwayHeader}, Secret param: ${secretParam ? "present" : "missing"}`);

  return { authorized: false, method: "none" };
}

export async function POST(request: NextRequest) {
  const auth = isAuthorized(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log(`[CRON API] Authorized via: ${auth.method}`);

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
