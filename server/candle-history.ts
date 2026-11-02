import { z } from "zod";
import { ProviderError } from "./provider-error.js";
export const candleReasons = [
  "EMPTY_CANDLES",
  "INVALID_SCHEMA",
  "INVALID_OHLC",
  "INVALID_TIMESTAMP",
  "OUT_OF_RANGE",
  "INVALID_ORDER",
  "INSTRUMENT_NOT_FOUND",
  "AMBIGUOUS_INSTRUMENT",
] as const;
export type CandleReason = (typeof candleReasons)[number];
export class CandleHistoryError extends ProviderError {
  constructor(
    public reason: CandleReason,
    public candleCount = 0,
  ) {
    super(
      reason === "INSTRUMENT_NOT_FOUND" || reason === "AMBIGUOUS_INSTRUMENT"
        ? "EXNESS_MARKET_DATA"
        : "EXNESS_INVALID_RESPONSE",
    );
  }
}
const instrumentName = z
  .string()
  .min(1)
  .max(11)
  .regex(/^[A-Za-z0-9._-]+$/);
const instrumentsSchema = z.object({
  instruments: z.array(instrumentName).max(10000),
});
export function instrumentNames(body: unknown) {
  const result = instrumentsSchema.safeParse(body);
  if (!result.success) throw new CandleHistoryError("INVALID_SCHEMA");
  return [...new Set(result.data.instruments)];
}
export function selectInstrument(ui: string, names: readonly string[]) {
  if (names.includes(ui)) return ui;
  // Only XAUUSD aliasing is in scope. Unknown semantic aliases cannot be inferred from names alone.
  if (ui === "XAUUSD") {
    const candidates = names.filter((name) =>
      /^XAUUSD[a-z0-9._-]{1,5}$/.test(name),
    );
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1)
      throw new CandleHistoryError("AMBIGUOUS_INSTRUMENT");
  }
  throw new CandleHistoryError("INSTRUMENT_NOT_FOUND");
}
const iso = z.iso.datetime({ offset: true });
export type HistoryWindow = { from: number; now: number; interval: number };
export function normalizeHistory(
  body: unknown,
  max: number,
  window?: HistoryWindow,
) {
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { candles?: unknown }).candles)
  )
    throw new CandleHistoryError("INVALID_SCHEMA");
  const candles = (body as { candles: unknown[] }).candles;
  const count = candles.length;
  if (!count) throw new CandleHistoryError("EMPTY_CANDLES", 0);
  if (count > Math.min(max, 5000))
    throw new CandleHistoryError("OUT_OF_RANGE", count);
  let previous = 0;
  return candles.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new CandleHistoryError("INVALID_SCHEMA", count);
    const row = value as Record<string, unknown>;
    if (
      ["time", "open", "high", "low", "close"].some(
        (k) => !Object.hasOwn(row, k),
      )
    )
      throw new CandleHistoryError("INVALID_SCHEMA", count);
    if (!iso.safeParse(row.time).success)
      throw new CandleHistoryError("INVALID_TIMESTAMP", count);
    const time = Date.parse(row.time as string) / 1000;
    if (!Number.isSafeInteger(time) || time <= 0)
      throw new CandleHistoryError("INVALID_TIMESTAMP", count);
    for (const key of ["open", "high", "low", "close"])
      if (typeof row[key] !== "number")
        throw new CandleHistoryError("INVALID_SCHEMA", count);
    const { open, high, low, close } = row as {
      open: number;
      high: number;
      low: number;
      close: number;
    };
    if (
      [open, high, low, close].some((v) => !Number.isFinite(v) || v <= 0) ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      low > high
    )
      throw new CandleHistoryError("INVALID_OHLC", count);
    if (
      row.volume !== undefined &&
      (typeof row.volume !== "number" ||
        !Number.isFinite(row.volume) ||
        row.volume < 0)
    )
      throw new CandleHistoryError("INVALID_SCHEMA", count);
    if (previous && time <= previous)
      throw new CandleHistoryError("INVALID_ORDER", count);
    previous = time;
    // No invented consecutive/alignment requirement: market-session gaps are legitimate.
    if (window && (time < window.from || time + window.interval > window.now))
      throw new CandleHistoryError("OUT_OF_RANGE", count);
    return { time, open, high, low, close };
  });
}
