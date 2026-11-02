import { acceptTick, updateBars, type Tick } from "./live";
import { validateBars, type Bar } from "./backtest";
import { sourceSchema, emptyQuotes, type Quotes } from "./paper";
import { Sma20Engine, type SignalState } from "./autopilot";
export type LiveQuote = {
  provider: "EXNESS";
  source: "EXNESS_LIVE";
  connectionId: string;
  symbol: string;
  bid: number;
  ask: number;
  spread: number;
  timestamp: number;
};
export type LiveMarket = {
  provider: "EXNESS";
  source: "EXNESS_LIVE";
  connectionId: string | null;
  symbol: string;
  interval: number;
  status: string;
  freshness: "WAITING" | "FRESH" | "STALE" | "UNAVAILABLE";
  quote: LiveQuote | null;
  quoteAgeMs: number | null;
  bars: Bar[];
  signal: SignalState;
};
const initial = (symbol = "XAUUSD", interval = 3600): LiveMarket => ({
  provider: "EXNESS",
  source: "EXNESS_LIVE",
  connectionId: null,
  symbol,
  interval,
  status: "CONNECTING",
  freshness: "WAITING",
  quote: null,
  quoteAgeMs: null,
  bars: [],
  signal: { status: "WAITING" },
});
export class LiveMarketStore {
  private value = initial();
  private accepting = false;
  private lastTickTime = 0;
  private listeners = new Set<() => void>();
  private engine = new Sma20Engine();
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: LiveMarket) {
    this.value = next;
    for (const f of this.listeners) f();
  }
  begin(symbol: string, interval: number) {
    this.accepting = false;
    this.lastTickTime = 0;
    this.publish(initial(symbol, interval));
  }
  basis(
    id: string,
    symbol: string,
    interval: number,
    bars: Bar[],
    now = Date.now(),
  ) {
    sourceSchema.parse({ kind: "EXNESS_LIVE", connectionId: id });
    validateBars(bars, interval, now / 1000);
    if (bars.some((b) => b.time + interval > Math.floor(now / 1000)))
      throw Error("INVALID_LIVE_BASIS");
    if (symbol !== this.value.symbol || interval !== this.value.interval)
      throw Error("LIVE_SCOPE_MISMATCH");
    this.accepting = true;
    this.lastTickTime = 0;
    const key = `EXNESS_LIVE:${id}:${symbol}:${interval}`;
    this.publish({
      ...initial(symbol, interval),
      connectionId: id,
      bars: [...bars],
      signal: this.engine.seed(key, bars, interval, now),
    });
  }
  tick(raw: Tick, now = Date.now()) {
    const s = this.value;
    if (!s.connectionId || !this.accepting) return false;
    const t = acceptTick(raw, s.connectionId, s.symbol, this.lastTickTime, now);
    if (!t) return false;
    this.lastTickTime = t.time;
    const bars = updateBars(s.bars, t, s.interval),
      key = `EXNESS_LIVE:${s.connectionId}:${s.symbol}:${s.interval}`;
    this.publish({
      ...s,
      status: "EXNESS_LIVE",
      freshness: "FRESH",
      quoteAgeMs: Math.max(0, now - t.time),
      quote: {
        provider: "EXNESS",
        source: "EXNESS_LIVE",
        connectionId: t.connectionId,
        symbol: t.symbol,
        bid: t.bid,
        ask: t.ask,
        spread: t.ask - t.bid,
        timestamp: t.time,
      },
      bars,
      signal: this.engine.evaluate(
        key,
        `EXNESS_LIVE:${s.connectionId}`,
        s.symbol,
        bars,
        s.interval,
        t.time,
        now,
      ),
    });
    return true;
  }
  status(code: string) {
    if (code === "EXNESS_LIVE") return; // Only tick() can establish LIVE.
    const s = this.value;
    if (code === "STALE") {
      this.publish({ ...s, status: code, freshness: "STALE" });
      return;
    }
    const waiting = [
      "CONNECTING",
      "WS_CONNECTED",
      "SUBSCRIPTION_SENT",
      "WAITING_FOR_BROKER_TICK",
    ].includes(code);
    const ackCandidate =
      code === "UNKNOWN_BROKER_RESPONSE · ACK_CONTRACT_UNVERIFIED";
    if (!waiting && !ackCandidate) this.accepting = false;
    this.publish({
      ...s,
      status: code,
      freshness: waiting ? "WAITING" : "UNAVAILABLE",
      quote: null,
      quoteAgeMs: null,
    });
  }
  clock(now = Date.now()) {
    const s = this.value;
    if (!s.quote) return;
    const age = Math.max(0, now - s.quote.timestamp);
    this.publish({
      ...s,
      quoteAgeMs: age,
      ...(age >= 10000 ? { status: "STALE", freshness: "STALE" as const } : {}),
    });
  }
}
export function marketQuotes(
  s: LiveMarket,
  symbol = s.symbol,
  interval = s.interval,
  now = Date.now(),
): Quotes {
  const q = s.quote,
    key = s.connectionId ? `EXNESS_LIVE:${s.connectionId}` : "";
  if (
    !q ||
    s.symbol !== symbol ||
    s.interval !== interval ||
    s.freshness !== "FRESH" ||
    s.status !== "EXNESS_LIVE" ||
    now - q.timestamp >= 10000
  )
    return emptyQuotes(key);
  return {
    accountKey: key,
    prices: { [q.symbol]: q.bid },
    sides: { [q.symbol]: { bid: q.bid, ask: q.ask, timestamp: q.timestamp } },
    expiresAt: q.timestamp + 10000,
  };
}
export function watchQuote(s: LiveMarket, symbol: string) {
  if (symbol !== s.symbol) return { status: "NOT SUBSCRIBED" as const };
  if (s.freshness === "STALE" && s.quote)
    return { status: "STALE" as const, quote: s.quote };
  if (s.freshness === "FRESH" && s.quote && s.status === "EXNESS_LIVE")
    return { status: "LIVE" as const, quote: s.quote };
  return { status: "UNAVAILABLE" as const };
}
export function liveSignalStatus(s: LiveMarket) {
  if (s.freshness === "STALE") return "STALE";
  if (s.freshness === "UNAVAILABLE") return "DISCONNECTED";
  return s.freshness === "FRESH" ? s.signal.status : "WAITING";
}
