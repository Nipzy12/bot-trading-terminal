import { z } from "zod";
import { accountKey, marketSource, type PaperSource } from "./paper";
import { validateBars, type Bar, type BacktestSymbol } from "./backtest";
const packet = z.object({
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
});
export async function loadHistory(
  mode: "DEMO" | "EXNESS",
  symbol: BacktestSymbol,
  interval: number,
  slots: number,
  signal: AbortSignal,
  onProgress: (count: number) => void,
  transport: typeof fetch = fetch,
): Promise<{
  bars: Bar[];
  source: PaperSource;
  excluded: number;
  emptyWindows: number;
}> {
  if (!Number.isInteger(slots) || slots < 180 || slots > 2160 || slots % 180)
    throw Error("INVALID_HISTORY_SIZE");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const pages: Bar[][] = [];
  let source: PaperSource | undefined,
    before: number | undefined,
    covered = 0,
    excluded = 0,
    emptyWindows = 0,
    oldestNewerTime: number | undefined;
  for (let page = 0; page < 12 && covered < slots; page++) {
    const query = new URLSearchParams({ symbol, interval: String(interval) });
    if (before !== undefined) query.set("before", String(before));
    const response = await transport(
      `${mode === "EXNESS" ? "/api/account" : "/api"}/backtest/history?${query}`,
      {
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      if (response.status === 401) throw Error("AUTH_REQUIRED");
      if (response.status === 429)
        throw Error(
          "RATE_LIMITED — tunggu, lalu jalankan ulang secara manual.",
        );
      throw Error(
        "HISTORY_UNAVAILABLE — periksa koneksi, limits, atau jendela provider.",
      );
    }
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw Error("HISTORY_TOO_LARGE");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw Error("INVALID_HISTORY_SCHEMA");
    }
    const parsed = packet.safeParse(raw);
    if (!parsed.success) throw Error("INVALID_HISTORY_SCHEMA");
    const identity = marketSource(raw, mode);
    if (source && accountKey(source) !== accountKey(identity))
      throw Error("FEED_CHANGED — hasil dibatalkan; koneksi berubah.");
    source = identity;
    const p = parsed.data,
      { from, to } = p.window;
    if (
      from >= to ||
      from % interval ||
      to % interval ||
      (to - from) / interval > 180 ||
      (before !== undefined && to !== before) ||
      (p.nextBefore !== null && p.nextBefore !== from)
    )
      throw Error("INVALID_HISTORY_WINDOW");
    if (p.emptyWindow !== (p.candles.length === 0))
      throw Error("INVALID_HISTORY_SCHEMA");
    if (p.candles.length) validateBars(p.candles, interval);
    if (
      p.candles.some(
        (b) =>
          b.time < from ||
          b.time >= to ||
          b.time + interval > to ||
          b.time + interval > Date.now() / 1000,
      )
    )
      throw Error("INVALID_HISTORY_WINDOW");
    if (p.candles.length) {
      if (
        oldestNewerTime !== undefined &&
        p.candles.at(-1)!.time >= oldestNewerTime
      )
        throw Error("INVALID_HISTORY_ORDER");
      oldestNewerTime = p.candles[0].time;
    } else emptyWindows++;
    pages.push(p.candles);
    covered += (to - from) / interval;
    excluded += p.excludedBoundaryCandles;
    onProgress(covered);
    if (p.nextBefore === null) break;
    before = p.nextBefore;
  }
  if (!source) throw Error("EMPTY_HISTORY");
  const bars = pages.reverse().flat();
  if (bars.length < 2) throw Error("INSUFFICIENT_HISTORY");
  validateBars(bars, interval);
  return { bars, source, excluded, emptyWindows };
}
