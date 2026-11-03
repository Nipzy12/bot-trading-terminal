#!/usr/bin/env node
// NEXUS V6.1 Windows heartbeat-only engine. No broker keys, market stream or orders.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const origin = "https://bot-trading-terminal.vercel.app";
const relayTest = process.argv.includes("--relay-test");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stopped = false;
process.on("SIGINT", () => { stopped = true; console.log("\nNEXUS Engine dihentikan."); });
process.on("SIGTERM", () => { stopped = true; });

async function send(path, body, token) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
    redirect: "error",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("HTTP_" + response.status);
    error.status = response.status;
    throw error;
  }
  return result;
}
console.log(relayTest ? "NEXUS Engine V6.2A · RELAY TEST ONLY" : "NEXUS Engine V6.1 · HEARTBEAT ONLY");
if (relayTest) console.log("Data XAUUSD adalah FIXTURE SIMULASI, bukan Exness. Tidak dipakai untuk trading.");
console.log("Semua broker order dinonaktifkan; tidak ada Exness API key di laptop.");
console.log("Buka https://bot-trading-terminal.vercel.app/accounts di browser, login Sesi NEXUS, lalu buat kode pairing.");
const io = createInterface({ input: stdin, output: stdout });
let code;
try { code = (await io.question("Tempel kode pairing (berlaku 5 menit): ")).trim(); }
finally { io.close(); }
if (!/^[A-Za-z0-9_-]{32}$/.test(code)) {
  console.error("Format kode pairing tidak valid."); process.exitCode = 1;
} else {
  try {
    const paired = await send("/api/engine/pair", { code });
    code = "";
    if (typeof paired.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(paired.token)) throw Error("INVALID_PAIR_RESPONSE");
    const token = paired.token; // Memory only. Never write to disk, stdout or environment.
    console.log("Pairing berhasil. Kirim heartbeat tiap 10 detik. Tekan Ctrl+C untuk berhenti.");
    let failures = 0;
    while (!stopped) {
      try {
        await send("/api/engine/heartbeat", {}, token);
        if (failures) console.log("Koneksi pulih.");
        failures = 0;
        if (relayTest) {
          try {
            await send("/api/engine/relay-test", {
              mode: "TEST_ONLY", symbol: "XAUUSD", bid: 2742.68, ask: 2742.92,
              at: new Date().toISOString(),
            }, token);
            console.log("Relay uji diterima · sumber TEST_ONLY (bukan Exness).");
          } catch (error) {
            console.error("Relay uji ditolak (" + (error.status ?? "NETWORK") + "). Tidak memengaruhi heartbeat.");
            if ([401, 403, 429].includes(error.status)) {
              console.error("Relay dibatasi; hentikan mode uji.");
              break;
            }
          }
        }
        console.log("NEXUS Engine ONLINE · " + new Date().toLocaleTimeString("id-ID"));
      } catch (error) {
        failures++;
        const status = error.status ?? "NETWORK";
        console.error("Heartbeat gagal (" + status + "); status mungkin OFFLINE.");
        if (status === 401 || status === 403) { console.error("Pairing dicabut; jalankan ulang dan pairing lagi."); break; }
        if (status === 429) { console.error("Batas permintaan; berhenti agar tidak mengulang terus."); break; }
      }
      if (!stopped) await sleep(10_000);
    }
  } catch (error) {
    console.error("Tidak dapat pairing: " + (error.status ?? "NETWORK_OR_CONFIG") + ". Cek login, kode, jaringan dan deployment V6.1.");
    process.exitCode = 1;
  }
}
