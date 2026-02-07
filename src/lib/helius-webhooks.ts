const HELIUS_API_BASE = "https://api.helius.xyz/v0";

export const SWAP_TRANSACTION_TYPES = ["SWAP"] as const;

export type WebhookType = "enhanced" | "raw" | "discord" | "enhancedDevnet" | "rawDevnet";

export interface HeliusWebhook {
  webhookID: string;
  wallet: string;
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: WebhookType;
  authHeader?: string;
}

export interface CreateWebhookRequest {
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: WebhookType;
  authHeader?: string;
}

export interface UpdateWebhookRequest {
  webhookURL?: string;
  transactionTypes?: string[];
  accountAddresses?: string[];
  authHeader?: string;
}

function getApiKey(): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new Error("HELIUS_API_KEY environment variable is not set");
  }
  return apiKey;
}

export async function createHeliusWebhook(request: CreateWebhookRequest): Promise<HeliusWebhook> {
  const apiKey = getApiKey();

  const response = await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create webhook: ${response.status} - ${error}`);
  }

  return response.json();
}

export async function getHeliusWebhook(webhookId: string): Promise<HeliusWebhook> {
  const apiKey = getApiKey();

  const response = await fetch(
    `${HELIUS_API_BASE}/webhooks/${webhookId}?api-key=${apiKey}`,
    { method: "GET" }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get webhook: ${response.status} - ${error}`);
  }

  const webhook = await response.json();

  return {
    ...webhook,
    accountAddresses: webhook.accountAddresses || [],
    transactionTypes: webhook.transactionTypes || [],
  };
}

export async function getAllHeliusWebhooks(): Promise<HeliusWebhook[]> {
  const apiKey = getApiKey();

  const response = await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${apiKey}`, {
    method: "GET",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get webhooks: ${response.status} - ${error}`);
  }

  const webhooks = await response.json();

  if (!Array.isArray(webhooks)) {
    return [];
  }

  return webhooks.map((w: HeliusWebhook) => ({
    ...w,
    accountAddresses: w.accountAddresses || [],
    transactionTypes: w.transactionTypes || [],
  }));
}

// NOTE: Helius PUT requires ALL fields, not just changes
export async function updateHeliusWebhook(
  webhookId: string,
  request: UpdateWebhookRequest
): Promise<HeliusWebhook> {
  const apiKey = getApiKey();

  const current = await getHeliusWebhook(webhookId);

  const fullRequest = {
    webhookURL: request.webhookURL ?? current.webhookURL,
    transactionTypes: request.transactionTypes ?? current.transactionTypes ?? [],
    accountAddresses: request.accountAddresses ?? current.accountAddresses ?? [],
    webhookType: current.webhookType,
    ...(request.authHeader && { authHeader: request.authHeader }),
  };

  const response = await fetch(
    `${HELIUS_API_BASE}/webhooks/${webhookId}?api-key=${apiKey}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fullRequest),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update webhook: ${response.status} - ${error}`);
  }

  return response.json();
}

