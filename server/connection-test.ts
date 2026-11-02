import {
  CandleHistoryError,
  type CandleReason,
  type RangeReason,
} from "./candle-history.js";
import { ProviderError } from "./provider-error.js";
export const connectionStages = [
  "discovery",
  "account_details",
  "limits",
  "candles",
] as const;
export type ConnectionStage = (typeof connectionStages)[number];
export const safeCategories = [
  "EXNESS_AUTH",
  "EXNESS_PERMISSION",
  "EXNESS_NETWORK",
  "EXNESS_INVALID_RESPONSE",
  "EXNESS_LIMITS_UNAVAILABLE",
  "RATE_LIMITED",
  "TIMEOUT",
  "EXNESS_SSRF",
  "EXNESS_CONFIGURATION",
  "EXNESS_MARKET_DATA",
  "EXNESS_UPSTREAM",
  "ACCOUNT_SERVICE_UNAVAILABLE",
  "CONNECTION_DELETED",
] as const;
export type SafeCategory = (typeof safeCategories)[number];
export type StageResult = {
  stage: ConnectionStage;
  status: "passed" | "failed" | "not_run";
  code?: SafeCategory;
};
export type ConnectionReport = {
  success: boolean;
  excludedBoundaryCandles?: number;
  stages: StageResult[];
  stage?: ConnectionStage | "configuration";
  error?: SafeCategory;
  reason?: CandleReason;
  rangeReason?: RangeReason;
  candleCount?: number;
  retryAfter?: number;
};
export function safeFailure(error: unknown): {
  code: SafeCategory;
  reason?: CandleReason;
  rangeReason?: RangeReason;
  candleCount?: number;
  retryAfter?: number;
} {
  const raw = error instanceof ProviderError ? error.code : "";
  const candidate =
    raw === "EXNESS_DATA_UNAVAILABLE"
      ? "EXNESS_MARKET_DATA"
      : [
            "EXNESS_INVALID_TIME_RANGE",
            "EXNESS_INVALID_COUNT",
            "EXNESS_INVALID_LIMIT",
            "EXNESS_INVALID_CURSOR",
          ].includes(raw)
        ? "EXNESS_INVALID_RESPONSE"
        : raw;
  const code =
    candidate === "EXNESS_RATE_LIMIT"
      ? "RATE_LIMITED"
      : safeCategories.includes(candidate as SafeCategory)
        ? (candidate as SafeCategory)
        : "EXNESS_UPSTREAM";
  return {
    code,
    ...(error instanceof CandleHistoryError
      ? {
          reason: error.reason,
          candleCount: error.candleCount,
          ...(error.rangeReason ? { rangeReason: error.rangeReason } : {}),
        }
      : {}),
    ...(error instanceof ProviderError && error.retryAfter
      ? {
          retryAfter: Math.max(1, Math.min(86400, Math.ceil(error.retryAfter))),
        }
      : {}),
  };
}
export function bounded<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new ProviderError("TIMEOUT", 504));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProviderError("TIMEOUT", 504));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
