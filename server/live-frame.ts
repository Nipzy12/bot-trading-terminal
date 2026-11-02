import { z } from "zod";
import { normalizeBrokerTick } from "../src/live.js";
import {
  brokerErrorCategories,
  safeBrokerErrorCode,
} from "../src/live-diagnostics.js";
const requestId = z.string().min(1).max(128);
// Official WsErrorResponse requires id/code/error_message. Text never leaves parser.
const subscriptionError = z
  .object({
    id: requestId,
    code: z.number().int(),
    error_message: z.string().min(1).max(256),
  })
  .strict();
// Not an officially documented ACK contract. Only this exact correlated shape
// may be observed without tearing down the stream; it is NOT accepted as success.
const unverifiedAck = z
  .object({ id: requestId, code: z.literal(200) })
  .strict();
export type FrameContext = {
  subscriptionId: string;
  accountId: string;
  instrument: string;
  connectionId: string;
  symbol: string;
  last: number;
  now?: number;
};
export function parseLiveFrame(raw: unknown, context: FrameContext) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { kind: "unknown" } as const;
  const value = raw as Record<string, unknown>;
  if (
    Object.hasOwn(value, "account_id") &&
    value.account_id !== context.accountId
  )
    return { kind: "account_mismatch" } as const;
  if (Object.hasOwn(value, "id") && value.id !== context.subscriptionId)
    return { kind: "unknown" } as const;
  // Control frames never fall through to tick normalization, including falsey code/error.
  if (
    ["code", "error", "error_message"].some((key) => Object.hasOwn(value, key))
  ) {
    const candidate = unverifiedAck.safeParse(value);
    if (candidate.success && candidate.data.id === context.subscriptionId)
      return { kind: "unverified_ack" } as const;
    const error = subscriptionError.safeParse(value);
    if (!error.success || error.data.id !== context.subscriptionId)
      return { kind: "unknown" } as const;
    const brokerErrorCode = safeBrokerErrorCode(error.data.code);
    if (brokerErrorCode === undefined) return { kind: "unknown" } as const;
    return {
      kind: "subscription_error",
      code: brokerErrorCategories[brokerErrorCode],
      brokerErrorCode,
    } as const;
  }
  const tick = normalizeBrokerTick(
    value,
    context.instrument,
    context.connectionId,
    context.symbol,
    context.last,
    context.now,
  );
  if (tick) return { kind: "tick", tick } as const;
  // Malformed, stale or foreign ticks are rejected without updating any marks.
  if (
    ["instrument", "bid", "ask", "timestamp"].some((key) =>
      Object.hasOwn(value, key),
    )
  )
    return { kind: "invalid_tick" } as const;
  return { kind: "unknown" } as const;
}
