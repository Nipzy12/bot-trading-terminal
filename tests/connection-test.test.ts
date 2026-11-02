import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { ExnessReader, ProviderError } from "../server/exness";
import { connectionStages } from "../server/connection-test";
import { parseReport } from "../src/connection-report";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const secret = "synthetic-private-diagnostic-never-echo";
const config = {
  apiKey: secret,
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  accountId: "123456",
  gateway: "https://gateway.exness.test",
};
const now = Date.UTC(2026, 10, 2, 12);
function fixture(failAt?: string, fail?: () => Promise<Response>) {
  const seen: string[] = [];
  const transport = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const stage = u.pathname.endsWith("access-point")
        ? "discovery"
        : u.pathname.endsWith("/account")
          ? "account_details"
          : u.pathname.endsWith("/limits")
            ? "limits"
            : "candles";
      seen.push(stage);
      const headers = init!.headers as Record<string, string>;
      const payload = Buffer.from(headers["EXN-DATA"], "base64url");
      const signed = JSON.parse(payload.toString());
      expect(signed.path).toBe(u.pathname + u.search);
      expect(signed.method).toBe("GET");
      expect(init!.method).toBe("GET");
      expect(init!.redirect).toBe("error");
      expect(signed.body_hash).toBe(
        "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
      );
      expect(headers["EXN-IDEMPOTENCY-KEY"]).toBe("");
      expect(
        verify(
          null,
          payload,
          publicKey,
          Buffer.from(headers["EXN-SIGN"], "base64url"),
        ),
      ).toBe(true);
      if (stage === failAt) return fail!();
      if (stage === "discovery")
        return Response.json({
          account_id: config.accountId,
          access_point: "https://ap.exness.test",
        });
      expect(u.origin).toBe("https://ap.exness.test");
      if (stage === "account_details")
        return Response.json({
          account_id: config.accountId,
          create_date: "2024-03-14T11:46:30+00:00",
          account_name: secret,
        });
      if (stage === "limits")
        return Response.json({
          limits: {
            rest: {
              global_account_rate: { limit: 100, window_seconds: 60 },
              methods: [
                {
                  api_operation_id: "getCandleHistory",
                  http_method: "GET",
                  path: "/v1/market-data/accounts/{account_id}/candles",
                  rate_limit: { limit: 100, window_seconds: 60 },
                  limits: { max_candles_per_request: 2 },
                },
              ],
            },
          },
        });
      expect(u.searchParams.get("instrument")).toBe("XAUUSD");
      expect(u.searchParams.get("timeframe")).toBe("H1");
      expect(u.searchParams.get("to")).toBeNull();
      expect(u.searchParams.get("price_type")).toBe("bid");
      const start = Date.parse(u.searchParams.get("from")!);
      return Response.json({
        candles: [0, 1].map((i) => ({
          time: new Date(start + i * 3600000).toISOString(),
          open: 2700,
          high: 2702,
          low: 2698,
          close: 2701,
        })),
      });
    },
  );
  return { transport, seen };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("fresh staged Exness read-only probe", () => {
  it("runs discovery → account details → limits → H1 candles and returns no provider data", async () => {
    const { transport, seen } = fixture();
    const reader = new ExnessReader(config, transport, () => now);
    const report = await reader.testConnection();
    expect(report).toEqual({
      success: true,
      stages: connectionStages.map((stage) => ({ stage, status: "passed" })),
    });
    expect(seen).toEqual(connectionStages);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(config.accountId);
  });
  for (const stage of connectionStages) {
    it.each([
      [401, 1000, "EXNESS_AUTH"],
      [403, 1002, "EXNESS_PERMISSION"],
      [429, 3015, "RATE_LIMITED"],
      [503, 2, "EXNESS_UPSTREAM"],
    ] as const)(
      `${stage}: classifies HTTP %s safely and stops later stages`,
      async (status, code, expected) => {
        const { transport, seen } = fixture(stage, async () =>
          Response.json(
            { code, error_message: secret, description: config.privateKey },
            { status, headers: { "Retry-After": "30" } },
          ),
        );
        const report = await new ExnessReader(
          config,
          transport,
          () => now,
        ).testConnection();
        expect(report).toMatchObject({
          success: false,
          stage,
          error: expected,
        });
        expect(report.stages.map((r) => r.status)).toEqual(
          connectionStages.map((s) =>
            connectionStages.indexOf(s) < connectionStages.indexOf(stage)
              ? "passed"
              : s === stage
                ? "failed"
                : "not_run",
          ),
        );
        expect(seen).toEqual(
          connectionStages.slice(0, connectionStages.indexOf(stage) + 1),
        );
        expect(JSON.stringify(report)).not.toContain(secret);
        expect(JSON.stringify(report)).not.toContain(config.privateKey);
        if (status === 429) expect(report.retryAfter).toBe(30);
      },
    );
    it(`${stage}: rejects malformed response without blaming the key`, async () => {
      const { transport } = fixture(stage, async () =>
        Response.json({ sensitive: secret }),
      );
      const report = await new ExnessReader(
        config,
        transport,
        () => now,
      ).testConnection();
      expect(report).toMatchObject({ stage, error: "EXNESS_INVALID_RESPONSE" });
    });
    it(`${stage}: classifies DNS/TLS/network failure without exposing its message`, async () => {
      const { transport } = fixture(stage, async () => {
        throw Error(secret);
      });
      const report = await new ExnessReader(
        config,
        transport,
        () => now,
      ).testConnection();
      expect(report).toMatchObject({ stage, error: "EXNESS_NETWORK" });
      expect(JSON.stringify(report)).not.toContain(secret);
    });
    it(`${stage}: enforces a deadline even if transport ignores abort`, async () => {
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(
          () => controller.abort(new DOMException("Timeout", "TimeoutError")),
          ms,
        );
        return controller.signal;
      });
      const { transport } = fixture(stage, () => new Promise(() => {}));
      const pending = new ExnessReader(
        config,
        transport,
        () => now,
      ).testConnection();
      await vi.advanceTimersByTimeAsync(4501);
      const report = await pending;
      expect(report).toMatchObject({ stage, error: "TIMEOUT" });
    });
  }
  it("reports missing candle constraints at limits, after account authentication succeeds", async () => {
    const { transport } = fixture("limits", async () =>
      Response.json({
        limits: {
          rest: {
            global_account_rate: { limit: 100, window_seconds: 60 },
            methods: [],
          },
        },
      }),
    );
    const report = await new ExnessReader(
      config,
      transport,
      () => now,
    ).testConnection();
    expect(report).toMatchObject({
      stage: "limits",
      error: "EXNESS_LIMITS_UNAVAILABLE",
    });
    expect(report.stages[1].status).toBe("passed");
    expect(report.stages[3].status).toBe("not_run");
  });
  it("keeps successful authentication when candle quotes are unavailable", async () => {
    const { transport } = fixture("candles", async () =>
      Response.json(
        { code: 4004, error_message: "MARKET_NO_QUOTES" },
        { status: 503 },
      ),
    );
    const report = await new ExnessReader(
      config,
      transport,
      () => now,
    ).testConnection();
    expect(report).toMatchObject({
      stage: "candles",
      error: "EXNESS_MARKET_DATA",
    });
    expect(report.stages.slice(0, 3).every((s) => s.status === "passed")).toBe(
      true,
    );
  });
  it("preserves controlled SSRF rejection as a network-policy category", async () => {
    const { transport } = fixture("discovery", async () => {
      throw new ProviderError("EXNESS_SSRF");
    });
    expect(
      await new ExnessReader(config, transport, () => now).testConnection(),
    ).toMatchObject({ stage: "discovery", error: "EXNESS_SSRF" });
  });
  it("does not reuse cached candles for a manual probe", async () => {
    const { transport, seen } = fixture();
    const reader = new ExnessReader(config, transport, () => now);
    await reader.candles("XAUUSD", 3600);
    seen.length = 0;
    expect((await reader.testConnection()).success).toBe(true);
    expect(seen).toEqual(connectionStages);
  });
  it("signs with a fresh timestamp after slow quota checks", async () => {
    let clock = now;
    const { transport } = fixture("discovery", async () =>
      Response.json({ code: 1000 }, { status: 401 }),
    );
    await new ExnessReader(
      config,
      transport,
      () => clock,
      async () => {
        clock += 1000;
      },
    ).testConnection();
    expect(
      (transport.mock.calls[0][1]!.headers as Record<string, string>)[
        "EXN-TIMESTAMP"
      ],
    ).toBe(String(now + 1000));
  });
  it("frontend ignores unrecognized stage/code text rather than displaying raw diagnostics", () => {
    const report = parseReport({
      stage: secret,
      error: secret,
      stages: [{ stage: "candles", status: "failed", description: secret }],
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report?.stages[3].status).toBe("failed");
  });
});
