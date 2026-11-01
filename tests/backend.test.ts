import { afterEach, describe, it, expect, vi } from "vitest";
import request from "supertest";
import { app } from "../server/app";
import { candles, market } from "../server/market";
afterEach(() => {
  delete process.env.EXNESS_DATA_URL;
  delete process.env.EXNESS_API_KEY;
  vi.unstubAllGlobals();
});
describe("safe market backend", () => {
  it("defaults to simulation and rejects live execution", async () => {
    const health = await request(app).get("/api/health");
    expect(health.body.liveTrading).toBe(false);
    for (const method of ["post", "get"] as const) {
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
  it("uses server-side auth without returning credentials", async () => {
    process.env.EXNESS_DATA_URL = "https://bridge.example/candles";
    process.env.EXNESS_API_KEY = "test-only-secret";
    const fetcher = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ candles: candles("EURUSD") }),
      });
    vi.stubGlobal("fetch", fetcher);
    const r = await request(app).get("/api/market?symbol=EURUSD");
    expect(r.body.source).toBe("exness-bridge");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer test-only-secret",
    );
    expect(JSON.stringify(r.body)).not.toContain("test-only-secret");
  });
  it("fails closed on malformed data and sanitizes errors", async () => {
    process.env.EXNESS_DATA_URL = "https://bridge.example";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ candles: [{ time: 1, open: -1 }] }),
        }),
    );
    const r = await request(app).get("/api/market?symbol=XAUUSD");
    expect(r.status).toBe(502);
    expect(r.body.error).toBe(
      "Market provider unavailable. Check backend configuration.",
    );
  });
  it("rejects insecure upstream and unordered candles", async () => {
    process.env.EXNESS_DATA_URL = "http://bridge.example";
    await expect(market("XAUUSD", 3600)).rejects.toThrow("HTTPS");
    process.env.EXNESS_DATA_URL = "https://bridge.example";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ candles: candles("XAUUSD").reverse() }),
        }),
    );
    await expect(market("XAUUSD", 3600)).rejects.toThrow("Invalid time order");
  });
});
