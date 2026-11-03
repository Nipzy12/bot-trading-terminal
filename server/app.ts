import { livePreflight } from "./live-preflight.js";
import { brokerProbeRouter } from "./engine-broker.js";
import { deviceEngineRouter } from "./engine.js";
import { historyQuery, demoHistory } from "./backtest-history.js";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { auth, configured, origin, cookieOnlyResponse } from "./auth.js";
import { database, takeRate } from "./database.js";
import { accountRouter } from "./accounts.js";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { ProviderError } from "./exness.js";
import { market, symbols } from "./market.js";
export const app = express();
app.disable("x-powered-by");
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.all("/api/auth/{*path}", async (req, res) => {
  try {
    if (!configured()) {
      res.status(503).json({ error: "ACCOUNT_SETUP_REQUIRED" });
      return;
    }
    if (
      req.method !== "GET" &&
      (req.get("origin") !== origin() ||
        req.get("sec-fetch-site") === "cross-site")
    ) {
      res.status(403).json({ error: "CSRF_REJECTED" });
      return;
    }
    const address =
      (process.env.VERCEL === "1"
        ? req.get("x-vercel-forwarded-for")
        : undefined) ??
      req.socket.remoteAddress ??
      "unknown";
    const key = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
      .update(address)
      .digest("hex");
    if (!(await takeRate(database(), `auth:${key}`, 20, 60))) {
      res.set("Retry-After", "60").status(429).json({ error: "RATE_LIMITED" });
      return;
    }
    if (
      req.method !== "POST" ||
      ![
        "/api/auth/sign-in/email",
        "/api/auth/sign-up/email",
        "/api/auth/sign-out",
      ].includes(req.path)
    ) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    await toNodeHandler({
      handler: async (request: Request) =>
        cookieOnlyResponse(await auth().handler(request)),
    })(req, res);
  } catch {
    res.status(503).json({ error: "AUTH_SERVICE_UNAVAILABLE" });
  }
});
app.use(express.json({ limit: "8kb" }));
app.post("/api/live/preflight", (req, res) => {
  void livePreflight(req, res);
});
app.use("/api/engine/broker", brokerProbeRouter());
app.use("/api/engine", deviceEngineRouter());
app.use("/api/account", accountRouter());
app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", execution: "simulation", liveTrading: false }),
);
app.get("/api/market", async (req, res) => {
  const parsed = z
    .object({
      symbol: z.enum(symbols),
      interval: z
        .enum(["300", "900", "3600", "14400", "86400"])
        .default("3600"),
    })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid symbol or interval" });
    return;
  }
  try {
    res
      .set("Cache-Control", "no-store")
      .json(await market(parsed.data.symbol, Number(parsed.data.interval)));
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
      res
        .status(error.status)
        .json({ error: error.code, retryAfter: error.retryAfter });
      return;
    }
    res.status(502).json({
      error: "Market provider unavailable. Check backend configuration.",
    });
  }
});
app.get("/api/backtest/history", (req, res) => {
  const parsed = historyQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_HISTORY_QUERY" });
    return;
  }
  try {
    res.json(
      demoHistory(
        parsed.data.symbol,
        Number(parsed.data.interval),
        parsed.data.before,
        undefined,
        parsed.data.windowIntervals,
      ),
    );
  } catch {
    res.status(400).json({ error: "INVALID_HISTORY_WINDOW" });
  }
});
// No broker order routes exist. Execution is exclusively browser-local paper trading.
app.all("/api/orders", (_req, res) =>
  res.status(403).json({ error: "Live trading is disabled" }),
);

// Keep unknown API requests out of the frontend SPA fallback.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

app.use(
  (
    _error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(400).json({ error: "INVALID_REQUEST" });
  },
);
