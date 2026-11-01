import { z } from "zod";
export const STORAGE_KEY = "nexus.paper.v1";
const instruments = z.enum([
  "XAUUSD",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "BTCUSD",
  "ETHUSD",
]);
const positionSchema = z.object({
  id: z.string(),
  symbol: instruments,
  side: z.enum(["Buy", "Sell"]),
  size: z.number().min(0.01).max(10),
  entry: z.number().positive(),
  openedAt: z.number(),
  sl: z.number().positive().optional(),
  tp: z.number().positive().optional(),
});
const closedSchema = positionSchema.extend({
  exit: z.number().positive(),
  closedAt: z.number(),
  pnl: z.number(),
  reason: z.enum(["Manual", "Stop Loss", "Take Profit", "Emergency"]),
});
const schema = z.object({
  version: z.literal(1),
  positions: z.array(positionSchema).max(100),
  history: z.array(closedSchema).max(5000),
  dailyLimit: z.number().min(1).max(10000),
  haltDay: z.string(),
  emergency: z.boolean(),
});
export type Position = z.infer<typeof positionSchema>;
export type Closed = z.infer<typeof closedSchema>;
export type Account = z.infer<typeof schema>;
export type Quotes = Record<string, number>;
export const fresh = (): Account => ({
  version: 1,
  positions: [],
  history: [],
  dailyLimit: 100,
  haltDay: "",
  emergency: false,
});
export function restore(raw: string | null): Account {
  try {
    return schema.parse(JSON.parse(raw ?? ""));
  } catch {
    return fresh();
  }
}
export function pnl(p: Position, price: number) {
  const contracts: Record<string, number> = {
    XAUUSD: 100,
    EURUSD: 100000,
    GBPUSD: 100000,
    USDJPY: 100000,
    BTCUSD: 1,
    ETHUSD: 1,
  };
  return (
    ((price - p.entry) *
      (p.side === "Buy" ? 1 : -1) *
      p.size *
      contracts[p.symbol]) /
    (p.symbol === "USDJPY" ? price : 1)
  );
}
export const day = (now = Date.now()) =>
  new Date(now).toISOString().slice(0, 10);
export function dailyLoss(a: Account, q: Quotes, now = Date.now()) {
  return (
    a.history
      .filter((p) => day(p.closedAt) === day(now))
      .reduce((sum, p) => sum + Math.max(0, -p.pnl), 0) +
    a.positions.reduce(
      (sum, p) => sum + (q[p.symbol] ? Math.max(0, -pnl(p, q[p.symbol])) : 0),
      0,
    )
  );
}
export function blocked(a: Account, q: Quotes, now = Date.now()) {
  return (
    a.emergency ||
    a.haltDay === day(now) ||
    dailyLoss(a, q, now) >= a.dailyLimit
  );
}
export function close(
  a: Account,
  id: string,
  q: Quotes,
  reason: Closed["reason"] = "Manual",
  now = Date.now(),
): Account {
  const p = a.positions.find((p) => p.id === id);
  if (!p || !q[p.symbol]) return a;
  const exit = q[p.symbol];
  return {
    ...a,
    positions: a.positions.filter((p) => p.id !== id),
    history: [
      { ...p, exit, closedAt: now, pnl: pnl(p, exit), reason },
      ...a.history,
    ].slice(0, 5000),
  };
}
export function settle(a: Account, q: Quotes, now = Date.now()): Account {
  let next = a;
  for (const p of a.positions) {
    const v = q[p.symbol];
    if (!v) continue;
    const sl = p.sl !== undefined && (p.side === "Buy" ? v <= p.sl : v >= p.sl);
    const tp = p.tp !== undefined && (p.side === "Buy" ? v >= p.tp : v <= p.tp);
    if (a.emergency || sl || tp)
      next = close(
        next,
        p.id,
        q,
        a.emergency ? "Emergency" : sl ? "Stop Loss" : "Take Profit",
        now,
      );
  }
  if (dailyLoss(next, q, now) >= next.dailyLimit && next.haltDay !== day(now))
    next = { ...next, haltDay: day(now) };
  return next;
}
export function validStops(
  side: Position["side"],
  price: number,
  sl?: number,
  tp?: number,
) {
  return (
    (sl === undefined ||
      (Number.isFinite(sl) &&
        sl > 0 &&
        (side === "Buy" ? sl < price : sl > price))) &&
    (tp === undefined ||
      (Number.isFinite(tp) &&
        tp > 0 &&
        (side === "Buy" ? tp > price : tp < price)))
  );
}
