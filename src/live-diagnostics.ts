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
  "WS_ERR_EXPECTED_FIN",
  "WS_ERR_EXPECTED_MASK",
  "WS_ERR_INVALID_CLOSE_CODE",
  "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH",
  "WS_ERR_INVALID_OPCODE",
  "WS_ERR_UNEXPECTED_MASK",
  "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH",
  "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
  "WS_ERR_INVALID_UTF8",
] as const;
export const networkStages = [
  "DNS_FAILED",
  "TCP_CONNECT_FAILED",
  "TLS_FAILED",
  "WS_HANDSHAKE_TIMEOUT",
  "WS_HANDSHAKE_FAILED",
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

export const networkPhases = [
  "DNS",
  "TCP",
  "TLS",
  "HANDSHAKE",
  "OPEN",
] as const;
export type NetworkPhase = (typeof networkPhases)[number];
export const internalCodes = [
  ...networkCodes,
  "NETWORK_ERROR",
  "NETWORK_CODE_UNCLASSIFIED",
  "DNS_ERROR_NO_CODE",
  "TCP_ERROR_NO_CODE",
  "TLS_ERROR_NO_CODE",
  "WS_HANDSHAKE_ERROR_NO_CODE",
  "WS_OPEN_ERROR_NO_CODE",
  "WS_SUBPROTOCOL_MISSING",
  "WS_SUBPROTOCOL_MISMATCH",
  "SUBSCRIPTION_SEND_FAILED",
  "HANDSHAKE_DEADLINE",
  "HTTP_REJECTED",
  "SOCKET_CLOSED",
  "CLOSED_BEFORE_OPEN",
] as const;
export const standardCloseCodes = [
  1000, 1001, 1002, 1003, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013,
  1014, 1015,
] as const;
export function safeCloseCode(code: unknown) {
  return typeof code === "number" &&
    (standardCloseCodes as readonly number[]).includes(code)
    ? code
    : undefined;
}
export type LiveDiagnostic = {
  phase: NetworkPhase;
  upstreamOpened: boolean;
  subscriptionSent: boolean;
  firstValidTickReceived: boolean;
  closeCode?: number;
  internalCode?: string;
};
export function liveDiagnostic(value: unknown): LiveDiagnostic | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (
    !(networkPhases as readonly unknown[]).includes(v.phase) ||
    [v.upstreamOpened, v.subscriptionSent, v.firstValidTickReceived].some(
      (v) => typeof v !== "boolean",
    )
  )
    return;
  return {
    phase: v.phase as NetworkPhase,
    upstreamOpened: v.upstreamOpened as boolean,
    subscriptionSent: v.subscriptionSent as boolean,
    firstValidTickReceived: v.firstValidTickReceived as boolean,
    ...(safeCloseCode(v.closeCode) !== undefined
      ? { closeCode: safeCloseCode(v.closeCode) }
      : {}),
    ...(typeof v.internalCode === "string" &&
    (internalCodes as readonly string[]).includes(v.internalCode)
      ? { internalCode: v.internalCode }
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
    (internalCodes as readonly string[]).includes(v.internalCode)
  )
    parts.push(v.internalCode);
  return parts.join(" · ");
}
