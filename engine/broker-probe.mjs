import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { WebSocket } from "ws";

function isPublic(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === "unicast";
  } catch { return false; }
}
export function verifyBrokerProbePackage(value, now = Date.now()) {
  if (!value || typeof value !== "object" || value.kind !== "BROKER_PROBE_ONLY" ||
      value.protocol !== "exness-ws-protocol" ||
      typeof value.wsUrl !== "string" || typeof value.instrument !== "string" ||
      typeof value.signedAt !== "number" || now - value.signedAt > 15000 ||
      value.signedAt > now + 2000 || value.maxRunSeconds !== 65 ||
      typeof value.headers !== "object" || value.headers === null) throw Error("INVALID_BROKER_PROBE");
  const url = new URL(value.wsUrl);
  const allowed = ["exness.com", "exness-api.com"];
  if (url.protocol !== "wss:" || url.port || url.username || url.password ||
      url.search || url.hash || !allowed.some(s => url.hostname === s || url.hostname.endsWith("." + s)) ||
      !/^\/v1\/server-events\/accounts\/[1-9]\d{0,19}\/ws\/ticks$/.test(url.pathname) ||
      !/^[A-Za-z0-9_.:-]{1,100}$/.test(value.instrument)) throw Error("INVALID_BROKER_PROBE");
  const expected = ["EXN-API-KEY","EXN-IDEMPOTENCY-KEY","EXN-TIMESTAMP","EXN-SIGN-VERSION","EXN-DATA","EXN-SIGN"];
  if (Object.keys(value.headers).sort().join("|") !== expected.sort().join("|") ||
      value.headers["EXN-SIGN-VERSION"] !== "1" ||
      value.headers["EXN-TIMESTAMP"] !== String(value.signedAt)) throw Error("INVALID_BROKER_PROBE");
  return { url, instrument: value.instrument, headers: value.headers };
}
export async function runBrokerProbe(token, post, shouldStop = () => false) {
  const challenge = await post("/api/engine/broker/probe",
    { confirmTemporarySignedAccess: true }, token);
  const prepared = verifyBrokerProbePackage(challenge);
  const host = prepared.url.hostname;
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(v => !isPublic(v.address))) throw Error("UNSAFE_BROKER_DNS");
  let ws;
  try {
    // ws validates the hostname via TLS/SNI; DNS is pinned to validated addresses.
    ws = new WebSocket(prepared.url, "exness-ws-protocol", {
      headers: prepared.headers, perMessageDeflate: false, followRedirects: false,
      rejectUnauthorized: true, servername: host, maxPayload: 16384,
      handshakeTimeout: 6000, lookup: (_host, opts, done) => {
        if (opts.all) done(null, addresses);
        else done(null, addresses[0].address, addresses[0].family);
      },
    });
  } finally {
    // Do not retain extra references to signed headers.
    for (const key of Object.keys(challenge.headers)) delete challenge.headers[key];
  }
  return await new Promise(resolve => {
    let ticks = 0, lastTick = 0, closed = false;
    const started = Date.now();
    const finish = (status) => {
      if (closed) return;
      closed = true;
      clearInterval(check);
      try { ws.terminate(); } catch {}
      console.log("Broker probe " + status + " · tick valid " + ticks + ". Tidak ada data broker dikirim ke relay.");
      resolve({ status, ticks });
    };
    const check = setInterval(() => {
      if (shouldStop()) finish("STOPPED");
      else if (Date.now() - started >= 65_000) finish("TIME_LIMIT");
    }, 500);
    ws.on("open", () => {
      const message = JSON.stringify({ id: "windows-probe", subscribe: {
        event: "ticks", instruments: [prepared.instrument] } });
      ws.send(message, error => { if (error) finish("SUBSCRIPTION_FAILED"); });
      console.log("Broker WebSocket OPEN; menunggu tick XAUUSD. Header auth tidak ditampilkan.");
    });
    ws.on("message", bytes => {
      if (closed || bytes.length > 16384) return;
      try {
        const data = JSON.parse(bytes.toString());
        if (!data || typeof data !== "object" || Array.isArray(data) ||
          data.instrument !== prepared.instrument || typeof data.bid !== "number" ||
          typeof data.ask !== "number" || !Number.isFinite(data.bid) || !Number.isFinite(data.ask) ||
          data.bid <= 0 || data.ask < data.bid || typeof data.timestamp !== "string") return;
        const at = Date.parse(data.timestamp), now = Date.now();
        if (!Number.isFinite(at) || at <= lastTick || at > now + 2000 || now - at > 10000) return;
        lastTick = at; ticks++;
        if (ticks === 1 || ticks % 10 === 0) console.log("Broker tick valid diterima: " + ticks + " (tanpa mencetak kuotasi)");
      } catch { /* Ignore non-tick frames. */ }
    });
    ws.on("unexpected-response", (_req, resp) => { const status = resp.statusCode;
      resp.resume(); finish("HTTP_" + (status >= 400 && status < 600 ? status : "ERROR")); });
    ws.on("error", () => finish("NETWORK_OR_AUTH_ERROR"));
    ws.on("close", () => finish("CLOSED"));
  });
}
