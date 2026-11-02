import { liveBootstrap } from "./live-cache.js";
import { rateInfo } from "../src/live-diagnostics.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { auth, configured, origin } from "./auth.js";
import { database, takeRate } from "./database.js";
import { decrypt } from "./vault.js";
import { productionReader } from "./accounts.js";
import { ProviderError, type Config } from "./exness.js";
import { safeOrigin, resolveHost } from "./ssrf.js";
import { bounded } from "./connection-test.js";
import { preflightCodes, type PreflightCode } from "../src/live-diagnostics.js";
export function liveFailure(
  error: unknown,
  fallback: PreflightCode = "WEBSOCKET_UPGRADE_FAILED",
): PreflightCode {
  const code = error instanceof ProviderError ? error.code : "";
  if ((preflightCodes as readonly string[]).includes(code))
    return code as PreflightCode;
  if (["EXNESS_RATE_LIMIT", "RATE_LIMITED"].includes(code))
    return "RATE_LIMITED";
  if (code === "EXNESS_LIMITS_UNAVAILABLE") return "LIMITS_INVALID";
  return fallback;
}
export async function livePreflight(req: IncomingMessage, res: ServerResponse) {
  let stage: PreflightCode = "BOOTSTRAP_FAILED";
  try {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    stage = "ORIGIN_REJECTED";
    if (req.headers.origin !== origin()) throw new ProviderError(stage, 403);
    stage = "SESSION_INVALID";
    if (!configured()) throw new ProviderError(stage, 503);
    const identity = await auth().api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!identity) throw new ProviderError(stage, 401);
    const db = database(),
      owner = identity.user.id;
    if (!(await takeRate(db, `live-preflight:${owner}`, 12, 60)))
      throw new ProviderError("RATE_LIMITED", 429, undefined, {
        rateLimitSource: "INTERNAL_USER",
      });
    stage = "ACCOUNT_NOT_SELECTED";
    const rows = await db.query(
      "SELECT c.id,c.envelope FROM nexus_private.nexus_credentials c JOIN nexus_private.nexus_selection s ON s.credential_id=c.id AND s.user_id=c.user_id WHERE c.user_id=$1 AND c.status='verified'",
      [owner],
    );
    const row = rows.rows[0];
    if (!row) throw new ProviderError(stage, 409);
    stage = "BOOTSTRAP_FAILED";
    const config = decrypt(row.envelope, owner, row.id) as Config;
    const hash = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
      .update(config.accountId)
      .digest("hex");
    const lease = await db.query(
      "SELECT account_hash,ceil(extract(epoch FROM (expires_at-now()))) AS retry FROM nexus_private.nexus_stream_lease WHERE account_hash=$1 AND expires_at>now()",
      [hash],
    );
    if (lease.rows.length)
      throw new ProviderError(
        "CONNECTION_QUOTA",
        429,
        Number(lease.rows[0]?.retry) > 0
          ? Math.min(30, Number(lease.rows[0].retry))
          : undefined,
        {
          rateLimitSource: "INTERNAL_WS_LEASE",
        },
      );
    const reader = productionReader(config, owner, row.id);
    const u = new URL(req.url ?? "/", "https://nexus.invalid"),
      symbol = u.searchParams.get("symbol") ?? "XAUUSD",
      interval = Number(u.searchParams.get("interval") ?? 3600);
    if (
      !["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD", "ETHUSD"].includes(
        symbol,
      ) ||
      ![300, 900, 3600, 14400, 86400].includes(interval)
    )
      throw new ProviderError(stage, 400);
    const { prepared } = await liveBootstrap(
      db,
      owner,
      row.id,
      symbol,
      interval,
      reader,
    );
    stage = "DNS_FAILED";
    await bounded(
      () => resolveHost(new URL(safeOrigin(prepared.host)).hostname),
      AbortSignal.timeout(4000),
    );
    stage = "BOOTSTRAP_FAILED";
    const still = await db.query(
      "SELECT c.id FROM nexus_private.nexus_credentials c JOIN nexus_private.nexus_selection s ON s.credential_id=c.id AND s.user_id=c.user_id WHERE c.id=$1 AND c.user_id=$2 AND c.status='verified'",
      [row.id, owner],
    );
    const session = await auth().api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!still.rows.length || session?.user.id !== owner)
      throw new ProviderError("SESSION_INVALID", 401);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({ ready: true, code: "READY", brokerLiveVerified: false }),
    );
  } catch (error) {
    const code = liveFailure(error, stage),
      status = error instanceof ProviderError ? error.status : 503;
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        ready: false,
        code,
        httpStatus: status,
        brokerLiveVerified: false,
        ...rateInfo(
          error instanceof ProviderError
            ? {
                rateLimitSource: error.details?.rateLimitSource,
                retryAfterSec: error.retryAfter,
              }
            : {},
        ),
      }),
    );
  }
}
