import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { sleep } from "./sleep";

// These patterns cover the Chrome MV3 service worker disconnection errors
// Phantom logs "[PHANTOM] Failed to send message to service worker..." and throws one of these
const RETRYABLE_SIGN_PATTERNS = [
  "disconnected port",
  "could not establish connection",
  "receiving end does not exist",
  "service worker",
  "extension context invalidated",
];

function isRetryableSignError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return RETRYABLE_SIGN_PATTERNS.some((p) => msg.includes(p));
}

interface SignWithRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  onRetry?: (attempt: number, maxAttempts: number) => void;
}

export async function signTransactionWithRetry<
  T extends Transaction | VersionedTransaction
>(
  signFn: (tx: T) => Promise<T>,
  transaction: T,
  options: SignWithRetryOptions = {}
): Promise<T> {
  const { maxAttempts = 3, retryDelayMs = 1500, onRetry } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await signFn(transaction);
    } catch (error) {
      lastError = error;

      if (isRetryableSignError(error) && attempt < maxAttempts) {
        onRetry?.(attempt, maxAttempts);
        await sleep(retryDelayMs);
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}
