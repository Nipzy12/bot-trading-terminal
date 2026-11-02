import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  LiveMarketStore,
  marketQuotes,
  watchQuote,
  liveSignalStatus,
} from "../src/market-store";
import { Sma20Engine, executeSmaSignal } from "../src/autopilot";
import {
  accountKey,
  fresh,
  openPosition,
  pnl,
  valuation,
  close,
  settle,
  restoreBook,
  blocked,
  executionPrice,
  robotStep,
  type Quotes,
} from "../src/paper";
const id = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222",
  source = { kind: "EXNESS_LIVE" as const, connectionId: id };
const time = Date.UTC(2026, 10, 3, 8, 0, 5),
  interval = 300,
  bucket = Math.floor(time / 1000 / interval) * interval;
function bars(end = bucket, count = 30) {
  return Array.from({ length: count }, (_, i) => ({
    time: end - (count - i) * interval,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
  }));
}
const tick = (bid = 3900, ask = 3901, at = time) => ({
  connectionId: id,
  symbol: "XAUUSD",
  time: at,
  bid,
  ask,
  provider: "EXNESS" as const,
  source: "EXNESS_LIVE" as const,
  freshness: "FRESH" as const,
  timestampMs: at,
});
function store() {
  const s = new LiveMarketStore();
  s.begin("XAUUSD", interval);
  s.basis(id, "XAUUSD", interval, bars(), time);
  return s;
}
function quote(bid = 3900, ask = 3901, at = time): Quotes {
  return {
    accountKey: accountKey(source),
    prices: { XAUUSD: bid },
    sides: { XAUUSD: { bid, ask, timestamp: at } },
    expiresAt: at + 10000,
  };
}
function entry(side: "Buy" | "Sell" = "Buy", q = quote()) {
  return openPosition(fresh(source), q, {
    id: "position",
    symbol: "XAUUSD",
    side,
    size: 0.01,
    openedAt: time,
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(time);
});
afterEach(() => vi.useRealTimers());
it("fans out one verified quote to consumers with provenance, spread, UTC OHLC and no synthetic watchlist values", () => {
  const s = store();
  expect(watchQuote(s.getSnapshot(), "XAUUSD").status).toBe("UNAVAILABLE");
  expect(s.tick(tick())).toBe(true);
  const snap = s.getSnapshot();
  expect(snap.quote).toMatchObject({
    provider: "EXNESS",
    source: "EXNESS_LIVE",
    symbol: "XAUUSD",
    connectionId: id,
    bid: 3900,
    ask: 3901,
    spread: 1,
    timestamp: time,
  });
  expect(watchQuote(snap, "XAUUSD")).toMatchObject({
    status: "LIVE",
    quote: { bid: 3900, ask: 3901 },
  });
  expect(watchQuote(snap, "EURUSD")).toEqual({ status: "NOT SUBSCRIBED" });
  expect(snap.bars.at(-1)).toMatchObject({
    time: bucket,
    open: 3900,
    high: 3900,
    low: 3900,
    close: 3900,
  });
  expect(marketQuotes(snap).sides?.XAUUSD).toEqual({
    bid: 3900,
    ask: 3901,
    timestamp: time,
  });
  expect(marketQuotes(snap, "EURUSD").prices).toEqual({});
});
it("rejects foreign account/symbol, invalid sides, duplicate/stale/out-of-order and DEMO ticks without changing snapshot", () => {
  const s = store();
  s.tick(tick());
  const snap = s.getSnapshot();
  for (const t of [
    { ...tick(), connectionId: other },
    { ...tick(), symbol: "EURUSD" },
    tick(3900, 3890),
    tick(0, 1),
    tick(),
    tick(3900, 3901, time - 20000),
    { ...tick(), provider: "DEMO" },
  ]) {
    expect(s.tick(t as any)).toBe(false);
    expect(s.getSnapshot()).toBe(snap);
  }
});
it("expires at ten seconds, blocks all actions and resets provenance on reconnect/account change", () => {
  const s = store();
  s.tick(tick());
  const a = entry();
  s.clock(time + 10000);
  vi.setSystemTime(time + 10000);
  expect(s.getSnapshot().freshness).toBe("STALE");
  expect(liveSignalStatus(s.getSnapshot())).toBe("STALE");
  expect(marketQuotes(s.getSnapshot()).prices).toEqual({});
  expect(pnl(a.positions[0], quote())).toBeUndefined();
  for (const code of [
    "WS_DISCONNECTED",
    "SESSION_REVOKED",
    "ACCOUNT_CHANGED",
    "RATE_LIMITED",
  ]) {
    s.status(code);
    expect(s.getSnapshot().quote).toBeNull();
    expect(liveSignalStatus(s.getSnapshot())).toBe("DISCONNECTED");
  }
  s.begin("XAUUSD", interval);
  s.basis(other, "XAUUSD", interval, bars(), time + 10000);
  expect(s.tick(tick())).toBe(false);
  expect(s.getSnapshot().quote).toBeNull();
  expect(
    s.tick(
      { ...tick(4000, 4002, time + 10001), connectionId: other },
      time + 10001,
    ),
  ).toBe(true);
  expect(
    pnl(
      a.positions[0],
      marketQuotes(s.getSnapshot(), "XAUUSD", interval, time + 10001),
    ),
  ).toBeUndefined();
});
it.each(["Buy", "Sell"] as const)(
  "executes %s on correct entry/exit sides, includes spread in floating/equity and preserves fill metadata",
  (side) => {
    const a = entry(side);
    expect(a.positions[0].entry).toBe(side === "Buy" ? 3901 : 3900);
    expect(a.positions[0].spreadCost).toBe(1);
    expect(pnl(a.positions[0], quote())).toBe(-1);
    expect(valuation(a, quote()).equity).toBe(9999);
    const b = close(a, "position", quote(3902, 3903));
    expect(b.history[0].exit).toBe(side === "Buy" ? 3902 : 3903);
    expect(b.history[0].pnl).toBe(side === "Buy" ? 1 : -3);
    expect(
      restoreBook(JSON.stringify({ version: 2, accounts: [b] }), null)
        .accounts[0],
    ).toEqual(b);
  },
);
it("requires actual two-sided fresh LIVE quotes; no prices-only, history or DEMO fallback", () => {
  for (const q of [
    { ...quote(), sides: undefined },
    { ...quote(), expiresAt: undefined },
    { ...quote(), accountKey: "DEMO" },
    { ...quote(), accountKey: `EXNESS:${id}` },
    {
      ...quote(),
      sides: { XAUUSD: { bid: 3900, ask: 3899, timestamp: time } },
    },
  ]) {
    expect(
      openPosition(fresh(source), q, {
        id: "x",
        symbol: "XAUUSD",
        side: "Buy",
        size: 0.01,
        openedAt: time,
      }).positions,
    ).toHaveLength(0);
  }
  expect(executionPrice(quote(), "XAUUSD", "Buy")).toBe(3901);
  expect(executionPrice(quote(), "XAUUSD", "Sell")).toBe(3900);
});
it("triggers Sell SL and Buy TP from liquidation sides, never from an unrelated Bid/Ask", () => {
  const sell = {
    ...entry("Sell"),
    positions: [{ ...entry("Sell").positions[0], sl: 3902 }],
  };
  expect(settle(sell, quote(3900, 3902)).history[0]).toMatchObject({
    reason: "Stop Loss",
    exit: 3902,
    pnl: -2,
  });
  const buy = {
    ...entry("Buy"),
    positions: [{ ...entry("Buy").positions[0], tp: 3902 }],
  };
  expect(settle(buy, quote(3901, 3903)).positions).toHaveLength(1);
  expect(settle(buy, quote(3902, 3903)).history[0]).toMatchObject({
    reason: "Take Profit",
    exit: 3902,
    pnl: 1,
  });
});
it("emergency settles Buy at Bid and Sell at Ask, preserves positions while disconnected and daily risk still locks", () => {
  let a = entry("Buy");
  a = openPosition(a, quote(), {
    id: "sell",
    symbol: "XAUUSD",
    side: "Sell",
    size: 0.01,
    openedAt: time,
  });
  const stopped = { ...a, emergency: true };
  expect(settle(stopped, { accountKey: accountKey(source), prices: {} })).toBe(
    stopped,
  );
  const settled = settle(stopped, quote());
  expect(settled.positions).toHaveLength(0);
  expect(settled.history.map((h) => h.exit).sort()).toEqual([3900, 3901]);
  expect(blocked(settled, quote())).toBe(true);
  expect(blocked({ ...a, dailyLimit: 1 }, quote())).toBe(true);
});
it("caps new paper positions at three without deleting existing legacy positions and rejects legacy live robotStep", () => {
  let a = fresh(source);
  for (let i = 0; i < 5; i++)
    a = openPosition(a, quote(), {
      id: String(i),
      symbol: "XAUUSD",
      side: "Buy",
      size: 0.01,
      openedAt: time,
    });
  expect(a.positions).toHaveLength(3);
  expect(
    robotStep(
      fresh(source),
      quote(),
      "XAUUSD",
      { accountKey: accountKey(source), average: 3800 },
      "r",
    ),
  ).toEqual(fresh(source));
  const legacy = {
    ...fresh(),
    positions: [
      {
        id: "old",
        accountKey: "DEMO",
        symbol: "XAUUSD" as const,
        side: "Buy" as const,
        size: 0.01,
        entry: 2740,
        openedAt: time,
      },
    ],
  };
  const book = restoreBook(
    JSON.stringify({ version: 2, accounts: [legacy, a] }),
    null,
  );
  expect(book.accounts[0]).toEqual(legacy);
});
function crossover() {
  const b = bars(bucket - interval, 21);
  b[b.length - 1] = { ...b.at(-1)!, open: 99, low: 98, high: 100, close: 99 };
  return b;
}
it("SMA20 uses closed-candle crossover only; consumes each candle once and ignores mutable active candles", () => {
  const e = new Sma20Engine(),
    b = crossover(),
    key = `${accountKey(source)}:XAUUSD:${interval}`;
  e.seed(key, b, interval, time);
  const closeBar = {
      time: bucket - interval,
      open: 99,
      high: 102,
      low: 98,
      close: 102,
    },
    active = { time: bucket, open: 102, high: 200, low: 100, close: 200 };
  const result = e.evaluate(
    key,
    accountKey(source),
    "XAUUSD",
    [...b, closeBar, active],
    interval,
    time,
    time,
  );
  expect(result).toMatchObject({
    status: "LIVE SIGNAL",
    signal: { side: "Buy", candleTime: bucket - interval },
  });
  expect(
    e.evaluate(
      key,
      accountKey(source),
      "XAUUSD",
      [...b, closeBar, { ...active, close: 50, low: 50 }],
      interval,
      time + 1,
      time + 1,
    ),
  ).toBe(result);
  const a = executeSmaSignal(fresh(source), quote(), result.signal!, "r", time);
  expect(a.positions[0]).toMatchObject({
    entry: 3901,
    side: "Buy",
    signalId: result.signal!.id,
  });
  expect(executeSmaSignal(a, quote(), result.signal!, "r2", time)).toBe(a);
  expect(
    executeSmaSignal(
      close(a, "r", quote()),
      quote(),
      result.signal!,
      "r3",
      time,
    ).positions,
  ).toHaveLength(0);
});
it("does not evaluate unfinished candles, replay startup/backfill, enter on a continuing level, or fabricate weekend bars", () => {
  const e = new Sma20Engine(),
    b = bars(),
    key = "context";
  e.seed(key, b, interval, time);
  expect(
    e.evaluate(
      key,
      accountKey(source),
      "XAUUSD",
      [...b, { time: bucket, open: 100, high: 200, low: 100, close: 200 }],
      interval,
      time,
      time,
    ),
  ).toEqual({ status: "NO SIGNAL" });
  const later = time + interval * 1000,
    below = { time: bucket, open: 100, high: 100, low: 99, close: 100 };
  expect(
    e.evaluate(
      key,
      accountKey(source),
      "XAUUSD",
      [...b, below],
      interval,
      later,
      later,
    ).status,
  ).toBe("NO SIGNAL");
  const gap = { ...below, time: bucket + 3 * interval };
  expect(
    e.evaluate(
      key,
      accountKey(source),
      "XAUUSD",
      [...b, gap],
      interval,
      later + 3 * interval * 1000,
      later + 3 * interval * 1000,
    ).status,
  ).toBe("WAITING");
});

it("detects a closed Sell crossover, uses Bid entry, and never fills after risk/stale/context violations", () => {
  const e = new Sma20Engine(),
    b = bars(bucket - interval, 21),
    key = `${accountKey(source)}:XAUUSD:${interval}`;
  b[b.length - 1] = { ...b.at(-1)!, close: 101, high: 102 };
  e.seed(key, b, interval, time);
  const closed = {
    time: bucket - interval,
    open: 101,
    high: 102,
    low: 97,
    close: 98,
  };
  const r = e.evaluate(
    key,
    accountKey(source),
    "XAUUSD",
    [...b, closed],
    interval,
    time,
    time,
  );
  expect(r.signal?.side).toBe("Sell");
  expect(
    executeSmaSignal(fresh(source), quote(), r.signal!, "sell").positions[0]
      .entry,
  ).toBe(3900);
  for (const a of [
    { ...fresh(source), emergency: true },
    { ...fresh(source), haltDay: new Date(time).toISOString().slice(0, 10) },
    fresh({ kind: "EXNESS_LIVE", connectionId: other }),
  ])
    expect(executeSmaSignal(a, quote(), r.signal!, "blocked")).toBe(a);
  vi.setSystemTime(time + 11000);
  expect(
    executeSmaSignal(fresh(source), quote(), r.signal!, "stale").positions,
  ).toHaveLength(0);
});
it("reconnect seeds a new baseline and never replays a previous signal or mixes ticker identities", () => {
  const s = store();
  s.tick(tick());
  s.status("WS_DISCONNECTED");
  expect(watchQuote(s.getSnapshot(), "XAUUSD")).toEqual({
    status: "UNAVAILABLE",
  });
  s.begin("EURUSD", interval);
  s.basis(other, "EURUSD", interval, bars(), time);
  expect(watchQuote(s.getSnapshot(), "XAUUSD")).toEqual({
    status: "NOT SUBSCRIBED",
  });
  expect(s.tick(tick())).toBe(false);
  expect(
    s.tick({ ...tick(1.1, 1.1002), symbol: "EURUSD", connectionId: other }),
  ).toBe(true);
  expect(s.getSnapshot().signal.signal).toBeUndefined();
  expect(watchQuote(s.getSnapshot(), "EURUSD")).toMatchObject({
    status: "LIVE",
    quote: { bid: 1.1, ask: 1.1002 },
  });
});

it("the store itself rejects ticks after terminal status until fresh bootstrap; subscribers share one snapshot", () => {
  const s = store(),
    seen: unknown[] = [];
  const stop = s.subscribe(() => seen.push(s.getSnapshot()));
  s.tick(tick());
  expect(seen.at(-1)).toBe(s.getSnapshot());
  s.status("SESSION_REVOKED");
  const blocked = s.getSnapshot();
  expect(s.tick(tick(3901, 3902, time + 1), time + 1)).toBe(false);
  expect(s.getSnapshot()).toBe(blocked);
  s.status("WAITING_FOR_BROKER_TICK");
  expect(s.tick(tick(3901, 3902, time + 1), time + 1)).toBe(false);
  s.begin("XAUUSD", interval);
  s.basis(id, "XAUUSD", interval, bars(), time);
  s.status("UNKNOWN_BROKER_RESPONSE · ACK_CONTRACT_UNVERIFIED");
  expect(s.tick(tick())).toBe(true);
  const count = seen.length;
  stop();
  s.clock(time + 1);
  expect(seen.length).toBe(count);
});

it("latches the daily halt at entry when spread reaches the daily limit, even if the next quote recovers", () => {
  const a = openPosition({ ...fresh(source), dailyLimit: 1 }, quote(), {
    id: "spread-risk",
    symbol: "XAUUSD",
    side: "Buy",
    size: 0.01,
    openedAt: time,
  });
  expect(a.haltDay).toBe(new Date(time).toISOString().slice(0, 10));
  expect(blocked(a, quote(3902, 3903))).toBe(true);
  const restored = restoreBook(
    JSON.stringify({ version: 2, accounts: [a] }),
    null,
  ).accounts[0];
  expect(restored.haltDay).toBe(a.haltDay);
});
