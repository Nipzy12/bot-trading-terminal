import { readConfig, readerFor } from "./exness.js";
export const symbols = [
  "XAUUSD",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "BTCUSD",
  "ETHUSD",
] as const;
export const bases: Record<string, number> = {
  XAUUSD: 2742.68,
  EURUSD: 1.08432,
  GBPUSD: 1.29764,
  USDJPY: 153.12,
  BTCUSD: 69420.5,
  ETHUSD: 2518.34,
};
export function candles(symbol: string, interval = 3600) {
  const base = bases[symbol];
  let previous = base * 0.992;
  const start =
    Math.floor(Date.now() / 1000 / interval) * interval - 179 * interval;
  return Array.from({ length: 180 }, (_, i) => {
    const open = previous;
    const close =
      base *
      (0.992 +
        i * 0.000045 +
        Math.sin(i * 0.61) * 0.0009 +
        Math.sin(i * 0.17) * 0.0015);
    previous = close;
    return {
      time: start + i * interval,
      open,
      high: Math.max(open, close) + base * 0.0006,
      low: Math.min(open, close) - base * 0.0005,
      close,
    };
  });
}
export async function market(symbol: string, interval: number) {
  const config = readConfig();
  if (!config)
    return {
      source: "simulation",
      label: "DEMO",
      live: false,
      kind: "synthetic",
      candles: candles(symbol, interval),
    };
  return {
    source: "exness",
    label: "EXNESS",
    live: false,
    kind: "candle-history",
    candles: await readerFor(config).candles(symbol, interval),
  };
}
