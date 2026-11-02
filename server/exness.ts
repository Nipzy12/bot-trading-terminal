import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { limitedJson } from "./http-json.js";
import { candleSchema } from "./validation.js";
import {
  normalizeHistory,
  instrumentNames,
  selectInstrument,
  CandleHistoryError,
  closedHistoryWindow,
} from "./candle-history.js";
export { normalizeHistory } from "./candle-history.js";
export const timeframes: Record<number, string> = {
  300: "M5",
  900: "M15",
  3600: "H1",
  14400: "H4",
  86400: "D1",
};
import { ProviderError } from "./provider-error.js";
export { ProviderError } from "./provider-error.js";
import {
  bounded,
  connectionStages,
  safeFailure,
  type ConnectionReport,
  type StageResult,
} from "./connection-test.js";
export function baseUrl(text: string) {
  const u = new URL(text);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    u.port ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(u.hostname) ||
    u.hostname === "localhost" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)
  )
    throw new ProviderError("EXNESS_CONFIGURATION");
  return u.origin;
}
export function loadKey(text: string): KeyObject {
  const input = text.trim().replace(/\\n/g, "\n");
  let key: KeyObject;
  if (input.startsWith("-----BEGIN PRIVATE KEY-----"))
    key = createPrivateKey(input);
  else {
    if (!/^[\da-f]{128}$/i.test(input))
      throw new ProviderError("EXNESS_CONFIGURATION");
    const raw = Buffer.from(input, "hex");
    key = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        raw.subarray(0, 32),
      ]),
      format: "der",
      type: "pkcs8",
    });
    const pub = createPublicKey(key).export({ format: "jwk" });
    if (!Buffer.from(pub.x!, "base64url").equals(raw.subarray(32)))
      throw new ProviderError("EXNESS_CONFIGURATION");
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new ProviderError("EXNESS_CONFIGURATION");
  return key;
}
export function signedHeaders(
  apiKey: string,
  key: KeyObject,
  path: string,
  now = Date.now(),
) {
  const payload = Buffer.from(
    JSON.stringify({
      api_key: apiKey,
      idempotency_key: "",
      timestamp: now,
      sign_version: 1,
      method: "GET",
      path,
      body_hash: createHash("sha256").update("").digest("base64url"),
    }),
  );
  return {
    "EXN-API-KEY": apiKey,
    "EXN-IDEMPOTENCY-KEY": "",
    "EXN-TIMESTAMP": String(now),
    "EXN-SIGN-VERSION": "1",
    "EXN-DATA": payload.toString("base64url"),
    "EXN-SIGN": sign(null, payload, key).toString("base64url"),
  };
}
export type Config = {
  apiKey: string;
  privateKey: string;
  accountId: string;
  gateway: string;
};
const rate = z.object({
  limit: z.number().int().positive(),
  window_seconds: z.number().int().positive(),
});
const constraints = z.object({
  max_candles_per_request: z.number().int().positive(),
  history_range_days: z.number().int().positive().optional(),
  history_age_days: z.number().int().positive().optional(),
});
const limitsSchema = z.object({
  limits: z.object({
    rest: z.object({
      global_account_rate: rate,
      methods: z.array(
        z.object({
          api_operation_id: z.string(),
          http_method: z.string(),
          path: z.string(),
          rate_limit: rate,
          limits: constraints.partial().optional(),
        }),
      ),
    }),
  }),
});
type Limits = z.infer<typeof limitsSchema>["limits"]["rest"];
type Candle = z.infer<typeof candleSchema>;
const iso = z.iso.datetime({ offset: true });
export type HistoryPage = {
  emptyWindow: boolean;
  candles: Candle[];
  window: { from: number; to: number };
  nextBefore: number | null;
  excludedBoundaryCandles: number;
};
// Warm-instance cache and quota accounting; no claim of cross-instance coordination.
export class ExnessReader {
  private key: KeyObject;
  private gateway: string;
  private ap?: string;
  private initializedAt = 0;
  private initializing?: Promise<void>;
  private limits?: Limits;
  private cooldown = 0;
  private usage: { at: number; operation: string }[] = [];
  private cache = new Map<string, { at: number; rows: Candle[] }>();
  private pending = new Map<string, Promise<Candle[]>>();
  private pages = new Map<string, { at: number; page: HistoryPage }>();
  private pagePending = new Map<string, Promise<HistoryPage>>();
  private instruments?: { at: number; names: string[] };
  constructor(
    private config: Config,
    private transport: typeof fetch = (...args) => fetch(...args),
    private now = () => Date.now(),
    private guard?: (
      operation: string,
      rules: { limit: number; window_seconds: number; scope: string }[],
    ) => Promise<void>,
  ) {
    try {
      if (
        !/^[1-9]\d{0,19}$/.test(config.accountId) ||
        BigInt(config.accountId) > 18446744073709551615n
      )
        throw Error();
      this.gateway = baseUrl(config.gateway);
      this.key = loadKey(config.privateKey);
    } catch {
      throw new ProviderError("EXNESS_CONFIGURATION");
    }
  }
  private async get(
    host: string,
    path: string,
    signal: AbortSignal,
    operation: string,
  ): Promise<unknown> {
    const now = this.now();
    if (now < this.cooldown)
      throw new ProviderError(
        "EXNESS_RATE_LIMIT",
        429,
        Math.ceil((this.cooldown - now) / 1000),
      );
    if (this.limits) {
      const method = this.limits.methods.find(
        (m) => m.api_operation_id === operation,
      );
      const rules = [
        { r: this.limits.global_account_rate, op: undefined },
        { r: method?.rate_limit, op: operation },
      ];
      for (const { r, op } of rules) {
        if (!r) continue;
        const calls = this.usage.filter(
          (u) =>
            now - u.at < r.window_seconds * 1000 && (!op || u.operation === op),
        );
        if (calls.length >= r.limit)
          throw new ProviderError(
            "EXNESS_RATE_LIMIT",
            429,
            Math.max(
              1,
              Math.ceil((calls[0].at + r.window_seconds * 1000 - now) / 1000),
            ),
          );
      }
    }
    if (this.guard) {
      const method = this.limits?.methods.find(
        (m) => m.api_operation_id === operation,
      );
      const rules = [
        {
          scope: "global",
          limit: this.limits?.global_account_rate.limit ?? 10,
          window_seconds: this.limits?.global_account_rate.window_seconds ?? 60,
        },
      ];
      if (method) rules.push({ scope: operation, ...method.rate_limit });
      await this.guard(operation, rules);
    }
    this.usage = this.usage.filter((u) => now - u.at < 86400000);
    this.usage.push({ at: now, operation });
    let response: Response;
    try {
      response = await this.transport(host + path, {
        method: "GET",
        headers: signedHeaders(this.config.apiKey, this.key, path, this.now()),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (
        signal.aborted ||
        (error instanceof Error &&
          ["TimeoutError", "AbortError"].includes(error.name))
      )
        throw new ProviderError("TIMEOUT", 504);
      throw new ProviderError("EXNESS_NETWORK");
    }
    let body: unknown;
    try {
      body = await bounded(() => limitedJson(response, signal), signal);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal.aborted) throw new ProviderError("TIMEOUT", 504);
      if (response.ok) throw new ProviderError("EXNESS_INVALID_RESPONSE");
    }
    const error =
      body && typeof body === "object"
        ? (body as { error?: unknown }).error
        : undefined;
    const publicError = (error && typeof error === "object" ? error : body) as
      | { code?: unknown; error_message?: unknown; retry_after?: unknown }
      | undefined;
    if (
      response.status === 429 ||
      publicError?.code === 3015 ||
      publicError?.error_message === "REQUEST_RATE_LIMIT"
    ) {
      const retry = response.headers.get("retry-after");
      const seconds = retry
        ? Number.isFinite(Number(retry))
          ? Number(retry)
          : (Date.parse(retry) - now) / 1000
        : Number(publicError?.retry_after);
      const wait =
        Number.isFinite(seconds) && seconds > 0
          ? Math.min(86400, Math.ceil(seconds))
          : 60;
      this.cooldown = now + wait * 1000;
      this.initializedAt = 0;
      this.cache.clear();
      this.pages.clear();
      throw new ProviderError("EXNESS_RATE_LIMIT", 429, wait);
    }
    if (!response.ok || publicError?.code !== undefined) {
      if (
        response.status === 401 ||
        [1000, 1001].includes(Number(publicError?.code))
      )
        throw new ProviderError("EXNESS_AUTH");
      if (
        response.status === 403 ||
        [1002, 2001, 2002].includes(Number(publicError?.code))
      )
        throw new ProviderError("EXNESS_PERMISSION");
      if ([4000, 4004].includes(Number(publicError?.code)))
        throw new ProviderError("EXNESS_MARKET_DATA");
      if (response.status === 404) {
        this.ap = undefined;
        this.instruments = undefined;
        this.initializedAt = 0;
      }
      throw new ProviderError("EXNESS_UPSTREAM");
    }
    return body;
  }
  private async initialize(signal: AbortSignal) {
    if (this.ap && this.limits && this.now() - this.initializedAt < 300000)
      return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      if (!this.ap) await this.discover(signal);
      await this.fetchLimits(signal);
      this.initializedAt = this.now();
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }
  private async discover(signal: AbortSignal) {
    const discovery = z
      .object({ access_point: z.string(), account_id: z.string() })
      .safeParse(
        await this.get(
          this.gateway,
          `/v1/trading/access-point?account_id=${this.config.accountId}`,
          signal,
          "discovery",
        ),
      );
    if (
      !discovery.success ||
      discovery.data.account_id !== this.config.accountId
    )
      throw new ProviderError("EXNESS_INVALID_RESPONSE");
    try {
      this.ap = baseUrl(discovery.data.access_point);
    } catch {
      throw new ProviderError("EXNESS_INVALID_RESPONSE");
    }
  }
  private async fetchLimits(signal: AbortSignal) {
    const limits = limitsSchema.safeParse(
      await this.get(
        this.ap!,
        `/v1/configuration/accounts/${this.config.accountId}/limits`,
        signal,
        "getLimits",
      ),
    );
    if (!limits.success) throw new ProviderError("EXNESS_INVALID_RESPONSE");
    this.limits = limits.data.limits.rest;
  }
  private historyWindow(interval: number) {
    const method = this.limits!.methods.find(
      (m) =>
        m.api_operation_id === "getCandleHistory" &&
        m.http_method === "GET" &&
        m.path === "/v1/market-data/accounts/{account_id}/candles",
    );
    const shape = constraints.safeParse(method?.limits);
    if (!method || !shape.success)
      throw new ProviderError("EXNESS_LIMITS_UNAVAILABLE");
    return closedHistoryWindow(this.now() / 1000, interval, shape.data);
  }

  private async accountInstrument(symbol: string, signal: AbortSignal) {
    if (!this.instruments || this.now() - this.instruments.at >= 300000) {
      const names = instrumentNames(
        await this.get(
          this.ap!,
          `/v1/configuration/accounts/${this.config.accountId}/instruments`,
          signal,
          "getAvailableInstrumentList",
        ),
      );
      this.instruments = { at: this.now(), names };
    }
    return selectInstrument(symbol, this.instruments.names);
  }
  private async history(
    symbol: string,
    interval: number,
    signal: AbortSignal,
    diagnostics?: { excludedBoundaryCandles: number },
  ) {
    try {
      const instrument = await this.accountInstrument(symbol, signal);
      const window = this.historyWindow(interval);
      const query = new URLSearchParams({
        instrument,
        price_type: "bid",
        timeframe: timeframes[interval],
        from: new Date(window.from * 1000).toISOString(),
        to: new Date(window.to * 1000).toISOString(),
      });
      const body = await this.get(
        this.ap!,
        `/v1/market-data/accounts/${this.config.accountId}/candles?${query}`,
        signal,
        "getCandleHistory",
      );
      return normalizeHistory(body, window.max, window, diagnostics);
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "EXNESS_INVALID_RESPONSE" &&
        !(error instanceof CandleHistoryError)
      )
        throw new CandleHistoryError("INVALID_SCHEMA");
      throw error;
    }
  }
  async testConnection(): Promise<ConnectionReport> {
    // Fresh probe avoids cached successes and concurrent mutations of an active chart reader.
    const probe = new ExnessReader(
      this.config,
      this.transport,
      this.now,
      this.guard,
    );
    probe.cooldown = this.cooldown;
    const stages: StageResult[] = connectionStages.map((stage) => ({
      stage,
      status: "not_run",
    }));
    const total = AbortSignal.timeout(20000);
    let candleCount: number | undefined;
    const diagnostics = { excludedBoundaryCandles: 0 };
    for (const result of stages) {
      const signal = AbortSignal.any([total, AbortSignal.timeout(4500)]);
      try {
        await bounded(async () => {
          if (result.stage === "discovery") await probe.discover(signal);
          else if (result.stage === "account_details") {
            const details = z
              .object({ account_id: z.string(), create_date: iso })
              .safeParse(
                await probe.get(
                  probe.ap!,
                  `/v1/configuration/accounts/${this.config.accountId}/account`,
                  signal,
                  "getAccountDetails",
                ),
              );
            if (
              !details.success ||
              details.data.account_id !== this.config.accountId
            )
              throw new ProviderError("EXNESS_INVALID_RESPONSE");
          } else if (result.stage === "limits") {
            await probe.fetchLimits(signal);
            probe.historyWindow(3600);
          } else
            candleCount = (
              await probe.history("XAUUSD", 3600, signal, diagnostics)
            ).length;
        }, signal);
        result.status = "passed";
      } catch (error) {
        const failure = safeFailure(error);
        if (failure.code === "RATE_LIMITED")
          this.cooldown = Math.max(
            this.cooldown,
            this.now() + (failure.retryAfter ?? 60) * 1000,
          );
        result.status = "failed";
        result.code = failure.code;
        return {
          success: false,
          stage: result.stage,
          error: failure.code,
          stages,
          ...(failure.reason
            ? {
                reason: failure.reason,
                candleCount: failure.candleCount,
                ...(failure.rangeReason
                  ? { rangeReason: failure.rangeReason }
                  : {}),
              }
            : {}),
          ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
        };
      }
    }
    return { success: true, stages, candleCount, ...diagnostics };
  }
  async historyPage(
    symbol: string,
    interval: number,
    before?: number,
  ): Promise<HistoryPage> {
    if (
      !["XAUUSD", "EURUSD", "BTCUSD"].includes(symbol) ||
      !timeframes[interval]
    )
      throw new ProviderError("EXNESS_REQUEST", 400);
    const signal = AbortSignal.timeout(8000);
    return bounded(async () => {
      await this.initialize(signal);
      const instrument = await this.accountInstrument(symbol, signal);
      const base = this.historyWindow(interval);
      const method = this.limits!.methods.find(
        (m) => m.api_operation_id === "getCandleHistory",
      );
      const age = constraints.parse(method!.limits).history_age_days ?? 365;
      const earliest =
        Math.ceil((this.now() / 1000 - Math.min(age, 365) * 86400) / interval) *
        interval;
      const to = before ?? base.to;
      if (
        !Number.isSafeInteger(to) ||
        to % interval ||
        to > base.to ||
        to <= earliest
      )
        throw new ProviderError("EXNESS_HISTORY_WINDOW", 400);
      const from = Math.max(earliest, to - base.max * interval);
      const window = { from, to, interval, requestedAt: base.requestedAt };
      const key = `${symbol}:${interval}:${from}:${to}`;
      const cached = this.pages.get(key);
      if (cached && this.now() - cached.at < 120000) return cached.page;
      const pending = this.pagePending.get(key);
      if (pending) return pending;
      const task = (async () => {
        const query = new URLSearchParams({
          instrument,
          price_type: "bid",
          timeframe: timeframes[interval],
          from: new Date(from * 1000).toISOString(),
          to: new Date(to * 1000).toISOString(),
        });
        const diagnostics = { excludedBoundaryCandles: 0 };
        const body = await this.get(
          this.ap!,
          `/v1/market-data/accounts/${this.config.accountId}/candles?${query}`,
          signal,
          "getCandleHistory",
        );
        // An explicitly empty, valid history window is a session gap, not a candle to fabricate.
        // Connection tests keep their stricter EMPTY_CANDLES failure behavior.
        const emptyWindow = z
          .object({ candles: z.array(z.unknown()).length(0) })
          .safeParse(body).success;
        const candles = emptyWindow
          ? []
          : normalizeHistory(body, (to - from) / interval, window, diagnostics);
        const page = {
          emptyWindow,
          candles,
          window: { from, to },
          nextBefore: from > earliest ? from : null,
          ...diagnostics,
        };
        if (this.pages.size >= 24)
          this.pages.delete(this.pages.keys().next().value!);
        this.pages.set(key, { at: this.now(), page });
        return page;
      })();
      this.pagePending.set(key, task);
      try {
        return await task;
      } finally {
        this.pagePending.delete(key);
      }
    }, signal);
  }
  async candles(symbol: string, interval: number): Promise<Candle[]> {
    if (
      !timeframes[interval] ||
      !["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD", "ETHUSD"].includes(
        symbol,
      )
    )
      throw new ProviderError("EXNESS_REQUEST");
    const cacheKey = `${symbol}:${interval}`;
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.at < 5000) return cached.rows;
    const existing = this.pending.get(cacheKey);
    if (existing) return existing;
    const promise = (async () => {
      const signal = AbortSignal.timeout(6500);
      await this.initialize(signal);
      const rows = await this.history(symbol, interval, signal);
      this.cache.set(cacheKey, { at: this.now(), rows });
      return rows;
    })();
    this.pending.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(cacheKey);
    }
  }
}
