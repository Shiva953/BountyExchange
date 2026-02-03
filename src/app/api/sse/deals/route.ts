/**
 * SSE Endpoint for Deal Updates
 * Streams real-time volume updates, milestones, and finalization events to clients.
 *
 * Query params:
 * - deals: Comma-separated list of deal public keys to watch
 * - wallet: Wallet address to watch all deals for
 *
 * Uses polling fallback since Vercel Edge doesn't support true Redis Pub/Sub.
 */

import { NextRequest } from "next/server";
import {
  getPendingEvents,
  formatSSEMessage,
  createHeartbeatEvent,
  type SSEEvent,
} from "@/lib/sse-broadcaster";

// Use edge runtime for better connection handling
export const runtime = "edge";

// Polling interval for pending events (ms)
const POLL_INTERVAL = 2000;

// Heartbeat interval (ms)
const HEARTBEAT_INTERVAL = 30000;

// Max connection duration (ms) - Vercel has limits
const MAX_DURATION = 5 * 60 * 1000; // 5 minutes

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Get deal public keys to watch
  const dealsParam = searchParams.get("deals");
  const walletParam = searchParams.get("wallet");

  const dealKeys = dealsParam ? dealsParam.split(",").filter(Boolean) : [];

  if (dealKeys.length === 0 && !walletParam) {
    return new Response(
      JSON.stringify({ error: "Either 'deals' or 'wallet' parameter is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Create SSE stream
  const encoder = new TextEncoder();
  const startTime = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial connection event
      const connectEvent: SSEEvent = {
        type: "connected",
        dealPublicKey: "",
        data: {
          timestamp: Date.now(),
        },
      };
      controller.enqueue(encoder.encode(formatSSEMessage(connectEvent)));

      let lastHeartbeat = Date.now();
      let isRunning = true;

      // Polling loop
      const poll = async () => {
        while (isRunning) {
          try {
            // Check if connection should end
            if (Date.now() - startTime > MAX_DURATION) {
              console.log("[SSE] Max duration reached, closing connection");
              controller.close();
              return;
            }

            // Send heartbeat if needed
            if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL) {
              controller.enqueue(
                encoder.encode(formatSSEMessage(createHeartbeatEvent()))
              );
              lastHeartbeat = Date.now();
            }

            // Poll for pending events for each deal
            for (const dealKey of dealKeys) {
              const events = await getPendingEvents(dealKey);
              for (const event of events) {
                controller.enqueue(encoder.encode(formatSSEMessage(event)));
              }
            }

            // Wait before next poll
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
          } catch (error) {
            console.error("[SSE] Polling error:", error);
            // Continue polling despite errors
          }
        }
      };

      // Start polling
      poll().catch((error) => {
        console.error("[SSE] Poll loop error:", error);
        controller.close();
      });

      // Handle client disconnect
      req.signal.addEventListener("abort", () => {
        console.log("[SSE] Client disconnected");
        isRunning = false;
      });
    },

    cancel() {
      console.log("[SSE] Stream cancelled");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
}
