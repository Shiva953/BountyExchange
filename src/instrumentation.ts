/**
 * Next.js Instrumentation
 *
 * This file runs once when the Next.js server starts.
 * Used to initialize cron jobs for background tasks.
 *
 * Works in both development (next dev) and production (next start).
 */

export async function register() {
  // Only run on the server side (Node.js runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log("[INSTRUMENTATION] Initializing server-side services...");

    // Skip in-process cron if CRON_SECRET is set (using HTTP-triggered cron in production)
    if (process.env.CRON_SECRET) {
      console.log(
        "[INSTRUMENTATION] CRON_SECRET detected - using HTTP-triggered cron jobs"
      );
      return;
    }

    try {
      // Dynamic import to avoid bundling issues
      const { initCronJobs } = await import("./lib/cron");
      initCronJobs();
      console.log("[INSTRUMENTATION] In-process cron jobs initialized (dev mode)");
    } catch (error) {
      console.error("[INSTRUMENTATION] Failed to initialize cron jobs:", error);
    }
  }
}
