import { historyQuery } from "./backtest-history.js";
import express, { type Request } from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { auth, configured, origin } from "./auth.js";
import { database, takeRate, type Database } from "./database.js";
import { decrypt, encrypt } from "./vault.js";
import { ExnessReader, ProviderError, loadKey, type Config } from "./exness.js";
import { safeOrigin, secureTransport } from "./ssrf.js";
import { connectionStages, type ConnectionReport } from "./connection-test.js";
import { symbols } from "./market.js";
export type Identity = {
  user: { id: string; name: string };
  session: { id: string };
};
type Reader = {
  testConnection: () => Promise<ConnectionReport>;
  historyPage?: (
    symbol: string,
    interval: number,
    before?: number,
  ) => Promise<unknown>;
  candles: (symbol: string, interval: number) => Promise<unknown>;
};
type Dependencies = {
  db: () => Database;
  identity: (req: Request) => Promise<Identity | null>;
  ready: () => boolean;
  reader: (config: Config, owner: string, id: string) => Reader;
};
export function csrf(identity: Identity) {
  return createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update(`csrf:${identity.user.id}:${identity.session.id}`)
    .digest("base64url");
}
export function validOrigin(req: Request) {
  return (
    req.get("origin") === origin() && req.get("sec-fetch-site") !== "cross-site"
  );
}
const credentials = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[\p{L}\p{N} ._-]+$/u),
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[\x21-\x7e]+$/),
    privateKey: z.string().trim().min(1).max(4096),
    accountId: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .refine((v) => BigInt(v) <= 18446744073709551615n),
    gateway: z.string().max(300),
  })
  .strict();
const marketQuery = z
  .object({
    symbol: z.enum(symbols),
    interval: z.enum(["300", "900", "3600", "14400", "86400"]).default("3600"),
  })
  .strict();
