import { ProviderError } from "./provider-error.js";
import {
  safeCategory,
  safeHistoryDetails,
  type HistoryDiagnostic,
} from "../src/history-diagnostics.js";
export function historyFailure(
  error: unknown,
  query: Record<string, unknown> = {},
) {
  const provider = error instanceof ProviderError;
  const category = safeCategory(provider ? error.code : undefined);
  const status =
    provider && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const context = (key: string, max: number, otherwise: number) => {
    const n = Number(query[key]);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : otherwise;
  };
  const diagnostic: HistoryDiagnostic = {
    category,
    httpStatus: status,
    pageIndex: Math.max(1, context("pageIndex", 12, 1)),
    loadedIntervals: context("loadedIntervals", 2160, 0),
    validCandles: context("validCandles", 2160, 0),
    ...safeHistoryDetails(
      provider
        ? { ...error.details, ...error, retryAfter: error.retryAfter }
        : undefined,
    ),
  };
  return {
    status,
    body: {
      error: category,
      httpStatus: status,
      ...safeHistoryDetails(diagnostic),
      diagnostic,
    },
  };
}
