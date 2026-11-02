import { useEffect, useRef, useState } from "react";
import {
  backtest,
  defaults,
  strategySchema,
  type Strategy,
  type BacktestResult,
  type Segment,
  type BacktestSymbol,
} from "./backtest";
import { loadHistory } from "./backtest-loader";
import { accountKey } from "./paper";
import "./backtest.css";
const money = (v: number) =>
  v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
function Curve({ segment }: { segment: Segment }) {
  const points = segment.curve;
  const min = Math.min(...points.map((p) => p.equity)),
    max = Math.max(...points.map((p) => p.equity));
  const path = points
    .map(
      (p, i) =>
        `${(i / (points.length - 1 || 1)) * 700},${180 - ((p.equity - min) / (max - min || 1)) * 160}`,
    )
    .join(" ");
  return (
    <figure className="equity-chart">
      <svg
        viewBox="0 0 700 200"
        role="img"
        aria-label="Equity curve pada penutupan candle"
      >
        <line x1="0" x2="700" y1="180" y2="180" stroke="#344154" />
        <polyline points={path} fill="none" stroke="#26c6a0" strokeWidth="2" />
      </svg>
      <figcaption>
        Equity close-to-close · {money(min)} – {money(max)} ·{" "}
        {new Date(points[0].time * 1000).toLocaleDateString("id-ID")} →{" "}
        {new Date(points.at(-1)!.time * 1000).toLocaleDateString("id-ID")}
      </figcaption>
    </figure>
  );
}
function Report({ segment, title }: { segment: Segment; title: string }) {
  return (
    <section className="bt-report panel">
      <h2>{title}</h2>
      <div className="bt-metrics">
        {[
          ["Net P&L", money(segment.net)],
          ["Win rate", `${segment.winRate.toFixed(1)}%`],
          [
            "Profit factor",
            segment.profitFactor === null
              ? "N/A (tanpa loss)"
              : segment.profitFactor.toFixed(2),
          ],
          [
            "Max drawdown",
            `${money(segment.drawdown)} · ${segment.drawdownPct.toFixed(2)}%`,
          ],
          ["Transaksi", String(segment.count)],
        ].map(([label, value]) => (
          <div key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <Curve segment={segment} />
      <details>
        <summary>Riwayat {segment.count} transaksi simulasi</summary>
        <div className="bt-trades">
          {segment.trades.map((t, i) => (
            <article key={i}>
              <strong>
                {t.side} · {t.reason}
                {t.ambiguous ? " · SL first" : ""}
              </strong>
              <span>
                {new Date(t.entryTime * 1000).toLocaleString("id-ID")} →{" "}
                {new Date(t.exitTime * 1000).toLocaleString("id-ID")}
              </span>
              <span>
                Entry {t.entry.toFixed(5)} · exit {t.exit.toFixed(5)} ·{" "}
                {t.lots.toFixed(4)} lot
              </span>
              <span>
                {money(t.pnl)} net · komisi {money(t.fees)}
              </span>
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}
const fields: { key: keyof Strategy; label: string; step?: string }[] = [
  { key: "fast", label: "EMA cepat" },
  { key: "slow", label: "EMA lambat" },
  { key: "rsiPeriod", label: "RSI period" },
  { key: "longRsi", label: "RSI minimum long" },
  { key: "shortRsi", label: "RSI maksimum short" },
  { key: "stopPct", label: "Stop Loss (%)", step: "0.1" },
  { key: "takePct", label: "Take Profit (%)", step: "0.1" },
  { key: "riskPct", label: "Risiko per transaksi (%)", step: "0.1" },
  { key: "spread", label: "Spread (unit harga)", step: "any" },
  { key: "slippage", label: "Slippage per fill (unit harga)", step: "any" },
  { key: "commission", label: "Komisi USD / lot / sisi", step: "0.1" },
  { key: "capital", label: "Modal backtest (USD)" },
  { key: "trainPct", label: "In-sample (%)" },
];
export function Backtest() {
  const [mode, setMode] = useState<"DEMO" | "EXNESS">("DEMO"),
    [symbol, setSymbol] = useState<BacktestSymbol>("XAUUSD"),
    [interval, setIntervalValue] = useState(3600),
    [slots, setSlots] = useState(720),
    [params, setParams] = useState<Strategy>(defaults),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState(""),
    [result, setResult] = useState<BacktestResult | null>(null),
    [excluded, setExcluded] = useState(0);
  const [reports, setReports] = useState<BacktestResult[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function clear() {
    controller.current?.abort();
    setResult(null);
    setError("");
    setBusy(false);
    setProgress(0);
  }
  async function run() {
    const parsed = strategySchema.safeParse(params);
    if (!parsed.success) {
      setError(
        "Parameter tidak valid. EMA cepat < lambat; RSI short ≤ long. Risiko 0.1–5%, SL 0.1–10%, TP 0.1–20%, in-sample 50–90%.",
      );
      return;
    }
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError("");
    setResult(null);
    setProgress(0);
    try {
      const history = await loadHistory(
        mode,
        symbol,
        interval,
        slots,
        c.signal,
        (n) => {
          if (!c.signal.aborted) setProgress(n);
        },
      );
      if (c.signal.aborted) return;
      const report = backtest(
        history.bars,
        symbol,
        interval,
        parsed.data,
        history.source,
      );
      if (history.bars.length < slots)
        report.warnings.push(
          `Diperoleh ${history.bars.length} candle untuk ${slots} interval kalender; gap atau batas history dapat mengurangi jumlah.`,
        );
      if (history.emptyWindows)
        report.warnings.push(
          `${history.emptyWindows} jendela historis kosong dilaporkan sebagai gap; tidak ada harga atau candle yang dibuat.`,
        );
      setResult(report);
      setExcluded(history.excluded);
      setReports((previous) => [report, ...previous].slice(0, 8));
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : "BACKTEST_FAILED");
    } finally {
      if (controller.current === c) setBusy(false);
    }
  }
  return (
    <main className="backtest-page">
      <header className="bt-header">
        <a className="logo" href="/">
          NEXUS <span>V4 / BACKTEST</span>
        </a>
        <nav>
          <a href="/">Terminal</a>
          <a href="/accounts">Accounts</a>
          <a href="/backtest" aria-current="page">
            Backtest
          </a>
        </nav>
      </header>
      <section className="bt-intro">
        <span className="badge">SIMULATION ONLY · read-only</span>
        <h1>Strategy Lab</h1>
        <p>
          EMA crossover 9/21 + RSI 14. Uji asumsi sebelum mengambil keputusan.
        </p>
        <p>
          Backtest terpisah dari akun paper: tidak mengubah saldo, posisi,
          riwayat, atau robot. Tidak ada live order maupun robot server-side.
        </p>
      </section>
      <section className="panel bt-config">
        <h2>Data & strategi</h2>
        <div className="bt-grid">
          <label>
            Sumber data
            <select
              aria-label="Sumber data"
              value={mode}
              onChange={(e) => {
                clear();
                setMode(e.target.value as typeof mode);
              }}
            >
              <option value="DEMO">DEMO · sintetis publik</option>
              <option value="EXNESS">EXNESS · history akun terpilih</option>
            </select>
          </label>
          <label>
            Instrumen
            <select
              aria-label="Instrumen"
              value={symbol}
              onChange={(e) => {
                clear();
                const value = e.target.value as BacktestSymbol;
                setSymbol(value);
                setParams((p) => ({
                  ...p,
                  spread:
                    value === "EURUSD" ? 0.0001 : value === "BTCUSD" ? 10 : 0.3,
                  slippage:
                    value === "EURUSD" ? 0.00005 : value === "BTCUSD" ? 2 : 0.1,
                }));
              }}
            >
              {["XAUUSD", "EURUSD", "BTCUSD"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Timeframe
            <select
              aria-label="Timeframe"
              value={interval}
              onChange={(e) => {
                clear();
                setIntervalValue(Number(e.target.value));
              }}
            >
              {[
                [300, "M5"],
                [900, "M15"],
                [3600, "H1"],
                [14400, "H4"],
                [86400, "D1"],
              ].map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Jendela interval tertutup
            <select
              aria-label="Jendela interval tertutup"
              value={slots}
              onChange={(e) => {
                clear();
                setSlots(Number(e.target.value));
              }}
            >
              {[180, 360, 720, 1440, 2160].map((n) => (
                <option key={n} value={n}>
                  {n} interval kalender
                </option>
              ))}
            </select>
          </label>
          {fields.map((f) => (
            <label key={f.key}>
              {f.label}
              <input
                type="number"
                step={f.step ?? "1"}
                value={params[f.key]}
                disabled={busy}
                onChange={(e) => {
                  setResult(null);
                  setParams((p) => ({ ...p, [f.key]: Number(e.target.value) }));
                }}
              />
            </label>
          ))}
        </div>
        <div className="bt-assumptions">
          <h3>Asumsi eksekusi simulasi</h3>
          <p>
            Sinyal memakai candle tertutup; entry pada open candle berikutnya.
            Long membeli pada bid + spread + slippage; short menjual pada bid −
            slippage. Exit short memakai ask (bid + spread). Komisi dikenakan
            pada kedua sisi. Spread dan slippage tetap, bukan biaya akun Exness
            yang terverifikasi.
          </p>
          <p>
            SL/TP berbasis persentase harga entry. Jika keduanya tersentuh, SL
            lebih dulu; gap melewati SL diisi pada open yang lebih buruk
            ditambah slippage. TP diisi pada target tanpa keuntungan gap. OHLC
            tidak mengungkap urutan intrabar. Maksimal satu posisi dan 10 lot;
            sizing memperhitungkan risiko SL dan estimasi biaya pulang-pergi.
            Gap dapat menyebabkan kerugian melampaui anggaran risiko.
          </p>
          <p>
            Drawdown dihitung dari equity penutupan candle, bukan tick intrabar.
            Tidak memodelkan margin, likuidasi, swap, latensi, maupun perubahan
            biaya. Tiap segmen memakai modal awal sendiri, posisi ditutup di
            akhir segmen; indikator OOS hanya memakai data sebelumnya untuk
            warmup. Parameter tidak dioptimasi otomatis. Bukan jaminan hasil
            trading.
          </p>
        </div>
        <div className="bt-actions">
          <button className="submit-order" disabled={busy} onClick={run}>
            {busy ? `Memuat ${progress} interval…` : "Jalankan backtest"}
          </button>
          {busy && <button onClick={clear}>Batalkan</button>}
        </div>
        {mode === "EXNESS" && (
          <p>
            Memerlukan login dan akun read-only terpilih di{" "}
            <a href="/accounts">Accounts</a>. Tidak ada form kredensial di
            halaman ini. Maksimal 12 halaman / 60 detik; rate limit menghentikan
            proses tanpa retry otomatis.
          </p>
        )}
        {error && (
          <p role="alert" className="red">
            {error}
          </p>
        )}
      </section>
      {result && (
        <section aria-label="Laporan backtest">
          <div className="bt-result-heading">
            <h2>
              {result.source.kind}{" "}
              {result.source.kind === "EXNESS"
                ? `· koneksi ${result.source.connectionId.slice(0, 8)} · HISTORY, bukan tick real-time`
                : "· data sintetis"}
            </h2>
            <p>
              {result.symbol} · {result.barCount} candle tertutup · batas OOS{" "}
              {new Date(result.splitTime * 1000).toLocaleString("id-ID")} ·
              boundary dikecualikan: {excluded}
            </p>
          </div>
          {result.warnings.map((w) => (
            <p className="bt-warning" key={w}>
              {w}
            </p>
          ))}
          <div className="bt-segments">
            <Report title="In-sample" segment={result.inSample} />
            <Report title="Out-of-sample" segment={result.outSample} />
          </div>
        </section>
      )}
      {reports.length > 0 && (
        <section className="panel bt-config">
          <h2>Hasil sesi ini · terpisah per sumber</h2>
          <p>
            Hanya di memori halaman; tidak disimpan ke akun paper atau
            localStorage.
          </p>
          {reports.map((r, i) => (
            <p key={i}>
              {accountKey(r.source)} · {r.symbol} · {r.barCount} candle · OOS{" "}
              {money(r.outSample.net)}
            </p>
          ))}
        </section>
      )}
    </main>
  );
}
