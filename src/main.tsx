import { useLive } from "./use-live";
import { updateBars } from "./live";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  Bot,
  ChartCandlestick,
  ChevronDown,
  CircleHelp,
  Crosshair,
  Expand,
  Globe,
  Layers,
  LayoutDashboard,
  ShieldCheck,
  Star,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import "./style.css";
const Backtest = React.lazy(() =>
  import("./Backtest").then((m) => ({ default: m.Backtest })),
);
const AccountManagement = React.lazy(() =>
  import("./AccountManagement").then((m) => ({ default: m.AccountManagement })),
);
const liveMode = new URLSearchParams(location.search).get("feed") === "live";
const marketPath =
  liveMode || new URLSearchParams(location.search).get("feed") === "exness"
    ? "/api/account/market"
    : "/api/market";
import {
  STORAGE_KEY,
  fresh,
  restoreBook,
  LEGACY_STORAGE_KEY,
  DEMO,
  accountKey,
  marketSource,
  ensureAccount,
  emptyQuotes,
  mark,
  openPosition,
  robotStep,
  valuation,
  type PaperSource,
  type PaperBook,
  pnl,
  close,
  settle,
  blocked,
  dailyLoss,
  validStops,
  type Account,
  type Position,
  type Closed,
  type Quotes,
} from "./paper";
type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};
const markets = [
  { symbol: "XAUUSD", name: "Gold / US Dollar", price: 2742.68, change: 0.84 },
  { symbol: "EURUSD", name: "Euro / US Dollar", price: 1.08432, change: 0.12 },
  {
    symbol: "GBPUSD",
    name: "British Pound / US Dollar",
    price: 1.29764,
    change: -0.23,
  },
  {
    symbol: "USDJPY",
    name: "US Dollar / Japanese Yen",
    price: 153.12,
    change: 0.36,
  },
  {
    symbol: "BTCUSD",
    name: "Bitcoin / US Dollar",
    price: 69420.5,
    change: 2.41,
  },
  {
    symbol: "ETHUSD",
    name: "Ethereum / US Dollar",
    price: 2518.34,
    change: -0.67,
  },
] as const;
const fmt = (n: number) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 2 ? 5 : 2,
  });
