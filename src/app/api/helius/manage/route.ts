/**
 * Helius Webhook Management API
 * Admin endpoint to manage Helius webhooks for swap tracking.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getOrCreateSwapWebhook,
  getAllHeliusWebhooks,
  getHeliusWebhook,
  addAddressesToWebhook,
  removeAddressesFromWebhook,
  syncWebhookWithActiveTraders,
} from "@/lib/helius-webhooks";

// Simple admin auth check
function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    console.warn("[HELIUS_MANAGE] ADMIN_SECRET not set, denying access");
    return false;
  }

  return authHeader === `Bearer ${adminSecret}`;
}

/**
 * GET - Get webhook status and info
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Get list of webhooks (note: list endpoint doesn't include accountAddresses)
    const webhookList = await getAllHeliusWebhooks();

    // Fetch full details for each webhook to get address counts
    const webhooks = await Promise.all(
      webhookList.map(async (w) => {
        try {
          const full = await getHeliusWebhook(w.webhookID);
          return {
            id: full.webhookID,
            url: full.webhookURL,
            type: full.webhookType,
            transactionTypes: full.transactionTypes || [],
            addressCount: (full.accountAddresses || []).length,
            addresses: (full.accountAddresses || []).slice(0, 10), // Show first 10 for debugging
          };
        } catch {
          // Fallback if individual fetch fails
          return {
            id: w.webhookID,
            url: w.webhookURL,
            type: w.webhookType,
            transactionTypes: w.transactionTypes || [],
            addressCount: -1, // Unknown
            addresses: [],
          };
        }
      })
    );

    return NextResponse.json({
      success: true,
      webhooks,
    });
  } catch (error) {
    console.error("[HELIUS_MANAGE] Error getting webhooks:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

/**
 * POST - Manage webhook operations
 * Actions: create, sync, addAddresses, removeAddresses
 */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { action, addresses } = body;

    switch (action) {
      case "create": {
        // Get or create the swap tracking webhook
        const webhook = await getOrCreateSwapWebhook();
        const addresses = webhook.accountAddresses || [];
        return NextResponse.json({
          success: true,
          webhook: {
            id: webhook.webhookID,
            url: webhook.webhookURL,
            type: webhook.webhookType,
            addressCount: addresses.length,
            addresses: addresses.slice(0, 10),
          },
          message: `Webhook ready: ${webhook.webhookID}`,
        });
      }

      case "sync": {
        // Sync webhook addresses with active traders in DB
        const result = await syncWebhookWithActiveTraders();
        return NextResponse.json({
          success: true,
          ...result,
          message: `Synced: +${result.added} -${result.removed} = ${result.total} active traders`,
        });
      }

      case "addAddresses": {
        if (!addresses || !Array.isArray(addresses)) {
          return NextResponse.json(
            { error: "addresses array is required" },
            { status: 400 }
          );
        }

        const webhookId = process.env.HELIUS_WEBHOOK_ID;
        if (!webhookId) {
          return NextResponse.json(
            { error: "HELIUS_WEBHOOK_ID not configured" },
            { status: 400 }
          );
        }

        const webhook = await addAddressesToWebhook(webhookId, addresses);
        const currentAddresses = webhook.accountAddresses || [];
        return NextResponse.json({
          success: true,
          addressCount: currentAddresses.length,
          message: `Added ${addresses.length} address(es)`,
        });
      }

      case "removeAddresses": {
        if (!addresses || !Array.isArray(addresses)) {
          return NextResponse.json(
            { error: "addresses array is required" },
            { status: 400 }
          );
        }

        const webhookId = process.env.HELIUS_WEBHOOK_ID;
        if (!webhookId) {
          return NextResponse.json(
            { error: "HELIUS_WEBHOOK_ID not configured" },
            { status: 400 }
          );
        }

        const webhook = await removeAddressesFromWebhook(webhookId, addresses);
        const currentAddresses = webhook.accountAddresses || [];
        return NextResponse.json({
          success: true,
          addressCount: currentAddresses.length,
          message: `Removed ${addresses.length} address(es)`,
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Valid actions: create, sync, addAddresses, removeAddresses` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("[HELIUS_MANAGE] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
