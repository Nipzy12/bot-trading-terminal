import { useEffect, useState } from "react";

type RelayTestStatus = {
  source: "TEST_ONLY"; fresh: boolean; symbol: string | null;
  bid: number | null; ask: number | null; sampledAt?: string;
};
type EngineStatus = {
  status: "ONLINE" | "OFFLINE" | "UNPAIRED";
  label: string | null;
  lastSeenAt: string | null;
};
export function EnginePanel({ csrfToken }: { csrfToken: string }) {
  const [state, setState] = useState<EngineStatus | null>(null);
  const [relay, setRelay] = useState<RelayTestStatus | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const response = await fetch("/api/account/engine/status", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw Error("Status engine tidak tersedia.");
    setState(await response.json());
  }
  useEffect(() => {
    let active = true;
    async function check() {
      try {
        const r = await fetch("/api/account/engine/status", { credentials: "same-origin", cache: "no-store" });
        if (r.ok && active) setState(await r.json());
        const q = await fetch("/api/account/engine/relay-test", { credentials: "same-origin", cache: "no-store" });
        if (active) setRelay(q.ok ? await q.json() : null);
      } catch { /* Offline can be displayed on next poll. */ }
    }
    void check();
    const timer = window.setInterval(check, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [csrfToken]);

  async function mutate(path: string) {
    setBusy(true); setMessage("");
    try {
      const r = await fetch("/api/account/engine/" + path, {
        method: "POST", credentials: "same-origin",
        headers: { "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(data.error === "RATE_LIMITED" ? "Batas pairing tercapai. Coba nanti." : "Permintaan ditolak, periksa sesi NEXUS.");
      if (path === "pair-code") {
        if (typeof data.code !== "string") throw Error("Kode pairing tidak tersedia.");
        setCode(data.code);
        setMessage("Kode ini hanya berlaku 5 menit dan hanya bisa dipakai sekali. Jangan dibagikan.");
      } else {
        setCode(""); setMessage("Pairing dibatalkan dan akses engine dicabut.");
      }
      await refresh();
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel account-box" aria-label="NEXUS Engine Windows">
      <h2>NEXUS Engine · Windows</h2>
      <p>Pair laptop untuk mengirim heartbeat. Belum ada koneksi Exness atau robot lokal pada tahap V6.1.</p>
      <p role="status">
        Status: <strong className={state?.status === "ONLINE" ? "green" : "muted"}>{state?.status ?? "MEMERIKSA"}</strong>
        {state?.lastSeenAt ? " · Terakhir: " + new Date(state.lastSeenAt).toLocaleString("id-ID") : ""}
      </p>
      <div className="connection-actions">
        <button disabled={busy} className="primary" onClick={() => void mutate("pair-code")}>Buat kode pairing laptop</button>
        <button disabled={busy || state?.status === "UNPAIRED"} onClick={() => void mutate("revoke")}>Cabut akses laptop</button>
      </div>
      {code && <p>Kode sekali pakai: <code style={{ userSelect: "all", fontWeight: 700, overflowWrap: "anywhere" }}>{code}</code></p>}
      {message && <p role="status">{message}</p>}
      <p>Mode default laptop tetap heartbeat saja: <code>node engine/index.mjs</code>.</p>
      <p><strong>Uji relay V6.2A (opsional):</strong> hentikan engine lama dengan Ctrl+C, lalu mulai ulang dengan <code>node engine/index.mjs --relay-test</code> dan kode pairing baru.</p>
      <p role="status">Relay laptop: <strong>{relay?.fresh ? "TEST ONLY · FRESH" : "BELUM ADA DATA UJI / STALE"}</strong></p>
      {relay?.fresh && relay.symbol && relay.bid !== null && relay.ask !== null && (
        <p>{relay.symbol} · Bid {relay.bid.toFixed(2)} · Ask {relay.ask.toFixed(2)} · <strong>SIMULASI, BUKAN EXNESS</strong></p>
      )}
      <p>Relay TEST_ONLY tidak mengubah chart, saldo, P&L, harga order, atau robot.</p>
      <p><strong>V6.2B · Broker probe terbatas:</strong> setelah pembaruan dan pairing baru, jalankan <code>node engine/index.mjs --broker-probe</code> di laptop. Mode ini membuka koneksi WebSocket Exness selama maksimal 65 detik, menampilkan hanya jumlah tick valid, dan tidak mengirim kuotasi ke website. Token signed GET sementara diteruskan ke laptop untuk handshake; jangan merekam log/traffic saat probe.</p>
    </section>
  );
}
