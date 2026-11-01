import { z } from "zod";
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
export const candleSchema = z
  .object({
    time: z.number().int().positive(),
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
  })
  .refine(
    (c) =>
      c.high >= Math.max(c.open, c.close) &&
      c.low <= Math.min(c.open, c.close) &&
      c.low <= c.high,
  );
export async function market(symbol: string, interval: number) {
  if (!process.env.EXNESS_DATA_URL)
    return { source: "simulation", candles: candles(symbol, interval) };
  const url = new URL(process.env.EXNESS_DATA_URL);
  if (url.protocol !== "https:") throw Error("HTTPS required");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", String(interval));
  const response = await fetch(url, {
    headers: process.env.EXNESS_API_KEY
      ? { Authorization: `Bearer ${process.env.EXNESS_API_KEY}` }
      : {},
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (!response.ok) throw Error("Provider unavailable");
  const parsed = z
    .object({ candles: z.array(candleSchema).min(2).max(5000) })
    .parse(await response.json());
  if (
    parsed.candles.some((c, i) => i > 0 && c.time <= parsed.candles[i - 1].time)
  )
    throw Error("Invalid time order");
  return { source: "exness-bridge", candles: parsed.candles };
}
