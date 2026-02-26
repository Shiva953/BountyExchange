import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import type { TokenMetadata } from "@/utils/tokenMetadata";

export type DealOutcome = "won" | "lost" | "expired_unfulfilled";
export type DealStatus = "executing" | "satisfied" | "failed" | "awaiting";

/**
 * Core on-chain deal account structure.
 * Used by both trader-facing and sponsor-facing deal views.
 */
export interface DealAccount {
  publicKey: PublicKey;
  dealId: BN;
  creator: PublicKey;
  token: PublicKey;
  trader: PublicKey;
  rewardAmount: BN;
  targetVolume: BN;
  minBuyVolume: BN | null;
  expirationWindowInHours: BN;
  holdDurationInHours: BN;
  escrowVault: PublicKey;
  bump: number;
  createdAt: BN;
  isActive: boolean;
  isAccepted: boolean;
}

/**
 * Deal enriched with token metadata and DB-sourced fields.
 * Used by traders viewing their accepted deals.
 * DB-only fields (outcome, volumeCompleted, expiresAt, finalizedAt) are
 * absent when data comes from the on-chain fallback.
 */
export interface DealWithMetadata extends DealAccount {
  tokenMetadata: TokenMetadata | null;
  // DB-only fields (not available on-chain)
  outcome?: DealOutcome | null;
  volumeCompleted?: number;
  expiresAt?: Date | null;
  finalizedAt?: Date | null;
}

/**
 * Deal enriched with token metadata and sponsor-specific fields.
 * Used by sponsors viewing their created deals.
 */
export interface CreatedDealWithMetadata extends DealAccount {
  tokenMetadata: TokenMetadata | null;
  traderName?: string | null;
  status: DealStatus;
}
