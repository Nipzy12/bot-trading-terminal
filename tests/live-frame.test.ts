import { expect, it } from "vitest";
import { parseLiveFrame, type FrameContext } from "../server/live-frame";
import {
  brokerErrorCategories,
  liveDiagnostic,
  streamStatusLabel,
} from "../src/live-diagnostics";
const now = Date.now(),
  context: FrameContext = {
    subscriptionId: "synthetic-subscription-request",
    accountId: "123456",
    instrument: "XAUUSDm",
    connectionId: "11111111-1111-4111-8111-111111111111",
    symbol: "XAUUSD",
    last: 0,
    now,
  };
const tick = {
  instrument: "XAUUSDm",
  bid: 3900,
  ask: 3901,
  timestamp: new Date(now).toISOString(),
};
it("keeps matched exact code=200 as an unverified ACK candidate, not official success", () => {
  expect(
    parseLiveFrame({ id: context.subscriptionId, code: 200 }, context),
  ).toEqual({ kind: "unverified_ack" });
  // A tick is independently verifiable without a documented standalone ACK.
  expect(parseLiveFrame(tick, context)).toMatchObject({
    kind: "tick",
    tick: { bid: 3900, ask: 3901 },
  });
});
it.each([
  { id: "foreign-subscription", code: 200 },
  { id: context.subscriptionId, code: "200" },
  { id: context.subscriptionId, code: 200, error: false },
  { id: context.subscriptionId, code: 200, error: null },
  {
    id: context.subscriptionId,
    code: 200,
    error_message: "AUTH_PERMISSION_DENIED",
  },
  { id: context.subscriptionId, code: 200, bid: 3900 },
  { id: context.subscriptionId, code: 200, account_id: context.accountId },
  { id: context.subscriptionId, code: 200, extra: true },
])("rejects mismatched, mixed or contradictory ACK shape", (raw) => {
  expect(parseLiveFrame(raw, context)).toEqual({ kind: "unknown" });
});
it.each(Object.entries(brokerErrorCategories))(
  "maps the documented public error %s without exposing text/id",
  (rawCode, category) => {
    const code = Number(rawCode),
      result = parseLiveFrame(
        {
          id: context.subscriptionId,
          code,
          error_message: "DO_NOT_FORWARD_ACCOUNT_HOST_OR_CREDENTIAL",
        },
        context,
      );
    expect(result).toEqual({
      kind: "subscription_error",
      code: category,
      brokerErrorCode: code,
    });
    expect(JSON.stringify(result)).not.toContain(context.subscriptionId);
    expect(JSON.stringify(result)).not.toContain("DO_NOT_FORWARD");
  },
);
it.each([
  { id: context.subscriptionId, code: 987654321, error_message: "secret" },
  { id: context.subscriptionId, code: "1002", error_message: "secret" },
  { id: "different", code: 1002, error_message: "secret" },
  { id: context.subscriptionId, code: 1002 },
  { id: context.subscriptionId, code: 1002, error_message: "" },
  {
    error: { id: context.subscriptionId, code: 1002, error_message: "secret" },
  },
  { code: 0 },
  { error: false },
  null,
  [],
  "raw",
  { unrecognized: "private" },
  { ...tick, code: 200 },
  { ...tick, error: false },
])("fails unknown/control frames closed without guessing permission", (raw) =>
  expect(parseLiveFrame(raw, context)).toEqual({ kind: "unknown" }),
);
it.each([
  { ...tick, bid: -1 },
  { ...tick, ask: 3800 },
  { ...tick, instrument: "EURUSD" },
  { ...tick, timestamp: new Date(now - 60000).toISOString() },
])("rejects invalid, stale or foreign ticks", (raw) =>
  expect(parseLiveFrame(raw, context)).toEqual({ kind: "invalid_tick" }),
);
it("preserves account and strictly increasing tick isolation", () => {
  expect(parseLiveFrame({ ...tick, account_id: "foreign" }, context)).toEqual({
    kind: "account_mismatch",
  });
  expect(parseLiveFrame(tick, { ...context, last: now })).toEqual({
    kind: "invalid_tick",
  });
});
it("diagnostic projection and labels only emit allowlisted numeric public codes", () => {
  const state = {
    phase: "OPEN",
    upstreamOpened: true,
    subscriptionSent: true,
    subscriptionAckReceived: false,
    firstValidTickReceived: false,
  };
  expect(liveDiagnostic({ ...state, brokerErrorCode: 1002 })).toMatchObject({
    brokerErrorCode: 1002,
    subscriptionAckReceived: false,
  });
  for (const code of [200, 987654321, "1002", NaN, null])
    expect(
      liveDiagnostic({ ...state, brokerErrorCode: code })?.brokerErrorCode,
    ).toBeUndefined();
  expect(
    streamStatusLabel("EXNESS_PERMISSION", { brokerErrorCode: 1002 }),
  ).toBe("EXNESS_PERMISSION · brokerErrorCode=1002");
  expect(
    streamStatusLabel("UNKNOWN_BROKER_RESPONSE", {
      brokerErrorCode: 987654321,
      error_message: "private",
    }),
  ).toBe("UNKNOWN_BROKER_RESPONSE");
});
