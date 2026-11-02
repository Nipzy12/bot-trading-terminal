import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import request from "supertest";
import { app } from "../server/app";
import { candles } from "../server/market";
beforeEach(() => {
  for (const name of [
    "EXN_API_KEY",
    "EXN_PRIVATE_KEY",
    "EXN_ACCOUNT_ID",
    "EXN_DISCOVERY_BASE_URL",
  ])
    vi.stubEnv(name, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("safe market backend", () => {
  it("defaults to simulation and rejects live execution", async () => {
    const health = await request(app).get("/api/health");
    expect(health.body.liveTrading).toBe(false);
    for (const method of ["post", "get", "put", "patch", "delete"] as const) {
      expect(
        (await request(app)[method]("/api/orders").send({ symbol: "XAUUSD" }))
          .status,
      ).toBe(403);
    }
  });
  it("returns coherent ordered candles for all supported intervals", async () => {
    for (const interval of [300, 900, 3600, 14400, 86400]) {
      const r = await request(app).get(
        `/api/market?symbol=XAUUSD&interval=${interval}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.source).toBe("simulation");
      const rows = candles("XAUUSD", interval);
      expect(rows).toHaveLength(180);
      rows.forEach((c, i) => {
        expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
        expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
        if (i) expect(c.time - rows[i - 1].time).toBe(interval);
      });
    }
  });
  it("rejects unsupported instruments and intervals", async () => {
    expect((await request(app).get("/api/market?symbol=INVALID")).status).toBe(
      400,
    );
    expect(
      (await request(app).get("/api/market?symbol=XAUUSD&interval=1")).status,
    ).toBe(400);
  });
  it("falls back to labeled demo without complete credentials", async () => {
    vi.stubEnv("EXN_API_KEY", "incomplete-test-key");
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    const r = await request(app).get("/api/market?symbol=XAUUSD");
    expect(r.body).toMatchObject({
      source: "simulation",
      label: "DEMO",
      live: false,
    });
    expect(transport).not.toHaveBeenCalled();
  });
});
