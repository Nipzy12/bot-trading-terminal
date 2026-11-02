// Closed allowlists: never display provider messages, URLs, headers, or arbitrary response text.
export const historyCategories = [
  "HISTORY_LIMIT_REACHED",
  "PAGE_BUDGET_REACHED",
  "EXNESS_HISTORY_WINDOW",
  "EXNESS_INVALID_TIME_RANGE",
  "EXNESS_INVALID_COUNT",
  "EXNESS_INVALID_LIMIT",
  "EXNESS_INVALID_CURSOR",
  "EXNESS_DATA_UNAVAILABLE",
  "EXNESS_MARKET_DATA",
  "EXNESS_INVALID_RESPONSE",
  "EXNESS_LIMITS_UNAVAILABLE",
  "EXNESS_NETWORK",
  "EXNESS_AUTH",
  "EXNESS_PERMISSION",
  "EXNESS_SSRF",
  "EXNESS_CONFIGURATION",
  "EXNESS_UPSTREAM",
  "EXNESS_INTERNAL_FAILURE",
  "HISTORY_INTERNAL_FAILURE",
  "RATE_LIMITED",
  "TIMEOUT",
  "AUTH_REQUIRED",
  "ACCOUNT_SERVICE_UNAVAILABLE",
  "NO_VERIFIED_ACCOUNT_SELECTED",
  "CONNECTION_DELETED",
  "FEED_CHANGED",
  "INVALID_HISTORY_SCHEMA",
  "INVALID_HISTORY_TIME",
  "INVALID_HISTORY_OHLC",
  "INVALID_HISTORY_ORDER",
  "INVALID_HISTORY_WINDOW",
  "HISTORY_TOO_LARGE",
  "INVALID_HISTORY_SIZE",
  "INSUFFICIENT_HISTORY",
  "INVALID_HISTORY_QUERY",
] as const;
export type HistoryCategory = (typeof historyCategories)[number];
export type HistoryDiagnostic = {
  category: HistoryCategory;
  httpStatus: number;
  pageIndex: number;
  loadedIntervals: number;
  validCandles: number;
  providerCode?: number;
  upstreamStatus?: number;
  retryAfter?: number;
  reason?: string;
  rangeReason?: string;
  limitCause?:
    | "PROVIDER_AGE"
    | "PROVIDER_DATA_UNAVAILABLE"
    | "CURSOR_FLOOR"
    | "PAGE_BUDGET";
};
const providers = [1, 2, 3, 3004, 3005, 3006, 3007, 4000, 4004];
const reasons = [
  "EMPTY_CANDLES",
  "INVALID_SCHEMA",
  "INVALID_OHLC",
  "INVALID_TIMESTAMP",
  "OUT_OF_RANGE",
  "INVALID_ORDER",
  "INSTRUMENT_NOT_FOUND",
  "AMBIGUOUS_INSTRUMENT",
];
const ranges = [
  "BEFORE_FROM",
  "AT_TO",
  "AFTER_TO",
  "UNFINISHED_CANDLE",
  "TOO_MANY_CANDLES",
];
export function safeCategory(value: unknown): HistoryCategory {
  if (value === "EXNESS_RATE_LIMIT") return "RATE_LIMITED";
  if (value === "UNAUTHORIZED") return "AUTH_REQUIRED";
  if (value === "EXNESS_RESPONSE_TOO_LARGE") return "HISTORY_TOO_LARGE";
  return typeof value === "string" &&
    (historyCategories as readonly string[]).includes(value)
    ? (value as HistoryCategory)
    : "HISTORY_INTERNAL_FAILURE";
}
export function safeHistoryDetails(value: unknown): Partial<HistoryDiagnostic> {
  const v =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    ...(providers.includes(Number(v.providerCode)) &&
    typeof v.providerCode === "number"
      ? { providerCode: v.providerCode }
      : {}),
    ...(Number.isInteger(v.upstreamStatus) &&
    Number(v.upstreamStatus) >= 100 &&
    Number(v.upstreamStatus) <= 599
      ? { upstreamStatus: Number(v.upstreamStatus) }
      : {}),
    ...(Number.isInteger(v.retryAfter) &&
    Number(v.retryAfter) > 0 &&
    Number(v.retryAfter) <= 86400
      ? { retryAfter: Number(v.retryAfter) }
      : {}),
    ...(typeof v.reason === "string" && reasons.includes(v.reason)
      ? { reason: v.reason }
      : {}),
    ...(typeof v.rangeReason === "string" && ranges.includes(v.rangeReason)
      ? { rangeReason: v.rangeReason }
      : {}),
    ...([
      "PROVIDER_AGE",
      "PROVIDER_DATA_UNAVAILABLE",
      "CURSOR_FLOOR",
      "PAGE_BUDGET",
    ].includes(String(v.limitCause))
      ? { limitCause: v.limitCause as HistoryDiagnostic["limitCause"] }
      : {}),
  };
}
export function diagnosticText(d: HistoryDiagnostic) {
  return `${d.category} · HTTP ${d.httpStatus === 0 ? "— (tanpa respons)" : d.httpStatus} · halaman ${d.pageIndex} · ${d.loadedIntervals} interval dimuat · ${d.validCandles} candle valid${d.providerCode !== undefined ? ` · provider ${d.providerCode}` : ""}${d.upstreamStatus !== undefined ? ` · upstream HTTP ${d.upstreamStatus}` : ""}${d.reason ? ` · ${d.reason}` : ""}${d.rangeReason ? ` / ${d.rangeReason}` : ""}${d.limitCause ? ` · ${d.limitCause}` : ""}`;
}
