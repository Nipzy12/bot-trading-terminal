import { z } from "zod";
export const STORAGE_KEY = "nexus.paper.v2";
export const LEGACY_STORAGE_KEY = "nexus.paper.v1";
export const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("DEMO") }).strict(),
  z.object({ kind: z.literal("EXNESS"), connectionId: z.uuid() }).strict(),
  z.object({ kind: z.literal("EXNESS_LIVE"), connectionId: z.uuid() }).strict(),
]);
export type PaperSource = z.infer<typeof sourceSchema>;
export const DEMO: PaperSource = { kind: "DEMO" };
export const accountKey = (source: PaperSource) =>
  source.kind === "DEMO" ? "DEMO" : `${source.kind}:${source.connectionId}`;
export function marketSource(
  value: unknown,
  expected: PaperSource["kind"],
): PaperSource {
  const result = z
    .object({
      source: z.string(),
      live: z.literal(false).optional(),
      kind: z.string().optional(),
      paperSource: sourceSchema.optional(),
    })
    .safeParse(value);
  if (!result.success) throw Error("Identitas feed belum terverifikasi.");
  const feed = result.data;
  if (expected === "DEMO" && feed.source === "simulation") return DEMO;
  if (
    expected === "EXNESS" &&
    feed.source === "exness" &&
    feed.live === false &&
    feed.kind === "candle-history" &&
    feed.paperSource?.kind === "EXNESS"
  )
    return feed.paperSource;
  throw Error(
    "Identitas feed tidak sesuai. Muat ulang atau pilih koneksi lagi.",
  );
}
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
  accountKey: z.string(),
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
  version: z.literal(2),
  source: sourceSchema,
  positions: z.array(positionSchema).max(100),
  history: z.array(closedSchema).max(5000),
  dailyLimit: z.number().min(1).max(10000),
  haltDay: z.string(),
  emergency: z.boolean(),
});
export type Position = z.infer<typeof positionSchema>;
export type Closed = z.infer<typeof closedSchema>;
export type Account = z.infer<typeof schema>;
export type Quotes = {
  expiresAt?: number;
  accountKey: string;
  prices: Record<string, number>;
};
export const emptyQuotes = (key = ""): Quotes => ({
  accountKey: key,
  prices: {},
});
export const fresh = (source: PaperSource = DEMO): Account => ({
  version: 2,
  source,
  positions: [],
  history: [],
  dailyLimit: 100,
  haltDay: "",
  emergency: false,
});
const legacySchema = schema.omit({ source: true }).extend({
  version: z.literal(1),
  positions: z.array(positionSchema.omit({ accountKey: true })).max(100),
  history: z.array(closedSchema.omit({ accountKey: true })).max(5000),
});
function parseAccount(value: unknown): Account {
  const legacy = legacySchema.safeParse(value);
  const a = legacy.success
    ? schema.parse({
        ...legacy.data,
        version: 2,
        source: DEMO,
        positions: legacy.data.positions.map((p) => ({
          ...p,
          accountKey: "DEMO",
        })),
        history: legacy.data.history.map((p) => ({ ...p, accountKey: "DEMO" })),
      })
    : schema.parse(value);
  if (
    [...a.positions, ...a.history].some(
      (p) => p.accountKey !== accountKey(a.source),
    )
  )
    throw Error("ACCOUNT_SOURCE_MISMATCH");
  return a;
}
export function restore(raw: string | null): Account {
  try {
    return parseAccount(JSON.parse(raw ?? ""));
  } catch {
    return fresh();
  }
}
export type PaperBook = { version: 2; accounts: Account[] };
export function restoreBook(
  raw: string | null,
  legacy: string | null,
): PaperBook {
  if (raw === null) return { version: 2, accounts: [restore(legacy)] };
  try {
    const book = z
      .object({ version: z.literal(2), accounts: z.array(z.unknown()).min(1) })
      .parse(JSON.parse(raw));
    const accounts = book.accounts.map(parseAccount);
    if (
      new Set(accounts.map((a) => accountKey(a.source))).size !==
      accounts.length
    )
      throw Error("DUPLICATE_ACCOUNT");
    return { version: 2, accounts };
  } catch {
    return { version: 2, accounts: [restore(legacy)] };
  }
}
export function ensureAccount(book: PaperBook, source: PaperSource): PaperBook {
  return book.accounts.some((a) => accountKey(a.source) === accountKey(source))
    ? book
    : { ...book, accounts: [...book.accounts, fresh(source)] };
}
export function mark(p: Position, q: Quotes): number | undefined {
  if (q.expiresAt !== undefined && Date.now() >= q.expiresAt) return undefined;
  const value = q.prices[p.symbol];
  return p.accountKey === q.accountKey && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
export function pnl(p: Position, q: Quotes): number | undefined {
  const price = mark(p, q);
  return price === undefined ? undefined : pricePnl(p, price);
}
function pricePnl(p: Position, price: number) {
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
export function dailyLoss(
  a: Account,
  q: Quotes,
  now = Date.now(),
): number | undefined {
  if (
    accountKey(a.source) !== q.accountKey ||
    a.positions.some((p) => mark(p, q) === undefined)
  )
    return undefined;
  return (
    a.history
      .filter((p) => day(p.closedAt) === day(now))
      .reduce((sum, p) => sum + Math.max(0, -p.pnl), 0) +
    a.positions.reduce((sum, p) => sum + Math.max(0, -pnl(p, q)!), 0)
  );
}
export function blocked(a: Account, q: Quotes, now = Date.now()) {
  return (
    a.emergency ||
    a.haltDay === day(now) ||
    dailyLoss(a, q, now) === undefined ||
    dailyLoss(a, q, now)! >= a.dailyLimit
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
  if (!p || p.accountKey !== accountKey(a.source)) return a;
  const exit = mark(p, q);
  if (exit === undefined) return a;
  return {
    ...a,
    positions: a.positions.filter((p) => p.id !== id),
    history: [
      { ...p, exit, closedAt: now, pnl: pricePnl(p, exit), reason },
      ...a.history,
    ].slice(0, 5000),
  };
}
export function settle(a: Account, q: Quotes, now = Date.now()): Account {
  let next = a;
  for (const p of a.positions) {
    const v = mark(p, q);
    if (v === undefined || p.accountKey !== accountKey(a.source)) continue;
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
  if (
    (dailyLoss(next, q, now) ?? -1) >= next.dailyLimit &&
    next.haltDay !== day(now)
  )
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

export function openPosition(
  a: Account,
  q: Quotes,
  input: Omit<Position, "entry" | "accountKey">,
): Account {
  const key = accountKey(a.source);
  const candidate = { ...input, accountKey: key, entry: 1 };
  const entry = mark(candidate, q);
  if (
    entry === undefined ||
    blocked(a, q, input.openedAt) ||
    a.positions.length >= 100 ||
    !positionSchema.safeParse({ ...candidate, entry }).success ||
    !validStops(input.side, entry, input.sl, input.tp)
  )
    return a;
  return {
    ...a,
    positions: [...a.positions, { ...input, entry, accountKey: key }],
  };
}
export function robotStep(
  a: Account,
  q: Quotes,
  symbol: Position["symbol"],
  signal: { accountKey: string; average: number },
  id: string,
  now = Date.now(),
): Account {
  const average = signal.average;
  if (signal.accountKey !== accountKey(a.source)) return a;
  const price = mark(
    { symbol, accountKey: accountKey(a.source) } as Position,
    q,
  );
  if (
    price === undefined ||
    !Number.isFinite(average) ||
    average <= 0 ||
    a.positions.length >= 3
  )
    return a;
  return openPosition(a, q, {
    id,
    symbol,
    side: price > average ? "Buy" : "Sell",
    size: 0.01,
    openedAt: now,
  });
}
export function valuation(a: Account, q: Quotes) {
  const realized = a.history.reduce((sum, p) => sum + p.pnl, 0);
  const complete =
    accountKey(a.source) === q.accountKey &&
    a.positions.every((p) => mark(p, q) !== undefined);
  const floating = complete
    ? a.positions.reduce((sum, p) => sum + pnl(p, q)!, 0)
    : undefined;
  return {
    realized,
    floating,
    equity: floating === undefined ? undefined : 10000 + realized + floating,
  };
}
