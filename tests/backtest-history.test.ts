import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import request from "supertest";
import { app } from "../server/app";
import { ExnessReader } from "../server/exness";
import { limitedJson } from "../server/http-json";
import { demoHistory } from "../server/backtest-history";
import { historyFailure } from "../server/history-errors";
import { loadHistory, HistoryLoadError } from "../src/backtest-loader";
const now = Date.UTC(2026, 10, 2, 12, 30);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
function fixture(
  options: {
    max?: number;
    age?: number | null;
    range?: number | null;
    rate?: number;
    empty?: boolean;
    emptyPages?: number[];
    providerErrorAt?: number;
    providerCode?: number;
    providerStatus?: number;
    boundaryAt?: number;
    identicalBoundary?: boolean;
    allBoundaries?: boolean;
  } = {},
) {
  const paths: string[] = [];
  let candleRequests = 0;
  const transport = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(url.pathname + url.search);
      const headers = init!.headers as Record<string, string>;
      const payload = Buffer.from(headers["EXN-DATA"], "base64url");
      expect(
        verify(
          null,
          payload,
          publicKey,
          Buffer.from(headers["EXN-SIGN"], "base64url"),
        ),
      ).toBe(true);
      expect(JSON.parse(payload.toString()).path).toBe(
        url.pathname + url.search,
      );
      expect(init!.method).toBe("GET");
      if (url.pathname.endsWith("access-point"))
        return Response.json({
          account_id: "123456",
          access_point: "https://ap.exness.test",
        });
      if (url.pathname.endsWith("limits"))
        return Response.json({
          limits: {
            rest: {
              global_account_rate: { limit: 1000, window_seconds: 60 },
              methods: [
                {
                  api_operation_id: "getCandleHistory",
                  http_method: "GET",
                  path: "/v1/market-data/accounts/{account_id}/candles",
                  rate_limit: {
                    limit: options.rate ?? 100,
                    window_seconds: 60,
                  },
                  limits: {
                    max_candles_per_request: options.max ?? 3,
                    ...(options.age === null
                      ? {}
                      : { history_age_days: options.age ?? 365 }),
                    ...(options.range === null
                      ? {}
                      : { history_range_days: options.range ?? 1 }),
                  },
                },
              ],
            },
          },
        });
      if (url.pathname.endsWith("instruments"))
        return Response.json({ instruments: ["XAUUSDm"] });
      if (url.searchParams.get("count") === "1") {
        expect(url.searchParams.get("to")).toBeNull();
        return Response.json({
          candles: [
            {
              time: url.searchParams.get("from"),
              open: 3900,
              high: 3901,
              low: 3899,
              close: 3900,
            },
          ],
        });
      }
      expect(url.searchParams.get("count")).toBeNull();
      expect(url.searchParams.get("instrument")).toBe("XAUUSDm");
      const from = Date.parse(url.searchParams.get("from")!) / 1000,
        to = Date.parse(url.searchParams.get("to")!) / 1000;
      candleRequests++;
      if (options.providerErrorAt === candleRequests)
        return Response.json(
          {
            code: options.providerCode,
            error_message: "secret-price-account-host",
          },
          { status: options.providerStatus ?? 400 },
        );
      const rows =
        options.empty || options.emptyPages?.includes(candleRequests)
          ? []
          : Array.from({ length: (to - from) / 3600 }, (_, i) => ({
              time: new Date((from + i * 3600) * 1000).toISOString(),
              open: 3900,
              high: 3901,
              low: 3899,
              close: 3900,
            }));
      if (
        options.boundaryAt === candleRequests ||
        (options.allBoundaries && to < Math.floor(now / 1000 / 3600) * 3600)
      )
        rows.push({
          time: new Date(to * 1000).toISOString(),
          open: options.identicalBoundary ? 3900 : 3900.5,
          high: 3901,
          low: 3899,
          close: 3900,
        });
      return Response.json({ candles: rows });
    },
  );
  const guard = vi.fn(async () => {});
  const reader = new ExnessReader(
    {
      apiKey: "synthetic",
      privateKey: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      accountId: "123456",
      gateway: "https://gateway.exness.test",
    },
    transport,
    () => now,
    guard,
  );
  return { reader, paths, guard };
}
describe("bounded read-only paginated history", () => {
  it("uses signed contiguous exclusive windows, provider limits, isolated cache and quota guard", async () => {
    const f = fixture();
    const first = await f.reader.historyPage("XAUUSD", 3600);
    const cached = await f.reader.historyPage("XAUUSD", 3600);
    expect(cached).toBe(first);
    expect(first.candles).toHaveLength(3);
    expect(first.window.to - first.window.from).toBe(3 * 3600);
    const older = await f.reader.historyPage("XAUUSD", 3600, first.nextBefore!);
    expect(older.window.to).toBe(first.window.from);
    expect(older.candles.at(-1)!.time).toBeLessThan(first.candles[0].time);
    expect(f.paths.filter((p) => p.includes("/candles?"))).toHaveLength(2);
    expect(f.guard).toHaveBeenCalled();
    const other = fixture();
    await other.reader.historyPage("XAUUSD", 3600);
    expect(other.paths.filter((p) => p.includes("/candles?"))).toHaveLength(1);
  });
  it("honors oldest provider boundary and rejects future and unaligned cursors", async () => {
    const f = fixture({ age: 1, max: 5000 });
    const first = await f.reader.historyPage("XAUUSD", 3600);
    expect(first.candles).toHaveLength(23);
    expect(first.nextBefore).toBeNull();
    await expect(
      f.reader.historyPage("XAUUSD", 3600, first.window.from),
    ).rejects.toMatchObject({ code: "HISTORY_LIMIT_REACHED" });
    await expect(
      f.reader.historyPage("XAUUSD", 3600, first.window.to + 3600),
    ).rejects.toMatchObject({ code: "EXNESS_HISTORY_WINDOW" });
    await expect(
      f.reader.historyPage("XAUUSD", 3600, first.window.to - 1),
    ).rejects.toMatchObject({ code: "EXNESS_HISTORY_WINDOW" });
  });
  it("stops on quota exhaustion instead of automatically retrying", async () => {
    const f = fixture({ rate: 1 });
    const page = await f.reader.historyPage("XAUUSD", 3600);
    await expect(
      f.reader.historyPage("XAUUSD", 3600, page.nextBefore!),
    ).rejects.toMatchObject({ code: "EXNESS_RATE_LIMIT", status: 429 });
    expect(f.paths.filter((p) => p.includes("/candles?"))).toHaveLength(1);
  });
  it("reports empty session windows explicitly without fabricating candles", async () => {
    const f = fixture({ empty: true });
    const page = await f.reader.historyPage("XAUUSD", 3600);
    expect(page).toMatchObject({
      emptyWindow: true,
      candles: [],
      excludedBoundaryCandles: 0,
    });
    expect(page.nextBefore).toBe(page.window.from);
  });
  it("enforces the adapter deadline even when transport ignores abort", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(), ms);
      return c.signal;
    });
    try {
      const reader = new ExnessReader(
        {
          apiKey: "synthetic",
          privateKey: privateKey
            .export({ format: "pem", type: "pkcs8" })
            .toString(),
          accountId: "123456",
          gateway: "https://gateway.exness.test",
        },
        () => new Promise(() => {}),
        () => now,
      );
      const assertion = expect(
        reader.historyPage("XAUUSD", 3600),
      ).rejects.toMatchObject({ code: "TIMEOUT", status: 504 });
      await vi.advanceTimersByTimeAsync(8001);
      await assertion;
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
  it("caps response bytes, handles malformed JSON and cancels stalled streams", async () => {
    await expect(
      limitedJson(
        new Response("x".repeat(101)),
        new AbortController().signal,
        100,
      ),
    ).rejects.toMatchObject({ code: "EXNESS_RESPONSE_TOO_LARGE" });
    await expect(
      limitedJson(
        new Response("{}", { headers: { "content-length": "200" } }),
        new AbortController().signal,
        100,
      ),
    ).rejects.toMatchObject({ code: "EXNESS_RESPONSE_TOO_LARGE" });
    await expect(
      limitedJson(new Response("not-json"), new AbortController().signal),
    ).rejects.toThrow();
    const controller = new AbortController(),
      response = new Response(new ReadableStream({ start() {} }));
    const pending = limitedJson(response, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("serves public closed DEMO pages and keeps all broker orders denied", async () => {
    const response = await request(app).get(
      "/api/backtest/history?symbol=XAUUSD&interval=3600",
    );
    expect(response.status).toBe(200);
    expect(response.body.paperSource).toEqual({ kind: "DEMO" });
    expect(response.body.live).toBe(false);
    expect(response.body.candles.at(-1).time + 3600).toBeLessThanOrEqual(
      Date.now() / 1000,
    );
    const next = await request(app).get(
      `/api/backtest/history?symbol=XAUUSD&interval=3600&before=${response.body.nextBefore}`,
    );
    expect(next.body.window.to).toBe(response.body.window.from);
    expect(
      (
        await request(app).get(
          "/api/backtest/history?symbol=XAUUSD&count=50000",
        )
      ).status,
    ).toBe(400);
    expect((await request(app).post("/api/orders")).status).toBe(403);
  });
  it("counts empty pagination gaps, rejects unflagged emptiness and fails wholly empty runs", async () => {
    let calls = 0;
    const transport = async (input: string | URL | Request) => {
      const u = new URL(String(input), "https://nexus.test");
      const page = demoHistory(
        "XAUUSD",
        3600,
        u.searchParams.has("before")
          ? Number(u.searchParams.get("before"))
          : undefined,
      );
      calls++;
      return Response.json(
        calls === 2 ? { ...page, candles: [], emptyWindow: true } : page,
      );
    };
    const result = await loadHistory(
      "DEMO",
      "XAUUSD",
      3600,
      540,
      new AbortController().signal,
      () => {},
      transport,
    );
    expect(result.emptyWindows).toBe(1);
    expect(result.bars).toHaveLength(360);
    const blank = async () =>
      Response.json({
        ...demoHistory("XAUUSD", 3600),
        candles: [],
        emptyWindow: true,
        nextBefore: null,
      });
    await expect(
      loadHistory(
        "DEMO",
        "XAUUSD",
        3600,
        180,
        new AbortController().signal,
        () => {},
        blank,
      ),
    ).rejects.toThrow("INSUFFICIENT_HISTORY");
    await expect(
      loadHistory(
        "DEMO",
        "XAUUSD",
        3600,
        180,
        new AbortController().signal,
        () => {},
        async () =>
          Response.json({ ...demoHistory("XAUUSD", 3600), candles: [] }),
      ),
    ).rejects.toThrow("INVALID_HISTORY_SCHEMA");
  });
  it("loads pages chronologically and refuses source changes, invalid data, and 429", async () => {
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "https://nexus.test");
      return Response.json(
        demoHistory(
          "XAUUSD",
          3600,
          url.searchParams.has("before")
            ? Number(url.searchParams.get("before"))
            : undefined,
        ),
      );
    });
    const result = await loadHistory(
      "DEMO",
      "XAUUSD",
      3600,
      360,
      new AbortController().signal,
      () => {},
      transport,
    );
    expect(result.bars).toHaveLength(360);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.bars[0].time).toBeLessThan(result.bars.at(-1)!.time);
    let calls = 0;
    const switching = async (input: string | URL | Request) => {
      const r = await transport(input);
      const page = await r.json();
      return Response.json({
        ...page,
        source: "exness",
        kind: "candle-history",
        paperSource: {
          kind: "EXNESS",
          connectionId:
            ++calls === 1
              ? "11111111-1111-4111-8111-111111111111"
              : "22222222-2222-4222-8222-222222222222",
        },
      });
    };
    await expect(
      loadHistory(
        "EXNESS",
        "XAUUSD",
        3600,
        360,
        new AbortController().signal,
        () => {},
        switching,
      ),
    ).rejects.toThrow("FEED_CHANGED");
    await expect(
      loadHistory(
        "DEMO",
        "XAUUSD",
        3600,
        180,
        new AbortController().signal,
        () => {},
        async () => new Response("", { status: 429 }),
      ),
    ).rejects.toThrow("RATE_LIMITED");
    const bad = {
      ...demoHistory("XAUUSD", 3600),
      candles: [{ time: 1, open: 1, high: 0, low: 1, close: 1 }],
    };
    await expect(
      loadHistory(
        "DEMO",
        "XAUUSD",
        3600,
        180,
        new AbortController().signal,
        () => {},
        async () => Response.json(bad),
      ),
    ).rejects.toThrow();
  });
});

