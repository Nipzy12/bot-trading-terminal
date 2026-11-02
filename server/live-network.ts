// Error messages/causes are deliberately never inspected or serialized.
import { networkCodes } from "../src/live-diagnostics.js";
export type NetworkPhase = "DNS" | "TCP" | "TLS" | "HANDSHAKE" | "OPEN";
export function networkFailure(error: unknown, phase: NetworkPhase) {
  const candidate =
    error && typeof error === "object" && "code" in error ? error.code : "";
  const internalCode =
    typeof candidate === "string" &&
    (networkCodes as readonly string[]).includes(candidate)
      ? candidate
      : "NETWORK_ERROR";
  const stage =
    phase === "OPEN"
      ? "WS_DISCONNECTED"
      : phase === "DNS" || ["ENOTFOUND", "EAI_AGAIN"].includes(internalCode)
        ? "DNS_FAILED"
        : internalCode.startsWith("ERR_TLS_") ||
            internalCode.startsWith("ERR_SSL_") ||
            internalCode.includes("CERT") ||
            internalCode.includes("ISSUER") ||
            internalCode.includes("SIGNATURE") ||
            phase === "TLS"
          ? "TLS_FAILED"
          : phase === "TCP"
            ? "TCP_CONNECT_FAILED"
            : "WS_DISCONNECTED";
  return { stage, internalCode };
}
