import { it, expect, vi, afterEach, beforeEach } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, verify } from "node:crypto";
const state = vi.hoisted(() => ({
  upstreams: [] as any[],
  identity: true,
  leased: false,
  selected: true,
  rate: true,
  failure: "",
  dnsFailure: "",
}));
vi.mock("ws", async () => {
  const actual = await vi.importActual<typeof import("ws")>("ws"),
    { EventEmitter } = await import("node:events");
  class Upstream extends EventEmitter {
    static OPEN = 1;
    send = vi.fn((_data: string, callback?: (error?: Error) => void) =>
      callback?.(),
    );
    constructor(
      public url: string,
      public options: any,
    ) {
      super();
      state.upstreams.push(this);
    }
    terminate() {
      this.emit("close");
    }
  }
  return { ...actual, WebSocket: Upstream };
});
vi.mock("../server/live-cache", () => ({
  liveBootstrap: async (
    _db: unknown,
    _owner: string,
    _id: string,
    symbol: string,
    interval: number,
    reader: any,
  ) => ({
    prepared: await reader.prepareLive(symbol),
    candles: await reader.candles(symbol, interval),
  }),
}));
vi.mock("../server/auth", () => ({
  configured: () => true,
  origin: () => "https://nexus.test",
  auth: () => ({
    api: {
      getSession: async () =>
        state.identity ? { user: { id: "owner" } } : null,
    },
  }),
}));
vi.mock("../server/database", () => ({
  takeRate: async () => state.rate,
  database: () => ({
    query: async (sql: string) => {
      if (sql.startsWith("SELECT account_hash"))
        return { rows: state.leased ? [{}] : [] };
      if (sql.includes("c.id,c.envelope") && !state.selected)
        return { rows: [] };
      if (sql.startsWith("INSERT INTO")) {
        if (state.leased) return { rows: [] };
        state.leased = true;
        return { rows: [{ token: "x" }] };
      }
      if (sql.startsWith("DELETE")) {
        state.leased = false;
        return { rows: [] };
      }
      return {
        rows: [{ id: "11111111-1111-4111-8111-111111111111", envelope: {} }],
      };
    },
  }),
}));
beforeEach(() =>
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "synthetic-long-test-auth-secret-32-characters",
  ),
);
const keys = generateKeyPairSync("ed25519");
vi.mock("../server/vault", () => ({
  decrypt: () => ({
    accountId: "123456",
    apiKey: "synthetic-key",
    privateKey: keys.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  }),
}));
vi.mock("../server/accounts", () => ({
  productionReader: () => ({
    prepareLive: async () => {
      if (state.failure) {
        const { ProviderError } = await import("../server/exness");
        throw new ProviderError(state.failure, 403);
      }
      return {
        host: "https://ap.exness.test",
        path: "/v1/server-events/accounts/123456/ws/ticks",
        instrument: "XAUUSDm",
        rules: [],
      };
    },
    candles: async () => [],
  }),
}));
vi.mock("../server/ssrf", () => ({
  safeOrigin: (s: string) => s,
  resolveHost: async () => {
    if (state.dnsFailure)
      throw Object.assign(new Error("secret host and account"), {
        code: state.dnsFailure,
      });
    return [{ address: "8.8.8.8", family: 4 }];
  },
}));
import { livePreflight } from "../server/live-preflight";
import { attachLive } from "../server/live-bridge";
const actual = await vi.importActual<typeof import("ws")>("ws");
let server: http.Server | undefined, client: import("ws").WebSocket | undefined;
afterEach(async () => {
  client?.terminate();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  state.identity = true;
  state.selected = true;
  state.rate = true;
  state.failure = "";
  state.dnsFailure = "";
  vi.useRealTimers();
  state.leased = false;
  state.upstreams = [];
});
async function start(origin = "https://nexus.test") {
  server = attachLive(
    http.createServer((req, res) => {
      void livePreflight(req, res);
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  client = new actual.WebSocket(
    `ws://127.0.0.1:${port}/api/live?symbol=XAUUSD&interval=3600`,
    { origin },
  );
  return client;
}
it("signs only the exact GET handshake and sends a tick-only subscription; sanitizes browser frames", async () => {
  const ws = await start(),
    frames: any[] = [];
  ws.on("message", (b) => frames.push(JSON.parse(b.toString())));
  await once(ws, "open");
  const up = state.upstreams[0],
    h = up.options.headers,
    payload = Buffer.from(h["EXN-DATA"], "base64url");
  expect(JSON.parse(payload.toString())).toMatchObject({
    method: "GET",
    path: "/v1/server-events/accounts/123456/ws/ticks",
  });
  expect(
    verify(
      null,
      payload,
      keys.publicKey,
      Buffer.from(h["EXN-SIGN"], "base64url"),
    ),
  ).toBe(true);
  up.emit("open");
  expect(JSON.parse(up.send.mock.calls[0][0]).subscribe).toEqual({
    event: "ticks",
    instruments: ["XAUUSDm"],
  });
  up.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        instrument: "XAUUSDm",
        bid: 3900,
        ask: 3901,
        timestamp: new Date().toISOString(),
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(frames.some((f) => f.type === "tick")).toBe(true);
  const text = JSON.stringify(frames);
  for (const forbidden of [
    "123456",
    "EXN-SIGN",
    "synthetic-key",
    "ap.exness.test",
    "PRIVATE KEY",
  ])
    expect(text).not.toContain(forbidden);
});
it.each([
  ["https://evil.test", true, 403],
  ["https://nexus.test", false, 401],
] as const)(
  "rejects Origin/session before upgrade",
  async (origin, identity, status) => {
    state.identity = identity;
    const ws = await start(origin);
    ws.on("error", () => {});
    const [, response] = await once(ws, "unexpected-response");
    expect(response.statusCode).toBe(status);
    response.destroy();
    expect(state.upstreams).toHaveLength(0);
  },
);

it.each([
  ["SESSION_INVALID", 401],
  ["ORIGIN_REJECTED", 403],
  ["ACCOUNT_NOT_SELECTED", 409],
  ["ACCOUNT_TRADE_MODE_DISABLED", 403],
  ["LIMITS_INVALID", 403],
  ["CONNECTION_QUOTA", 429],
  ["RATE_LIMITED", 429],
  ["BOOTSTRAP_FAILED", 403],
] as const)(
  "returns safe authenticated preflight category %s",
  async (code, status) => {
    const socket = await start();
    await once(socket, "open");
    socket.terminate();
    await new Promise((r) => setTimeout(r, 10));
    if (code === "SESSION_INVALID") state.identity = false;
    if (code === "ACCOUNT_NOT_SELECTED") state.selected = false;
    if (code === "CONNECTION_QUOTA") state.leased = true;
    if (code === "RATE_LIMITED") state.rate = false;
    if (["ACCOUNT_TRADE_MODE_DISABLED", "BOOTSTRAP_FAILED"].includes(code))
      state.failure = code;
    if (code === "LIMITS_INVALID") state.failure = "EXNESS_LIMITS_UNAVAILABLE";
    const port = (server!.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/api/live/preflight`, {
      method: "POST",
      headers: {
        origin:
          code === "ORIGIN_REJECTED"
            ? "https://evil.test"
            : "https://nexus.test",
      },
    });
    expect(r.status).toBe(status);
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({
      ready: false,
      code,
      brokerLiveVerified: false,
    });
    if (code === "RATE_LIMITED")
      expect(JSON.parse(text)).toMatchObject({
        rateLimitSource: "INTERNAL_USER",
      });
    if (code === "CONNECTION_QUOTA")
      expect(JSON.parse(text)).toMatchObject({
        rateLimitSource: "INTERNAL_WS_LEASE",
      });
    if (code === "RATE_LIMITED" || code === "CONNECTION_QUOTA")
      expect(JSON.parse(text).retryAfterSec).toBeUndefined();
    for (const forbidden of [
      "123456",
      "PRIVATE KEY",
      "EXN-",
      "ap.exness.test",
      "synthetic-key",
    ])
      expect(text).not.toContain(forbidden);
  },
);
it("rejects a second tab via the shared lease without opening another upstream", async () => {
  const first = await start();
  await once(first, "open");
  await vi.waitFor(() => expect(state.upstreams).toHaveLength(1));
  const port = (server!.address() as any).port;
  const second = new actual.WebSocket(
    `ws://127.0.0.1:${port}/api/live?symbol=XAUUSD&interval=3600`,
    { origin: "https://nexus.test" },
  );
  const [bytes] = await once(second, "message");
  const message = JSON.parse(bytes.toString());
  expect(message).toMatchObject({
    type: "status",
    code: "CONNECTION_QUOTA",
    rateLimitSource: "INTERNAL_WS_LEASE",
  });
  expect(message.retryAfterSec).toBeUndefined();
  expect(state.upstreams).toHaveLength(1);
  second.terminate();
});
it.each([
  ["session", 401],
  ["selection", 409],
] as const)(
  "does not reuse a preflight auth decision after %s revocation",
  async (kind, status) => {
    server = attachLive(
      http.createServer((req, res) => {
        void livePreflight(req, res);
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as any).port;
    const preflight = await fetch(
      `http://127.0.0.1:${port}/api/live/preflight`,
      { method: "POST", headers: { origin: "https://nexus.test" } },
    );
    expect((await preflight.json()).ready).toBe(true);
    if (kind === "session") state.identity = false;
    else state.selected = false;
    client = new actual.WebSocket(
      `ws://127.0.0.1:${port}/api/live?symbol=XAUUSD&interval=3600`,
      { origin: "https://nexus.test" },
    );
    client.on("error", () => {});
    const [, response] = await once(client, "unexpected-response");
    expect(response.statusCode).toBe(status);
    response.destroy();
    expect(state.upstreams).toHaveLength(0);
  },
);

async function observed() {
  const ws = await start(),
    frames: any[] = [];
  ws.on("message", (b) => frames.push(JSON.parse(b.toString())));
  await once(ws, "open");
  return { ws, frames };
}
it("reports DNS failure safely and releases the shared lease", async () => {
  state.dnsFailure = "ENOTFOUND";
  const { frames } = await observed();
  await vi.waitFor(() =>
    expect(frames).toContainEqual(
      expect.objectContaining({
        code: "DNS_FAILED",
        internalCode: "ENOTFOUND",
        upstreamOpened: false,
      }),
    ),
  );
  expect(state.upstreams).toHaveLength(0);
  expect(state.leased).toBe(false);
  expect(JSON.stringify(frames)).not.toContain("secret host");
});
it.each([
  ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS_FAILED"],
  ["CERT_HAS_EXPIRED", "TLS_FAILED"],
  ["ECONNREFUSED", "TCP_CONNECT_FAILED"],
  ["ETIMEDOUT", "TCP_CONNECT_FAILED"],
  ["NOT_ALLOWLISTED_secret", "TCP_CONNECT_FAILED"],
])(
  "classifies pre-open %s without forwarding raw errors",
  async (code, expected) => {
    const { frames } = await observed();
    const up = state.upstreams[0];
    up.emit(
      "error",
      Object.assign(new Error("private host headers signature account"), {
        code,
      }),
    );
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({ code: expected, upstreamOpened: false }),
      ),
    );
    expect(JSON.stringify(frames)).not.toMatch(
      /private host|signature|NOT_ALLOWLISTED/,
    );
    expect(state.leased).toBe(false);
  },
);
it("bounds the whole TCP/TLS/HTTP handshake deadline and cleans up once", async () => {
  const { frames } = await observed();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // Reconnect starts its deadline under the controlled clock.
  client!.terminate();
  await new Promise((r) => setImmediate(r));
  await new Promise<void>((r) => server!.close(() => r()));
  const second = await observed();
  await vi.advanceTimersByTimeAsync(5001);
  await new Promise((r) => setImmediate(r));
  expect(second.frames).toContainEqual(
    expect.objectContaining({
      code: "WS_HANDSHAKE_TIMEOUT",
      upstreamOpened: false,
    }),
  );
  expect(state.leased).toBe(false);
  expect(frames.some((f) => f.code === "EXNESS_LIVE")).toBe(false);
});
it.each([401, 403, 429, 302])(
  "reports HTTP %s rejection before open, preserving cooldown",
  async (status) => {
    const { frames } = await observed();
    const response = {
      statusCode: status,
      headers: { "retry-after": "17", secret: "private" },
      destroy: vi.fn(),
    };
    state.upstreams[0].emit("unexpected-response", {}, response);
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          code: status === 429 ? "RATE_LIMITED" : "WS_HTTP_REJECTED",
          stage: "WS_HTTP_REJECTED",
          upstreamOpened: false,
        }),
      ),
    );
    const failure = frames.at(-1);
    if (status === 429)
      expect(failure).toMatchObject({
        rateLimitSource: "EXNESS_WS",
        retryAfterSec: 17,
      });
    expect(state.upstreams).toHaveLength(1);
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(frames)).not.toContain("private");
  },
);
it("tracks 101, subscription and waiting without claiming LIVE before a fresh tick", async () => {
  const { frames } = await observed();
  const up = state.upstreams[0];
  up.emit("open");
  await vi.waitFor(() =>
    expect(frames).toContainEqual(
      expect.objectContaining({
        code: "WAITING_FOR_BROKER_TICK",
        upstreamOpened: true,
      }),
    ),
  );
  expect(frames.filter((f) => f.type === "status").map((f) => f.code)).toEqual([
    "WS_CONNECTED",
    "SUBSCRIPTION_SENT",
    "WAITING_FOR_BROKER_TICK",
  ]);
  up.emit("close");
  await vi.waitFor(() =>
    expect(frames).toContainEqual(
      expect.objectContaining({
        code: "WS_DISCONNECTED",
        internalCode: "SOCKET_CLOSED",
        upstreamOpened: true,
      }),
    ),
  );
  expect(
    frames.some((f) => f.type === "tick" || f.code === "EXNESS_LIVE"),
  ).toBe(false);
});
it("preserves post-open classification and pinned DNS all/single contracts", async () => {
  const { frames } = await observed();
  const up = state.upstreams[0],
    cb = vi.fn();
  up.options.lookup("ap.exness.test", { all: true }, cb);
  expect(cb).toHaveBeenLastCalledWith(null, [
    { address: "8.8.8.8", family: 4 },
  ]);
  up.options.lookup("ap.exness.test", {}, cb);
  expect(cb).toHaveBeenLastCalledWith(null, "8.8.8.8", 4);
  expect(up.options.followRedirects).toBe(false);
  expect(up.url).toBe(
    "wss://ap.exness.test/v1/server-events/accounts/123456/ws/ticks",
  );
  up.emit("open");
  up.emit("error", Object.assign(new Error("private"), { code: "ECONNRESET" }));
  await vi.waitFor(() =>
    expect(frames).toContainEqual(
      expect.objectContaining({
        code: "WS_DISCONNECTED",
        internalCode: "ECONNRESET",
        upstreamOpened: true,
      }),
    ),
  );
});

