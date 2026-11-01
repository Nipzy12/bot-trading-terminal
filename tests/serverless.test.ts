import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import handler from "../api/index";

describe("Vercel Express entrypoint", () => {
  beforeEach(() => {
    vi.stubEnv("EXN_DISCOVERY_BASE_URL", "");
    vi.stubEnv("EXN_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("serves health and demo market across repeated stateless invocations", async () => {
    for (let i = 0; i < 2; i++) {
      const health = await request(handler).get("/api/health");
      expect(health.status).toBe(200);
      expect(health.headers["cache-control"]).toBe("no-store");
      expect(health.body).toEqual({
        status: "ok",
        execution: "simulation",
        liveTrading: false,
      });
      const market = await request(handler).get(
        "/api/market?symbol=XAUUSD&interval=300",
      );
      expect(market.status).toBe(200);
      expect(market.headers["cache-control"]).toBe("no-store");
      expect(market.body.source).toBe("simulation");
      expect(market.body.candles).toHaveLength(180);
      expect(market.body.candles[1].time - market.body.candles[0].time).toBe(
        300,
      );
    }
  });

  it("never serves SPA HTML for invalid API paths or queries", async () => {
    const unknown = await request(handler).get("/api/unknown");
    expect(unknown.status).toBe(404);
    expect(unknown.type).toBe("application/json");
    const invalid = await request(handler).get("/api/market?symbol=INVALID");
    expect(invalid.status).toBe(400);
    expect(invalid.headers["cache-control"]).toBe("no-store");
  });

  it("rejects every live order method even when backend credentials are configured", async () => {
    vi.stubEnv("EXN_API_KEY", "test-backend-only");
    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "options",
    ] as const) {
      const response = await request(handler)[method]("/api/orders");
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "Live trading is disabled" });
      expect(JSON.stringify(response.body)).not.toContain("test-backend-only");
    }
  });
});
