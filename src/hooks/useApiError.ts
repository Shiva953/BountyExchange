"use client";

import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";

// Mirror the API error structure from backend
export interface ApiError {
  message: string;
  code:
    | "CONNECTION_ERROR"
    | "RPC_FORBIDDEN"
    | "RPC_RATE_LIMITED"
    | "RPC_ERROR"
    | "VALIDATION_ERROR"
    | "AUTH_ERROR"
    | "UNKNOWN";
  retryable: boolean;
  retryAfter?: number;
}

export interface UseApiErrorOptions {
  maxRetries?: number;
  showToast?: boolean;
  onRetryStart?: () => void;
  onRetryEnd?: (success: boolean) => void;
}

export interface UseApiErrorReturn {
  error: ApiError | null;
  isRetrying: boolean;
  retryCount: number;
  setError: (error: ApiError | null) => void;
  handleError: (error: unknown) => ApiError;
  retry: () => Promise<void>;
  clear: () => void;
  withErrorHandling: <T>(fn: () => Promise<T>) => Promise<T | null>;
}

// Parse error from API response or thrown error
function parseApiError(error: unknown): ApiError {
  // If it's already an ApiError structure from the API
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "retryable" in error
  ) {
    return error as ApiError;
  }

  // If it's an Error with a message
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Connection/timeout errors
    if (
      message.includes("connection") ||
      message.includes("timeout") ||
      message.includes("network") ||
      message.includes("fetch")
    ) {
      return {
        message: "Connection failed. Please check your network.",
        code: "CONNECTION_ERROR",
        retryable: true,
        retryAfter: 1000,
      };
    }

    // RPC errors
    if (message.includes("403") || message.includes("forbidden")) {
      return {
        message: "Service temporarily unavailable. Please try again later.",
        code: "RPC_FORBIDDEN",
        retryable: false,
      };
    }

    if (message.includes("429") || message.includes("rate limit")) {
      return {
        message: "Too many requests. Please wait a moment.",
        code: "RPC_RATE_LIMITED",
        retryable: true,
        retryAfter: 5000,
      };
    }

    return {
      message: error.message,
      code: "UNKNOWN",
      retryable: false,
    };
  }

  return {
    message: "An unexpected error occurred.",
    code: "UNKNOWN",
    retryable: false,
  };
}

export function useApiError(
  retryFn?: () => Promise<void>,
  options: UseApiErrorOptions = {}
): UseApiErrorReturn {
  const { maxRetries = 3, showToast = true, onRetryStart, onRetryEnd } = options;

  const [error, setError] = useState<ApiError | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const retryFnRef = useRef(retryFn);
  retryFnRef.current = retryFn;

  const handleError = useCallback(
    (err: unknown): ApiError => {
      const apiError = parseApiError(err);
      setError(apiError);

      if (showToast) {
        if (apiError.retryable && retryCount < maxRetries) {
          toast.error(apiError.message, {
            description: "Retrying...",
            duration: 3000,
          });
        } else {
          toast.error(apiError.message);
        }
      }

      return apiError;
    },
    [showToast, retryCount, maxRetries]
  );

  const retry = useCallback(async () => {
    if (!retryFnRef.current || !error?.retryable || retryCount >= maxRetries) {
      return;
    }

    setIsRetrying(true);
    onRetryStart?.();

    // Wait for retryAfter delay if specified
    if (error.retryAfter) {
      await new Promise((resolve) => setTimeout(resolve, error.retryAfter));
    }

    try {
      await retryFnRef.current();
      setError(null);
      setRetryCount(0);
      onRetryEnd?.(true);
    } catch (err) {
      setRetryCount((prev) => prev + 1);
      handleError(err);
      onRetryEnd?.(false);
    } finally {
      setIsRetrying(false);
    }
  }, [error, retryCount, maxRetries, handleError, onRetryStart, onRetryEnd]);

  const clear = useCallback(() => {
    setError(null);
    setRetryCount(0);
    setIsRetrying(false);
  }, []);

  // Wrapper to handle async operations with automatic error handling
  const withErrorHandling = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | null> => {
      try {
        clear();
        const result = await fn();
        return result;
      } catch (err) {
        handleError(err);
        return null;
      }
    },
    [clear, handleError]
  );

  return {
    error,
    isRetrying,
    retryCount,
    setError,
    handleError,
    retry,
    clear,
    withErrorHandling,
  };
}

// Helper to extract API error from fetch response
export async function extractApiError(response: Response): Promise<ApiError> {
  try {
    const data = await response.json();
    if (data.code && data.retryable !== undefined) {
      return {
        message: data.error || data.message || "Request failed",
        code: data.code,
        retryable: data.retryable,
        retryAfter: data.retryAfter,
      };
    }
    return parseApiError(new Error(data.error || data.message || `HTTP ${response.status}`));
  } catch {
    return parseApiError(new Error(`HTTP ${response.status}`));
  }
}