const idSchema = z.uuid();
const readers = new Map<string, { at: number; reader: ExnessReader }>();
export function productionReader(config: Config, owner: string, id: string) {
  const cacheKey = `${owner}:${id}`;
  const previous = readers.get(cacheKey);
  if (previous && Date.now() - previous.at < 300000) return previous.reader;
  if (readers.size >= 50) readers.delete(readers.keys().next().value!);
  const accountHash = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update(config.accountId)
    .digest("hex");
  const reader = new ExnessReader(
    config,
    secureTransport,
    () => Date.now(),
    async (_op, rules) => {
      try {
        const exists = await database().query(
          "SELECT id FROM nexus_private.nexus_credentials WHERE id=$1 AND user_id=$2",
          [id, owner],
        );
        if (!exists.rows.length)
          throw new ProviderError("CONNECTION_DELETED", 409);
        for (const r of rules)
          if (
            !(await takeRate(
              database(),
              `provider:${accountHash}:${r.scope}`,
              r.limit,
              r.window_seconds,
            ))
          )
            throw new ProviderError("EXNESS_RATE_LIMIT", 429, r.window_seconds);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("ACCOUNT_SERVICE_UNAVAILABLE", 503);
      }
    },
  );
  readers.set(cacheKey, { at: Date.now(), reader });
  return reader;
}
const defaults: Dependencies = {
  db: database,
  ready: configured,
  identity: (req) =>
    auth().api.getSession({ headers: fromNodeHeaders(req.headers) }),
  reader: productionReader,
};
export function accountRouter(overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  const router = express.Router();
  router.get("/config", async (_req, res) => {
    let enabled = deps.ready();
    if (enabled) {
      try {
        const probe = await deps
          .db()
          .query(
            "SELECT to_regclass('nexus_private.nexus_credentials') IS NOT NULL AND to_regclass('nexus_private.session') IS NOT NULL AS ready",
          );
        enabled = probe.rows[0]?.ready === true;
      } catch {
        enabled = false;
      }
    }
    res.json({ enabled, execution: "simulation", liveTrading: false });
  });
  router.use(async (req, res, next) => {
    try {
      if (!deps.ready()) {
        res.status(503).json({ error: "ACCOUNT_SETUP_REQUIRED" });
        return;
      }
      const identity = await deps.identity(req);
      if (!identity) {
        res.status(401).json({ error: "UNAUTHORIZED" });
        return;
      }
      res.locals.identity = identity;
      if (!["GET", "HEAD"].includes(req.method)) {
        const token = req.get("x-csrf-token") ?? "";
        const expected = csrf(identity);
        if (
          !validOrigin(req) ||
          Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
        ) {
          res.status(403).json({ error: "CSRF_REJECTED" });
          return;
        }
      }
      if (
        !(await takeRate(deps.db(), `private:${identity.user.id}`, 120, 60))
      ) {
        res
          .set("Retry-After", "60")
          .status(429)
          .json({ error: "RATE_LIMITED" });
        return;
      }
      next();
    } catch {
      res.status(503).json({ error: "ACCOUNT_SERVICE_UNAVAILABLE" });
    }
  });
  router.get("/session", (_req, res) => {
    const identity = res.locals.identity as Identity;
    res.json({ user: { name: identity.user.name }, csrfToken: csrf(identity) });
  });
  router.get("/connections", async (_req, res) => {
    const owner = (res.locals.identity as Identity).user.id;
    const rows = await deps
      .db()
      .query(
        "SELECT c.id,c.label,c.status,c.tested_at, (s.credential_id=c.id) AS selected FROM nexus_private.nexus_credentials c LEFT JOIN nexus_private.nexus_selection s ON s.user_id=c.user_id WHERE c.user_id=$1 ORDER BY c.created_at",
        [owner],
      );
    res.json({ accounts: rows.rows });
  });
  router.post("/connections", async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_CREDENTIALS" });
      return;
    }
    const { label, ...input } = parsed.data;
    try {
      safeOrigin(input.gateway);
      loadKey(input.privateKey);
    } catch {
      res.status(400).json({ error: "INVALID_KEY_OR_GATEWAY" });
      return;
    }
    const owner = (res.locals.identity as Identity).user.id;
    const id = randomUUID();
    // Owner cap is also enforced by a database trigger under an advisory lock.
    const result = await deps
      .db()
      .query(
        `INSERT INTO nexus_private.nexus_credentials(id,user_id,label,envelope) SELECT $1,$2,$3,$4::jsonb WHERE (SELECT count(*) FROM nexus_private.nexus_credentials WHERE user_id=$2)<10 RETURNING id`,
        [id, owner, label, JSON.stringify(encrypt(input, owner, id))],
      );
    if (!result.rows.length) {
      res.status(409).json({ error: "ACCOUNT_LIMIT" });
      return;
    }
    res.status(201).json({ id, label, status: "saved" });
  });
  router.post("/connections/:id/test", async (req, res) => {
    if (!idSchema.safeParse(req.params.id).success) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    const owner = (res.locals.identity as Identity).user.id;
    const id = String(req.params.id);
    const row = await deps
      .db()
      .query(
        "SELECT envelope FROM nexus_private.nexus_credentials WHERE id=$1 AND user_id=$2",
        [id, owner],
      );
    if (!row.rows.length) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    if (!(await takeRate(deps.db(), `test:${owner}:${id}`, 3, 60))) {
      res.set("Retry-After", "60").status(429).json({ error: "RATE_LIMITED" });
      return;
    }
    let report: ConnectionReport;
    try {
      const config = decrypt(row.rows[0].envelope, owner, id) as Config;
      safeOrigin(config.gateway);
      report = await deps.reader(config, owner, id).testConnection();
    } catch (error) {
      const code =
        error instanceof ProviderError && error.code === "EXNESS_SSRF"
          ? "EXNESS_SSRF"
          : "EXNESS_CONFIGURATION";
      report = {
        success: false,
        stage: "configuration",
        error: code,
        stages: connectionStages.map((stage) => ({ stage, status: "not_run" })),
      };
    }
    // Database failures stay account-service errors, never mislabeled as provider authentication.
    const updated = await deps
      .db()
      .query(
        "UPDATE nexus_private.nexus_credentials SET status=$3,tested_at=now() WHERE id=$1 AND user_id=$2 RETURNING id",
        [id, owner, report.success ? "verified" : "error"],
      );
    if (!updated.rows.length) {
      res.status(409).json({ error: "CONNECTION_DELETED" });
      return;
    }
    if (report.success) {
      res.json({
        status: "verified",
        label: "EXNESS",
        kind: "candle-history",
        live: false,
        ...report,
      });
      return;
    }
    if (report.retryAfter) res.set("Retry-After", String(report.retryAfter));
    res
      .status(
        report.error === "RATE_LIMITED"
          ? 429
          : report.error === "TIMEOUT"
            ? 504
            : 502,
      )
      .json({ ...report, live: false });
  });
  router.post("/selection", async (req, res) => {
    const parsed = z.object({ id: idSchema }).strict().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_SELECTION" });
      return;
    }
    const owner = (res.locals.identity as Identity).user.id;
    const row = await deps
      .db()
      .query(
        "SELECT id FROM nexus_private.nexus_credentials WHERE id=$1 AND user_id=$2 AND status='verified'",
        [parsed.data.id, owner],
      );
    if (!row.rows.length) {
      res.status(404).json({ error: "NOT_FOUND_OR_UNVERIFIED" });
      return;
    }
    await deps
      .db()
      .query(
        "INSERT INTO nexus_private.nexus_selection(user_id,credential_id) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET credential_id=excluded.credential_id",
        [owner, parsed.data.id],
      );
    res.json({ selected: true });
  });
  router.delete("/connections/:id", async (req, res) => {
    if (!idSchema.safeParse(req.params.id).success) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    const result = await deps
      .db()
      .query(
        "DELETE FROM nexus_private.nexus_credentials WHERE id=$1 AND user_id=$2 RETURNING id",
        [req.params.id, (res.locals.identity as Identity).user.id],
      );
    if (!result.rows.length) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    readers.delete(
      `${(res.locals.identity as Identity).user.id}:${req.params.id}`,
    );
    res.json({ deleted: true });
  });
  router.get(["/market", "/backtest/history"], async (req, res) => {
    const isHistory = req.path === "/backtest/history";
    const parsed = (isHistory ? historyQuery : marketQuery).safeParse(
      req.query,
    );
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_MARKET" });
      return;
    }
    const owner = (res.locals.identity as Identity).user.id;
    const rows = await deps
      .db()
      .query(
        "SELECT c.id,c.envelope FROM nexus_private.nexus_credentials c JOIN nexus_private.nexus_selection s ON s.credential_id=c.id AND s.user_id=c.user_id WHERE c.user_id=$1 AND c.status='verified'",
        [owner],
      );
    if (!rows.rows.length) {
      res.status(409).json({ error: "NO_VERIFIED_ACCOUNT_SELECTED" });
      return;
    }
    const row = rows.rows[0];
    const config = decrypt(row.envelope, owner, row.id) as Config;
    safeOrigin(config.gateway);
    const reader = deps.reader(config, owner, row.id);
    const page = isHistory
      ? await reader.historyPage?.(
          parsed.data.symbol,
          Number(parsed.data.interval),
          "before" in parsed.data && typeof parsed.data.before === "number"
            ? parsed.data.before
            : undefined,
        )
      : undefined;
    if (isHistory && !page) throw new ProviderError("HISTORY_UNAVAILABLE");
    const candles = isHistory
      ? undefined
      : await reader.candles(parsed.data.symbol, Number(parsed.data.interval));
    // Recheck ownership after network I/O so a concurrent disconnect revokes the response.
    const valid = await deps
      .db()
      .query(
        "SELECT c.id FROM nexus_private.nexus_credentials c JOIN nexus_private.nexus_selection s ON s.credential_id=c.id AND s.user_id=c.user_id WHERE c.id=$1 AND c.user_id=$2 AND c.status='verified'",
        [row.id, owner],
      );
    if (!valid.rows.length) {
      res.status(409).json({ error: "CONNECTION_DELETED" });
      return;
    }
    res.json({
      source: "exness",
      paperSource: { kind: "EXNESS", connectionId: row.id },
      label: "EXNESS",
      kind: "candle-history",
      live: false,
      ...(isHistory ? (page as object) : { candles }),
    });
  });
  router.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof ProviderError) {
        if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
        res
          .status(error.status)
          .json({ error: error.code, retryAfter: error.retryAfter });
        return;
      }
      res.status(503).json({ error: "ACCOUNT_SERVICE_UNAVAILABLE" });
    },
  );
  return router;
}
