/**
 * Full trader record as stored in the DB and returned by /api/getTraders.
 * Used in TraderIndex and CreateBountyModal.
 */
export interface Trader {
  id: number;
  name: string;
  address: string;
  imageUrl: string | null;
  volumeCompleted: number;
  activeBounties: number;
}

/**
 * Lightweight trader info attached to a deal (from useTraderDeals hook).
 * Does not include id/address — sourced from the DB trader record.
 */
export interface TraderData {
  name: string | null;
  imageUrl: string | null;
  volumeCompleted: number;
  activeBounties: number;
}