function Chart({ data }: { data: Candle[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<ReturnType<
    ReturnType<typeof createChart>["addSeries"]
  > | null>(null);
  const previousData = useRef<Candle[]>([]);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#10141d" },
        textColor: "#758095",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1a202c" },
        horzLines: { color: "#1a202c" },
      },
      rightPriceScale: { borderColor: "#242b39" },
      timeScale: { borderColor: "#242b39", timeVisible: true },
      crosshair: { mode: 0 },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#26c6a0",
      downColor: "#ed6175",
      borderVisible: false,
      wickUpColor: "#26c6a0",
      wickDownColor: "#ed6175",
    });
    seriesRef.current = series;
    series.setData(data.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, []);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const prev = previousData.current;
    if (
      liveMode &&
      prev.length &&
      data.length >= prev.length &&
      prev[0] === data[0] &&
      data.at(-1)
    )
      series.update({
        ...data.at(-1)!,
        time: data.at(-1)!.time as UTCTimestamp,
      });
    else
      series.setData(data.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    previousData.current = data;
  }, [data]);
  return <div className="chart" ref={ref} />;
}
function App() {
  const [symbol, setSymbol] = useState<Position["symbol"]>("XAUUSD"),
    [interval, setIntervalValue] = useState("3600"),
    [data, setData] = useState<Candle[]>([]),
    [source, setSource] = useState("simulation"),
    [feedPause, setFeedPause] = useState(""),
    [feedEpoch, setFeedEpoch] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [side, setSide] = useState<"Buy" | "Sell">("Buy"),
    [size, setSize] = useState("0.01"),
    [book, setBook] = useState<PaperBook>(() => {
      try {
        return restoreBook(
          localStorage.getItem(STORAGE_KEY),
          localStorage.getItem(LEGACY_STORAGE_KEY),
        );
      } catch {
        return { version: 2, accounts: [fresh()] };
      }
    }),
    [activeKey, setActiveKey] = useState<string | null>(
      marketPath === "/api/market" ? "DEMO" : null,
    ),
    [feedSource, setFeedSource] = useState<PaperSource | null>(
      marketPath === "/api/market" ? DEMO : null,
    ),
    [quotes, setQuotes] = useState<Quotes>(emptyQuotes()),
    [storageError, setStorageError] = useState(false),
    [sl, setSl] = useState(""),
    [tp, setTp] = useState(""),
    [robot, setRobot] = useState(false),
    [tab, setTab] = useState("Posisi"),
    [notice, setNotice] = useState(""),
    [search, setSearch] = useState("");
  const account =
    book.accounts.find((a) => accountKey(a.source) === activeKey) ?? fresh();
  const feedKey = feedSource ? accountKey(feedSource) : "";
  const accountLabel =
    account.source.kind === "DEMO"
      ? "DEMO"
      : `${account.source.kind} · ${account.source.connectionId.slice(0, 8)}`;
  const matchingFeed = activeKey !== null && activeKey === feedKey;
  function setAccount(update: (a: Account) => Account) {
    setBook((b) => ({
      ...b,
      accounts: b.accounts.map((a) =>
        accountKey(a.source) === activeKey ? update(a) : a,
      ),
    }));
  }
  function activateFeed(next: PaperSource) {
    const key = accountKey(next);
    setBook((b) => ensureAccount(b, next));
    if (!feedSource || accountKey(feedSource) !== key) {
      setRobot(false);
      setQuotes(emptyQuotes());
      setActiveKey(key);
    }
    setFeedSource(next);
  }
  const [liveAsk, setLiveAsk] = useState<number | undefined>();
  const [liveStatus, setLiveStatus] = useState("CONNECTING");
  useLive(liveMode, symbol, Number(interval), feedEpoch, {
    basis: (id, bars) => {
      setQuotes(emptyQuotes());
      setRobot(false);
      activateFeed({ kind: "EXNESS_LIVE", connectionId: id });
      setData(bars);
      setSource("exness-live");
      setLoading(false);
      setError("");
    },
    tick: (t) => {
      setLiveAsk(t.ask);
      setData((b) => updateBars(b, t, Number(interval)));
      setQuotes({
        accountKey: `EXNESS_LIVE:${t.connectionId}`,
        prices: { [symbol]: t.bid },
        expiresAt: t.time + 10000,
      });
    },
    status: (s) => {
      setLiveStatus(s);
      if (s !== "EXNESS_LIVE") {
        setQuotes(emptyQuotes());
        setLiveAsk(undefined);
        setRobot(false);
      }
    },
  });
  const paused = useRef(false);
  function pauseFeed(seconds: number) {
    paused.current = true;
    setRobot(false);
    setQuotes(emptyQuotes());
    setFeedPause(
      `EXNESS rate limit. Tunggu ${seconds} detik sebelum mencoba lagi secara manual.`,
    );
  }
  const dataLabel =
    loading || error || feedPause
      ? "UNVERIFIED"
      : liveMode
        ? liveStatus === "EXNESS_LIVE"
          ? "EXNESS · LIVE"
          : "UNVERIFIED"
        : source === "exness"
          ? "EXNESS · HISTORY"
          : "DEMO";
  const { positions, history } = account;
  const riskBlocked = blocked(account, quotes);
  const { floating, realized, equity } = valuation(account, quotes);
  const loss = dailyLoss(account, quotes);
  const orderPrice =
    quotes.accountKey === activeKey && matchingFeed
      ? quotes.prices[symbol]
      : undefined;
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(book));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [book]);
  useEffect(() => {
    setAccount((a) => settle(a, quotes));
  }, [quotes, activeKey]);
  useEffect(() => {
    if (riskBlocked || !matchingFeed) setRobot(false);
  }, [riskBlocked, activeKey, feedKey]);
  const quoteSymbols = [
    ...new Set([
      symbol,
      ...(matchingFeed ? positions.map((p) => p.symbol) : []),
    ]),
  ]
    .sort()
    .join(",");
  useEffect(() => {
    if (liveMode) return;
    const controller = new AbortController();
    let refreshing = false;
    async function refresh() {
      if (refreshing || paused.current || !feedKey) return;
      refreshing = true;
      await Promise.all(
        quoteSymbols.split(",").map(async (instrument) => {
          try {
            const response = await fetch(
              `${marketPath}?symbol=${instrument}&interval=300`,
              {
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(8000),
                ]),
              },
            );
            if (response.status === 429) {
              const body = await response.json();
              pauseFeed(body.retryAfter ?? 60);
              throw Error("Rate limited");
            }
            if (!response.ok) throw Error("Quote unavailable");
            const feed = await response.json();
            const identity = marketSource(
              feed,
              marketPath === "/api/market" ? "DEMO" : "EXNESS",
            );
            if (accountKey(identity) !== feedKey) {
              if (!controller.signal.aborted) {
                setError(
                  "Koneksi feed berubah. Muat ulang chart; akun paper lama tetap tersimpan.",
                );
                setQuotes(emptyQuotes());
                setRobot(false);
              }
              throw Error("Feed identity changed");
            }
            const last = feed.candles.at(-1)?.close;
            if (!Number.isFinite(last) || last <= 0)
              throw Error("Invalid quote");
            const mark =
              feed.source === "simulation"
                ? last * (1 + Math.sin(Date.now() / 15000) * 0.00015)
                : last;
            if (!controller.signal.aborted && !paused.current)
              setQuotes((q) => ({
                accountKey: feedKey,
                prices: {
                  ...(q.accountKey === feedKey ? q.prices : {}),
                  [instrument]: mark,
                },
              }));
          } catch {
            if (!controller.signal.aborted) {
              setQuotes((q) => {
                const prices = { ...q.prices };
                delete prices[instrument];
                return { ...q, prices };
              });
              setRobot(false);
            }
          }
        }),
      );
      refreshing = false;
    }
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [quoteSymbols, feedEpoch, feedKey]);
  const current = markets.find((m) => m.symbol === symbol)!;
  const price =
    (quotes.accountKey === feedKey ? quotes.prices[symbol] : undefined) ??
    data.at(-1)?.close;
  useEffect(() => {
    if (liveMode) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData([]);
    fetch(`${marketPath}?symbol=${symbol}&interval=${interval}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (r.status === 429) {
          const body = await r.json();
          pauseFeed(body.retryAfter ?? 60);
          throw Error(
            "EXNESS rate limit: coba lagi secara manual setelah masa tunggu.",
          );
        }
        if (!r.ok) throw Error("Data market tidak tersedia. Periksa backend.");
        return r.json();
      })
      .then((d) => {
        if (controller.signal.aborted) return;
        const identity = marketSource(
          d,
          marketPath === "/api/market" ? "DEMO" : "EXNESS",
        );
        activateFeed(identity);
        setData(d.candles);
        setSource(d.source);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [symbol, interval, feedEpoch]);
  function order(orderSide = side) {
    const volume = Number(size);
    if (
      !Number.isFinite(volume) ||
      volume < 0.01 ||
      volume > 10 ||
      !data.length
    ) {
      setNotice("Volume harus 0.01–10 lot dan data market harus tersedia.");
      return;
    }
    const stop = sl === "" ? undefined : Number(sl),
      take = tp === "" ? undefined : Number(tp);
    if (
      !orderPrice ||
      !validStops(orderSide, orderPrice ?? 0, stop, take) ||
      (stop !== undefined && (!Number.isFinite(stop) || stop <= 0)) ||
      (take !== undefined && (!Number.isFinite(take) || take <= 0))
    ) {
      setNotice(
        "SL/TP tidak valid: Buy SL < harga < TP; Sell TP < harga < SL.",
      );
      return;
    }
    if (
      !matchingFeed ||
      loading ||
      error ||
      feedPause ||
      riskBlocked ||
      (liveMode && liveStatus !== "EXNESS_LIVE")
    )
      return;
    setAccount((a) =>
      openPosition(a, quotes, {
        id: crypto.randomUUID(),
        symbol,
        side: orderSide,
        size: volume,
        openedAt: Date.now(),
        sl: stop,
        tp: take,
      }),
    );
    setNotice(`Order ${orderSide} simulasi berhasil dibuat.`);
  }
  const robotContext = useRef({ quotes, activeKey, feedKey });
  robotContext.current = { quotes, activeKey, feedKey };
  useEffect(() => {
    if (
      !robot ||
      riskBlocked ||
      !matchingFeed ||
      loading ||
      error ||
      feedPause ||
      !orderPrice
    )
      return;
    const key = activeKey;
    const timer = window.setInterval(() => {
      const context = robotContext.current;
      if (
        data.length < 20 ||
        context.activeKey !== key ||
        context.feedKey !== key ||
        context.quotes.accountKey !== key
      )
        return;
      const closed = liveMode
        ? data.filter((c) => c.time + Number(interval) <= Date.now() / 1000)
        : data;
      if (closed.length < 20) return;
      const average =
        closed.slice(-20).reduce((sum, c) => sum + c.close, 0) / 20;
      setAccount((a) =>
        robotStep(
          a,
          context.quotes,
          symbol,
          { accountKey: context.feedKey, average },
          crypto.randomUUID(),
        ),
      );
    }, 10000);
    return () => clearInterval(timer);
  }, [
    robot,
    riskBlocked,
    data,
    symbol,
    loading,
    error,
    feedPause,
    activeKey,
    feedKey,
  ]);
  function emergency() {
    setRobot(false);
    setAccount((a) => settle({ ...a, emergency: true }, quotes));
    setNotice(
      "Emergency stop aktif. Posisi tanpa kuotasi menunggu feed pulih untuk ditutup.",
    );
  }
  return (
    <div className="app">
      <aside className="rail">
        <div className="brand-icon">
          <Activity />
        </div>
        <button aria-label="Terminal" className="active">
          <ChartCandlestick />
        </button>
        <button
          aria-label="Ringkasan akun"
          onClick={() => setNotice("Akun simulasi · saldo virtual $10,000.00")}
        >
          <LayoutDashboard />
        </button>
        <button
          aria-label="Robot trading"
          onClick={() =>
            document
              .getElementById("robot")
              ?.scrollIntoView({ behavior: "smooth" })
          }
        >
          <Bot />
        </button>
        <button
          aria-label="Dompet"
          onClick={() =>
            setNotice("Dompet simulasi. Deposit dan penarikan tidak tersedia.")
          }
        >
          <Wallet />
        </button>
        <div className="rail-bottom">
          <ShieldCheck />
          <button
            aria-label="Bantuan"
            onClick={() =>
              setNotice(
                "Pilih market, tentukan volume, lalu buat order simulasi. Robot SMA20 berjalan selama halaman terbuka.",
              )
            }
          >
            <CircleHelp />
          </button>
          <div className="avatar">NP</div>
        </div>
      </aside>
      <div className="workspace">
        <header>
          <a className="logo" href="/">
            NEXUS<span>TERMINAL</span>
          </a>
          <nav>
            <a className="selected" href="#terminal">
              Terminal
            </a>
            <a href="#markets">Markets</a>
            <a href="/accounts">Accounts</a>
            <a href="/backtest">Backtest</a>
            <a href="#robot">
              Trading bot <span className="new">NEW</span>
            </a>
          </nav>
          <div className="header-right">
            <span className="badge">
              <i /> Paper trading
            </span>
            <button
              aria-label="Notifikasi"
              onClick={() =>
                setNotice(
                  "Tidak ada notifikasi baru. Semua transaksi dalam mode simulasi.",
                )
              }
            >
              <Bell size={18} />
            </button>
            <div className="avatar">NP</div>
            <span className="user">
              Nipzy <ChevronDown size={13} />
            </span>
          </div>
        </header>
        {liveMode && (
          <div className="feed-warning" role="status">
            EXNESS LIVE · {liveStatus} · Bid/Ask broker; OHLC tick teramati,
            candle aktif parsial setelah reconnect.{" "}
            <button onClick={() => setFeedEpoch((n) => n + 1)}>
              Hubungkan ulang manual
            </button>
          </div>
        )}
        {feedPause && (
          <div className="feed-warning" role="alert">
            {feedPause}
            <button
              onClick={() => {
                paused.current = false;
                setFeedPause("");
                setFeedEpoch((n) => n + 1);
              }}
            >
              Coba lagi
            </button>
          </div>
        )}
        <section className="account">
          <div>
            <span className="eyebrow">WORKSPACE / OVERVIEW</span>
            <h1>
              Trading terminal
              <span className="live-dot" />
            </h1>
            <p>Pasar global. Satu workspace. Kendali penuh.</p>
          </div>
          <div className="metric">
            <span>
              Saldo virtual <Wallet size={13} />
            </span>
            <strong>${fmt(10000 + realized)}</strong>
            <small>
              {accountLabel} · USD · Realized ${fmt(realized)}
            </small>
          </div>
          <div className="metric">
            <span>Posisi terbuka</span>
            <strong>
              {positions.length}
              <span> posisi</span>
            </strong>
            <small className="green">Modal virtual, tanpa risiko dana</small>
          </div>
          <div className="session">
            <Globe size={17} />
            <div>
              Execution environment
              <strong>
                Paper trading <i />
              </strong>
            </div>
            <span className="muted">{accountLabel}</span>
          </div>
        </section>
        <section className="paper-switch panel" aria-label="Akun paper trading">
          <label htmlFor="paper-account">Akun paper terpisah</label>
          <select
            id="paper-account"
            value={activeKey ?? ""}
            onChange={(e) => {
              setRobot(false);
              setActiveKey(e.target.value);
              setSl("");
              setTp("");
            }}
          >
            {activeKey === null && (
              <option value="">Menunggu identitas EXNESS…</option>
            )}
            {book.accounts.map((a) => (
              <option key={accountKey(a.source)} value={accountKey(a.source)}>
                {a.source.kind === "DEMO"
                  ? "DEMO"
                  : `${a.source.kind} · ${a.source.connectionId.slice(0, 8)}`}{" "}
                · {a.positions.length} posisi
              </option>
            ))}
          </select>
          <a href="/">Feed DEMO</a>
          <a href="/?feed=exness">Feed EXNESS history</a>
          <a href="/?feed=live">Feed EXNESS LIVE</a>
          <p role="status">
            {!matchingFeed
              ? "Feed berbeda / belum terverifikasi: penilaian, SL/TP, penutupan dan robot akun ini ditangguhkan. Posisi tetap tersimpan."
              : `${accountLabel} · ${account.source.kind === "EXNESS_LIVE" ? "Mark Bid tick broker, freshness 10 detik" : account.source.kind === "EXNESS" ? "Mark candle historis M5, bukan tick real-time" : "Harga simulasi DEMO"}`}
          </p>
        </section>
        <section className="ticker" aria-label="Snapshot DEMO">
          {markets.slice(0, 5).map((m) => (
            <button key={m.symbol} onClick={() => setSymbol(m.symbol)}>
              <span>
                {m.symbol} · DEMO{" "}
                <small>
                  {m.symbol === "XAUUSD" ? "GOLD" : "FOREX / CRYPTO"}
                </small>
              </span>
              <strong>{fmt(m.price)}</strong>
              <em className={m.change > 0 ? "green" : "red"}>
                {m.change > 0 ? "+" : ""}
                {m.change}%
              </em>
            </button>
          ))}
        </section>
        <main id="terminal">
          <section className="chart-panel panel">
            <div className="panel-top">
              <div className="instrument">
                <div className="gold-icon">Au</div>
                <div>
                  <strong>
                    {symbol} <ChevronDown size={13} />
                  </strong>
                  <small>{current.name}</small>
                </div>
                <span className="exchange">{dataLabel}</span>
              </div>
              <div className="chart-actions">
                <span className="green">
                  <i />{" "}
                  {loading ? "Memuat" : error ? "Feed error" : "Market data"}
                </span>
                <button
                  aria-label="Perbesar chart"
                  onClick={() =>
                    document
                      .querySelector(".chart-panel")
                      ?.requestFullscreen?.()
                  }
                >
                  <Expand size={16} />
                </button>
              </div>
            </div>
            <div className="toolbar">
              {[
                ["300", "5m"],
                ["900", "15m"],
                ["3600", "1h"],
                ["14400", "4h"],
                ["86400", "1D"],
              ].map(([value, label]) => (
                <button
                  className={interval === value ? "chosen" : ""}
                  key={value}
                  onClick={() => setIntervalValue(value)}
                >
                  {label}
                </button>
              ))}
              <span className="divider" />
              <ChartCandlestick size={17} />
              <span className="divider" />
              <span className="muted">
                <TrendingUp size={15} /> Candlestick
              </span>
              <span className="toolbar-end">
                USD <ChevronDown size={12} />
              </span>
            </div>
            <div className="ohlc">
              <strong>
                {symbol} ·{" "}
                {interval === "3600"
                  ? "1h"
                  : interval === "300"
                    ? "5m"
                    : interval === "900"
                      ? "15m"
                      : interval === "14400"
                        ? "4h"
                        : "1D"}
              </strong>
              <span>
                O <b>{fmt(data.at(-1)?.open ?? 0)}</b>
              </span>
              <span>
                H <b>{fmt(data.at(-1)?.high ?? 0)}</b>
              </span>
              <span>
                L <b>{fmt(data.at(-1)?.low ?? 0)}</b>
              </span>
              <span>
                C{" "}
                <b className="green">
                  {price === undefined ? "—" : fmt(price)}
                </b>
              </span>
            </div>
            <div className="chart-wrap">
              <div className="drawing-tools">
                <Crosshair />
                <TrendingUp />
                <Layers />
                <span>T</span>
              </div>
              {error ? (
                <div className="chart-state red">{error}</div>
              ) : loading ? (
                <div className="chart-state">Memuat market…</div>
              ) : (
                <Chart data={data} />
              )}
              <span className="watermark">
                NEXUS
                <span> / {dataLabel}</span>
              </span>
            </div>
            <div className="chart-footer">
              <span>Rentang: {data.length} candles</span>
              <span>
                UTC ·{" "}
                {dataLabel === "UNVERIFIED"
                  ? "Data belum terverifikasi"
                  : source === "simulation"
                    ? "DEMO · data simulasi, bukan harga live"
                    : liveMode
                      ? "EXNESS LIVE · Bid tick broker · candle aktif teramati/parsial"
                      : "EXNESS · candle history, bukan live ticks"}
              </span>
              <span className={error ? "red" : "green"}>
                ●{" "}
                {loading
                  ? "Connecting"
                  : error
                    ? "Unavailable"
                    : "Backend feed"}
              </span>
            </div>
          </section>
          <aside className="order-panel panel">
            <div className="panel-title">
              <h2>Order terminal</h2>
              <ShieldCheck size={16} className="green" />
            </div>
            <div className="simulation-note">
              <ShieldCheck size={15} />
              <span>Mode simulasi aktif</span>
            </div>
            <div className="order-symbol">
              <strong>{symbol}</strong>
              <span>{current.name}</span>
            </div>
            <div className="side-toggle">
              <button
                className={side === "Buy" ? "buy selected-side" : ""}
                onClick={() => setSide("Buy")}
              >
                Buy / Long
              </button>
              <button
                className={side === "Sell" ? "sell selected-side" : ""}
                onClick={() => setSide("Sell")}
              >
                Sell / Short
              </button>
            </div>
            <div className="order-type">
              Market order <span>Eksekusi simulasi</span>
            </div>
            <label htmlFor="volume">
              Volume <span>Lot</span>
            </label>
            <div className="volume-control">
              <button
                aria-label="Kurangi volume"
                onClick={() =>
                  setSize(
                    String(Math.max(0.01, Number(size) - 0.01).toFixed(2)),
                  )
                }
              >
                −
              </button>
              <input
                id="volume"
                type="number"
                min="0.01"
                max="10"
                step="0.01"
                value={size}
                onChange={(e) => setSize(e.target.value)}
              />
              <button
                aria-label="Tambah volume"
                onClick={() =>
                  setSize(String(Math.min(10, Number(size) + 0.01).toFixed(2)))
                }
              >
                +
              </button>
            </div>
            <div className="presets">
              {["0.01", "0.10", "0.50", "1.00"].map((s) => (
                <button
                  key={s}
                  className={size === s ? "chosen" : ""}
                  onClick={() => setSize(s)}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="stops">
              <label htmlFor="sl">Stop Loss (harga)</label>
              <input
                id="sl"
                type="number"
                step="any"
                min="0"
                placeholder="Opsional"
                value={sl}
                onChange={(e) => setSl(e.target.value)}
              />
              <label htmlFor="tp">Take Profit (harga)</label>
              <input
                id="tp"
                type="number"
                step="any"
                min="0"
                placeholder="Opsional"
                value={tp}
                onChange={(e) => setTp(e.target.value)}
              />
            </div>
            <div className="order-details">
              {liveMode && (
                <p>
                  Ask / spread{" "}
                  <strong>
                    {liveAsk === undefined || orderPrice === undefined
                      ? "Menunggu"
                      : `${fmt(liveAsk)} / ${fmt(liveAsk - orderPrice)}`}
                  </strong>
                </p>
              )}
              <p>
                Harga paper{" "}
                {account.source.kind === "EXNESS_LIVE"
                  ? "EXNESS LIVE"
                  : account.source.kind === "EXNESS"
                    ? "EXNESS HISTORY"
                    : "DEMO"}{" "}
                <strong>
                  {orderPrice === undefined ? "Menunggu" : fmt(orderPrice)}
                </strong>
              </p>
              <p>
                Jenis eksekusi <strong>Paper trading</strong>
              </p>
              <p>
                Batas posisi robot <strong>3 posisi</strong>
              </p>
            </div>
            <button
              disabled={
                loading ||
                !!error ||
                !!feedPause ||
                riskBlocked ||
                !matchingFeed ||
                account.emergency ||
                !orderPrice
              }
              className={`submit-order ${side === "Sell" ? "sell-bg" : ""}`}
              onClick={() => order()}
            >
              {side === "Buy" ? (
                <ArrowUpRight size={18} />
              ) : (
                <ArrowDownLeft size={18} />
              )}{" "}
              {side} {symbol}
              <span>{size} lot</span>
            </button>
            <p className="disclaimer">
              Order virtual. Tidak dikirim ke broker.
            </p>
            <div id="robot" className="robot">
              <div>
                <Bot size={19} />
                <strong>Nexus AutoPilot</strong>
                <span className="mini-badge">{account.source.kind}</span>
              </div>
              <p>
                Strategi SMA 20 · interval 10 detik
                <br />
                Maksimal 3 posisi, volume 0.01 lot.
              </p>
              <label htmlFor="daily-limit">Batas rugi harian (USD, UTC)</label>
              <input
                id="daily-limit"
                type="number"
                min="1"
                max="10000"
                value={account.dailyLimit}
                disabled={robot}
                onChange={(e) => {
                  const limit = Number(e.target.value);
                  if (Number.isFinite(limit) && limit >= 1 && limit <= 10000)
                    setAccount((a) =>
                      settle({ ...a, dailyLimit: limit }, quotes),
                    );
                }}
              />
              <p>
                Kerugian hari ini:{" "}
                {loss === undefined ? "Menunggu" : `$${fmt(loss)}`} / $
                {fmt(account.dailyLimit)}
                {riskBlocked ? " · Robot terkunci" : ""}
              </p>
              <button
                className={robot ? "robot-running" : ""}
                disabled={
                  !robot &&
                  (!matchingFeed ||
                    loading ||
                    !!error ||
                    !!feedPause ||
                    riskBlocked ||
                    !orderPrice)
                }
                onClick={() => setRobot(!robot)}
              >
                <span className="status-dot" />
                {robot ? "Hentikan robot" : "Jalankan robot simulasi"}
                <Activity size={14} />
              </button>
              <button className="emergency" onClick={emergency}>
                Emergency stop · tutup semua
              </button>
              <small>
                Emergency stop hanya untuk akun paper {accountLabel}.
              </small>
              {account.emergency && (
                <button
                  onClick={() =>
                    setAccount((a) => ({ ...a, emergency: false }))
                  }
                  disabled={positions.length > 0}
                >
                  Buka kunci manual (robot tetap berhenti)
                </button>
              )}
            </div>
          </aside>
          <section className="positions panel">
            <div className="pnl-strip">
              <div>
                Floating P&L{" "}
                <strong className={(floating ?? 0) >= 0 ? "green" : "red"}>
                  {floating === undefined ? "Menunggu" : `$${fmt(floating)}`}
                </strong>
              </div>
              <div>
                Equity{" "}
                <strong>
                  {equity === undefined ? "Menunggu" : `$${fmt(equity)}`}
                </strong>
              </div>
              <small>
                {!matchingFeed ||
                positions.some((p) => mark(p, quotes) === undefined)
                  ? "Menunggu feed akun yang sesuai · P&L / equity belum dinilai"
                  : `${accountLabel} · ${account.source.kind === "EXNESS_LIVE" ? "Mark Bid tick broker" : account.source.kind === "EXNESS" ? "Mark M5 history, bukan tick real-time" : "Mark DEMO"}`}
              </small>
            </div>
            {storageError && (
              <p role="alert" className="red storage-alert">
                Penyimpanan tidak tersedia. Perubahan hanya tersimpan pada tab
                ini.
              </p>
            )}
            <div className="position-tabs">
              {["Posisi", "Riwayat"].map((t) => (
                <button
                  key={t}
                  className={tab === t ? "tab-active" : ""}
                  onClick={() => setTab(t)}
                >
                  {t}{" "}
                  <span>
                    {t === "Posisi" ? positions.length : history.length}
                  </span>
                </button>
              ))}
              <span className="muted">Paper {accountLabel}</span>
            </div>
            <div className="trade-list">
              <div className="trade-heading">
                <span>INSTRUMEN / ARAH</span>
                <span>VOLUME / MASUK</span>
                <span>SL / TP</span>
                <span>P&L (USD)</span>
                <span>AKSI / EXIT</span>
              </div>
              {(tab === "Posisi" ? positions : history).map((row) => {
                const p: Position | Closed = row;
                const done = (p: Position | Closed): p is Closed =>
                  "closedAt" in p;
                const value = done(p) ? p.pnl : pnl(p, quotes);
                return (
                  <article className="trade-card" key={p.id}>
                    <div>
                      <strong>{p.symbol}</strong>
                      <small className={p.side === "Buy" ? "green" : "red"}>
                        {p.side} · {done(p) ? "Ditutup" : "Terbuka"}
                      </small>
                      <small>
                        {new Date(p.openedAt).toLocaleString("id-ID")}
                      </small>
                    </div>
                    <div>
                      <span>{p.size} lot</span>
                      <small>Masuk {fmt(p.entry)}</small>
                    </div>
                    <div>
                      <small>SL {p.sl ? fmt(p.sl) : "—"}</small>
                      <small>TP {p.tp ? fmt(p.tp) : "—"}</small>
                    </div>
                    <div>
                      <strong className={(value ?? 0) >= 0 ? "green" : "red"}>
                        {value === undefined ? "Menunggu" : `$${fmt(value)}`}
                      </strong>
                      <small>{done(p) ? p.reason : "Floating P&L"}</small>
                    </div>
                    <div>
                      {done(p) ? (
                        <>
                          <span>Exit {fmt(p.exit)}</span>
                          <small>
                            {new Date(p.closedAt).toLocaleString("id-ID")}
                          </small>
                        </>
                      ) : (
                        <button
                          disabled={
                            mark(p, quotes) === undefined || !matchingFeed
                          }
                          onClick={() =>
                            setAccount((a) =>
                              settle(close(a, p.id, quotes), quotes),
                            )
                          }
                        >
                          Tutup
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
              {(tab === "Posisi" ? positions : history).length === 0 && (
                <div className="empty">
                  <Layers size={23} />
                  <strong>
                    {tab === "Posisi"
                      ? "Belum ada posisi terbuka"
                      : "Belum ada riwayat transaksi"}
                  </strong>
                  <span>Paper trading tersimpan di perangkat ini.</span>
                </div>
              )}
            </div>
          </section>
          <section id="markets" className="watchlist panel">
            <div className="panel-title">
              <h2>Watchlist · DEMO</h2>
              <Star size={15} className="muted" />
            </div>
            <input
              className="search"
              aria-label="Cari market"
              placeholder="Cari instrumen…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="watch-head">
              <span>SIMBOL / NAMA</span>
              <span>HARGA / 24H</span>
            </div>
            {markets
              .filter((m) =>
                (m.symbol + " " + m.name)
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((m) => (
                <button
                  className={`watch-row ${symbol === m.symbol ? "watch-selected" : ""}`}
                  key={m.symbol}
                  onClick={() => setSymbol(m.symbol)}
                >
                  <div
                    className={`coin ${m.symbol === "XAUUSD" ? "gold" : ""}`}
                  >
                    {m.symbol === "XAUUSD" ? "Au" : m.symbol.slice(0, 1)}
                  </div>
                  <div>
                    <strong>{m.symbol}</strong>
                    <small>{m.name}</small>
                  </div>
                  <div className="watch-price">
                    <strong>{fmt(m.price)}</strong>
                    <small className={m.change > 0 ? "green" : "red"}>
                      {m.change > 0 ? "+" : ""}
                      {m.change.toFixed(2)}%
                    </small>
                  </div>
                </button>
              ))}
            <div className="watch-note">Snapshot demo · bukan kuotasi live</div>
          </section>
        </main>
        <footer>
          <span>
            <i /> Semua sistem simulasi operasional
          </span>
          <span>
            <ShieldCheck size={12} /> Live trading dinonaktifkan
          </span>
          <span>
            NEXUS TERMINAL <small>v5.0</small>
          </span>
        </footer>
      </div>
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button aria-label="Tutup notifikasi" onClick={() => setNotice("")}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Suspense fallback={<p role="status">Memuat workspace…</p>}>
      {location.pathname === "/accounts" ? (
        <AccountManagement />
      ) : location.pathname === "/backtest" ? (
        <Backtest />
      ) : (
        <App />
      )}
    </React.Suspense>
  </React.StrictMode>,
);