it("preserves AP SNI, verified TLS and DNS pinning while distinguishing TLS negotiation reset", async () => {
  const tls = await import("node:tls"),
    { EventEmitter } = await import("node:events");
  const connection = new EventEmitter();
  const connect = vi
    .spyOn(tls.default, "connect")
    .mockReturnValue(connection as any);
  try {
    const { frames } = await observed(),
      up = state.upstreams[0];
    up.options.createConnection({
      host: "ap.exness.test",
      port: 443,
      path: "/sensitive-path",
      lookup: up.options.lookup,
    });
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "ap.exness.test",
        servername: "ap.exness.test",
        rejectUnauthorized: true,
        path: undefined,
        lookup: up.options.lookup,
      }),
    );
    connection.emit("connect");
    up.emit(
      "error",
      Object.assign(new Error("never serialize host"), { code: "ECONNRESET" }),
    );
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          code: "TLS_FAILED",
          internalCode: "ECONNRESET",
          upstreamOpened: false,
        }),
      ),
    );
  } finally {
    connect.mockRestore();
  }
});
it("reports DNS failures during preflight without upgrading upstream", async () => {
  server = attachLive(
    http.createServer((req, res) => {
      void livePreflight(req, res);
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  state.dnsFailure = "EAI_AGAIN";
  const r = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/api/live/preflight`,
    { method: "POST", headers: { origin: "https://nexus.test" } },
  );
  expect(r.status).toBe(503);
  expect(await r.json()).toMatchObject({
    code: "DNS_FAILED",
    brokerLiveVerified: false,
    ready: false,
  });
  expect(state.upstreams).toHaveLength(0);
});
