import express from "express";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { database, takeRate } from "./database.js";
import { engineSecretHash } from "./engine.js";
import { decrypt } from "./vault.js";
import { productionReader } from "./accounts.js";
import { loadKey, signedHeaders, type Config } from "./exness.js";
import { safeOrigin, resolveHost } from "./ssrf.js";
import { EXNESS_WS_PROTOCOL } from "./live-network.js";

// A time-limited, manual, read-only broker connectivity probe, NOT a persistent relay.
// Never logs/stores the signed handshake headers. These are temporary credentials.
// A device token does not grant arbitrary signing: the server only signs the fixed
// GET /v1/server-events/accounts/<selected-account>/ws/ticks path.
export const brokerProbeFlag = z.object({ confirmTemporarySignedAccess: z.literal(true) }).strict();
export const PROBE_LEASE_SECONDS = 95;
export const PROBE_RUN_SECONDS = 65;
export function brokerProbePath(accountId: string) {
  if (!/^[1-9]\d{0,19}$/.test(accountId) || BigInt(accountId) > 18446744073709551615n)
    throw Error("INVALID_ACCOUNT");
  return "/v1/server-events/accounts/" + accountId + "/ws/ticks";
}
export function brokerProbeHost(url: string) {
  const origin = safeOrigin(url);
  if (new URL(origin).protocol !== "https:") throw Error("INVALID_HOST");
  return origin.replace(/^https:/, "wss:");
}
export function brokerProbeRouter() {
  const router = express.Router();
  router.post("/probe", async (req, res) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get("authorization") ?? "");
    if (!match) { res.status(401).json({ error: "ENGINE_UNAUTHORIZED" }); return; }
    if (!brokerProbeFlag.safeParse(req.body).success) {
      res.status(400).json({ error: "EXPLICIT_PROBE_CONFIRMATION_REQUIRED" }); return;
    }
    try {
      const db = database();
      const hash = engineSecretHash("device", match[1]);
      const device = await db.query(
        "SELECT user_id FROM nexus_private.nexus_engine_devices WHERE token_hash=$1 AND last_seen_at>clock_timestamp()-interval '30 seconds'",
        [hash],
      );
      if (device.rows.length !== 1) {
        res.status(401).json({ error: "ENGINE_UNAUTHORIZED" }); return;
      }
      const owner = device.rows[0].user_id as string;
      if (!(await takeRate(db, "engine-broker-probe:" + owner, 2, 3600))) {
        res.status(429).json({ error: "PROBE_RATE_LIMITED" }); return;
      }
      const selected = await db.query(
        "SELECT c.id,c.envelope FROM nexus_private.nexus_credentials c JOIN nexus_private.nexus_selection s ON s.credential_id=c.id AND s.user_id=c.user_id WHERE c.user_id=$1 AND c.status='verified'",
        [owner],
      );
      if (selected.rows.length !== 1) {
        res.status(409).json({ error: "SELECTED_EXNESS_CONNECTION_REQUIRED" }); return;
      }
      const row = selected.rows[0];
      const config = decrypt(row.envelope, owner, row.id) as Config;
      safeOrigin(config.gateway);
      const reader = productionReader(config, owner, row.id);
      const prepared = await reader.prepareLive("XAUUSD");
      if (prepared.path !== brokerProbePath(config.accountId)) {
        res.status(503).json({ error: "BROKER_PROBE_NOT_AVAILABLE" }); return;
      }
      const brokerHost = brokerProbeHost(prepared.host);
      // Reject SSRF before issuing usable headers. Laptop independently validates/pins DNS.
      await resolveHost(new URL(brokerHost).hostname);
      const accountHash = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
        .update(config.accountId).digest("hex");
      const lease = randomUUID();
      const acquired = await db.query(
        "INSERT INTO nexus_private.nexus_stream_lease(account_hash,token,expires_at) VALUES($1,$2,clock_timestamp()+interval '95 seconds') ON CONFLICT(account_hash) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at WHERE nexus_stream_lease.expires_at<clock_timestamp() RETURNING token",
        [accountHash, lease],
      );
      if (!acquired.rows.length) {
        res.status(409).json({ error: "BROKER_STREAM_ALREADY_IN_USE" }); return;
      }
      // Verify device is still paired/selected after network I/O. No response on revocation.
      const stillValid = await db.query(
        "SELECT d.user_id FROM nexus_private.nexus_engine_devices d JOIN nexus_private.nexus_selection s ON s.user_id=d.user_id JOIN nexus_private.nexus_credentials c ON c.id=s.credential_id AND c.user_id=d.user_id WHERE d.user_id=$1 AND d.token_hash=$2 AND d.last_seen_at>clock_timestamp()-interval '30 seconds' AND c.id=$3 AND c.status='verified'",
        [owner, hash, row.id],
      );
      if (!stillValid.rows.length) {
        await db.query("DELETE FROM nexus_private.nexus_stream_lease WHERE account_hash=$1 AND token=$2", [accountHash, lease]);
        res.status(401).json({ error: "ENGINE_ACCESS_REVOKED" }); return;
      }
      // Lease rate limits are not a replacement for provider quotas.
      for (const [index, rule] of prepared.rules.entries()) {
        if (!(await takeRate(db, "live-provider:" + accountHash + ":" + index,
          Math.min(rule.limit, rule.burst), Math.ceil(rule.window_seconds)))) {
          await db.query("DELETE FROM nexus_private.nexus_stream_lease WHERE account_hash=$1 AND token=$2", [accountHash, lease]);
          res.status(429).json({ error: "PROVIDER_RATE_LIMITED" }); return;
        }
      }
      const now = Date.now();
      const headers = signedHeaders(config.apiKey, loadKey(config.privateKey), prepared.path, now);
      // Headers are privileged, short-lived signed GET metadata, NOT the private signing key.
      res.set("Cache-Control", "no-store").json({
        kind: "BROKER_PROBE_ONLY", wsUrl: brokerHost + prepared.path,
        headers, instrument: prepared.instrument, protocol: EXNESS_WS_PROTOCOL,
        signedAt: now, maxRunSeconds: PROBE_RUN_SECONDS,
      });
    } catch {
      res.status(503).json({ error: "BROKER_PROBE_NOT_AVAILABLE" });
    }
  });
  return router;
}
