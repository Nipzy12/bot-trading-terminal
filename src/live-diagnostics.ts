export const preflightCodes = [
  "SESSION_INVALID",
  "ORIGIN_REJECTED",
  "ACCOUNT_NOT_SELECTED",
  "ACCOUNT_TRADE_MODE_DISABLED",
  "LIMITS_INVALID",
  "CONNECTION_QUOTA",
  "RATE_LIMITED",
  "BOOTSTRAP_FAILED",
  "WEBSOCKET_UPGRADE_FAILED",
] as const;
export type PreflightCode = (typeof preflightCodes)[number];
export function preflightCode(value: unknown): PreflightCode {
  return typeof value === "string" &&
    (preflightCodes as readonly string[]).includes(value)
    ? (value as PreflightCode)
    : "WEBSOCKET_UPGRADE_FAILED";
}

export const rateLimitSources = [
  "INTERNAL_USER",
  "INTERNAL_PROVIDER_REST",
  "INTERNAL_WS_LEASE",
  "EXNESS_REST",
  "EXNESS_WS",
] as const;
export type RateInfo = {
  rateLimitSource?: (typeof rateLimitSources)[number];
  retryAfterSec?: number;
};
export function rateInfo(value: unknown): RateInfo {
  const v =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    ...(typeof v.rateLimitSource === "string" &&
    (rateLimitSources as readonly string[]).includes(v.rateLimitSource)
      ? { rateLimitSource: v.rateLimitSource as RateInfo["rateLimitSource"] }
      : {}),
    ...(typeof v.retryAfterSec === "number" &&
    Number.isFinite(v.retryAfterSec) &&
    v.retryAfterSec > 0 &&
    v.retryAfterSec <= 86400
      ? { retryAfterSec: Math.ceil(v.retryAfterSec) }
      : {}),
  };
}
