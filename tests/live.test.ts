import { describe, it, expect } from "vitest";
import {
  acceptTick,
  updateBars,
  reconnectDelay,
  normalizeBrokerTick,
} from "../src/live";
import {
  fresh,
  openPosition,
  settle,
  pnl,
  accountKey,
  type PaperSource,
} from "../src/paper";
const id = "11111111-1111-4111-8111-111111111111",
  now = Date.now();
const t = {
  symbol: "XAUUSD",
  connectionId: id,
  time: now,
  bid: 3900,
  ask: 3901,
};
describe("live ticks and paper isolation", () => {
  it("rejects invalid, stale, future, duplicate, unordered and foreign ticks", () => {
    expect(acceptTick(t, id, "XAUUSD", 0, now)).toEqual(t);
    for (const bad of [
      { ...t, bid: -1 },
      { ...t, ask: 3800 },
      { ...t, time: now - 11000 },
      { ...t, time: now + 3000 },
      { ...t, symbol: "EURUSD" },
      { ...t, connectionId: "22222222-2222-4222-8222-222222222222" },
    ])
      expect(acceptTick(bad, id, "XAUUSD", 0, now)).toBeNull();
    expect(acceptTick(t, id, "XAUUSD", now, now)).toBeNull();
  });
  it.each([300, 900, 3600, 14400, 86400])(
    "updates UTC OHLC and rolls over %i without fabricating gap candles",
    (interval) => {
      const bucket = Math.floor(now / 1000 / interval) * interval;
      const first = updateBars([], t, interval);
      expect(first[0].time).toBe(bucket);
      const second = updateBars(first, { ...t, bid: 3902 }, interval);
      expect(second[0]).toMatchObject({
        open: 3900,
        high: 3902,
        low: 3900,
        close: 3902,
      });
      const afterWeekend = updateBars(
        second,
        { ...t, time: (bucket + 3 * 86400 + interval) * 1000, bid: 3910 },
        interval,
      );
      expect(afterWeekend).toHaveLength(2);
      expect(afterWeekend[1].open).toBe(3910);
    },
  );
  it("isolates HISTORY, LIVE and DEMO positions and rejects stale actions", () => {
    const source: PaperSource = { kind: "EXNESS_LIVE", connectionId: id },
      q = {
        accountKey: accountKey(source),
        prices: { XAUUSD: 3900 },
        expiresAt: Date.now() + 10000,
      };
    const a = openPosition(fresh(source), q, {
      id: "p",
      symbol: "XAUUSD",
      side: "Buy",
      size: 0.01,
      openedAt: Date.now(),
      tp: 3910,
    });
    expect(a.positions).toHaveLength(1);
    const history = {
      ...q,
      accountKey: `EXNESS:${id}`,
      prices: { XAUUSD: 4000 },
    };
    expect(settle(a, history)).toBe(a);
    expect(pnl(a.positions[0], history)).toBeUndefined();
    expect(
      settle(a, { ...q, expiresAt: Date.now() - 1, prices: { XAUUSD: 4000 } }),
    ).toBe(a);
  });
  it("bounds exponential reconnect delay", () => {
    expect(reconnectDelay(0)).toBe(5000);
    expect(reconnectDelay(10)).toBe(60000);
  });
});

describe("official Exness WSTick normalization", () => {
  const raw = {
    instrument: "XAUUSDm",
    bid: 3900,
    ask: 3901,
    timestamp: new Date(now).toISOString(),
  };
  it("normalizes flat broker frames without raw metadata or credentials", () => {
    const t = normalizeBrokerTick(
      { ...raw, privateField: "not-forwarded" },
      "XAUUSDm",
      id,
      "XAUUSD",
      0,
      now,
    )!;
    expect(t).toMatchObject({
      provider: "EXNESS",
      source: "EXNESS_LIVE",
      freshness: "FRESH",
      timestampMs: now,
      connectionId: id,
      symbol: "XAUUSD",
    });
    expect(JSON.stringify(t)).not.toContain("not-forwarded");
    expect(acceptTick(t, id, "XAUUSD", 0, now)).not.toBeNull();
  });
  it("rejects unsupported envelopes, stale/out-of-order ticks and schema violations", () => {
    for (const bad of [
      { data: raw },
      { ...raw, instrument: "EURUSD" },
      { ...raw, bid: "3900" },
      { ...raw, ask: 3800 },
      { ...raw, timestamp: "2026-11-02T10:00:00" },
      { ...raw, timestamp: new Date(now - 11000).toISOString() },
    ])
      expect(
        normalizeBrokerTick(bad, "XAUUSDm", id, "XAUUSD", 0, now),
      ).toBeNull();
    expect(
      normalizeBrokerTick(raw, "XAUUSDm", id, "XAUUSD", now, now),
    ).toBeNull();
    expect(
      acceptTick(
        {
          connectionId: id,
          symbol: "XAUUSD",
          bid: 3900,
          ask: 3901,
          time: now,
          timestampMs: now + 1,
        },
        id,
        "XAUUSD",
        0,
        now,
      ),
    ).toBeNull();
  });
});
