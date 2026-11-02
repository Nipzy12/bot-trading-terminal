import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { ExnessReader } from "../server/exness";
import {
  normalizeHistory,
  closedHistoryWindow,
  selectInstrument,
  instrumentNames,
} from "../server/candle-history";
import { parseReport } from "../src/connection-report";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const config = {
  apiKey: "synthetic-candle-test-key",
  privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  accountId: "123456",
  gateway: "https://gateway.exness.test",
};
const now = Date.UTC(2026, 10, 2, 12, 30),
  interval = 3600;
const good = {
  time: "2026-11-02T10:00:00Z",
  open: 2711.23,
  high: 2715.56,
  low: 2708.12,
  close: 2713.45,
  volume: 123,
};
const window = {
  from: Date.UTC(2026, 10, 2, 10) / 1000,
  to: Math.floor(now / 1000 / 3600) * 3600,
  interval,
};
function fixture(
  options: {
    names?: unknown;
    body?: unknown;
    max?: number;
    age?: number;
    malformedJson?: boolean;
  } = {},
) {
  const calls: { path: string; query: URLSearchParams }[] = [];
  const transport = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      calls.push({ path: u.pathname, query: u.searchParams });
      const headers = init!.headers as Record<string, string>;
      const bytes = Buffer.from(headers["EXN-DATA"], "base64url");
      const signed = JSON.parse(bytes.toString());
      expect(init!.method).toBe("GET");
      expect(signed.path).toBe(u.pathname + u.search);
      expect(headers["EXN-IDEMPOTENCY-KEY"]).toBe("");
      expect(
        verify(
          null,
          bytes,
          publicKey,
          Buffer.from(headers["EXN-SIGN"], "base64url"),
        ),
      ).toBe(true);
      if (u.pathname.endsWith("access-point"))
        return Response.json({
          account_id: config.accountId,
          access_point: "https://ap.exness.test",
        });
      if (u.pathname.endsWith("/account"))
        return Response.json({
          account_id: config.accountId,
          create_date: "2024-01-01T00:00:00Z",
        });
      if (u.pathname.endsWith("/limits"))
        return Response.json({
          limits: {
            rest: {
              global_account_rate: { limit: 1000, window_seconds: 60 },
              methods: [
                {
                  api_operation_id: "getAvailableInstrumentList",
                  http_method: "GET",
                  path: "/v1/configuration/accounts/{account_id}/instruments",
                  rate_limit: { limit: 100, window_seconds: 60 },
                },
                {
                  api_operation_id: "getCandleHistory",
                  http_method: "GET",
                  path: "/v1/market-data/accounts/{account_id}/candles",
                  rate_limit: { limit: 100, window_seconds: 60 },
                  limits: {
                    max_candles_per_request: options.max ?? 2,
                    history_age_days: options.age ?? 365,
                  },
                },
              ],
            },
          },
        });
      if (u.pathname.endsWith("/instruments"))
        return Response.json(
          options.names ?? { instruments: ["EURUSD", "XAUUSDm"] },
        );
      expect(u.pathname).toBe("/v1/market-data/accounts/123456/candles");
      expect(u.searchParams.get("timeframe")).toBe("H1");
      expect(u.searchParams.get("count")).toBeNull();
      expect(u.searchParams.get("to")).not.toBeNull();
      expect(u.searchParams.get("price_type")).toBe("bid");
      if (options.malformedJson)
        return new Response("not-json", { status: 200 });
      if (options.body !== undefined) return Response.json(options.body);
      const start = Date.parse(u.searchParams.get("from")!);
      const count =
        (Date.parse(u.searchParams.get("to")!) -
          Date.parse(u.searchParams.get("from")!)) /
        (interval * 1000);
      return Response.json({
        candles: Array.from({ length: count }, (_, i) => ({
          ...good,
          time: new Date(start + i * interval * 1000).toISOString(),
        })),
      });
    },
  );
  return {
    calls,
    transport,
    reader: new ExnessReader(config, transport, () => now),
  };
}
describe("verified account instrument mapping", () => {
  it.each([
    "XAUUSD",
    "XAUUSDm",
    "XAUUSDc",
    "XAUUSDz",
    "XAUUSD.pro",
    "XAUUSDmicro",
  ])("uses only verified name %s from signed instrument list", async (name) => {
    const f = fixture({ names: { instruments: ["EURUSD", name] } });
    const report = await f.reader.testConnection();
    expect(report.success).toBe(true);
    expect(report.candleCount).toBe(2);
    const query = f.calls.at(-1)!.query;
    expect(query.get("instrument")).toBe(name);
    expect(f.calls.at(-2)!.path).toBe(
      "/v1/configuration/accounts/123456/instruments",
    );
    expect(query.get("from")).toBe("2026-11-02T10:00:00.000Z");
    expect(query.get("count")).toBeNull();
    expect(query.get("to")).toBe("2026-11-02T12:00:00.000Z");
    expect(JSON.stringify(report)).not.toContain(name);
    expect(JSON.stringify(report)).not.toContain(String(good.close));
  });
  it("prefers an exact listed symbol over variants, never guesses missing suffixes", () => {
    expect(selectInstrument("XAUUSD", ["XAUUSDm", "XAUUSDc", "XAUUSD"])).toBe(
      "XAUUSD",
    );
    expect(() =>
      selectInstrument("XAUUSD", ["EURUSD", "GOLD", "XAUUSDT"]),
    ).toThrow();
    expect(() => selectInstrument("XAUUSD", ["XAUUSDm", "XAUUSDc"])).toThrow();
    expect(instrumentNames({ instruments: ["XAUUSDm", "XAUUSDm"] })).toEqual([
      "XAUUSDm",
    ]);
  });
  it.each([
    [["EURUSD"], "INSTRUMENT_NOT_FOUND"],
    [["XAUUSDm", "XAUUSDz"], "AMBIGUOUS_INSTRUMENT"],
    [[], "INSTRUMENT_NOT_FOUND"],
  ] as const)(
    "stops without a candle request when mapping cannot be verified",
    async (names, reason) => {
      const f = fixture({ names: { instruments: names } });
      const report = await f.reader.testConnection();
      expect(report).toMatchObject({
        stage: "candles",
        error: "EXNESS_MARKET_DATA",
        reason,
        candleCount: 0,
      });
      expect(f.calls.some((c) => c.path.endsWith("/candles"))).toBe(false);
      expect(
        report.stages.slice(0, 3).every((s) => s.status === "passed"),
      ).toBe(true);
    },
  );
  it("rejects an instrument list with objects rather than documented strings", async () => {
    const f = fixture({ names: { instruments: [{ name: "XAUUSDm" }] } });
    expect(await f.reader.testConnection()).toMatchObject({
      stage: "candles",
      reason: "INVALID_SCHEMA",
      candleCount: 0,
    });
  });
  it("caches the verified list within an account reader while fresh probes reload it", async () => {
    const f = fixture();
    await f.reader.candles("XAUUSD", 3600);
    await f.reader.candles("XAUUSD", 3600);
    expect(f.calls.filter((c) => c.path.endsWith("/instruments"))).toHaveLength(
      1,
    );
    await f.reader.testConnection();
    expect(f.calls.filter((c) => c.path.endsWith("/instruments"))).toHaveLength(
      2,
    );
  });
});
describe("strict candle diagnostics", () => {
  const cases: [unknown, string, number][] = [
    [{ candles: [] }, "EMPTY_CANDLES", 0],
    [{ data: [good] }, "INVALID_SCHEMA", 0],
    [{ candles: [{ time: good.time }] }, "INVALID_SCHEMA", 1],
    [{ candles: [{ ...good, open: "2711.23" }] }, "INVALID_SCHEMA", 1],
    [{ candles: [{ ...good, high: 2700 }] }, "INVALID_OHLC", 1],
    [{ candles: [{ ...good, low: 2720 }] }, "INVALID_OHLC", 1],
    [{ candles: [{ ...good, close: 0 }] }, "INVALID_OHLC", 1],
    [{ candles: [{ ...good, time: 1793613600000 }] }, "INVALID_TIMESTAMP", 1],
    [
      { candles: [{ ...good, time: "2026-02-30T10:00:00Z" }] },
      "INVALID_TIMESTAMP",
      1,
    ],
    [
      { candles: [{ ...good, time: "2026-11-02T10:00:00" }] },
      "INVALID_TIMESTAMP",
      1,
    ],
    [
      { candles: [{ ...good, time: "2026-11-02T12:00:00Z" }] },
      "OUT_OF_RANGE",
      1,
    ],
    [
      { candles: [{ ...good, time: "2026-11-02T09:00:00Z" }] },
      "OUT_OF_RANGE",
      1,
    ],
    [{ candles: [good, good] }, "INVALID_ORDER", 2],
    [
      { candles: [{ ...good, time: "2026-11-02T11:00:00Z" }, good] },
      "INVALID_ORDER",
      2,
    ],
    [{ candles: [good, good, good] }, "OUT_OF_RANGE", 3],
  ];
  it.each(cases.map(([body, reason, count]) => ({ body, reason, count })))(
    "rejects $reason (count $count)",
    async ({ body, reason, count }) => {
      const f = fixture({ body });
      const report = await f.reader.testConnection();
      expect(report).toMatchObject({
        success: false,
        stage: "candles",
        error: "EXNESS_INVALID_RESPONSE",
        reason,
        candleCount: count,
      });
      expect(
        report.stages.slice(0, 3).every((s) => s.status === "passed"),
      ).toBe(true);
      for (const forbidden of [
        config.apiKey,
        config.privateKey,
        config.accountId,
        "ap.exness.test",
        String(good.close),
        "EXN-SIGN",
        "EXN-DATA",
      ])
        expect(JSON.stringify(report)).not.toContain(forbidden);
    },
  );
  it("rejects non-finite OHLC without numeric coercion", () => {
    expect(() =>
      normalizeHistory({ candles: [{ ...good, open: Infinity }] }, 2, window),
    ).toThrow();
  });
  it("classifies malformed JSON without returning any raw body", async () => {
    const f = fixture({ malformedJson: true });
    expect(await f.reader.testConnection()).toMatchObject({
      reason: "INVALID_SCHEMA",
      candleCount: 0,
    });
  });
  it("accepts smaller valid history and session gaps without demanding consecutive candles", () => {
    const rows = normalizeHistory(
      { candles: [good, { ...good, time: "2026-11-02T11:00:00+00:00" }] },
      180,
      window,
    );
    expect(rows).toHaveLength(2);
    expect(normalizeHistory({ candles: [good] }, 180, window)).toHaveLength(1);
    const gapped = { ...window, from: window.from - 86400 };
    expect(
      normalizeHistory(
        { candles: [{ ...good, time: "2026-11-01T10:00:00Z" }, good] },
        180,
        gapped,
      ),
    ).toHaveLength(2);
  });
  it("bounds requested count and from by returned history age limits", async () => {
    const f = fixture({ max: 5000, age: 1 });
    await f.reader.testConnection();
    const query = f.calls.at(-1)!.query;
    expect(query.get("count")).toBeNull();
    expect(
      (Date.parse(query.get("to")!) - Date.parse(query.get("from")!)) / 3600000,
    ).toBe(23);
    expect(Date.parse(query.get("from")!)).toBeGreaterThanOrEqual(
      now - 86400000,
    );
  });
  it("frontend accepts only allowlisted reasons and integer candle counts", () => {
    expect(
      parseReport({ stages: [], reason: "EMPTY_CANDLES", candleCount: 0 }),
    ).toMatchObject({ reason: "EMPTY_CANDLES", candleCount: 0 });
    const report = parseReport({
      stages: [],
      reason: config.apiKey,
      candleCount: good.close,
    });
    expect(report?.reason).toBeUndefined();
    expect(report?.candleCount).toBeUndefined();
  });
});

