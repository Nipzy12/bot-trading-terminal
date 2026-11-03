import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { ExnessReader, signedHeaders, loadKey } from "../server/exness.js";
import { secureTransport, resolveHost } from "../server/ssrf.js";
import { EXNESS_WS_PROTOCOL, pinnedTlsOptions } from "../server/live-network.js";
import { acceptLocalProbeFrame, localConfigSchema,
  localTicksUrl, safeLocalBrokerOrigin, LOCAL_PROBE_LIMIT_MS } from "./local-probe-core.js";

const script = fileURLToPath(new URL("./windows-credentials.ps1", import.meta.url));
type Action = "setup" | "read" | "status" | "forget";
function runVault(action: Exclude<Action, "read">) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("powershell.exe",
      ["-NoProfile", "-File", script, "-Action", action],
      { stdio: "inherit", windowsHide: false });
    child.once("error", () => reject(Error("POWERSHELL_UNAVAILABLE")));
    child.once("close", code => resolve(code ?? 1));
  });
}
function readVault(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let output = "";
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      if (error) reject(error);
      else {
        try { resolve(JSON.parse(output)); }
        catch { reject(Error("INVALID_LOCAL_VAULT")); }
      }
      output = "";
    };
    const child = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", script, "-Action", "read"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, signal });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 12_000) {
        child.kill();
        finish(Error("INVALID_LOCAL_VAULT"));
      }
    });
    child.once("error", () => finish(Error("VAULT_READ_FAILED")));
    child.once("close", code => finish(code === 0 ? undefined : Error("VAULT_READ_FAILED")));
  });
}
function withinDeadline<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(Error("PROBE_STOPPED"));
  return new Promise<T>((resolve, reject) => {
    const fail = () => reject(Error("PROBE_STOPPED"));
    signal.addEventListener("abort", fail, { once: true });
    job.then(resolve, reject).finally(() => signal.removeEventListener("abort", fail));
  });
}
async function openProbe(signal: AbortSignal) {
  // Deadline includes vault read, REST bootstrap, DNS, TLS, subscription and
  // data collection, unlike the rejected V6.2B implementation.
  const source = localConfigSchema.parse(await readVault(signal));
  const gateway = safeLocalBrokerOrigin(source.gateway);
  const config = { ...source, gateway };
  // Fail locally if the Ed25519 secret has an invalid format/keypair.
  const key = loadKey(config.privateKey);
  const reader = new ExnessReader(config, secureTransport);
  const prepared = await withinDeadline(reader.prepareLive("XAUUSD"), signal);
  const endpoint = localTicksUrl(prepared.host, prepared.path, source.accountId);
  const host = new URL(endpoint).hostname;
  const addresses = await withinDeadline(resolveHost(host), signal);
  if (signal.aborted) throw Error("PROBE_STOPPED");
  const requestId = randomUUID();
  const subscription = JSON.stringify({ id: requestId,
    subscribe: { event: "ticks", instruments: [prepared.instrument] } });
  if (Buffer.byteLength(subscription) > prepared.maxMessageBytes)
    throw Error("SUBSCRIPTION_TOO_LARGE");
  const headers = signedHeaders(config.apiKey, key, prepared.path);
  const ws = new WebSocket(endpoint, EXNESS_WS_PROTOCOL, {
    headers, perMessageDeflate: false, followRedirects: false,
    rejectUnauthorized: true, maxPayload: 16384,
    handshakeTimeout: 6000,
    ...pinnedTlsOptions(host, addresses, () => {}),
  });
  return new Promise<{ status: string; ticks: number }>(resolve => {
    let done = false, ticks = 0, last = 0;
    const finish = (status: string) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      try { ws.terminate(); } catch { /* no raw upstream errors */ }
      resolve({ status, ticks });
    };
    const abort = () => finish(signal.reason === "USER_STOP" ? "STOPPED" : "TIME_LIMIT");
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    ws.on("open", () => {
      if (signal.aborted) { abort(); return; }
      console.log("Exness socket OPEN. Menunggu tick terverifikasi; tidak mencetak harga atau header.");
      ws.send(subscription, error => { if (error) finish("SUBSCRIPTION_FAILED"); });
    });
    ws.on("message", bytes => {
      if (done || signal.aborted || Buffer.byteLength(bytes as Buffer) > 16384) return;
      try {
        const frame = acceptLocalProbeFrame(JSON.parse(bytes.toString()), {
          subscriptionId: requestId, accountId: config.accountId,
          instrument: prepared.instrument, connectionId: randomUUID(),
          symbol: "XAUUSD", last,
        });
        if (frame.kind === "subscription_error") {
          finish("BROKER_SUBSCRIPTION_REJECTED"); return;
        }
        if (frame.kind === "account_mismatch" || frame.kind === "unknown") {
          finish("BROKER_FRAME_UNVERIFIED"); return;
        }
        if (frame.kind !== "tick") return;
        last = frame.tick.time;
        ticks++;
        if (ticks === 1 || ticks % 10 === 0)
          console.log("Tick Exness valid:", ticks, "(harga tidak ditampilkan)");
      } catch { finish("BROKER_FRAME_UNVERIFIED"); }
    });
    ws.on("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      response.resume();
      finish(status === 429 ? "EXNESS_RATE_LIMIT" : status === 401 || status === 403
        ? "EXNESS_AUTH_OR_SCOPE" : "WS_HTTP_REJECTED");
    });
    ws.on("error", () => finish("TLS_OR_NETWORK_FAILED"));
    ws.on("close", () => finish("SOCKET_CLOSED"));
  });
}

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== "win32") {
    console.error("WINDOWS_ONLY"); return 1;
  }
  const action = args[0];
  if (args.length !== 1 || !["setup", "status", "forget", "probe"].includes(action)) {
    console.log("Pilihan: npm run engine:local:setup | engine:local:status | engine:local:probe | engine:local:forget");
    return 1;
  }
  if (action !== "probe") return runVault(action as Exclude<Action, "read">);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("TIME_LIMIT"), LOCAL_PROBE_LIMIT_MS);
  const stop = () => controller.abort("USER_STOP");
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  console.log("NEXUS V6.2C · LOCAL EXNESS READ-ONLY PROBE · 65s maximum");
  console.log("Hanya GET dan subscribe ticks XAUUSD. Tidak ada relay, robot atau broker order.");
  try {
    const result = await withinDeadline(openProbe(controller.signal), controller.signal);
    console.log("Probe:", result.status, "| tick valid:", result.ticks);
    return result.ticks > 0 ? 0 : 1;
  } catch {
    console.error(controller.signal.aborted ? "PROBE_STOPPED_OR_TIME_LIMIT"
      : "PROBE_FAILED: periksa vault, read-only scope, gateway, TLS, dan kuota broker.");
    return 1;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
}
if (process.argv[1] &&
    fileURLToPath(import.meta.url).toLowerCase() ===
    fileURLToPath(new URL("file:///" + process.argv[1].replaceAll("\\", "/"))).toLowerCase()) {
  main().then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
}
