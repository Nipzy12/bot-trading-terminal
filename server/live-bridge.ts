import { liveBootstrap } from "./live-cache.js";
import { rateInfo, type RateInfo } from "../src/live-diagnostics.js";
import { liveFailure } from "./live-preflight.js";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { fromNodeHeaders } from "better-auth/node";
import { auth, configured, origin } from "./auth.js";
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
import { normalizeBrokerTick } from "../src/live.js";
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
export function attachLive(server: http.Server) {
  server.on("upgrade", async (req, socket, head) => {
    let upstream: WebSocket | undefined,
      client: WebSocket | undefined,
      lease: string | undefined,
      hash: string | undefined,
      closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined,
      check: ReturnType<typeof setInterval> | undefined;
    const send = (value: unknown) => {
      if (client?.readyState === WebSocket.OPEN)
        client.send(JSON.stringify(value));
    };
    const stop = (code = "DISCONNECTED", info: RateInfo = {}) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearInterval(check);
      send({ type: "status", code, ...info });
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
      if (
        url.pathname !== "/api/live" ||
        req.headers.origin !== origin() ||
        !configured()
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
      const identity = await auth().api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
      if (!identity) throw new ProviderError("SESSION_INVALID", 401);
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
      const subscription = JSON.stringify({
        id: randomUUID(),
        subscribe: { event: "ticks", instruments: [prepared.instrument] },
      });
      if (Buffer.byteLength(subscription) > prepared.maxMessageBytes)
        throw new ProviderError("EXNESS_LIMITS_UNAVAILABLE");

      const host = safeOrigin(prepared.host),
        addresses = await bounded(
          () => resolveHost(new URL(host).hostname),
          AbortSignal.timeout(4000),
        );
      if (closed) return;
      const valid = async () => {
        const session = await auth().api.getSession({
          headers: fromNodeHeaders(req.headers),
        });
        if (session?.user.id !== owner) return false;
        const found = await db.query(
          "SELECT c.id FROM nexus_private.nexus_credentials c JOIN nexus_private.nexus_selection s ON s.credential_id=c.id AND s.user_id=c.user_id WHERE c.id=$1 AND c.user_id=$2 AND c.status='verified'",
          [row.id, owner],
        );
        return !!found.rows.length;
      };
      if (!(await valid())) throw new ProviderError("CONNECTION_DELETED", 409);
      if (closed) return;
      send({ type: "basis", connectionId: row.id, symbol, interval, candles });
      upstream = new WebSocket(
        host.replace(/^https:/, "wss:") + prepared.path,
        {
          headers: signedHeaders(
            config.apiKey,
            loadKey(config.privateKey),
            prepared.path,
          ),
          followRedirects: false,
          handshakeTimeout: 5000,
          maxPayload: 16384,
          lookup: (_host, options, cb) => {
            if ((options as { all?: boolean }).all) cb(null, addresses as any);
            else cb(null, addresses[0].address, addresses[0].family);
          },
        },
      );
      let last = 0,
        lastPong = Date.now();
      client?.on("pong", () => {
        lastPong = Date.now();
      });
      upstream.on("open", () => upstream?.send(subscription));
      upstream.on("message", (bytes) => {
        try {
          const raw = JSON.parse(bytes.toString());
          if (raw.error || raw.code) {
            stop(
              Number(raw.code ?? raw.error?.code) === 3015 ||
                Number(raw.code ?? raw.error?.code) === 1
                ? "RATE_LIMITED"
                : "EXNESS_PERMISSION_OR_UNAVAILABLE",
              Number(raw.code ?? raw.error?.code) === 3015 ||
                Number(raw.code ?? raw.error?.code) === 1
                ? { rateLimitSource: "EXNESS_WS" }
                : {},
            );
            return;
          }
          if (
            raw.account_id !== undefined &&
            String(raw.account_id) !== config.accountId
          ) {
            stop("INVALID_RESPONSE");
            return;
          }
          const t = normalizeBrokerTick(
            raw,
            prepared.instrument,
            row.id,
            symbol,
            last,
          );
          if (!t) return;
          last = t.time;
          if ((client?.bufferedAmount ?? 0) > 65536) {
            stop("SLOW_CLIENT");
            return;
          }
          send({ type: "tick", ...t });
        } catch {
          stop("INVALID_RESPONSE");
        }
      });
      upstream.on("unexpected-response", (_r, response) => {
        response.destroy();
        stop(
          response.statusCode === 429
            ? "RATE_LIMITED"
            : response.statusCode === 401 || response.statusCode === 403
              ? "EXNESS_PERMISSION"
              : "EXNESS_UNAVAILABLE",
          response.statusCode === 429
            ? {
                rateLimitSource: "EXNESS_WS",
                ...rateInfo({
                  retryAfterSec: Number(response.headers["retry-after"]),
                }),
              }
            : {},
        );
      });
      upstream.on("error", () => stop("EXNESS_NETWORK"));
      upstream.on("close", () => stop());
      check = setInterval(() => {
        if (Date.now() - lastPong > 6000) {
          stop("DISCONNECTED");
          return;
        }
        if (client?.readyState === WebSocket.OPEN) client.ping();
        void valid()
          .then((ok) => {
            if (!ok) stop("AUTH_REVOKED");
          })
          .catch(() => stop("AUTH_UNAVAILABLE"));
      }, 2000);
    } catch (error) {
      const category = liveFailure(error);
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
