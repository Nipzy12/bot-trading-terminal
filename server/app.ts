import express from "express";
import { z } from "zod";
import { market, symbols } from "./market.js";
export const app = express();
app.disable("x-powered-by");
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "8kb" }));
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
  } catch {
    res.status(502).json({
      error: "Market provider unavailable. Check backend configuration.",
    });
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
