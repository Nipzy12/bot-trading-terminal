import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import request from "supertest";
import { app } from "../server/app";
import { ExnessReader } from "../server/exness";
import { limitedJson } from "../server/http-json";
import { demoHistory } from "../server/backtest-history";
import { loadHistory } from "../src/backtest-loader";
const now = Date.UTC(2026, 10, 2, 12, 30);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
function fixture(
  options: { max?: number; age?: number; rate?: number; empty?: boolean } = {},
) {
  const paths: string[] = [];
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
                    history_age_days: options.age ?? 365,
                    history_range_days: 1,
                  },
                },
              ],
            },
          },
        });
      if (url.pathname.endsWith("instruments"))
        return Response.json({ instruments: ["XAUUSDm"] });
      expect(url.searchParams.get("count")).toBeNull();
      expect(url.searchParams.get("instrument")).toBe("XAUUSDm");
      const from = Date.parse(url.searchParams.get("from")!) / 1000,
        to = Date.parse(url.searchParams.get("to")!) / 1000;
      return Response.json({
        candles: options.empty
          ? []
          : Array.from({ length: (to - from) / 3600 }, (_, i) => ({
              time: new Date((from + i * 3600) * 1000).toISOString(),
              open: 3900,
              high: 3901,
              low: 3899,
              close: 3900,
            })),
      });
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
    ).rejects.toMatchObject({ code: "EXNESS_HISTORY_WINDOW" });
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
