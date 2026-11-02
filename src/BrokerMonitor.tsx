import { useEffect, useRef, useState } from "react";
import {
  brokerSnapshot,
  formatBrokerDecimal,
  type BrokerSnapshot,
} from "./broker-monitor";
export function BrokerMonitor() {
  const [data, setData] = useState<BrokerSnapshot | null>(null),
    [status, setStatus] = useState("UNAVAILABLE"),
    [busy, setBusy] = useState(false),
    [until, setUntil] = useState(0),
    [clock, setClock] = useState(Date.now());
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const clear = () => {
      request.current?.abort();
      setData(null);
      setStatus("UNAVAILABLE");
      setBusy(false);
    };
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("nexus-account-change")
        : null;
    channel?.addEventListener("message", clear);
    const hidden = () => {
      if (document.hidden) clear();
    };
    window.addEventListener("focus", clear);
    document.addEventListener("visibilitychange", hidden);
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      request.current?.abort();
      channel?.close();
      clearInterval(timer);
      window.removeEventListener("focus", clear);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  async function refresh() {
    if (busy || Date.now() < until) return;
    request.current?.abort();
    const c = new AbortController();
    request.current = c;
    setData(null);
    setBusy(true);
    setStatus("LOADING");
    try {
      const response = await fetch("/api/account/monitor", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(10000)]),
      });
      if (c.signal.aborted) return;
      if (!response.ok) {
        const retry = Number(response.headers.get("Retry-After"));
        if (
          response.status === 429 &&
          Number.isFinite(retry) &&
          retry > 0 &&
          retry <= 86400
        )
          setUntil(Date.now() + Math.ceil(retry) * 1000);
        throw Error("UNAVAILABLE");
      }
      const parsed = brokerSnapshot.safeParse(await response.json());
      if (!parsed.success || Date.parse(parsed.data.asOf) > Date.now() + 2000)
        throw Error("UNAVAILABLE");
      if (!c.signal.aborted) {
        setData(parsed.data);
        setStatus("SNAPSHOT");
        setClock(Date.now());
      }
    } catch {
      if (!c.signal.aborted) {
        setData(null);
        setStatus("UNAVAILABLE");
      }
    } finally {
      if (request.current === c) setBusy(false);
    }
  }
  const stale = data && clock - Date.parse(data.asOf) > 30000,
    remaining = Math.max(0, Math.ceil((until - clock) / 1000));
  return (
    <div
      className="metric broker-monitor"
      aria-label="EXNESS DEMO ACCOUNT MONITOR"
    >
      <span>EXNESS DEMO · Saldo Broker</span>
      <strong>{data ? formatBrokerDecimal(data.balance) : "—"}</strong>
      <small>
        {data?.currency ?? "Currency belum tersedia"} ·{" "}
        {stale ? "STALE" : status}
      </small>
      {data && (
        <>
          <small>Equity: {formatBrokerDecimal(data.equity)}</small>
          <small>Used margin: {formatBrokerDecimal(data.used_margin)}</small>
          <small>
            Snapshot diterima {new Date(data.asOf).toLocaleString("id-ID")}
          </small>
        </>
      )}
      <button disabled={busy || remaining > 0} onClick={refresh}>
        {busy
          ? "Memuat saldo…"
          : remaining > 0
            ? `Cooldown ${remaining} detik`
            : "Refresh saldo broker"}
      </button>
      <small>
        Read-only · bukan saldo paper. Akun terpilih; tipe Demo/Riil tidak
        diverifikasi dari respons ini.
      </small>
    </div>
  );
}
