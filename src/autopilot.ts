import type { Bar } from "./backtest";
import { accountKey, openPosition, type Account, type Quotes } from "./paper";
export type SmaSignal = {
  id: string;
  accountKey: string;
  symbol: string;
  interval: number;
  candleTime: number;
  side: "Buy" | "Sell";
  average: number;
};
export type SignalState = {
  status: "WAITING" | "NO SIGNAL" | "LIVE SIGNAL";
  signal?: SmaSignal;
};
export function closedBars(
  bars: Bar[],
  interval: number,
  now: number,
  brokerTime = now,
) {
  const boundary =
    Math.floor(Math.min(now, brokerTime) / 1000 / interval) * interval;
  return bars.filter((b) => b.time + interval <= boundary);
}
export class Sma20Engine {
  private cursor = -1;
  private key = "";
  private result: SignalState = { status: "WAITING" };
  seed(key: string, bars: Bar[], interval: number, now = Date.now()) {
    this.key = key;
    const closed = closedBars(bars, interval, now),
      tail = closed.slice(-21);
    this.cursor = closed.at(-1)?.time ?? -1;
    const usable =
      tail.length === 21 &&
      tail.every(
        (b, i) =>
          Number.isFinite(b.close) &&
          b.close > 0 &&
          (i === 0 || b.time - tail[i - 1].time === interval),
      );
    this.result = { status: usable ? "NO SIGNAL" : "WAITING" };
    return this.result;
  }
  evaluate(
    key: string,
    account: string,
    symbol: string,
    bars: Bar[],
    interval: number,
    brokerTime: number,
    now = Date.now(),
  ): SignalState {
    if (key !== this.key) return this.seed(key, bars, interval, now);
    const closed = closedBars(bars, interval, now, brokerTime),
      latest = closed.at(-1);
    if (!latest || latest.time <= this.cursor) return this.result;
    this.cursor = latest.time; // Consume even a gap/no-signal; never replay a backlog.
    const tail = closed.slice(-21);
    if (
      tail.length < 21 ||
      tail.some(
        (b, i) =>
          !Number.isFinite(b.close) ||
          b.close <= 0 ||
          (i > 0 && b.time - tail[i - 1].time !== interval),
      )
    )
      return (this.result = { status: "WAITING" });
    const previous = tail.slice(0, 20).reduce((s, b) => s + b.close, 0) / 20;
    const average = tail.slice(1).reduce((s, b) => s + b.close, 0) / 20;
    const before = tail[19].close,
      after = tail[20].close;
    const side =
      before <= previous && after > average
        ? "Buy"
        : before >= previous && after < average
          ? "Sell"
          : undefined;
    return (this.result = side
      ? {
          status: "LIVE SIGNAL",
          signal: {
            id: `${key}:${latest.time}`,
            accountKey: account,
            symbol,
            interval,
            candleTime: latest.time,
            side,
            average,
          },
        }
      : { status: "NO SIGNAL" });
  }
}
export function executeSmaSignal(
  a: Account,
  q: Quotes,
  s: SmaSignal,
  id: string,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(s.candleTime) ||
    s.candleTime <= 0 ||
    ![300, 900, 3600, 14400, 86400].includes(s.interval) ||
    !Number.isFinite(s.average) ||
    s.average <= 0 ||
    a.source.kind !== "EXNESS_LIVE" ||
    s.accountKey !== accountKey(a.source) ||
    q.accountKey !== s.accountKey ||
    now < (s.candleTime + s.interval) * 1000 ||
    now >= (s.candleTime + 2 * s.interval) * 1000 ||
    [...a.positions, ...a.history].some((p) => p.signalId === s.id)
  )
    return a;
  return openPosition(a, q, {
    id,
    symbol: s.symbol as Account["positions"][number]["symbol"],
    side: s.side,
    size: 0.01,
    openedAt: now,
    signalId: s.id,
  });
}
