import { describe, it, expect } from "vitest";
import { normalizeHistory } from "../server/candle-history";
const base = { open: 10, high: 12, low: 9, close: 11, volume: 20 };
const t = Date.UTC(2026, 9, 20) / 1000;
const ref = { ...base, time: t };
const row = { ...base, time: new Date(t * 1000).toISOString() };
const older = { ...row, time: new Date((t - 3600) * 1000).toISOString() };
const window = {
  from: t - 180 * 3600,
  to: t,
  interval: 3600,
  requestedAt: t + 86400,
  historicalReference: ref,
};
describe("historical boundary proof", () => {
  it("excludes exactly one identical closed boundary and reports it", () => {
    const d = { excludedBoundaryCandles: 0, historicalBoundaryExcluded: 0 };
    const result = normalizeHistory({ candles: [older, row] }, 180, window, d);
    expect(result.length).toBe(1);
    expect(result[0].volume).toBe(20);
    expect(d).toEqual({
      excludedBoundaryCandles: 1,
      historicalBoundaryExcluded: 1,
    });
  });
  it.each([
    [{ ...row, close: 10 }, "mismatched close"],
    [{ ...row, volume: 21 }, "mismatched volume"],
    [{ ...row, volume: undefined }, "missing volume"],
    [{ ...row, time: new Date((t + 3600) * 1000).toISOString() }, "after end"],
    [{ ...row, high: 1 }, "invalid OHLC"],
  ])("rejects %s", (bad, _label) => {
    expect(() =>
      normalizeHistory({ candles: [older, bad] }, 180, window),
    ).toThrow();
  });
  it("rejects missing proof, duplicate timestamps and reversed order", () => {
    expect(() =>
      normalizeHistory({ candles: [older, row] }, 180, {
        ...window,
        historicalReference: undefined,
      }),
    ).toThrow();
    expect(() =>
      normalizeHistory({ candles: [older, row, row] }, 180, window),
    ).toThrow();
    expect(() =>
      normalizeHistory({ candles: [row, older] }, 180, window),
    ).toThrow();
  });
  it("accepts weekend gaps without duplicating or fabricating rows", () => {
    const friday = {
      ...older,
      time: new Date((t - 3 * 86400) * 1000).toISOString(),
    };
    expect(
      normalizeHistory({ candles: [friday, older, row] }, 180, window).length,
    ).toBe(2);
  });
});
