import { describe, it, expect } from "vitest";
import {
  DEMO,
  accountKey,
  fresh,
  restoreBook,
  ensureAccount,
  marketSource,
  openPosition,
  robotStep,
  close,
  settle,
  pnl,
  valuation,
  blocked,
  dailyLoss,
  type PaperSource,
  type Quotes,
} from "../src/paper";
const one: PaperSource = {
  kind: "EXNESS",
  connectionId: "11111111-1111-4111-8111-111111111111",
};
const two: PaperSource = {
  kind: "EXNESS",
  connectionId: "22222222-2222-4222-8222-222222222222",
};
const now = Date.UTC(2026, 10, 2, 12);
const quote = (source: PaperSource, price: number): Quotes => ({
  accountKey: accountKey(source),
  prices: { XAUUSD: price },
});
const input = {
  id: "position",
  symbol: "XAUUSD" as const,
  side: "Buy" as const,
  size: 0.01,
  openedAt: now,
};
const signal = (source: PaperSource, average = 3800) => ({
  accountKey: accountKey(source),
  average,
});
describe("paper source isolation and legacy migration", () => {
  it("preserves all legacy positions, history and risk controls as DEMO, idempotently", () => {
    const positions = Array.from({ length: 3 }, (_, i) => ({
      ...input,
      id: `old-${i}`,
      entry: 2740,
      sl: 2700,
      tp: 2800,
    }));
    const history = [
      { ...positions[0], exit: 2742, pnl: 2, closedAt: now, reason: "Manual" },
    ];
    const legacy = JSON.stringify({
      version: 1,
      positions,
      history,
      dailyLimit: 70,
      haltDay: "2026-11-01",
      emergency: true,
    });
    const book = restoreBook(null, legacy);
    expect(book.accounts[0]).toMatchObject({
      source: DEMO,
      positions: positions.map((p) => ({ ...p, accountKey: "DEMO" })),
      history: history.map((p) => ({ ...p, accountKey: "DEMO" })),
      dailyLimit: 70,
      haltDay: "2026-11-01",
      emergency: true,
    });
    expect(restoreBook(JSON.stringify(book), legacy)).toEqual(book);
    const withExness = ensureAccount(book, one);
    expect(withExness.accounts).toHaveLength(2);
    expect(withExness.accounts[0]).toEqual(book.accounts[0]);
    expect(ensureAccount(withExness, one)).toBe(withExness);
  });
  it("never marks 2740 DEMO positions with 3899 Exness candles or auto closes them", () => {
    let demo = openPosition(fresh(), quote(DEMO, 2740), {
      ...input,
      sl: 2700,
      tp: 2800,
    });
    const exness = quote(one, 3899);
    expect(pnl(demo.positions[0], exness)).toBeUndefined();
    expect(valuation(demo, exness)).toEqual({
      realized: 0,
      floating: undefined,
      equity: undefined,
    });
    expect(settle(demo, exness, now)).toBe(demo);
    expect(close(demo, input.id, exness)).toBe(demo);
    expect(dailyLoss(demo, exness, now)).toBeUndefined();
    expect(blocked(demo, exness, now)).toBe(true);
    expect(pnl(demo.positions[0], quote(DEMO, 2741))).toBe(1);
    expect(valuation(demo, quote(DEMO, 2741))).toEqual({
      realized: 0,
      floating: 1,
      equity: 10001,
    });
  });
  it("persists two connections separately and uses only matching history prices for new orders", () => {
    const a = openPosition(fresh(one), quote(one, 3899), input);
    const b = openPosition(fresh(two), quote(two, 3901), input);
    expect(a.positions[0]).toMatchObject({
      entry: 3899,
      accountKey: accountKey(one),
    });
    expect(b.positions[0]).toMatchObject({
      entry: 3901,
      accountKey: accountKey(two),
    });
    expect(
      openPosition(fresh(one), quote(DEMO, 2740), input).positions,
    ).toHaveLength(0);
    expect(
      openPosition(fresh(one), quote(two, 3901), input).positions,
    ).toHaveLength(0);
    const book = { version: 2 as const, accounts: [fresh(), a, b] };
    expect(restoreBook(JSON.stringify(book), null)).toEqual(book);
    expect(pnl(a.positions[0], quote(two, 3905))).toBeUndefined();
    expect(pnl(a.positions[0], quote(one, 3905))).toBe(6);
  });
  it.each([
    ["Buy", 3890, 3910, 3889, "Stop Loss"],
    ["Buy", 3890, 3910, 3911, "Take Profit"],
    ["Sell", 3910, 3890, 3911, "Stop Loss"],
    ["Sell", 3910, 3890, 3889, "Take Profit"],
  ] as const)(
    "applies %s SL/TP solely within the same connection",
    (side, sl, tp, price, reason) => {
      const a = openPosition(fresh(one), quote(one, 3900), {
        ...input,
        side,
        sl,
        tp,
      });
      expect(settle(a, quote(two, price), now)).toBe(a);
      expect(settle(a, quote(DEMO, price), now)).toBe(a);
      const closed = settle(a, quote(one, price), now);
      expect(closed.positions).toHaveLength(0);
      expect(closed.history[0]).toMatchObject({
        reason,
        accountKey: accountKey(one),
        exit: price,
      });
    },
  );
  it("isolates emergency and daily loss locks and keeps pending positions when feed mismatches", () => {
    const a = openPosition(fresh(one), quote(one, 3900), input);
    const emergency = { ...a, emergency: true };
    expect(settle(emergency, quote(two, 3901), now)).toBe(emergency);
    expect(settle(emergency, quote(one, 3901), now).history[0].reason).toBe(
      "Emergency",
    );
    const loss = settle({ ...a, dailyLimit: 5 }, quote(one, 3890), now);
    expect(blocked(loss, quote(one, 3901), now)).toBe(true);
    expect(blocked(fresh(two), quote(two, 3901), now)).toBe(false);
    expect(blocked(fresh(), quote(DEMO, 2740), now)).toBe(false);
  });
  it("robot rejects foreign marks and signals; source and locks persist, running state does not", () => {
    const a = fresh(one);
    expect(
      robotStep(a, quote(two, 3899), "XAUUSD", signal(one), "r", now),
    ).toBe(a);
    expect(
      robotStep(a, quote(one, 3899), "XAUUSD", signal(DEMO), "r", now),
    ).toBe(a);
    const b = robotStep(a, quote(one, 3899), "XAUUSD", signal(one), "r", now);
    expect(b.positions[0]).toMatchObject({
      entry: 3899,
      accountKey: accountKey(one),
      side: "Buy",
    });
    expect(
      robotStep(
        { ...a, emergency: true },
        quote(one, 3899),
        "XAUUSD",
        signal(one),
        "r",
        now,
      ).positions,
    ).toHaveLength(0);
    const restored = restoreBook(
      JSON.stringify({ version: 2, accounts: [b] }),
      null,
    );
    expect(restored.accounts[0]).toEqual(b);
    expect(JSON.stringify(restored)).not.toContain('"robot"');
  });
  it("rejects unverified feed identity, live ticks and cross-mode fallback", () => {
    const feed = {
      source: "exness",
      kind: "candle-history",
      live: false,
      paperSource: one,
    };
    expect(marketSource(feed, "EXNESS")).toEqual(one);
    expect(marketSource({ source: "simulation" }, "DEMO")).toEqual(DEMO);
    for (const f of [
      { ...feed, paperSource: undefined },
      { ...feed, live: true },
      { ...feed, kind: "ticks" },
      {
        ...feed,
        paperSource: { kind: "EXNESS", connectionId: "private-account-id" },
      },
      { source: "simulation" },
    ])
      expect(() => marketSource(f, "EXNESS")).toThrow();
    expect(() => marketSource(feed, "DEMO")).toThrow();
  });
  it("does not present partial floating/equity when one position lacks a matching mark", () => {
    const a = openPosition(fresh(one), quote(one, 3900), input);
    const b = {
      ...a,
      positions: [
        ...a.positions,
        { ...a.positions[0], id: "eur", symbol: "EURUSD" as const, entry: 1.1 },
      ],
    };
    expect(valuation(b, quote(one, 3901)).equity).toBeUndefined();
    expect(blocked(b, quote(one, 3901), now)).toBe(true);
  });
});