describe("closed from/to windows", () => {
  it("accepts 123 candles in 180 hours with a weekend session gap", async () => {
    const w = closedHistoryWindow(now / 1000, 3600, {
      max_candles_per_request: 5000,
    });
    const times = Array.from({ length: 180 }, (_, i) => w.from + i * 3600)
      .filter((t) => ![0, 6].includes(new Date(t * 1000).getUTCDay()))
      .slice(0, 123);
    expect(times).toHaveLength(123);
    const f = fixture({
      max: 5000,
      body: {
        candles: times.map((t) => ({
          ...good,
          time: new Date(t * 1000).toISOString(),
        })),
      },
    });
    expect(await f.reader.testConnection()).toMatchObject({
      success: true,
      candleCount: 123,
    });
    const q = f.calls.at(-1)!.query;
    expect(q.get("count")).toBeNull();
    expect(Date.parse(q.get("to")!) - Date.parse(q.get("from")!)).toBe(
      180 * 3600000,
    );
  });
  it.each([
    ["2026-11-02T09:00:00Z", "BEFORE_FROM"],
    ["2026-11-02T12:00:00Z", "AT_OR_AFTER_TO"],
    ["2026-11-02T13:00:00Z", "AT_OR_AFTER_TO"],
    ["2026-11-02T11:30:00Z", "UNFINISHED_CANDLE"],
  ])("rejects unsafe boundary with category %s", async (time, rangeReason) => {
    const report = await fixture({
      body: { candles: [{ ...good, time }] },
    }).reader.testConnection();
    expect(report).toMatchObject({
      reason: "OUT_OF_RANGE",
      rangeReason,
      candleCount: 1,
    });
    expect(JSON.stringify(report)).not.toContain(time);
    expect(parseReport(report)?.rangeReason).toBe(rangeReason);
  });
  it("accepts inclusive from and last closed candle", () => {
    expect(
      normalizeHistory(
        { candles: [good, { ...good, time: "2026-11-02T11:00:00Z" }] },
        2,
        window,
      ),
    ).toHaveLength(2);
  });
  it("respects provider range, maximum and age, rejecting windows without a full candle", () => {
    const w = closedHistoryWindow(now / 1000, 3600, {
      max_candles_per_request: 5000,
      history_range_days: 2,
      history_age_days: 1,
    });
    expect(w.max).toBe(23);
    expect(w.from).toBeGreaterThanOrEqual(now / 1000 - 86400);
    expect(
      closedHistoryWindow(now / 1000, 3600, {
        max_candles_per_request: 3,
        history_range_days: 1,
      }).max,
    ).toBe(3);
    expect(
      closedHistoryWindow(now / 1000, 3600, {
        max_candles_per_request: 5000,
        history_range_days: 2,
      }).max,
    ).toBe(48);
    expect(() =>
      closedHistoryWindow(now / 1000, 3600, {
        max_candles_per_request: 5000,
        history_age_days: 0,
      }),
    ).toThrow("EXNESS_LIMITS_UNAVAILABLE");
  });
  it("reports excessive count without leaking rows or accepting unknown diagnostics", async () => {
    expect(
      await fixture({
        body: { candles: [good, good, good] },
      }).reader.testConnection(),
    ).toMatchObject({ rangeReason: "TOO_MANY_CANDLES", candleCount: 3 });
    expect(
      parseReport({ stages: [], rangeReason: config.privateKey })?.rangeReason,
    ).toBeUndefined();
  });
});
