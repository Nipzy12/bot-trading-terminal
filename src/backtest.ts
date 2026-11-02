import { z } from "zod";
import type { PaperSource } from "./paper";
export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};
export const strategySchema = z
  .object({
    fast: z.number().int().min(2).max(100),
    slow: z.number().int().min(3).max(250),
    rsiPeriod: z.number().int().min(2).max(100),
    longRsi: z.number().min(1).max(99),
    shortRsi: z.number().min(1).max(99),
    stopPct: z.number().min(0.1).max(10),
    takePct: z.number().min(0.1).max(20),
    riskPct: z.number().min(0.1).max(5),
    spread: z.number().min(0).max(100),
    slippage: z.number().min(0).max(100),
    commission: z.number().min(0).max(100),
    capital: z.number().min(100).max(10000000),
    trainPct: z.number().int().min(50).max(90),
  })
  .refine((p) => p.fast < p.slow, {
    message: "EMA cepat harus lebih kecil dari EMA lambat.",
  })
  .refine((p) => p.shortRsi <= p.longRsi, {
    message: "Batas RSI short harus ≤ long.",
  });
export type Strategy = z.infer<typeof strategySchema>;
export const defaults: Strategy = {
  fast: 9,
  slow: 21,
  rsiPeriod: 14,
  longRsi: 50,
  shortRsi: 50,
  stopPct: 0.5,
  takePct: 1,
  riskPct: 1,
  spread: 0.3,
  slippage: 0.1,
  commission: 3.5,
  capital: 10000,
  trainPct: 70,
};
export type Trade = {
  side: "Buy" | "Sell";
  signalTime: number;
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  lots: number;
  sl: number;
  tp: number;
  pnl: number;
  fees: number;
  reason: "SL" | "TP" | "Segment end";
  ambiguous: boolean;
};
export type CurvePoint = { time: number; equity: number };
export type Segment = {
  trades: Trade[];
  curve: CurvePoint[];
  net: number;
  winRate: number;
  profitFactor: number | null;
  drawdown: number;
  drawdownPct: number;
  count: number;
};
export function ema(values: number[], period: number) {
  let current = 0;
  return values.map((v, i) => {
    if (i < period) {
      current += v;
      if (i === period - 1) {
        current /= period;
        return current;
      }
      return undefined;
    }
    current += ((v - current) * 2) / (period + 1);
    return current;
  });
}
export function rsi(values: number[], period: number) {
  let gains = 0,
    losses = 0;
  return values.map((v, i) => {
    if (!i) return undefined;
    const delta = v - values[i - 1];
    if (i <= period) {
      gains += Math.max(0, delta);
      losses += Math.max(0, -delta);
      if (i < period) return undefined;
      gains /= period;
      losses /= period;
    } else {
      gains = (gains * (period - 1) + Math.max(0, delta)) / period;
      losses = (losses * (period - 1) + Math.max(0, -delta)) / period;
    }
    return losses === 0
      ? gains === 0
        ? 50
        : 100
      : 100 - 100 / (1 + gains / losses);
  });
}
export function indicators(bars: Bar[], p: Strategy) {
  const closes = bars.map((b) => b.close);
  return {
    fast: ema(closes, p.fast),
    slow: ema(closes, p.slow),
    rsi: rsi(closes, p.rsiPeriod),
  };
}
export function signalAt(
  i: number,
  series: ReturnType<typeof indicators>,
  p: Strategy,
): "Buy" | "Sell" | undefined {
  const f = series.fast[i],
    s = series.slow[i],
    pf = series.fast[i - 1],
    ps = series.slow[i - 1],
    r = series.rsi[i];
  if (
    f === undefined ||
    s === undefined ||
    pf === undefined ||
    ps === undefined ||
    r === undefined
  )
    return;
  if (pf <= ps && f > s && r >= p.longRsi) return "Buy";
  if (pf >= ps && f < s && r <= p.shortRsi) return "Sell";
}
const contracts = { XAUUSD: 100, EURUSD: 100000, BTCUSD: 1 } as const;
export type BacktestSymbol = keyof typeof contracts;
export function validateBars(
  bars: Bar[],
  interval: number,
  now = Date.now() / 1000,
) {
  if (
    !Number.isInteger(interval) ||
    interval < 300 ||
    bars.length < 1 ||
    bars.length > 2160
  )
    throw Error("INVALID_HISTORY_SIZE");
  let previous = 0;
  for (const b of bars) {
    if (
      !Number.isSafeInteger(b.time) ||
      b.time <= previous ||
      b.time + interval > now ||
      b.time <= 0
    )
      throw Error("INVALID_HISTORY_TIME");
    if (
      [b.open, b.high, b.low, b.close].some(
        (v) => !Number.isFinite(v) || v <= 0,
      ) ||
      b.high < Math.max(b.open, b.close) ||
      b.low > Math.min(b.open, b.close) ||
      b.low > b.high
    )
      throw Error("INVALID_HISTORY_OHLC");
    previous = b.time;
  }
}
export function summarize(
  trades: Trade[],
  curve: CurvePoint[],
  capital: number,
): Segment {
  const wins = trades.filter((t) => t.pnl > 0),
    grossWin = wins.reduce((s, t) => s + t.pnl, 0),
    grossLoss = trades.reduce((s, t) => s + Math.max(0, -t.pnl), 0);
  let peak = capital,
    drawdown = 0,
    drawdownPct = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    drawdown = Math.max(drawdown, peak - p.equity);
    drawdownPct = Math.max(drawdownPct, ((peak - p.equity) / peak) * 100);
  }
  return {
    trades,
    curve,
    net: trades.reduce((s, t) => s + t.pnl, 0),
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : null,
    drawdown,
    drawdownPct,
    count: trades.length,
  };
}
// Each segment starts with independent capital; indicators may warm up using earlier closes only.
export function simulate(
  bars: Bar[],
  symbol: BacktestSymbol,
  p: Strategy,
  start = 0,
  end = bars.length,
): Segment {
  const series = indicators(bars, p),
    contract = contracts[symbol];
  let balance = p.capital,
    position:
      | Omit<
          Trade,
          "exitTime" | "exit" | "pnl" | "fees" | "reason" | "ambiguous"
        >
      | undefined;
  const trades: Trade[] = [],
    curve: CurvePoint[] = [{ time: bars[start].time, equity: balance }];
  for (let i = start; i < end; i++) {
    const b = bars[i];
    const side = i > start ? signalAt(i - 1, series, p) : undefined;
    if (!position && side && balance > 0) {
      const entry =
        b.open + (side === "Buy" ? p.spread + p.slippage : -p.slippage);
      if (entry <= 0) throw Error("INVALID_COST_ASSUMPTIONS");
      const distance = (entry * p.stopPct) / 100;
      const risk = (balance * p.riskPct) / 100;
      const lots = Math.min(
        10,
        risk /
          (distance * contract +
            (p.spread + 2 * p.slippage) * contract +
            2 * p.commission),
      );
      position = {
        side,
        signalTime: bars[i - 1].time,
        entryTime: b.time,
        entry,
        lots,
        sl: entry + (side === "Buy" ? -distance : distance),
        tp: entry * (1 + ((side === "Buy" ? 1 : -1) * p.takePct) / 100),
      };
    }
    if (position) {
      const v = position,
        isBuy = v.side === "Buy",
        open = b.open + (isBuy ? 0 : p.spread),
        low = b.low + (isBuy ? 0 : p.spread),
        high = b.high + (isBuy ? 0 : p.spread);
      const stop = isBuy ? low <= v.sl : high >= v.sl,
        take = isBuy ? high >= v.tp : low <= v.tp;
      const reason = stop
        ? "SL"
        : take
          ? "TP"
          : i === end - 1
            ? "Segment end"
            : undefined;
      if (reason) {
        const level =
          reason === "SL"
            ? isBuy
              ? Math.min(open, v.sl)
              : Math.max(open, v.sl)
            : reason === "TP"
              ? v.tp
              : b.close + (isBuy ? 0 : p.spread);
        const exit = level + (isBuy ? -p.slippage : p.slippage);
        if (exit <= 0) throw Error("INVALID_COST_ASSUMPTIONS");
        const fees = v.lots * p.commission * 2;
        const pnl =
          (exit - v.entry) * (isBuy ? 1 : -1) * v.lots * contract - fees;
        trades.push({
          ...v,
          exitTime: b.time,
          exit,
          pnl,
          fees,
          reason,
          ambiguous: stop && take,
        });
        balance += pnl;
        position = undefined;
      }
    }
    const mark = position
      ? (b.close +
          (position.side === "Buy" ? -p.slippage : p.spread + p.slippage) -
          position.entry) *
          (position.side === "Buy" ? 1 : -1) *
          position.lots *
          contract -
        2 * position.lots * p.commission
      : 0;
    curve.push({ time: b.time, equity: balance + mark });
  }
  return summarize(trades, curve, p.capital);
}
export type BacktestResult = {
  source: PaperSource;
  symbol: BacktestSymbol;
  interval: number;
  parameters: Strategy;
  inSample: Segment;
  outSample: Segment;
  splitTime: number;
  warnings: string[];
  barCount: number;
  gaps: number;
};
export function backtest(
  bars: Bar[],
  symbol: BacktestSymbol,
  interval: number,
  parameters: Strategy,
  source: PaperSource,
  now = Date.now() / 1000,
): BacktestResult {
  if (bars.length < 2) throw Error("INSUFFICIENT_HISTORY");
  const p = strategySchema.parse(parameters);
  validateBars(bars, interval, now);
  const split = Math.max(
    1,
    Math.min(bars.length - 1, Math.floor((bars.length * p.trainPct) / 100)),
  );
  const gaps = bars
    .slice(1)
    .filter((b, i) => b.time - bars[i].time > interval).length;
  const warnings: string[] = [];
  if (bars.length < Math.max(200, p.slow * 5))
    warnings.push("Data terlalu sedikit untuk penilaian strategi yang andal.");
  if (gaps)
    warnings.push(
      `Terdapat ${gaps} gap historis, termasuk kemungkinan jeda sesi/weekend. Tidak ada candle sintetis yang disisipkan.`,
    );
  const inSample = simulate(bars, symbol, p, 0, split),
    outSample = simulate(bars, symbol, p, split);
  if (outSample.count < 20)
    warnings.push(
      "Transaksi out-of-sample kurang dari 20; statistik belum stabil.",
    );
  if ([...inSample.trades, ...outSample.trades].some((t) => t.ambiguous))
    warnings.push(
      "SL dan TP tersentuh pada candle yang sama: SL diasumsikan terjadi lebih dulu.",
    );
  return {
    source,
    symbol,
    interval,
    parameters: p,
    inSample,
    outSample,
    splitTime: bars[split].time,
    warnings,
    barCount: bars.length,
    gaps,
  };
}
