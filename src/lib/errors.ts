// Unified error handling utilities for Prisma and RPC errors

export type ApiErrorCode =
  | "CONNECTION_ERROR" // DB connection timeout/refused
  | "RPC_FORBIDDEN" // Helius 403
  | "RPC_RATE_LIMITED" // Helius 429
  | "RPC_ERROR" // Other RPC errors
  | "VALIDATION_ERROR" // Bad input
  | "AUTH_ERROR" // Unauthorized
  | "UNKNOWN";

export interface ApiError {
  message: string;
  code: ApiErrorCode;
  retryable: boolean;
  retryAfter?: number; // ms to wait before retry
}

// Detect Prisma connection errors (timeouts, refused connections)
export function isPrismaConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("can't reach database server") ||
    message.includes("p1001") || // Prisma connection error code
    message.includes("p1002") || // Server unreachable
    message.includes("connection") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("connection pool timeout") ||
    message.includes("timed out")
  );
}

// Detect RPC errors (Helius/Solana)
export function isRPCError(error: unknown, statusCode?: number): boolean {
  if (statusCode === 403 || statusCode === 429 || statusCode === 503) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("403") ||
    message.includes("forbidden") ||
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("rpc") ||
    message.includes("helius")
  );
}

// Check if an error is retryable
export function isRetryableError(error: unknown): boolean {
  if (isPrismaConnectionError(error)) return true;

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // 403 forbidden is NOT retryable (auth issue)
    if (message.includes("403") || message.includes("forbidden")) {
      return false;
    }
    // 429 rate limit IS retryable after delay
    if (message.includes("429") || message.includes("rate limit")) {
      return true;
    }
    // Connection issues are retryable
    if (
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("econnreset") ||
      message.includes("socket")
    ) {
      return true;
    }
  }
  return false;
}

// Get error code from error
export function getErrorCode(error: unknown, statusCode?: number): ApiErrorCode {
  if (isPrismaConnectionError(error)) {
    return "CONNECTION_ERROR";
  }

  if (statusCode === 403) return "RPC_FORBIDDEN";
  if (statusCode === 429) return "RPC_RATE_LIMITED";
  if (statusCode === 401) return "AUTH_ERROR";
  if (statusCode === 400) return "VALIDATION_ERROR";

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("403") || message.includes("forbidden")) {
      return "RPC_FORBIDDEN";
    }
    if (message.includes("429") || message.includes("rate limit")) {
      return "RPC_RATE_LIMITED";
    }
    if (message.includes("rpc") || message.includes("helius")) {
      return "RPC_ERROR";
    }
  }

  return "UNKNOWN";
}

// Create standardized API error response
export function createApiError(error: unknown, statusCode?: number): ApiError {
  const code = getErrorCode(error, statusCode);
  const retryable = isRetryableError(error);

  let message: string;
  let retryAfter: number | undefined;

  switch (code) {
    case "CONNECTION_ERROR":
      message = "Database connection failed. Please try again.";
      retryAfter = 1000;
      break;
    case "RPC_FORBIDDEN":
      message = "RPC service unavailable. Please try again later.";
      break;
    case "RPC_RATE_LIMITED":
      message = "Too many requests. Please wait a moment.";
      retryAfter = 5000;
      break;
    case "RPC_ERROR":
      message = "Network error. Please check your connection.";
      retryAfter = 2000;
      break;
    case "VALIDATION_ERROR":
      message = error instanceof Error ? error.message : "Invalid request.";
      break;
    case "AUTH_ERROR":
      message = "Unauthorized. Please reconnect your wallet.";
      break;
    default:
      message = error instanceof Error ? error.message : "An unexpected error occurred.";
  }

  return { message, code, retryable, retryAfter };
}

// Generic retry wrapper with exponential backoff
export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 500,
    maxDelay = 10000,
    shouldRetry = isRetryableError,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!shouldRetry(error)) {
        throw error;
      }

      if (attempt === maxRetries) {
        break;
      }

      const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
      onRetry?.(attempt + 1, error);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// Fetch with timeout using AbortController
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
