import { z } from "zod";
import { bases } from "./market.js";
export const historyQuery = z
  .object({
    symbol: z.enum(["XAUUSD", "EURUSD", "BTCUSD"]),
    interval: z.enum(["300", "900", "3600", "14400", "86400"]).default("3600"),
    before: z.coerce.number().int().positive().max(8640000000000).optional(),
  })
  .strict();
export function demoHistory(
  symbol: string,
  interval: number,
  before?: number,
  now = Date.now() / 1000,
) {
  const current = Math.floor(now / interval) * interval;
  const to = before ?? current;
  const earliest = Math.ceil((now - 365 * 86400) / interval) * interval;
  if (to > current || to % interval || to <= earliest)
    throw Error("INVALID_HISTORY_WINDOW");
  const from = Math.max(earliest, to - 180 * interval),
    base = bases[symbol];
  const price = (t: number) =>
    base *
    (1 +
      0.018 * Math.sin((t / interval) * 0.037) +
      0.007 * Math.sin((t / interval) * 0.19));
  const candles = Array.from({ length: (to - from) / interval }, (_, i) => {
    const time = from + i * interval,
      open = price(time),
      close = price(time + interval);
    return {
      time,
      open,
      high: Math.max(open, close) + base * 0.0006,
      low: Math.min(open, close) - base * 0.0006,
      close,
    };
  });
  return {
    emptyWindow: false,
    source: "simulation",
    paperSource: { kind: "DEMO" },
    label: "DEMO",
    kind: "synthetic",
    live: false,
    candles,
    window: { from, to },
    nextBefore: from > earliest ? from : null,
    excludedBoundaryCandles: 0,
  };
}
