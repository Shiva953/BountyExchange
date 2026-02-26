/**
 * API contract types shared between server route handlers and client hooks.
 *
 * Keeping these in a neutral types file prevents client-side hooks from
 * importing server-only route modules (which risks bundling server code).
 */

// ---------------------------------------------------------------------------
// Trader Deals API (/api/deal/getTraderDeals)
// ---------------------------------------------------------------------------

/** Single accepted deal row returned by getTraderDeals route. */
export interface TraderDealResponse {
  id: number;
  publicKey: string;
  dealId: string;
  creator: string;
  token: string;
  traderAddress: string;
  rewardAmount: string;
  targetVolume: string;
  minBuyVolume: string | null;
  expirationHours: number;
  holdDurationHours: number;
  escrowVault: string;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  isAccepted: boolean;
  volumeCompleted: string | null;
  outcome: string | null;
}

/** Trader profile returned alongside deals by getTraderDeals route. */
export interface TraderDataResponse {
  id: number;
  name: string | null;
  address: string;
  imageUrl: string | null;
  volumeCompleted: number;
  activeBounties: number;
}

// ---------------------------------------------------------------------------
// Sponsor Deals API (/api/sponsor/deals)
// ---------------------------------------------------------------------------

/** Single deal row returned by the sponsor deals route. */
export interface SponsorDealResponse {
  publicKey: string;
  dealId: string;
  creator: string;
  token: string;
  traderAddress: string;
  rewardAmount: number;
  targetVolume: number;
  minBuyVolume: number | null;
  expirationHours: number;
  holdDurationHours: number;
  escrowVault: string;
  createdAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  isAccepted: boolean;
  volumeCompleted: number;
  outcome: string | null;
  status: "executing" | "satisfied" | "failed" | "awaiting";
  traderName: string | null;
  traderImageUrl: string | null;
}

/** Full response envelope from the sponsor deals route. */
export interface SponsorDealsAPIResponse {
  success: boolean;
  deals: SponsorDealResponse[];
  stats: {
    totalEscrow: number;
    activeCampaigns: number;
    contractors: number;
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// API Request Bodies
// ---------------------------------------------------------------------------

/** POST /api/deal/create */
export interface CreateDealRequestBody {
  payer: string;
  token: string;
  trader: string;
  rewardAmount: string;
  targetVolume: string;
  minBuyVolume?: string;
  expirationWindowInHours: string;
  holdDurationInHours: string;
}

/** POST /api/deal/accept */
export interface AcceptDealRequestBody {
  trader: string;
  dealPubkey: string;
}

/** POST /api/deal/finalize */
export interface FinalizeDealRequest {
  dealPubkey: string;
  /** Volume in USD; converted to raw units server-side */
  volumeAtEndTime?: number;
  /** Hold duration in hours */
  holdDurationAtEndTime?: number;
}

/** POST /api/deal/confirmDealAccepted */
export interface ConfirmDealAcceptedBody {
  dealPubkey: string;
  signature?: string;
}
