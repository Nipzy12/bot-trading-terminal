import { afterEach, describe, it, expect, vi } from "vitest";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import request from "supertest";
import {
  ExnessReader,
  loadKey,
  signedHeaders,
  normalizeHistory,
  timeframes,
  baseUrl,
  type Config,
} from "../server/exness";
import { app } from "../server/app";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const jwk = privateKey.export({ format: "jwk" });
const raw = Buffer.concat([
  Buffer.from(jwk.d!, "base64url"),
  Buffer.from(jwk.x!, "base64url"),
]).toString("hex");
const config: Config = {
  apiKey: "test-exnsk-id",
  privateKey: pem,
  accountId: "18446744073709551615",
  gateway: "https://gateway.exness.test",
};
const now = Date.UTC(2026, 10, 2, 12);
let clock = now;
function limits(max = 180, quota = 100) {
  return {
    limits: {
      rest: {
        global_account_rate: { limit: 1000, window_seconds: 60 },
        methods: [
          {
            api_operation_id: "getCandleHistory",
            http_method: "GET",
            path: "/v1/market-data/accounts/{account_id}/candles",
            rate_limit: { limit: quota, window_seconds: 60 },
            limits: { max_candles_per_request: max },
          },
        ],
      },
    },
  };
}
function fixture(
  options: {
    limit?: number;
    quota?: number;
    discovery?: unknown;
    history?: unknown;
    failure?: Response;
  } = {},
) {
  const transport = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const headers = init!.headers as Record<string, string>;
      const bytes = Buffer.from(headers["EXN-DATA"], "base64url");
      const data = JSON.parse(bytes.toString());
      expect(data.path).toBe(u.pathname + u.search);
      expect(data.method).toBe("GET");
      expect(data.idempotency_key).toBe("");
      expect(data.timestamp).toBe(Number(headers["EXN-TIMESTAMP"]));
      expect(
        verify(
          null,
          bytes,
          publicKey,
          Buffer.from(headers["EXN-SIGN"], "base64url"),
        ),
      ).toBe(true);
      expect(init!.redirect).toBe("error");
      if (u.pathname === "/v1/trading/access-point")
        return Response.json(
          options.discovery ?? {
            access_point: "https://ap.exness.test",
            account_id: config.accountId,
          },
        );
      expect(u.origin).toBe("https://ap.exness.test");
      if (u.pathname.endsWith("/limits"))
        return Response.json(limits(options.limit, options.quota));
      if (options.failure) return options.failure.clone();
      const start = Date.parse(u.searchParams.get("from")!);
      const interval = Number(
        Object.entries(timeframes).find(
          ([, v]) => v === u.searchParams.get("timeframe"),
        )![0],
      );
      const count = Number(u.searchParams.get("count"));
      return Response.json(
        options.history ?? {
          candles: Array.from({ length: count }, (_, i) => ({
            time: new Date(start + i * interval * 1000).toISOString(),
            open: 100,
            high: 103,
            low: 98,
            close: 101,
            volume: 0,
          })),
        },
      );
    },
  );
  return transport;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clock = now;
});
describe("Exness read-only adapter contract", () => {
  it("imports documented PEM and seed+public hex, signs exact UTF-8 bytes with empty body hash", () => {
    for (const input of [pem, raw, pem.replace(/\n/g, "\\n")]) {
      const key = loadKey(input);
      expect(createPublicKey(key).export({ format: "jwk" }).x).toBe(jwk.x);
      const headers = signedHeaders(
        config.apiKey,
        key,
        "/v1/test?instrument=XAUUSD&from=2026-11-02T00%3A00%3A00Z",
        now,
      );
      const data = JSON.parse(
        Buffer.from(headers["EXN-DATA"], "base64url").toString(),
      );
      expect(data).toMatchObject({
        timestamp: now,
        method: "GET",
        sign_version: 1,
        idempotency_key: "",
        body_hash: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
      });
      expect(headers["EXN-IDEMPOTENCY-KEY"]).toBe("");
      expect(headers["EXN-SIGN"]).not.toContain("=");
      expect(
        verify(
          null,
          Buffer.from(headers["EXN-DATA"], "base64url"),
          publicKey,
          Buffer.from(headers["EXN-SIGN"], "base64url"),
        ),
      ).toBe(true);
    }
  });
  it("rejects malformed/mismatched and non-Ed25519 keys, unsafe hosts and account ids", () => {
    for (const key of [
      "bad",
      raw.slice(0, 64) + "0".repeat(64),
      generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    ])
      expect(() => loadKey(key)).toThrow();
    for (const url of [
      "http://gateway.test",
      "https://user:secret@host.test",
      "https://host.test/path",
      "https://127.0.0.1",
      "https://host.test?x=1",
    ])
      expect(() => baseUrl(url)).toThrow();
    for (const id of ["0", "-1", "18446744073709551616", "../bad"])
      expect(() => new ExnessReader({ ...config, accountId: id })).toThrow(
        "EXNESS_CONFIGURATION",
      );
  });
  it.each(Object.entries(timeframes))(
    "discovers Gateway, loads effective limits, maps %s to %s and validates history",
    async (interval, timeframe) => {
      const transport = fixture({ limit: 3 });
      const reader = new ExnessReader(config, transport, () => clock);
      const rows = await reader.candles("XAUUSD", Number(interval));
      expect(rows).toHaveLength(3);
      expect(rows[1].time - rows[0].time).toBe(Number(interval));
      expect(transport).toHaveBeenCalledTimes(3);
      expect(String(transport.mock.calls[0][0])).toContain(
        "/v1/trading/access-point?account_id=" + config.accountId,
      );
      const query = new URL(String(transport.mock.calls[2][0])).searchParams;
      expect(query.get("timeframe")).toBe(timeframe);
      expect(query.get("price_type")).toBe("bid");
      expect(query.get("to")).toBeNull();
      expect(query.get("count")).toBe("3");
    },
  );
  it("caches discovery and coalesces same-market concurrent requests", async () => {
    const transport = fixture();
    const reader = new ExnessReader(config, transport, () => clock);
    await Promise.all([
      reader.candles("XAUUSD", 300),
      reader.candles("XAUUSD", 300),
    ]);
    await reader.candles("XAUUSD", 300);
    expect(transport).toHaveBeenCalledTimes(3);
    clock += 6000;
    await reader.candles("XAUUSD", 300);
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it("rejects discovery mismatch, invalid payloads, unordered OHLC and empty data", async () => {
    for (const discovery of [
      { account_id: "wrong", access_point: "https://ap.exness.test" },
      { account_id: config.accountId, access_point: "http://bad.test" },
    ])
      await expect(
        new ExnessReader(config, fixture({ discovery }), () => clock).candles(
          "XAUUSD",
          300,
        ),
      ).rejects.toThrow();
    for (const body of [
      { candles: [] },
      { candles: [{ time: now, open: 1 }] },
      {
        candles: [
          {
            time: "2026-11-02T10:00:00Z",
            open: 10,
            high: 9,
            low: 11,
            close: 10,
          },
        ],
      },
    ])
      expect(() => normalizeHistory(body, 180)).toThrow(
        "EXNESS_INVALID_RESPONSE",
      );
    const c = {
      time: "2026-11-02T10:00:00Z",
      open: 10,
      high: 11,
      low: 9,
      close: 10,
    };
    expect(() => normalizeHistory({ candles: [c, c] }, 180)).toThrow();
  });
  it("does not retry a 429, respects Retry-After and blocks requests during cooldown", async () => {
    const transport = fixture({
      failure: Response.json(
        { code: 3015, error_message: "REQUEST_RATE_LIMIT" },
        { status: 429, headers: { "Retry-After": "30" } },
      ),
    });
    const reader = new ExnessReader(config, transport, () => clock);
    await expect(reader.candles("XAUUSD", 300)).rejects.toMatchObject({
      code: "EXNESS_RATE_LIMIT",
      retryAfter: 30,
      status: 429,
    });
    expect(transport).toHaveBeenCalledTimes(3);
    await expect(reader.candles("XAUUSD", 300)).rejects.toMatchObject({
      status: 429,
    });
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it("honors endpoint quota before another upstream call", async () => {
    const transport = fixture({ quota: 1 });
    const reader = new ExnessReader(config, transport, () => clock);
    await reader.candles("XAUUSD", 300);
    await expect(reader.candles("EURUSD", 300)).rejects.toMatchObject({
      status: 429,
    });
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it.each([401, 403, 500, 503])(
    "sanitizes upstream HTTP %s without retries",
    async (status) => {
      const transport = fixture({
        failure: Response.json(
          { description: "private upstream diagnostics" },
          { status },
        ),
      });
      await expect(
        new ExnessReader(config, transport, () => clock).candles("XAUUSD", 300),
      ).rejects.toThrow(status < 500 ? "EXNESS_AUTH" : "EXNESS_UPSTREAM");
      expect(transport).toHaveBeenCalledTimes(3);
    },
  );
  it("handles timeout/network exceptions with sanitized errors", async () => {
    const transport = vi
      .fn()
      .mockRejectedValue(new Error("private timeout details"));
    await expect(
      new ExnessReader(config, transport, () => clock).candles("XAUUSD", 300),
    ).rejects.toThrow("EXNESS_NETWORK");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("labels successful API candle history as EXNESS without a live claim or signing fields", async () => {
    for (const [key, value] of Object.entries({
      EXN_API_KEY: config.apiKey,
      EXN_PRIVATE_KEY: pem,
      EXN_ACCOUNT_ID: config.accountId,
      EXN_DISCOVERY_BASE_URL: config.gateway,
    }))
      vi.stubEnv(key, value);
    vi.stubGlobal("fetch", fixture({ limit: 2 }));
    const r = await request(app).get("/api/market?symbol=XAUUSD&interval=900");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      label: "EXNESS",
      source: "exness",
      kind: "candle-history",
      live: false,
    });
    expect(r.body.candles).toHaveLength(2);
    expect(JSON.stringify(r.body)).not.toContain("EXN-SIGN");
    expect(JSON.stringify(r.body)).not.toContain(config.apiKey);
  });
  it("refuses history without returned candle limits and rejects malformed JSON", async () => {
    const transport = fixture();
    const broken = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) =>
        String(url).endsWith("/limits")
          ? Response.json({
              limits: {
                rest: {
                  global_account_rate: { limit: 10, window_seconds: 60 },
                  methods: [],
                },
              },
            })
          : transport(url, init),
    );
    await expect(
      new ExnessReader(config, broken, () => clock).candles("XAUUSD", 300),
    ).rejects.toThrow("EXNESS_LIMITS_UNAVAILABLE");
    await expect(
      new ExnessReader(
        config,
        vi.fn().mockResolvedValue(new Response("bad json")),
        () => clock,
      ).candles("XAUUSD", 300),
    ).rejects.toThrow("EXNESS_INVALID_RESPONSE");
  });
  it("honors returned history range and global quota", async () => {
    const transport = fixture();
    const restricted = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const response = await transport(url, init);
        if (String(url).endsWith("/limits")) {
          const data = await response.json();
          data.limits.rest.methods[0].limits.history_range_days = 1;
          data.limits.rest.global_account_rate.limit = 3;
          return Response.json(data);
        }
        return response;
      },
    );
    const reader = new ExnessReader(config, restricted, () => clock);
    const rows = await reader.candles("XAUUSD", 86400);
    expect(rows).toHaveLength(1);
    await expect(reader.candles("EURUSD", 300)).rejects.toMatchObject({
      status: 429,
    });
  });
  it("API returns rate-limit contract without leaking credentials and never falls back to demo on configured errors", async () => {
    for (const [key, value] of Object.entries({
      EXN_API_KEY: config.apiKey,
      EXN_PRIVATE_KEY: raw,
      EXN_ACCOUNT_ID: config.accountId,
      EXN_DISCOVERY_BASE_URL: config.gateway,
    }))
      vi.stubEnv(key, value);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ retry_after: 20 }, { status: 429 })),
    );
    const r = await request(app).get("/api/market?symbol=XAUUSD");
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("20");
    expect(r.body).toEqual({ error: "EXNESS_RATE_LIMIT", retryAfter: 20 });
    expect(JSON.stringify(r.body)).not.toContain(config.apiKey);
    expect(JSON.stringify(r.body)).not.toContain(raw);
  });
});
