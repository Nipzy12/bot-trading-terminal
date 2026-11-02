import { describe, it, expect } from "vitest";
import {
  ema,
  rsi,
  indicators,
  signalAt,
  simulate,
  backtest,
  defaults,
  validateBars,
  summarize,
  type Trade,
  type Strategy,
} from "../src/backtest";
const closes = [100, 99, 98, 97, 99, 101, 103, 101, 99, 97, 99, 101, 103];
const bars = closes.map((close, i) => ({
  time: 1700000000 + i * 3600,
  open: close,
  high: close + 0.01,
  low: close - 0.01,
  close,
}));
const p: Strategy = {
  ...defaults,
  fast: 2,
  slow: 3,
  rsiPeriod: 2,
  spread: 0,
  slippage: 0,
  commission: 0,
};
describe("EMA/RSI backtest without look-ahead", () => {
  it("seeds EMA with SMA and RSI with Wilder averages", () => {
    expect(ema([1, 2, 3, 4], 3)).toEqual([undefined, undefined, 2, 3]);
    expect(rsi([1, 2, 3, 4], 2)).toEqual([undefined, undefined, 100, 100]);
    expect(rsi([4, 3, 2, 1], 2).at(-1)).toBe(0);
    expect(rsi([2, 2, 2, 2], 2).at(-1)).toBe(50);
  });
  it("uses a closed crossover at i to enter at i+1 open, never its close", () => {
    const data = bars.slice(0, 7).map((b) => ({ ...b }));
    data[6] = { ...data[6], open: 105, high: 106 };
    expect(signalAt(5, indicators(data, p), p)).toBe("Buy");
    const t = simulate(data, "XAUUSD", p).trades[0];
    expect(t.signalTime).toBe(data[5].time);
    expect(t.entryTime).toBe(data[6].time);
    expect(t.entry).toBe(105);
    expect(simulate(data.slice(0, 6), "XAUUSD", p).count).toBe(0);
  });
  it("future mutations cannot alter earlier indicators, signals or completed trades", () => {
    const changed = bars.map((b, i) =>
      i < 9
        ? b
        : {
            ...b,
            open: b.open * 2,
            high: b.high * 2,
            low: b.low * 2,
            close: b.close * 2,
          },
    );
    const a = indicators(bars, p),
      b = indicators(changed, p);
    for (let i = 0; i < 9; i++) {
      expect(a.fast[i]).toBe(b.fast[i]);
      expect(a.slow[i]).toBe(b.slow[i]);
      expect(a.rsi[i]).toBe(b.rsi[i]);
      expect(signalAt(i, a, p)).toBe(signalAt(i, b, p));
    }
    expect(
      simulate(bars, "XAUUSD", p).trades.filter(
        (t) => t.exitTime < bars[9].time,
      ),
    ).toEqual(
      simulate(changed, "XAUUSD", p).trades.filter(
        (t) => t.exitTime < bars[9].time,
      ),
    );
  });
  it("chooses SL first if both levels touch and executes stop gaps at the worse open", () => {
    const ambiguous = bars.slice(0, 7).map((b) => ({ ...b }));
    ambiguous[6].high = 120;
    ambiguous[6].low = 80;
    const t = simulate(ambiguous, "XAUUSD", p).trades[0];
    expect(t.reason).toBe("SL");
    expect(t.ambiguous).toBe(true);
    expect(t.exit).toBe(t.sl);
    const gap = bars.slice(0, 8).map((b) => ({ ...b }));
    gap[7] = { ...gap[7], open: 90, high: 92, low: 89, close: 91 };
    expect(simulate(gap, "XAUUSD", p).trades[0].exit).toBe(90);
  });
  it("applies spread, adverse slippage, round-trip commission and risk sizing", () => {
    const data = bars.slice(0, 7);
    const costly = { ...p, spread: 0.3, slippage: 0.1, commission: 3.5 };
    const t = simulate(data, "XAUUSD", costly).trades[0];
    expect(t.entry).toBeCloseTo(103.4);
    expect(t.exit).toBeCloseTo(102.9);
    expect(t.fees).toBeCloseTo(7 * t.lots);
    expect(t.pnl).toBeLessThan(0);
    expect(simulate(data, "XAUUSD", p).net).toBe(0);
    expect((t.entry - t.sl) * t.lots * 100 + t.fees).toBeLessThanOrEqual(
      (costly.capital * costly.riskPct) / 100,
    );
    expect(t.lots).toBeLessThanOrEqual(10);
  });
  it("simulates shorts with ask-side stops and commissions", () => {
    const t = simulate(bars, "XAUUSD", {
      ...p,
      spread: 0.1,
      slippage: 0.05,
      commission: 2,
    }).trades.find((t) => t.side === "Sell")!;
    expect(t.entry).toBeCloseTo(96.95);
    expect(t.exit).toBeCloseTo(99.15);
    expect(t.pnl).toBeLessThan(0);
    expect(t.fees).toBeCloseTo(t.lots * 4);
  });
  it("keeps IS/OOS capital and positions separate and warns on gaps/small samples", () => {
    const data = bars.map((b, i) => ({
      ...b,
      time: b.time + (i > 7 ? 86400 : 0),
    }));
    const result = backtest(data, "XAUUSD", 3600, p, { kind: "DEMO" });
    expect(result.inSample.curve[0].equity).toBe(p.capital);
    expect(result.outSample.curve[0].equity).toBe(p.capital);
    expect(
      result.inSample.trades.every((t) => t.exitTime < result.splitTime),
    ).toBe(true);
    expect(
      result.outSample.trades.every(
        (t) => t.signalTime >= result.splitTime && t.entryTime > t.signalTime,
      ),
    ).toBe(true);
    expect(result.gaps).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(1);
    expect(JSON.stringify(result)).not.toContain('"positions"');
  });
  it("calculates net, win rate, profit factor and close-equity drawdown", () => {
    const report = summarize(
      [{ pnl: 10 }, { pnl: -2 }, { pnl: 0 }] as Trade[],
      [
        { time: 1, equity: 100 },
        { time: 2, equity: 110 },
        { time: 3, equity: 88 },
      ],
      100,
    );
    expect(report.net).toBe(8);
    expect(report.winRate).toBeCloseTo(100 / 3);
    expect(report.profitFactor).toBe(5);
    expect(report.drawdown).toBe(22);
    expect(report.drawdownPct).toBe(20);
    expect(summarize([], [], 100).profitFactor).toBeNull();
  });
  it("rejects running, duplicate, damaged history and invalid strategy parameters", () => {
    expect(() =>
      validateBars([{ ...bars[0], time: Math.floor(Date.now() / 1000) }], 3600),
    ).toThrow();
    expect(() => validateBars([bars[0], bars[0]], 3600)).toThrow();
    expect(() => validateBars([{ ...bars[0], high: 1 }], 3600)).toThrow();
    expect(() =>
      backtest(bars, "XAUUSD", 3600, { ...p, fast: 30 }, { kind: "DEMO" }),
    ).toThrow();
  });
});