const source = {
  kind: "EXNESS" as const,
  connectionId: "11111111-1111-4111-8111-111111111111",
};
function bridge(f: ReturnType<typeof fixture>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const u = new URL(String(input), "https://nexus.test");
    try {
      const page = await f.reader.historyPage(
        "XAUUSD",
        3600,
        u.searchParams.has("before")
          ? Number(u.searchParams.get("before"))
          : undefined,
        Number(u.searchParams.get("windowIntervals") ?? 180),
      );
      return Response.json({
        ...page,
        source: "exness",
        kind: "candle-history",
        live: false,
        paperSource: source,
      });
    } catch (error) {
      const fail = historyFailure(error, Object.fromEntries(u.searchParams));
      return Response.json(
        { ...fail.body, paperSource: source },
        { status: fail.status },
      );
    }
  });
}
const run = (transport: typeof fetch, slots = 1440) =>
  loadHistory(
    "EXNESS",
    "XAUUSD",
    3600,
    slots,
    new AbortController().signal,
    () => {},
    transport,
  );
describe("long-window pagination and safe diagnostics", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
  afterEach(() => vi.restoreAllMocks());
  it.each([180, 360, 720, 1440, 2160])(
    "loads %i intervals through signed disjoint bounded windows",
    async (slots) => {
      const f = fixture({ max: 180, range: 10, age: null }),
        transport = bridge(f);
      const result = await run(transport, slots);
      expect(result.bars).toHaveLength(slots);
      expect(result.loadedIntervals).toBe(slots);
      expect(result.truncated).toBe(false);
      expect(result.historyAgeKnown).toBe(false);
      expect(transport).toHaveBeenCalledTimes(slots / 180);
      const paths = f.paths.filter((p) => p.includes("/candles?"));
      for (let i = 1; i < paths.length; i++) {
        const older = new URL(paths[i], "https://nexus.test"),
          newer = new URL(paths[i - 1], "https://nexus.test");
        expect(older.searchParams.get("to")).toBe(
          newer.searchParams.get("from"),
        );
      }
    },
  );
  it.each([180, 360, 720, 1440, 2160])(
    "proves and excludes historical duplicates for %i intervals",
    async (slots) => {
      const f = fixture({
        max: 180,
        range: 10,
        age: null,
        allBoundaries: true,
        identicalBoundary: true,
      });
      const result = await run(bridge(f), slots);
      expect(result.bars.length).toBe(slots);
      expect(new Set(result.bars.map((b) => b.time)).size).toBe(slots);
      expect(result.historicalBoundaryExcluded).toBe(slots / 180 - 1);
    },
  );
  it("proves a historical boundary on a cold reader with a signed one-candle read", async () => {
    const f = fixture({
      max: 180,
      range: 10,
      age: null,
      allBoundaries: true,
      identicalBoundary: true,
    });
    const page = await f.reader.historyPage(
      "XAUUSD",
      3600,
      Math.floor(now / 1000 / 3600) * 3600 - 180 * 3600,
    );
    expect(page.candles.length).toBe(180);
    expect(page.boundaryDiagnostic).toBe("HISTORICAL_BOUNDARY_DUPLICATE");
    expect(f.paths.some((p) => p.includes("count=1"))).toBe(true);
  });
  it("caps the last request by remaining intervals and respects provider range separately from age", async () => {
    const f = fixture({ max: 128, range: 10, age: null });
    const result = await run(bridge(f), 1440);
    expect(result.loadedIntervals).toBe(1440);
    expect(result.bars).toHaveLength(1440);
    const query = new URL(f.paths.at(-1)!, "https://nexus.test").searchParams;
    expect(
      (Date.parse(query.get("to")!) - Date.parse(query.get("from")!)) / 3600000,
    ).toBe(32);
    const small = fixture({ max: 180, range: 1, age: null });
    const partial = await run(bridge(small), 720);
    expect(partial.loadedIntervals).toBe(288);
    expect(partial.diagnostic).toMatchObject({
      category: "PAGE_BUDGET_REACHED",
      pageIndex: 12,
      loadedIntervals: 288,
      validCandles: 288,
    });
  });
  it("does not invent a 365-day age limit when the provider omits it", async () => {
    const f = fixture({ age: null, max: 180, range: 10 });
    const to = Math.floor(now / 1000 / 3600) * 3600 - 400 * 86400;
    const page = await f.reader.historyPage("XAUUSD", 3600, to);
    expect(page.historyAgeKnown).toBe(false);
    expect(page.nextBefore).toBe(page.window.from);
    expect(page.candles).toHaveLength(180);
  });
  it("truncates at declared age with no requests beyond the provider boundary", async () => {
    const f = fixture({ age: 30, max: 180, range: 10 }),
      transport = bridge(f);
    const result = await run(transport, 1440);
    expect(result.truncated).toBe(true);
    expect(result.bars).toHaveLength(719);
    expect(result.loadedIntervals).toBe(719);
    expect(result.diagnostic).toMatchObject({
      category: "HISTORY_LIMIT_REACHED",
      httpStatus: 200,
      pageIndex: 4,
      validCandles: 719,
      limitCause: "PROVIDER_AGE",
    });
    expect(transport).toHaveBeenCalledTimes(4);
    for (const path of f.paths.filter((p) => p.includes("/candles?")))
      expect(
        Date.parse(
          new URL(path, "https://nexus.test").searchParams.get("from")!,
        ),
      ).toBeGreaterThanOrEqual(now - 30 * 86400000);
  });
  it("offers only validated sample when older data is explicitly unavailable, including empty historical pages", async () => {
    const f = fixture({
        max: 180,
        range: 10,
        age: null,
        emptyPages: [3],
        providerErrorAt: 5,
        providerCode: 4004,
      }),
      transport = bridge(f);
    const result = await run(transport, 2160);
    expect(result.truncated).toBe(true);
    expect(result.emptyWindows).toBe(1);
    expect(result.bars).toHaveLength(540);
    expect(result.diagnostic).toMatchObject({
      category: "HISTORY_LIMIT_REACHED",
      httpStatus: 400,
      pageIndex: 5,
      loadedIntervals: 720,
      validCandles: 540,
      providerCode: 4004,
      limitCause: "PROVIDER_DATA_UNAVAILABLE",
    });
    expect(transport).toHaveBeenCalledTimes(5);
  });
  it.each([
    [3004, "EXNESS_INVALID_TIME_RANGE"],
    [3005, "EXNESS_INVALID_COUNT"],
    [3006, "EXNESS_INVALID_LIMIT"],
    [3007, "EXNESS_INVALID_CURSOR"],
    [4000, "EXNESS_MARKET_DATA"],
    [3, "EXNESS_INTERNAL_FAILURE"],
  ] as const)(
    "preserves provider %i as %s instead of claiming history exhaustion",
    async (providerCode, category) => {
      const f = fixture({
          max: 180,
          range: 10,
          age: null,
          providerErrorAt: 5,
          providerCode,
        }),
        transport = bridge(f);
      try {
        await run(transport);
        throw Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(HistoryLoadError);
        const d = (error as HistoryLoadError).diagnostic;
        expect(d).toMatchObject({
          category,
          httpStatus: 400,
          pageIndex: 5,
          loadedIntervals: 720,
          validCandles: 720,
          providerCode,
          upstreamStatus: 400,
        });
        for (const forbidden of [
          "secret-price-account-host",
          "123456",
          "3900",
          "https://",
        ]) {
          expect(JSON.stringify(d)).not.toContain(forbidden);
          expect((error as Error).message).not.toContain(forbidden);
        }
      }
      expect(transport).toHaveBeenCalledTimes(5);
    },
  );
  it("never masks an old boundary violation or uses its invalid page in counts", async () => {
    const f = fixture({ max: 180, range: 10, age: null, boundaryAt: 5 });
    await expect(run(bridge(f))).rejects.toMatchObject({
      diagnostic: {
        category: "EXNESS_INVALID_RESPONSE",
        pageIndex: 5,
        loadedIntervals: 720,
        validCandles: 720,
        reason: "OUT_OF_RANGE",
        rangeReason: "AT_TO",
      },
    });
  });
  it("reports rate limit progress and makes no automatic retry", async () => {
    const f = fixture({ max: 180, range: 10, age: null, rate: 4 }),
      transport = bridge(f);
    await expect(run(transport)).rejects.toMatchObject({
      diagnostic: {
        category: "RATE_LIMITED",
        httpStatus: 429,
        pageIndex: 5,
        loadedIntervals: 720,
        validCandles: 720,
      },
    });
    expect(transport).toHaveBeenCalledTimes(5);
    expect(f.paths.filter((p) => p.includes("/candles?"))).toHaveLength(4);
  });
  it.each([
    ["EXNESS_HISTORY_WINDOW", 400],
    ["EXNESS_AUTH", 401],
    ["EXNESS_PERMISSION", 403],
    ["TIMEOUT", 504],
    ["secret host or account", 500],
  ] as const)(
    "preserves safe category or redacts internal text for HTTP %s",
    async (error, status) => {
      let calls = 0;
      const transport = bridge(fixture({ max: 180, range: 10, age: null }));
      const wrapped: typeof fetch = async (input, init) =>
        ++calls === 5
          ? Response.json({ error }, { status })
          : transport(input, init);
      await expect(run(wrapped)).rejects.toMatchObject({
        diagnostic: {
          category: error.startsWith("secret")
            ? "HISTORY_INTERNAL_FAILURE"
            : error,
          httpStatus: status,
          pageIndex: 5,
          loadedIntervals: 720,
          validCandles: 720,
        },
      });
    },
  );
  it("reports no-response network failures without exposing transport text", async () => {
    const transport = bridge(fixture({ max: 180, range: 10, age: null }));
    let calls = 0;
    const wrapped: typeof fetch = async (input, init) => {
      if (++calls === 5) throw Error("private transport host or key");
      return transport(input, init);
    };
    await expect(run(wrapped)).rejects.toMatchObject({
      diagnostic: {
        category: "EXNESS_NETWORK",
        httpStatus: 0,
        pageIndex: 5,
        loadedIntervals: 720,
        validCandles: 720,
      },
    });
    expect(calls).toBe(5);
  });
  it("bounds a stalled frontend page even when the transport ignores abort", async () => {
    vi.useFakeTimers({ now });
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(), ms);
      return c.signal;
    });
    try {
      const transport = bridge(fixture({ max: 180, range: 10, age: null }));
      let calls = 0;
      const wrapped: typeof fetch = async (input, init) =>
        ++calls === 5 ? new Promise(() => {}) : transport(input, init);
      const assertion = expect(run(wrapped)).rejects.toMatchObject({
        diagnostic: {
          category: "TIMEOUT",
          httpStatus: 0,
          pageIndex: 5,
          loadedIntervals: 720,
          validCandles: 720,
        },
      });
      await vi.advanceTimersByTimeAsync(10001);
      await assertion;
      expect(calls).toBe(5);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
  it("rejects truncated samples from a changed connection", async () => {
    const transport = bridge(fixture({ max: 180, range: 10, age: null }));
    let calls = 0;
    const wrapped: typeof fetch = async (input, init) =>
      ++calls === 5
        ? Response.json(
            {
              error: "EXNESS_DATA_UNAVAILABLE",
              providerCode: 4004,
              paperSource: {
                ...source,
                connectionId: "22222222-2222-4222-8222-222222222222",
              },
            },
            { status: 400 },
          )
        : transport(input, init);
    await expect(run(wrapped)).rejects.toMatchObject({
      diagnostic: { category: "FEED_CHANGED", pageIndex: 5, validCandles: 720 },
    });
  });
});
