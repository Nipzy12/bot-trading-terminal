import tls from "node:tls";
import type { LookupAddress } from "node:dns";
import {
  brokerStatuses,
  networkCodes,
  liveDiagnostic,
  networkStages,
  preflightCodes,
  type NetworkPhase,
} from "../src/live-diagnostics.js";
export type { NetworkPhase } from "../src/live-diagnostics.js";
// Official TypeScript signed-WebSocket helper uses this subprotocol and no compression.
export const EXNESS_WS_PROTOCOL = "exness-ws-protocol";

// ws synthesizes several code-less handshake errors. Never inspect messages,
// causes or raw frames to guess their meaning; retain the observed phase instead.
export function networkFailure(error: unknown, phase: NetworkPhase) {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  const missing = {
    DNS: "DNS_ERROR_NO_CODE",
    TCP: "TCP_ERROR_NO_CODE",
    TLS: "TLS_ERROR_NO_CODE",
    HANDSHAKE: "WS_HANDSHAKE_ERROR_NO_CODE",
    OPEN: "WS_OPEN_ERROR_NO_CODE",
  };
  const internalCode =
    typeof candidate === "string" &&
    (networkCodes as readonly string[]).includes(candidate)
      ? candidate
      : candidate === undefined || candidate === null || candidate === ""
        ? missing[phase]
        : "NETWORK_CODE_UNCLASSIFIED";
  const stage =
    phase === "OPEN"
      ? "WS_DISCONNECTED"
      : phase === "DNS" || ["ENOTFOUND", "EAI_AGAIN"].includes(internalCode)
        ? "DNS_FAILED"
        : phase === "HANDSHAKE"
          ? "WS_HANDSHAKE_FAILED"
          : internalCode.startsWith("ERR_TLS_") ||
              internalCode.startsWith("ERR_SSL_") ||
              internalCode.includes("CERT") ||
              internalCode.includes("ISSUER") ||
              internalCode.includes("SIGNATURE") ||
              phase === "TLS"
            ? "TLS_FAILED"
            : "TCP_CONNECT_FAILED";
  return { stage, internalCode };
}

// Same object-form connection contract as ws's tlsConnect. Callers supply fresh
// SSRF-validated DNS answers; the URL host/port and TLS verification remain intact.
export function pinnedTlsOptions(
  hostname: string,
  addresses: LookupAddress[],
  phase: (phase: NetworkPhase) => void,
) {
  return {
    createConnection: ((options: tls.ConnectionOptions) => {
      const connection = tls.connect({
        ...options,
        path: undefined,
        servername: hostname,
        rejectUnauthorized: true,
      });
      connection.once("connect", () => phase("TLS"));
      connection.once("secureConnect", () => phase("HANDSHAKE"));
      return connection;
    }) as typeof import("node:net").createConnection,
    lookup: ((
      _host: string,
      options: { all?: boolean },
      cb: (...args: any[]) => void,
    ) => {
      if (options.all) cb(null, addresses);
      else cb(null, addresses[0].address, addresses[0].family);
    }) as import("node:net").LookupFunction,
  };
}

const observations = [
  ...brokerStatuses,
  ...networkStages,
  ...preflightCodes,
  "PHASE_CHANGED",
  "WS_CLOSE_OBSERVED",
  "MAX_DURATION",
  "DISCONNECTED",
  "INVALID_CLIENT_MESSAGE",
  "INVALID_RESPONSE",
  "SLOW_CLIENT",
  "AUTH_REVOKED",
  "AUTH_UNAVAILABLE",
  "EXNESS_PERMISSION_OR_UNAVAILABLE",
] as readonly string[];
export function observeLive(stage: string, value: unknown) {
  // Build from a strict allowlist, never spread an exception, context or headers.
  console.info(
    JSON.stringify({
      event: "nexus.live",
      stage: observations.includes(stage) ? stage : "UNAVAILABLE",
      ...liveDiagnostic(value),
    }),
  );
}
