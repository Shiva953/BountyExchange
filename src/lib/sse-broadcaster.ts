/**
 * SSE Broadcaster
 * Manages Server-Sent Events connections and broadcasts deal updates.
 * Uses Redis Pub/Sub for multi-instance support.
 */

import { cache } from "./redis";
import { SSEEventType, SSEEvent } from "@/types/sse";

export type { SSEEventType, SSEEvent };

// Channel name for Redis Pub/Sub
const CHANNEL_PREFIX = "deal-updates";

/**
 * Get channel name for a deal
 */
export function getDealChannel(dealPublicKey: string): string {
  return `${CHANNEL_PREFIX}:${dealPublicKey}`;
}

/**
 * Get channel name for a wallet (receives all deal updates for that wallet)
 */
export function getWalletChannel(walletAddress: string): string {
  return `${CHANNEL_PREFIX}:wallet:${walletAddress.toLowerCase()}`;
}

/**
 * Broadcast an SSE event for a deal
 * Publishes to both the deal-specific channel and wallet channel
 */
export async function broadcastDealUpdate(
  dealPublicKey: string,
  walletAddress: string,
  event: SSEEvent
): Promise<void> {
  const message = JSON.stringify(event);

  try {
    // Publish to deal channel
    await cache.publish(getDealChannel(dealPublicKey), message);

    // Publish to wallet channel
    await cache.publish(getWalletChannel(walletAddress), message);

    console.log(
      `[SSE] Broadcast ${event.type} for deal ${dealPublicKey.slice(0, 8)}... to wallet ${walletAddress.slice(0, 8)}...`
    );
  } catch (error) {
    console.error("[SSE] Broadcast error:", error);
  }
}

/**
 * Broadcast volume update for a deal
 */
export async function broadcastVolumeUpdate(
  dealPublicKey: string,
  walletAddress: string,
  volumeUSD: number,
  totalVolume: number,
  targetVolume: number
): Promise<void> {
  const progress = targetVolume > 0 ? (volumeUSD / targetVolume) * 100 : 0;

  const event: SSEEvent = {
    type: "volume_update",
    dealPublicKey,
    data: {
      volumeUSD,
      totalVolume,
      progress: Math.min(100, progress),
      timestamp: Date.now(),
    },
  };

  await broadcastDealUpdate(dealPublicKey, walletAddress, event);
}

/**
 * Broadcast milestone achievement for a deal
 */
export async function broadcastMilestone(
  dealPublicKey: string,
  walletAddress: string,
  milestone: 25 | 50 | 75 | 90,
  volumeUSD: number,
  progress: number
): Promise<void> {
  const event: SSEEvent = {
    type: "milestone",
    dealPublicKey,
    data: {
      volumeUSD,
      progress,
      milestone,
      timestamp: Date.now(),
    },
  };

  await broadcastDealUpdate(dealPublicKey, walletAddress, event);
}

/**
 * Broadcast deal finalization
 */
export async function broadcastFinalization(
  dealPublicKey: string,
  walletAddress: string,
  outcome: "won" | "lost",
  volumeUSD: number
): Promise<void> {
  const event: SSEEvent = {
    type: "finalized",
    dealPublicKey,
    data: {
      volumeUSD,
      outcome,
      timestamp: Date.now(),
    },
  };

  await broadcastDealUpdate(dealPublicKey, walletAddress, event);
}

/**
 * Store pending events for polling fallback (when Redis Pub/Sub not available)
 * Events are stored with TTL and can be polled by the SSE endpoint
 */
export async function storePendingEvent(
  dealPublicKey: string,
  event: SSEEvent
): Promise<void> {
  const key = `pending-events:${dealPublicKey}`;

  try {
    // Get existing events
    const existing = await cache.get<SSEEvent[]>(key) || [];

    // Add new event and keep only last 10
    existing.push(event);
    const trimmed = existing.slice(-10);

    // Store with 5 minute TTL
    await cache.set(key, trimmed, 300);
  } catch (error) {
    console.error("[SSE] Error storing pending event:", error);
  }
}

/**
 * Get and clear pending events for a deal (used by polling fallback)
 */
export async function getPendingEvents(dealPublicKey: string): Promise<SSEEvent[]> {
  const key = `pending-events:${dealPublicKey}`;

  try {
    const events = await cache.get<SSEEvent[]>(key) || [];

    // Clear after reading
    if (events.length > 0) {
      await cache.del(key);
    }

    return events;
  } catch (error) {
    console.error("[SSE] Error getting pending events:", error);
    return [];
  }
}

/**
 * Format an SSE event for transmission
 */
export function formatSSEMessage(event: SSEEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Create a heartbeat event
 */
export function createHeartbeatEvent(): SSEEvent {
  return {
    type: "heartbeat",
    dealPublicKey: "",
    data: {
      timestamp: Date.now(),
    },
  };
}
