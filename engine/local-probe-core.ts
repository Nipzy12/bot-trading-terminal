import { z } from "zod";
import { safeOrigin } from "../server/ssrf.js";
import { parseLiveFrame, type FrameContext } from "../server/live-frame.js";

export const localConfigSchema = z.object({
  apiKey: z.string().min(8).max(256),
  privateKey: z.string().regex(/^[0-9a-f]{128}$/i),
  accountId: z.string().regex(/^[1-9]\d{0,19}$/),
  gateway: z.string().min(12).max(256),
}).strict();
export const LOCAL_PROBE_LIMIT_MS = 65_000;
const allowedSuffixes = ["exness.com", "exness-api.com"] as const;

export function safeLocalBrokerOrigin(candidate: string) {
  const origin = safeOrigin(candidate);
  const hostname = new URL(origin).hostname;
  if (!allowedSuffixes.some(suffix =>
    hostname === suffix || hostname.endsWith("." + suffix))) throw Error("BROKER_HOST_NOT_ALLOWED");
  return origin;
}
export function localTicksUrl(host: string, path: string, accountId: string) {
  const origin = safeLocalBrokerOrigin(host);
  if (!/^[1-9]\d{0,19}$/.test(accountId) ||
      BigInt(accountId) > 18446744073709551615n ||
      path !== "/v1/server-events/accounts/" + accountId + "/ws/ticks") {
    throw Error("UNEXPECTED_BROKER_PATH");
  }
  return origin.replace(/^https:/, "wss:") + path;
}

export function acceptLocalProbeFrame(raw: unknown, context: FrameContext) {
  // Reuse the same strict broker decoder as the Vercel bridge. Control/error
  // frames cannot be accepted as ticks even if they include bid/ask fields.
  return parseLiveFrame(raw, context);
}
