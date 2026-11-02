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
