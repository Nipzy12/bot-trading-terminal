import { describe, it, expect } from "vitest";
import {
  fresh,
  restore,
  pnl,
  close,
  settle,
  day,
  blocked,
  dailyLoss,
  validStops,
  type Position,
} from "../src/paper";
const now = Date.UTC(2026, 10, 2, 12);
const position = (extra: Partial<Position> = {}): Position => ({
  id: "one",
  symbol: "XAUUSD",
  side: "Buy",
  size: 0.1,
  entry: 2700,
  openedAt: now,
  ...extra,
});
describe("paper account and risk engine", () => {
  it("restores versioned positions/history and recovers corrupt storage", () => {
    const a = { ...fresh(), positions: [position()] };
    expect(restore(JSON.stringify(a))).toEqual(a);
    for (const raw of [
      "bad",
      "{}",
      '{"version":2}',
      JSON.stringify({ ...a, dailyLimit: -1 }),
    ])
      expect(restore(raw)).toEqual(fresh());
  });
  it("calculates buy/sell USD P&L with explicit contract sizes and JPY conversion", () => {
    expect(pnl(position(), 2702)).toBe(20);
    expect(pnl(position({ side: "Sell" }), 2702)).toBe(-20);
    expect(
      pnl(position({ symbol: "EURUSD", entry: 1.1, size: 1 }), 1.101),
    ).toBeCloseTo(100);
    expect(
      pnl(position({ symbol: "USDJPY", entry: 150, size: 1 }), 151),
    ).toBeCloseTo(100000 / 151);
  });
  it("closes once, records exit and realized P&L and survives reload", () => {
    const a = { ...fresh(), positions: [position()] };
    const b = close(a, "one", { XAUUSD: 2698 }, "Manual", now);
    expect(b.positions).toHaveLength(0);
    expect(b.history[0]).toMatchObject({
      exit: 2698,
      pnl: -20,
      reason: "Manual",
      closedAt: now,
    });
    expect(close(b, "one", { XAUUSD: 2698 })).toBe(b);
    expect(restore(JSON.stringify(b))).toEqual(b);
  });
  it.each([
    ["Buy", 2698, "Stop Loss"],
    ["Buy", 2702, "Take Profit"],
    ["Sell", 2702, "Stop Loss"],
    ["Sell", 2698, "Take Profit"],
  ] as const)("executes %s protection at %s", (side, price, reason) => {
    const p = position({
      side,
      sl: side === "Buy" ? 2699 : 2701,
      tp: side === "Buy" ? 2701 : 2699,
    });
    const b = settle({ ...fresh(), positions: [p] }, { XAUUSD: price }, now);
    expect(b.positions).toHaveLength(0);
    expect(b.history[0].reason).toBe(reason);
    expect(b.history[0].exit).toBe(price);
  });
  it("ignores missing quotes and queues emergency exits until a quote arrives", () => {
    const a = { ...fresh(), emergency: true, positions: [position()] };
    expect(settle(a, {}, now).positions).toHaveLength(1);
    const b = settle(a, { XAUUSD: 2700 }, now);
    expect(b.positions).toHaveLength(0);
    expect(b.history[0].reason).toBe("Emergency");
    expect(blocked(b, {}, now)).toBe(true);
  });
  it("latches daily gross loss including floating, gains do not offset and next UTC day unlocks", () => {
    let a = { ...fresh(), dailyLimit: 50, positions: [position()] };
    a = settle(a, { XAUUSD: 2694 }, now);
    expect(dailyLoss(a, { XAUUSD: 2694 }, now)).toBeCloseTo(60);
    expect(a.haltDay).toBe(day(now));
    expect(blocked(a, { XAUUSD: 2702 }, now)).toBe(true);
    a = close(a, "one", { XAUUSD: 2694 }, "Manual", now);
    expect(blocked(a, {}, now + 86400000)).toBe(false);
  });
  it("checks stops against both sides", () => {
    expect(validStops("Buy", 100, 90, 110)).toBe(true);
    expect(validStops("Sell", 100, 110, 90)).toBe(true);
    expect(validStops("Buy", 100, 110, 90)).toBe(false);
    expect(validStops("Sell", 100, 90, 110)).toBe(false);
    expect(validStops("Buy", 100, NaN, 110)).toBe(false);
  });
});
