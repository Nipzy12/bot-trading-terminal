import {
  requireLiveSession,
  revalidateLiveAccess,
} from "./live-authorization.js";
import {
  EXNESS_WS_PROTOCOL,
  pinnedTlsOptions,
  observeLive,
  networkFailure,
  type NetworkPhase,
} from "./live-network.js";
import { liveBootstrap } from "./live-cache.js";
import {
  safeCloseCode,
  rateInfo,
  type RateInfo,
} from "../src/live-diagnostics.js";
import { liveFailure } from "./live-preflight.js";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { configured, origin } from "./auth.js";
import { database, takeRate } from "./database.js";
import { decrypt } from "./vault.js";
import { productionReader } from "./accounts.js";
import {
  signedHeaders,
  loadKey,
  ProviderError,
  type Config,
} from "./exness.js";
import { safeOrigin, resolveHost } from "./ssrf.js";
import { bounded } from "./connection-test.js";
import { parseLiveFrame } from "./live-frame.js";
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
export function attachLive(server: http.Server) {
  server.on("upgrade", async (req, socket, head) => {
    let upstream: WebSocket | undefined,
      client: WebSocket | undefined,
      lease: string | undefined,
      hash: string | undefined,
      closed = false;
    let phase: NetworkPhase = "DNS";
    let upstreamOpened = false,
      subscriptionSent = false,
      // No standalone successful-ACK schema is defined by the official docs.
      subscriptionAckReceived = false,
      ackCandidateReceived = false,
      firstValidTickReceived = false;
    let closeCode: number | undefined, handshakeIssue: string | undefined;
    const state = () => ({
      phase,
      upstreamOpened,
      subscriptionSent,
      subscriptionAckReceived,
      firstValidTickReceived,
      ...(closeCode !== undefined ? { closeCode } : {}),
      ...diagnostic,
    });
    const status = (code: string) => {
      const snapshot = state();
      send({ type: "status", code, ...snapshot });
      observeLive(code, snapshot);
    };
    let handshake: ReturnType<typeof setTimeout> | undefined;
    let diagnostic: Record<string, unknown> = {};
    let timer: ReturnType<typeof setTimeout> | undefined,
      check: ReturnType<typeof setInterval> | undefined;
    const send = (value: unknown) => {
      if (client?.readyState === WebSocket.OPEN)
        client.send(JSON.stringify(value));
    };
    const stop = (code = "WS_DISCONNECTED", info: RateInfo = {}) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(handshake);
      clearInterval(check);
      const snapshot = state();
      send({ type: "status", code, ...snapshot, ...info });
      observeLive(code, snapshot);
      upstream?.terminate();
      client?.close(1000);
      if (!client) socket.destroy();
      if (lease && hash)
        void database()
          .query(
            "DELETE FROM nexus_private.nexus_stream_lease WHERE account_hash=$1 AND token=$2",
            [hash, lease],
          )
          .catch(() => {});
    };
    socket.once("close", () => stop());
    timer = setTimeout(() => stop("MAX_DURATION"), 25000);
    try {
      const url = new URL(req.url ?? "/", "https://nexus.invalid");
      if (!configured()) throw new ProviderError("AUTH_UNAVAILABLE", 503);
      if (
        url.pathname !== "/api/live" ||
        req.headers.origin !== origin() ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new ProviderError("ORIGIN_REJECTED", 403);
      const symbol = url.searchParams.get("symbol") ?? "XAUUSD",
        interval = Number(url.searchParams.get("interval") ?? 3600);
      if (
        !["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD", "ETHUSD"].includes(
          symbol,
        ) ||
        ![300, 900, 3600, 14400, 86400].includes(interval)
      )
        throw new ProviderError("INVALID_REQUEST", 400);
      const identity = await requireLiveSession(req.headers);
      const db = database(),
        owner = identity.user.id;
      const selected = await db.query(
        "SELECT c.id,c.envelope FROM nexus_private.nexus_credentials c JOIN nexus_private.nexus_selection s ON s.credential_id=c.id AND s.user_id=c.user_id WHERE c.user_id=$1 AND c.status='verified'",
        [owner],
      );
      const row = selected.rows[0];
      if (!row) throw new ProviderError("ACCOUNT_NOT_SELECTED", 409);
      wss.handleUpgrade(req, socket, head, (ws) => {
        client = ws;
        ws.on("close", () => stop());
        ws.on("error", () => stop("WS_DISCONNECTED"));
        ws.on("message", () => stop("INVALID_CLIENT_MESSAGE"));
      });
      if (!(await takeRate(db, `live-user:${owner}`, 12, 60)))
        throw new ProviderError("RATE_LIMITED", 429, undefined, {
          rateLimitSource: "INTERNAL_USER",
        });
      if (closed) return;
      const config = decrypt(row.envelope, owner, row.id) as Config;
      hash = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
        .update(config.accountId)
        .digest("hex");
      lease = randomUUID();
      const acquired = await db.query(
        "INSERT INTO nexus_private.nexus_stream_lease(account_hash,token,expires_at) VALUES($1,$2,now()+interval '30 seconds') ON CONFLICT(account_hash) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE nexus_stream_lease.expires_at<now() RETURNING token",
        [hash, lease],
      );
      if (!acquired.rows.length) {
        lease = undefined;
        throw new ProviderError("CONNECTION_QUOTA", 429, undefined, {
          rateLimitSource: "INTERNAL_WS_LEASE",
        });
      }
      if (closed) {
        await db.query(
          "DELETE FROM nexus_private.nexus_stream_lease WHERE account_hash=$1 AND token=$2",
          [hash, lease],
        );
        return;
      }
      const reader = productionReader(config, owner, row.id);
      const { prepared, candles } = await liveBootstrap(
        db,
        owner,
        row.id,
        symbol,
        interval,
        reader,
      );
      if (closed) return;
      for (const [i, r] of prepared.rules.entries())
        if (
          !(await takeRate(
            db,
            `live-provider:${hash}:${i}`,
            Math.min(r.limit, r.burst),
            Math.ceil(r.window_seconds),
          ))
        )
          throw new ProviderError("RATE_LIMITED", 429, undefined, {
            rateLimitSource: "INTERNAL_WS_LEASE",
          });
      const subscriptionId = randomUUID();
      const subscription = JSON.stringify({
        id: subscriptionId,
        subscribe: { event: "ticks", instruments: [prepared.instrument] },
      });
      if (Buffer.byteLength(subscription) > prepared.maxMessageBytes)
        throw new ProviderError("EXNESS_LIMITS_UNAVAILABLE");

      const host = safeOrigin(prepared.host);
      let addresses: Awaited<ReturnType<typeof resolveHost>>;
      try {
        addresses = await bounded(
          () => resolveHost(new URL(host).hostname),
          AbortSignal.timeout(4000),
        );
      } catch (error) {
        diagnostic = networkFailure(error, "DNS");
        stop("DNS_FAILED");
        return;
      }
      if (closed) return;
      const valid = () =>
        revalidateLiveAccess(req.headers, identity, db, row.id);
      await valid();
      if (closed) return;
      send({ type: "basis", connectionId: row.id, symbol, interval, candles });
      const upstreamHeaders = signedHeaders(
        config.apiKey,
        loadKey(config.privateKey),
        prepared.path,
      );
      phase = "TCP";
      send({ type: "diagnostic", ...state() });
      observeLive("PHASE_CHANGED", state());
      handshake = setTimeout(() => {
        diagnostic = {
          stage: "WS_HANDSHAKE_TIMEOUT",
          internalCode: "HANDSHAKE_DEADLINE",
        };
        stop("WS_HANDSHAKE_TIMEOUT");
      }, 5000);
      upstream = new WebSocket(
        host.replace(/^https:/, "wss:") + prepared.path,
        EXNESS_WS_PROTOCOL,
        {
          perMessageDeflate: false,
          headers: upstreamHeaders,
          followRedirects: false,
          // Our wall-clock deadline also bounds TCP and TLS, without parsing ws errors.
          handshakeTimeout: 6000,
          ...pinnedTlsOptions(new URL(host).hostname, addresses, (next) => {
            if (!closed) {
              phase = next;
              send({ type: "diagnostic", ...state() });
              observeLive("PHASE_CHANGED", state());
            }
          }),
          maxPayload: 16384,
        },
      );
      let last = 0,
        lastPong = Date.now();
      client?.on("pong", () => {
        lastPong = Date.now();
      });
      upstream.on("upgrade", (response) => {
        // Compare only to the documented constant. Never forward/log header values.
        const protocol = response.headers["sec-websocket-protocol"];
        if (protocol !== EXNESS_WS_PROTOCOL)
          handshakeIssue =
            protocol === undefined
              ? "WS_SUBPROTOCOL_MISSING"
              : "WS_SUBPROTOCOL_MISMATCH";
      });
      upstream.on("open", () => {
        if (closed) return;
        clearTimeout(handshake);
        phase = "OPEN";
        upstreamOpened = true;
        status("WS_CONNECTED");
        const sent = (error?: Error) => {
          if (closed) return;
          if (error) {
            diagnostic = {
              stage: "WS_DISCONNECTED",
              internalCode: "SUBSCRIPTION_SEND_FAILED",
            };
            stop("WS_DISCONNECTED");
            return;
          }
          subscriptionSent = true;
          // A late write callback must not replace a valid tick with WAITING.
          if (!firstValidTickReceived && !ackCandidateReceived) {
            status("SUBSCRIPTION_SENT");
            status("WAITING_FOR_BROKER_TICK");
          } else {
            observeLive("SUBSCRIPTION_SENT", state());
            send({ type: "diagnostic", ...state() });
          }
        };
        try {
          upstream?.send(subscription, sent);
        } catch {
          sent(new Error());
        }
      });
      upstream.on("message", (bytes) => {
        if (closed || !upstreamOpened) return;
        try {
          const frame = parseLiveFrame(JSON.parse(bytes.toString()), {
            subscriptionId,
            accountId: config.accountId,
            instrument: prepared.instrument,
            connectionId: row.id,
            symbol,
            last,
          });
          if (frame.kind === "unverified_ack" && !ackCandidateReceived) {
            ackCandidateReceived = true;
            // Docs do not establish code=200 as ACK success. Keep waiting for an
            // independently validated tick; no ACK, quota or feed-verification bypass.
            diagnostic = { internalCode: "ACK_CONTRACT_UNVERIFIED" };
            status("UNKNOWN_BROKER_RESPONSE");
            return;
          }
          if (frame.kind === "subscription_error") {
            diagnostic = { brokerErrorCode: frame.brokerErrorCode };
            stop(
              frame.code,
              frame.code === "RATE_LIMITED"
                ? { rateLimitSource: "EXNESS_WS" }
                : {},
            );
            return;
          }
          if (frame.kind === "account_mismatch") {
            diagnostic = {};
            stop("INVALID_RESPONSE");
            return;
          }
          if (frame.kind === "invalid_tick") return;
          if (frame.kind !== "tick") {
            diagnostic = {};
            stop("UNKNOWN_BROKER_RESPONSE");
            return;
          }
          const t = frame.tick;
          last = t.time;
          if ((client?.bufferedAmount ?? 0) > 65536) {
            stop("SLOW_CLIENT");
            return;
          }
          if (!firstValidTickReceived) {
            firstValidTickReceived = true;
            diagnostic = {};
            observeLive("EXNESS_LIVE", state());
            send({ type: "diagnostic", ...state() });
          }
          send({ type: "tick", ...t });
        } catch {
          diagnostic = {};
          stop("UNKNOWN_BROKER_RESPONSE");
        }
      });
      upstream.on("unexpected-response", (_r, response) => {
        clearTimeout(handshake);
        const status = response.statusCode;
        diagnostic = {
          stage: "WS_HTTP_REJECTED",
          internalCode: "HTTP_REJECTED",
          ...([400, 401, 403, 404, 408, 429, 500, 502, 503, 504].includes(
            status ?? 0,
          )
            ? { httpStatus: status }
            : {}),
        };
        stop(
          response.statusCode === 429 ? "RATE_LIMITED" : "WS_HTTP_REJECTED",
          response.statusCode === 429
            ? {
                rateLimitSource: "EXNESS_WS",
                ...rateInfo({
                  retryAfterSec: Number(response.headers["retry-after"]),
                }),
              }
            : {},
        );
        response.destroy();
      });
      upstream.on("error", (error) => {
        if (closed) return;
        diagnostic = networkFailure(error, phase);
        if (
          !upstreamOpened &&
          phase === "HANDSHAKE" &&
          handshakeIssue &&
          diagnostic.internalCode === "WS_HANDSHAKE_ERROR_NO_CODE"
        )
          diagnostic.internalCode = handshakeIssue;
        stop(String(diagnostic.stage));
      });
      upstream.on("close", (code) => {
        closeCode = safeCloseCode(code);
        if (closed) {
          observeLive("WS_CLOSE_OBSERVED", state());
          return;
        }
        diagnostic = {
          stage: "WS_DISCONNECTED",
          internalCode: upstreamOpened ? "SOCKET_CLOSED" : "CLOSED_BEFORE_OPEN",
        };
        stop("WS_DISCONNECTED");
      });
      check = setInterval(() => {
        if (Date.now() - lastPong > 6000) {
          stop("DISCONNECTED");
          return;
        }
        if (client?.readyState === WebSocket.OPEN) client.ping();
        void valid().catch((error) =>
          stop(liveFailure(error, "AUTH_UNAVAILABLE")),
        );
      }, 2000);
    } catch (error) {
      const category = (["TCP", "TLS", "HANDSHAKE"] as string[]).includes(phase)
        ? ((diagnostic = networkFailure(error, phase)),
          String(diagnostic.stage))
        : liveFailure(error);
      const status =
        error instanceof ProviderError &&
        [400, 401, 403, 409, 429].includes(error.status)
          ? error.status
          : 503;
      if (!client && !socket.destroyed) {
        socket.write(
          `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        socket.destroy();
      }
      stop(
        category,
        rateInfo(
          error instanceof ProviderError
            ? {
                rateLimitSource: error.details?.rateLimitSource,
                retryAfterSec: error.retryAfter,
              }
            : {},
        ),
      );
    }
  });
  return server;
}
