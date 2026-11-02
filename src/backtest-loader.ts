import { z } from "zod";
import { accountKey, marketSource, type PaperSource } from "./paper";
import { validateBars, type Bar, type BacktestSymbol } from "./backtest";
import {
  safeCategory,
  safeHistoryDetails,
  diagnosticText,
  type HistoryDiagnostic,
  type HistoryCategory,
} from "./history-diagnostics";
const packet = z.object({
  historicalBoundaryExcluded: z.union([z.literal(0), z.literal(1)]).default(0),
  boundaryDiagnostic: z.literal("HISTORICAL_BOUNDARY_DUPLICATE").optional(),
  emptyWindow: z.boolean().default(false),
  candles: z
    .array(
      z.object({
        time: z.number().int(),
        open: z.number(),
        high: z.number(),
        low: z.number(),
        close: z.number(),
      }),
    )
    .max(180),
  window: z.object({
    from: z.number().int().positive(),
    to: z.number().int().positive(),
  }),
  nextBefore: z.number().int().positive().nullable(),
  excludedBoundaryCandles: z.union([z.literal(0), z.literal(1)]),
  historyAgeKnown: z.boolean().optional(),
  limitCause: z.enum(["PROVIDER_AGE", "CURSOR_FLOOR"]).optional(),
});
export class HistoryLoadError extends Error {
  constructor(public diagnostic: HistoryDiagnostic) {
    super(diagnosticText(diagnostic));
  }
}
export type HistoryLoadResult = {
  bars: Bar[];
  source: PaperSource;
  excluded: number;
  emptyWindows: number;
  historicalBoundaryExcluded: number;
  loadedIntervals: number;
  historyAgeKnown: boolean;
  truncated: boolean;
  diagnostic?: HistoryDiagnostic;
};
function deadlineWork<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new DOMException("Timeout", "TimeoutError"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Timeout", "TimeoutError"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function loadHistory(
  mode: "DEMO" | "EXNESS",
  symbol: BacktestSymbol,
  interval: number,
  slots: number,
  signal: AbortSignal,
  onProgress: (count: number) => void,
  transport: typeof fetch = fetch,
): Promise<HistoryLoadResult> {
  let covered = 0,
    excluded = 0,
    historicalBoundaryExcluded = 0,
    emptyWindows = 0,
    oldestNewerTime: number | undefined,
    before: number | undefined,
    source: PaperSource | undefined,
    pageIndex = 1,
    httpStatus = 0,
    historyAgeKnown = true,
    diagnostic: HistoryDiagnostic | undefined;
  const pages: Bar[][] = [];
  const validCount = () => pages.reduce((sum, p) => sum + p.length, 0);
  const details = (
    category: HistoryCategory,
    value: unknown = {},
  ): HistoryDiagnostic => ({
    category,
    httpStatus,
    pageIndex,
    loadedIntervals: covered,
    validCandles: validCount(),
    ...safeHistoryDetails(value),
  });
  const fail = (category: HistoryCategory, value: unknown = {}): never => {
    throw new HistoryLoadError(details(category, value));
  };
  if (!Number.isInteger(slots) || slots < 180 || slots > 2160 || slots % 180)
    fail("INVALID_HISTORY_SIZE");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  for (let page = 0; page < 12 && covered < slots; page++) {
    pageIndex = page + 1;
    httpStatus = 0;
    const span = Math.min(180, slots - covered);
    const query = new URLSearchParams({
      symbol,
      interval: String(interval),
      windowIntervals: String(span),
      pageIndex: String(pageIndex),
      loadedIntervals: String(covered),
      validCandles: String(validCount()),
    });
    if (before !== undefined) query.set("before", String(before));
    const requestSignal = AbortSignal.any([
      deadline,
      AbortSignal.timeout(10000),
    ]);
    let response: Response, text: string;
    try {
      response = await deadlineWork(
        () =>
          transport(
            `${mode === "EXNESS" ? "/api/account" : "/api"}/backtest/history?${query}`,
            { signal: requestSignal, cache: "no-store" },
          ),
        requestSignal,
      );
      httpStatus = response.status;
      text = await deadlineWork(() => response.text(), requestSignal);
    } catch {
      fail(requestSignal.aborted ? "TIMEOUT" : "EXNESS_NETWORK");
    }
    if (text!.length > 2 * 1024 * 1024) fail("HISTORY_TOO_LARGE");
    let raw: Record<string, unknown> = {};
    try {
      const json: unknown = JSON.parse(text!);
      if (!json || typeof json !== "object" || Array.isArray(json))
        fail("INVALID_HISTORY_SCHEMA");
      raw = json as Record<string, unknown>;
    } catch {
      if (response!.ok) fail("INVALID_HISTORY_SCHEMA");
    }
    if (!response!.ok) {
      const reported = safeCategory(raw.error);
      const category =
        response!.status === 429
          ? "RATE_LIMITED"
          : reported !== "HISTORY_INTERNAL_FAILURE"
            ? reported
            : response!.status === 401
              ? "AUTH_REQUIRED"
              : response!.status === 504
                ? "TIMEOUT"
                : "HISTORY_INTERNAL_FAILURE";
      const safe = safeHistoryDetails(raw);
      // Only an explicit age/cursor end or an older, provider-confirmed NO_QUOTES response may truncate.
      // Invalid time/count/limit/cursor, auth, timeout and validation errors are never treated as exhaustion.
      const end =
        (category === "HISTORY_LIMIT_REACHED" &&
          (safe.limitCause === "PROVIDER_AGE" ||
            safe.limitCause === "CURSOR_FLOOR")) ||
        (category === "EXNESS_DATA_UNAVAILABLE" &&
          safe.providerCode === 4004 &&
          covered > 0);
      if (end && source) {
        if (mode === "EXNESS") {
          const check = z
            .object({ kind: z.literal("EXNESS"), connectionId: z.uuid() })
            .safeParse(raw.paperSource);
          if (!check.success || accountKey(check.data) !== accountKey(source))
            fail("FEED_CHANGED");
        }
        diagnostic = details("HISTORY_LIMIT_REACHED", {
          ...safe,
          limitCause:
            category === "EXNESS_DATA_UNAVAILABLE"
              ? "PROVIDER_DATA_UNAVAILABLE"
              : safe.limitCause,
        });
        break;
      }
      fail(category, safe);
    }
    const parsed = packet.safeParse(raw);
    if (!parsed.success)
      throw new HistoryLoadError(details("INVALID_HISTORY_SCHEMA"));
    let identity: PaperSource;
    try {
      identity = marketSource(raw, mode);
    } catch {
      fail("FEED_CHANGED");
    }
    if (source && accountKey(source) !== accountKey(identity!))
      fail("FEED_CHANGED");
    const p = parsed.data,
      { from, to } = p.window;
    if (
      from >= to ||
      from % interval ||
      to % interval ||
      (to - from) / interval > span ||
      (before !== undefined && to !== before) ||
      (p.nextBefore !== null && p.nextBefore !== from)
    )
      fail("INVALID_HISTORY_WINDOW");
    if (p.emptyWindow !== (p.candles.length === 0))
      fail("INVALID_HISTORY_SCHEMA");
    if (p.candles.length) {
      try {
        validateBars(p.candles, interval);
      } catch (e) {
        fail(safeCategory(e instanceof Error ? e.message : undefined));
      }
    }
    if (
      p.candles.some(
        (b) =>
          b.time < from ||
          b.time >= to ||
          b.time + interval > to ||
          b.time + interval > Date.now() / 1000,
      )
    )
      fail("INVALID_HISTORY_WINDOW");
    if (
      p.candles.length &&
      oldestNewerTime !== undefined &&
      p.candles.at(-1)!.time >= oldestNewerTime
    )
      fail("INVALID_HISTORY_ORDER");
    // Only fully validated pages affect progress or the sample offered to the user.
    source = identity!;
    if (mode === "EXNESS" && p.historyAgeKnown !== true)
      historyAgeKnown = false;
    if (p.candles.length) oldestNewerTime = p.candles[0].time;
    else emptyWindows++;
    pages.push(p.candles);
    covered += (to - from) / interval;
    if (
      p.historicalBoundaryExcluded &&
      (p.boundaryDiagnostic !== "HISTORICAL_BOUNDARY_DUPLICATE" ||
        p.excludedBoundaryCandles !== 1)
    )
      fail("INVALID_HISTORY_SCHEMA");
    historicalBoundaryExcluded += p.historicalBoundaryExcluded;
    excluded += p.excludedBoundaryCandles;
    onProgress(covered);
    if (p.nextBefore === null) {
      if (covered < slots)
        diagnostic = details("HISTORY_LIMIT_REACHED", {
          limitCause: p.limitCause ?? "CURSOR_FLOOR",
        });
      break;
    }
    before = p.nextBefore;
  }
  if (covered < slots && !diagnostic)
    diagnostic = details("PAGE_BUDGET_REACHED", { limitCause: "PAGE_BUDGET" });
  const bars = pages.reverse().flat();
  if (!source || bars.length < 2) {
    if (diagnostic) throw new HistoryLoadError(diagnostic);
    fail("INSUFFICIENT_HISTORY");
  }
  try {
    validateBars(bars, interval);
  } catch (e) {
    fail(safeCategory(e instanceof Error ? e.message : undefined));
  }
  return {
    bars,
    source: source!,
    excluded,
    emptyWindows,
    historicalBoundaryExcluded,
    loadedIntervals: covered,
    historyAgeKnown,
    truncated: diagnostic !== undefined,
    diagnostic,
  };
}