export async function deleteHeliusWebhook(webhookId: string): Promise<void> {
  const apiKey = getApiKey();

  const response = await fetch(
    `${HELIUS_API_BASE}/webhooks/${webhookId}?api-key=${apiKey}`,
    { method: "DELETE" }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to delete webhook: ${response.status} - ${error}`);
  }
}

export async function addAddressesToWebhook(
  webhookId: string,
  addresses: string[]
): Promise<HeliusWebhook> {
  const webhook = await getHeliusWebhook(webhookId);
  const currentAddresses = webhook.accountAddresses || [];

  const existingSet = new Set(currentAddresses.map(a => a.toLowerCase()));
  const newAddresses = addresses.filter(a => !existingSet.has(a.toLowerCase()));

  if (newAddresses.length === 0) {
    console.log("[HeliusWebhooks] No new addresses to add");
    return webhook;
  }

  const updatedAddresses = [...currentAddresses, ...newAddresses];

  if (updatedAddresses.length > 100000) {
    throw new Error(`Too many addresses: ${updatedAddresses.length} (max 100,000)`);
  }

  return updateHeliusWebhook(webhookId, { accountAddresses: updatedAddresses });
}

export async function removeAddressesFromWebhook(
  webhookId: string,
  addresses: string[]
): Promise<HeliusWebhook> {
  const webhook = await getHeliusWebhook(webhookId);
  const currentAddresses = webhook.accountAddresses || [];

  const removeSet = new Set(addresses.map(a => a.toLowerCase()));
  const updatedAddresses = currentAddresses.filter(a => !removeSet.has(a.toLowerCase()));

  return updateHeliusWebhook(webhookId, { accountAddresses: updatedAddresses });
}

export async function getOrCreateSwapWebhook(): Promise<HeliusWebhook> {
  const webhookId = process.env.HELIUS_WEBHOOK_ID;

  if (webhookId) {
    try {
      return await getHeliusWebhook(webhookId);
    } catch {
      console.warn("[HeliusWebhooks] Could not find webhook by ID, checking all webhooks");
    }
  }

  const webhooks = await getAllHeliusWebhooks();
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.VERCEL_URL;

  if (!baseUrl) {
    throw new Error("NEXT_PUBLIC_BASE_URL or VERCEL_URL must be set");
  }

  const webhookURL = `${baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`}/api/helius/webhook`;

  const existing = webhooks.find(w => w.webhookURL === webhookURL);
  if (existing) {
    console.log(`[HeliusWebhooks] Found existing webhook: ${existing.webhookID}`);
    return existing;
  }

  const { prisma } = await import("./prisma");
  const activeDeals = await prisma.deal.findMany({
    where: { isActive: true, isAccepted: true },
    select: { traderAddress: true },
    distinct: ["traderAddress"],
  });

  const initialAddresses = [...new Set(activeDeals.map(d => d.traderAddress))];

  if (initialAddresses.length === 0) {
    throw new Error(
      "Cannot create Helius webhook: no active traders found. " +
      "At least one deal must be accepted before webhook can be created."
    );
  }

  const rpcUrl = process.env.HELIUS_DEVNET_URL || "";
  const isDevnet = rpcUrl.toLowerCase().includes("devnet");
  const webhookType: WebhookType = isDevnet ? "enhancedDevnet" : "enhanced";

  console.log(`[HeliusWebhooks] Creating webhook (${webhookType}) with ${initialAddresses.length} address(es)`);

  const webhook = await createHeliusWebhook({
    webhookURL,
    transactionTypes: [...SWAP_TRANSACTION_TYPES],
    accountAddresses: initialAddresses,
    webhookType,
    authHeader: process.env.HELIUS_WEBHOOK_SECRET,
  });

  console.log(`[HeliusWebhooks] Created webhook: ${webhook.webhookID}`);
  console.log(`[HeliusWebhooks] Add HELIUS_WEBHOOK_ID=${webhook.webhookID} to env`);

  return webhook;
}

export async function registerTraderForWebhook(traderAddress: string): Promise<void> {
  try {
    const webhook = await getOrCreateSwapWebhook();
    await addAddressesToWebhook(webhook.webhookID, [traderAddress]);
    console.log(`[HeliusWebhooks] Registered trader ${traderAddress.slice(0, 8)}...`);
  } catch (error) {
    console.error("[HeliusWebhooks] Failed to register trader:", error);
  }
}

export async function unregisterTraderFromWebhook(traderAddress: string): Promise<void> {
  try {
    const webhookId = process.env.HELIUS_WEBHOOK_ID;
    if (!webhookId) {
      console.warn("[HeliusWebhooks] No HELIUS_WEBHOOK_ID set");
      return;
    }

    await removeAddressesFromWebhook(webhookId, [traderAddress]);
    console.log(`[HeliusWebhooks] Unregistered trader ${traderAddress.slice(0, 8)}...`);
  } catch (error) {
    console.error("[HeliusWebhooks] Failed to unregister trader:", error);
  }
}

export async function syncWebhookWithActiveTraders(): Promise<{
  added: number;
  removed: number;
  total: number;
}> {
  const { prisma } = await import("./prisma");

  const activeDeals = await prisma.deal.findMany({
    where: { isActive: true, isAccepted: true },
    select: { traderAddress: true },
    distinct: ["traderAddress"],
  });

  const activeTraders = [...new Set(activeDeals.map(d => d.traderAddress))];

  const webhook = await getOrCreateSwapWebhook();
  const webhookAddresses = webhook.accountAddresses || [];
  const currentAddresses = new Set(webhookAddresses.map(a => a.toLowerCase()));
  const targetAddresses = new Set(activeTraders.map(a => a.toLowerCase()));

  const toAdd = activeTraders.filter(a => !currentAddresses.has(a.toLowerCase()));
  const toRemove = webhookAddresses.filter(a => !targetAddresses.has(a.toLowerCase()));

  if (toAdd.length > 0 || toRemove.length > 0) {
    const toRemoveLower = new Set(toRemove.map(r => r.toLowerCase()));
    const newAddresses = [
      ...webhookAddresses.filter(a => !toRemoveLower.has(a.toLowerCase())),
      ...toAdd,
    ];

    await updateHeliusWebhook(webhook.webhookID, { accountAddresses: newAddresses });

    console.log(`[HeliusWebhooks] Synced: +${toAdd.length} -${toRemove.length} = ${newAddresses.length} addresses`);
  }

  return { added: toAdd.length, removed: toRemove.length, total: activeTraders.length };
}
