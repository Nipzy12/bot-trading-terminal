import { z } from "zod";
import type { Bar } from "./backtest";
export const tickSchema = z
  .object({
    symbol: z.string(),
    connectionId: z.uuid(),
    time: z.number().int().positive(),
    bid: z.number().positive(),
    ask: z.number().positive(),
  })
  .refine((t) => t.ask >= t.bid);
export type Tick = z.infer<typeof tickSchema>;
export function acceptTick(
  raw: unknown,
  id: string,
  symbol: string,
  last: number,
  now = Date.now(),
): Tick | null {
  const p = tickSchema.safeParse(raw);
  if (!p.success) return null;
  const t = p.data;
  return t.connectionId === id &&
    t.symbol === symbol &&
    t.time > last &&
    t.time <= now + 2000 &&
    now - t.time <= 10000
    ? t
    : null;
}
export function updateBars(bars: Bar[], tick: Tick, interval: number): Bar[] {
  const time = Math.floor(tick.time / 1000 / interval) * interval,
    last = bars.at(-1);
  if (last && time < last.time) return bars;
  const candle =
    last?.time === time
      ? {
          ...last,
          high: Math.max(last.high, tick.bid),
          low: Math.min(last.low, tick.bid),
          close: tick.bid,
        }
      : {
          time,
          open: tick.bid,
          high: tick.bid,
          low: tick.bid,
          close: tick.bid,
        };
  return last?.time === time
    ? [...bars.slice(0, -1), candle]
    : [...bars, candle].slice(-500);
}
export const reconnectDelay = (attempt: number) =>
  Math.min(60000, 5000 * 2 ** Math.min(attempt, 4));
