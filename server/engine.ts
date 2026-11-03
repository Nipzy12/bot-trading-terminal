import { createHmac, randomBytes } from "node:crypto";
import express from "express";
import { z } from "zod";
import { database, takeRate } from "./database.js";
import type { Identity } from "./accounts.js";

// The Windows process is a heartbeat-only device. It never receives Exness secrets,
// broker permissions, market quotes, or commands through these routes.
const pairCode = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/;
const deviceLabel = "Windows laptop";
const presenceWindowMs = 30_000;

export function engineSecretHash(kind: string, value: string, key = process.env.BETTER_AUTH_SECRET ?? "") {
  if (key.length < 32) throw Error("ENGINE_AUTH_UNAVAILABLE");
  return createHmac("sha256", key).update("nexus-engine-v1:").update(kind).update(":").update(value).digest("hex");
}
export function enginePresence(lastSeen: unknown, now = Date.now()): "ONLINE" | "OFFLINE" {
  if (!lastSeen) return "OFFLINE";
  const timestamp = new Date(lastSeen as string).getTime();
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= presenceWindowMs
    ? "ONLINE" : "OFFLINE";
}
function newCode() { return randomBytes(24).toString("base64url"); }
function newToken() { return randomBytes(32).toString("base64url"); }

export function ownerEngineRouter() {
  const router = express.Router();
  router.get("/status", async (_req, res) => {
    try {
      const owner = (res.locals.identity as Identity).user.id;
      const result = await database().query(
        "SELECT label,paired_at,last_seen_at FROM nexus_private.nexus_engine_devices WHERE user_id=$1",
        [owner],
      );
      const row = result.rows[0];
      res.json(row
        ? { status: enginePresence(row.last_seen_at), label: row.label,
            pairedAt: row.paired_at, lastSeenAt: row.last_seen_at }
        : { status: "UNPAIRED", label: null, pairedAt: null, lastSeenAt: null });
    } catch {
      res.status(503).json({ error: "ENGINE_SERVICE_UNAVAILABLE" });
    }
  });
  // Inherits authenticated session, exact-Origin/CSRF and owner rate limiting from /api/account.
  router.post("/pair-code", async (_req, res) => {
    try {
      const owner = (res.locals.identity as Identity).user.id;
      if (!(await takeRate(database(), "engine-pair-create:" + owner, 5, 3600))) {
        res.status(429).json({ error: "RATE_LIMITED" }); return;
      }
      const code = newCode();
      const hash = engineSecretHash("pair", code);
      await database().query(
        "INSERT INTO nexus_private.nexus_engine_pairing(user_id,code_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '5 minutes') ON CONFLICT(user_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at",
        [owner, hash],
      );
      res.set("Cache-Control", "no-store").json({ code, expiresInSeconds: 300 });
    } catch {
      res.status(503).json({ error: "ENGINE_SERVICE_UNAVAILABLE" });
    }
  });
  router.post("/revoke", async (_req, res) => {
    try {
      const owner = (res.locals.identity as Identity).user.id;
      await database().query("DELETE FROM nexus_private.nexus_engine_pairing WHERE user_id=$1", [owner]);
      await database().query("DELETE FROM nexus_private.nexus_engine_devices WHERE user_id=$1", [owner]);
      res.json({ revoked: true });
    } catch {
      res.status(503).json({ error: "ENGINE_SERVICE_UNAVAILABLE" });
    }
  });
  return router;
}

export function deviceEngineRouter() {
  const router = express.Router();
  router.post("/pair", async (req, res) => {
    const parsed = z.object({ code: pairCode }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "INVALID_PAIR_CODE" }); return; }
    try {
      // This unauthenticated claim endpoint uses high-entropy, single-use codes and
      // shared PostgreSQL rate limiting. No client-provided owner identity is trusted.
      const address = (process.env.VERCEL === "1"
        ? req.get("x-vercel-forwarded-for") : undefined) ?? req.socket.remoteAddress ?? "unknown";
      const bucket = engineSecretHash("ip", address);
      if (!(await takeRate(database(), "engine-claim:" + bucket, 12, 60))) {
        res.status(429).json({ error: "RATE_LIMITED" }); return;
      }
      const token = newToken();
      const tokenHash = engineSecretHash("device", token);
      const codeHash = engineSecretHash("pair", parsed.data.code);
      const result = await database().query(
        "WITH claimed AS (DELETE FROM nexus_private.nexus_engine_pairing WHERE code_hash=$1 AND expires_at>clock_timestamp() RETURNING user_id) INSERT INTO nexus_private.nexus_engine_devices(user_id,token_hash,label,paired_at,last_seen_at) SELECT user_id,$2,$3,clock_timestamp(),NULL FROM claimed ON CONFLICT(user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,label=EXCLUDED.label,paired_at=clock_timestamp(),last_seen_at=NULL RETURNING user_id",
        [codeHash, tokenHash, deviceLabel],
      );
      if (result.rows.length !== 1) { res.status(403).json({ error: "PAIR_CODE_EXPIRED_OR_USED" }); return; }
      // Device token is returned once and kept only in process memory by the Windows CLI.
      res.set("Cache-Control", "no-store").json({ paired: true, token, heartbeatSeconds: 10 });
    } catch {
      res.status(503).json({ error: "ENGINE_SERVICE_UNAVAILABLE" });
    }
  });
  router.post("/heartbeat", async (req, res) => {
    const found = bearer.exec(req.get("authorization") ?? "");
    if (!found) { res.status(401).json({ error: "ENGINE_UNAUTHORIZED" }); return; }
    try {
      const hash = engineSecretHash("device", found[1]);
      if (!(await takeRate(database(), "engine-beat:" + hash, 12, 60))) {
        res.status(429).json({ error: "RATE_LIMITED" }); return;
      }
      const result = await database().query(
        "UPDATE nexus_private.nexus_engine_devices SET last_seen_at=clock_timestamp() WHERE token_hash=$1 RETURNING user_id",
        [hash],
      );
      if (result.rows.length !== 1) { res.status(401).json({ error: "ENGINE_UNAUTHORIZED" }); return; }
      res.json({ acknowledged: true, brokerOrders: false, mode: "HEARTBEAT_ONLY" });
    } catch {
      res.status(503).json({ error: "ENGINE_SERVICE_UNAVAILABLE" });
    }
  });
  return router;
}
