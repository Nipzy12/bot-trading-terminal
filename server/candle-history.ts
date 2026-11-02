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
export const rangeReasons = [
  "BEFORE_FROM",
  "AT_TO",
  "AFTER_TO",
  "UNFINISHED_CANDLE",
  "TOO_MANY_CANDLES",
] as const;
export type RangeReason = (typeof rangeReasons)[number];
export class CandleHistoryError extends ProviderError {
  constructor(
    public reason: CandleReason,
    public candleCount = 0,
    public rangeReason?: RangeReason,
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
export type HistoryWindow = {
  from: number;
  to: number;
  interval: number;
  requestedAt?: number;
  historicalReference?: {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  };
};
export function closedHistoryWindow(
  now: number,
  interval: number,
  limits: {
    max_candles_per_request: number;
    history_range_days?: number;
    history_age_days?: number;
  },
) {
  const to = Math.floor(now / interval) * interval;
  let capacity = Math.min(180, limits.max_candles_per_request);
  if (limits.history_range_days !== undefined)
    capacity = Math.min(
      capacity,
      Math.floor((limits.history_range_days * 86400) / interval),
    );
  let from = to - capacity * interval;
  if (limits.history_age_days !== undefined)
    from = Math.max(
      from,
      Math.ceil((now - limits.history_age_days * 86400) / interval) * interval,
    );
  const max = (to - from) / interval;
  if (!Number.isSafeInteger(max) || max < 1)
    throw new ProviderError("EXNESS_LIMITS_UNAVAILABLE");
  return { from, to, interval, max, requestedAt: now };
}
export function normalizeHistory(
  body: unknown,
  max: number,
  window?: HistoryWindow,
  diagnostics?: {
    excludedBoundaryCandles: number;
    historicalBoundaryExcluded?: number;
  },
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
  if (count > Math.min(max, 5000) + (window ? 1 : 0))
    throw new CandleHistoryError("OUT_OF_RANGE", count, "TOO_MANY_CANDLES");
  let previous = 0;
  const parsed = candles.map((value) => {
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
    return {
      time,
      open,
      high,
      low,
      close,
      ...(row.volume === undefined ? {} : { volume: row.volume as number }),
    };
  });
  // Validate every row before considering the single explicitly reported provider-boundary exception.
  if (window && parsed.some((candle) => candle.time > window.to))
    throw new CandleHistoryError("OUT_OF_RANGE", count, "AFTER_TO");
  let excludedBoundaryCandles = 0;
  for (const [index, candle] of parsed.entries()) {
    if (!window) continue;
    const time = candle.time;
    if (time < window.from)
      throw new CandleHistoryError("OUT_OF_RANGE", count, "BEFORE_FROM");
    if (time === window.to) {
      const running =
        window.requestedAt !== undefined &&
        window.requestedAt >= time &&
        window.requestedAt < time + window.interval;
      const ref = window.historicalReference;
      const identical =
        ref !== undefined &&
        ["time", "open", "high", "low", "close", "volume"].every(
          (key) =>
            candle[key as keyof typeof candle] === ref[key as keyof typeof ref],
        );
      if (index !== parsed.length - 1 || (!running && !identical))
        throw new CandleHistoryError("OUT_OF_RANGE", count, "AT_TO");
      if (!running && identical && diagnostics)
        diagnostics.historicalBoundaryExcluded = 1;
      excludedBoundaryCandles = 1;
    } else if (time + window.interval > window.to)
      throw new CandleHistoryError("OUT_OF_RANGE", count, "UNFINISHED_CANDLE");
  }
  const result = excludedBoundaryCandles ? parsed.slice(0, -1) : parsed;
  if (result.length > Math.min(max, 5000))
    throw new CandleHistoryError("OUT_OF_RANGE", count, "TOO_MANY_CANDLES");
  if (!result.length) throw new CandleHistoryError("EMPTY_CANDLES", count);
  if (diagnostics)
    diagnostics.excludedBoundaryCandles = excludedBoundaryCandles;
  return result;
}
