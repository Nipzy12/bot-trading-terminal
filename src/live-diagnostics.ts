export const networkCodes = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
] as const;
export const networkStages = [
  "DNS_FAILED",
  "TCP_CONNECT_FAILED",
  "TLS_FAILED",
  "WS_HANDSHAKE_TIMEOUT",
  "WS_HTTP_REJECTED",
  "WS_CONNECTED",
  "SUBSCRIPTION_SENT",
  "WAITING_FOR_BROKER_TICK",
  "EXNESS_LIVE",
  "WS_DISCONNECTED",
] as const;
export const preflightCodes = [
  "DNS_FAILED",
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

// Only known enums and selected HTTP statuses may reach the status text.
export function streamStatusLabel(code: string, value: unknown) {
  const v =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const parts = [code];
  if (v.stage === "WS_HTTP_REJECTED" && code !== v.stage) parts.push(v.stage);
  if (
    typeof v.httpStatus === "number" &&
    [400, 401, 403, 404, 408, 429, 500, 502, 503, 504].includes(v.httpStatus)
  )
    parts.push(`HTTP ${v.httpStatus}`);
  if (
    typeof v.internalCode === "string" &&
    [
      ...networkCodes,
      "NETWORK_ERROR",
      "HANDSHAKE_DEADLINE",
      "HTTP_REJECTED",
      "SOCKET_CLOSED",
      "CLOSED_BEFORE_OPEN",
    ].includes(v.internalCode)
  )
    parts.push(v.internalCode);
  return parts.join(" · ");
}
