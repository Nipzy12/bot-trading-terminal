import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { candleSchema } from "./validation.js";
export const timeframes: Record<number, string> = {
  300: "M5",
  900: "M15",
  3600: "H1",
  14400: "H4",
  86400: "D1",
};
export class ProviderError extends Error {
  constructor(
    public code: string,
    public status = 502,
    public retryAfter?: number,
  ) {
    super(code);
  }
}
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
export function readConfig(): Config | null {
  const [apiKey, privateKey, accountId, gateway] = [
    "EXN_API_KEY",
    "EXN_PRIVATE_KEY",
    "EXN_ACCOUNT_ID",
    "EXN_DISCOVERY_BASE_URL",
  ].map((k) => process.env[k]?.trim() ?? "");
  return apiKey && privateKey && accountId && gateway
    ? { apiKey, privateKey, accountId, gateway }
    : null;
}
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
const historySchema = z.object({
  candles: z
    .array(
      z.object({
        time: iso,
        open: z.number().positive(),
        high: z.number().positive(),
        low: z.number().positive(),
        close: z.number().positive(),
        volume: z.number().nonnegative().optional(),
      }),
    )
    .max(5000),
});
export function normalizeHistory(body: unknown, max: number) {
  const result = historySchema.safeParse(body);
  if (
    !result.success ||
    result.data.candles.length < 1 ||
    result.data.candles.length > max
  )
    throw new ProviderError("EXNESS_INVALID_RESPONSE");
  const rows = result.data.candles.map((c) => ({
    time: Date.parse(c.time) / 1000,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
  if (
    rows.some(
      (c, i) =>
        !candleSchema.safeParse(c).success ||
        (i > 0 && c.time <= rows[i - 1].time),
    )
  )
    throw new ProviderError("EXNESS_INVALID_RESPONSE");
  return rows;
}
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
  constructor(
    private config: Config,
    private transport: typeof fetch = (...args) => fetch(...args),
    private now = () => Date.now(),
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
    this.usage = this.usage.filter((u) => now - u.at < 86400000);
    this.usage.push({ at: now, operation });
    let response: Response;
    try {
      response = await this.transport(host + path, {
        method: "GET",
        headers: signedHeaders(this.config.apiKey, this.key, path, now),
        redirect: "error",
        signal,
      });
    } catch {
      throw new ProviderError("EXNESS_NETWORK");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
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
      throw new ProviderError("EXNESS_RATE_LIMIT", 429, wait);
    }
    if (!response.ok || publicError?.code !== undefined) {
      if (
        response.status === 401 ||
        response.status === 403 ||
        [1000, 1001, 1002].includes(Number(publicError?.code))
      )
        throw new ProviderError("EXNESS_AUTH");
      if (response.status === 404) {
        this.ap = undefined;
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
      if (!this.ap) {
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
        this.ap = baseUrl(discovery.data.access_point);
      }
      const limits = limitsSchema.safeParse(
        await this.get(
          this.ap,
          `/v1/configuration/accounts/${this.config.accountId}/limits`,
          signal,
          "getLimits",
        ),
      );
      if (!limits.success) throw new ProviderError("EXNESS_INVALID_RESPONSE");
      this.limits = limits.data.limits.rest;
      this.initializedAt = this.now();
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
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
      const method = this.limits!.methods.find(
        (m) =>
          m.api_operation_id === "getCandleHistory" &&
          m.http_method === "GET" &&
          m.path === "/v1/market-data/accounts/{account_id}/candles",
      );
      const shape = constraints.safeParse(method?.limits);
      if (!method || !shape.success)
        throw new ProviderError("EXNESS_LIMITS_UNAVAILABLE");
      let count = Math.min(180, shape.data.max_candles_per_request);
      for (const days of [
        shape.data.history_range_days,
        shape.data.history_age_days,
      ])
        if (days)
          count = Math.min(count, Math.floor((days * 86400) / interval));
      if (count < 1) throw new ProviderError("EXNESS_LIMITS_UNAVAILABLE");
      const end = Math.floor(this.now() / 1000 / interval) * interval;
      const start = end - count * interval;
      const query = new URLSearchParams({
        instrument: symbol,
        price_type: "bid",
        timeframe: timeframes[interval],
        from: new Date(start * 1000).toISOString(),
        count: String(count),
      });
      const path = `/v1/market-data/accounts/${this.config.accountId}/candles?${query}`;
      const rows = normalizeHistory(
        await this.get(this.ap!, path, signal, "getCandleHistory"),
        count,
      );
      if (rows.some((c) => c.time < start || c.time >= end))
        throw new ProviderError("EXNESS_INVALID_RESPONSE");
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
let current: { fingerprint: string; reader: ExnessReader } | undefined;
export function readerFor(config: Config) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex");
  if (current?.fingerprint !== fingerprint)
    current = { fingerprint, reader: new ExnessReader(config) };
  return current.reader;
}
