import { it, expect, vi, afterEach, beforeEach } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, verify } from "node:crypto";
const state = vi.hoisted(() => ({
  upstreams: [] as any[],
  identity: true,
  sessionId: "synthetic-session",
  duringBootstrap: undefined as undefined | (() => Promise<void>),
  leased: false,
  selected: true,
  rate: true,
  failure: "",
  dnsFailure: "",
  sendFailure: "",
}));
vi.mock("ws", async () => {
  const actual = await vi.importActual<typeof import("ws")>("ws"),
    { EventEmitter } = await import("node:events");
  class Upstream extends EventEmitter {
    static OPEN = 1;
    send = vi.fn((_data: string, callback?: (error?: Error) => void) => {
      if (state.sendFailure === "throw")
        throw new Error("private subscription context");
      if (state.sendFailure === "pending") return;
      callback?.(
        state.sendFailure === "callback"
          ? new Error("private subscription context")
          : undefined,
      );
    });
    constructor(
      public url: string,
      public protocol: string,
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
        state.identity
          ? { user: { id: "owner" }, session: { id: state.sessionId } }
          : null,
    },
  }),
}));
vi.mock("../server/database", () => ({
  takeRate: async () => state.rate,
  database: () => ({
    query: async (sql: string) => {
      if (sql.startsWith("SELECT account_hash"))
        return { rows: state.leased ? [{}] : [] };
      if (
        (sql.includes("c.id,c.envelope") || sql.startsWith("SELECT c.id")) &&
        !state.selected
      )
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
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "synthetic-long-test-auth-secret-32-characters",
  );
});
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
      await state.duringBootstrap?.();
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
  state.sessionId = "synthetic-session";
  state.duringBootstrap = undefined;
  state.selected = true;
  state.rate = true;
  state.failure = "";
  state.dnsFailure = "";
  state.sendFailure = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  ["SESSION_MISSING", 401],
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
    if (code === "SESSION_MISSING") state.identity = false;
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

it.each(["TCP", "TLS", "HANDSHAKE"] as const)(
  "retains %s evidence for a code-less pre-open error",
  async (phase) => {
    const { frames } = await observed(),
      up = state.upstreams[0];
    const tls = await import("node:tls"),
      { EventEmitter } = await import("node:events"),
      connection = new EventEmitter();
    const connect = vi
      .spyOn(tls.default, "connect")
      .mockReturnValue(connection as any);
    try {
      up.options.createConnection({
        host: "ap.exness.test",
        port: 443,
        lookup: up.options.lookup,
      });
      if (phase !== "TCP") connection.emit("connect");
      if (phase === "HANDSHAKE") connection.emit("secureConnect");
      up.emit("error", new Error("DO_NOT_LOG host IP account headers"));
      await vi.waitFor(() =>
        expect(frames).toContainEqual(
          expect.objectContaining({
            code:
              phase === "TCP"
                ? "TCP_CONNECT_FAILED"
                : phase === "TLS"
                  ? "TLS_FAILED"
                  : "WS_HANDSHAKE_FAILED",
            phase,
            upstreamOpened: false,
            subscriptionSent: false,
            firstValidTickReceived: false,
            internalCode:
              phase === "HANDSHAKE"
                ? "WS_HANDSHAKE_ERROR_NO_CODE"
                : `${phase}_ERROR_NO_CODE`,
          }),
        ),
      );
      expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
        "DO_NOT_LOG",
      );
    } finally {
      connect.mockRestore();
    }
  },
);
it.each(["callback", "throw"])(
  "handles %s subscription send failure without claiming it was sent",
  async (mode) => {
    state.sendFailure = mode;
    const { frames } = await observed(),
      up = state.upstreams[0];
    up.emit("open");
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          code: "WS_DISCONNECTED",
          phase: "OPEN",
          upstreamOpened: true,
          subscriptionSent: false,
          firstValidTickReceived: false,
          internalCode: "SUBSCRIPTION_SEND_FAILED",
        }),
      ),
    );
    expect(state.leased).toBe(false);
    expect(JSON.stringify(frames)).not.toContain(
      "private subscription context",
    );
    expect(frames.some((f) => f.code === "SUBSCRIPTION_SENT")).toBe(false);
  },
);
it("distinguishes OPEN then code-less error before first tick, with no retry or fabricated tick", async () => {
  const { frames } = await observed(),
    up = state.upstreams[0];
  expect(up.protocol).toBe("exness-ws-protocol");
  expect(up.options.perMessageDeflate).toBe(false);
  up.emit("open");
  up.emit("error", new Error("private"));
  await vi.waitFor(() =>
    expect(frames).toContainEqual(
      expect.objectContaining({
        code: "WS_DISCONNECTED",
        phase: "OPEN",
        upstreamOpened: true,
        subscriptionSent: true,
        firstValidTickReceived: false,
        internalCode: "WS_OPEN_ERROR_NO_CODE",
      }),
    ),
  );
  expect(state.upstreams).toHaveLength(1);
  expect(frames.some((f) => f.type === "tick")).toBe(false);
});
it.each([1000, 1006, 1011, 4001])(
  "only exposes standard close codes (%s), without raw close reason",
  async (closeCode) => {
    const { frames } = await observed(),
      up = state.upstreams[0];
    up.emit("open");
    up.emit(
      "close",
      closeCode,
      Buffer.from("DO_NOT_DISPLAY_PRIVATE_CLOSE_REASON"),
    );
    await vi.waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        code: "WS_DISCONNECTED",
        phase: "OPEN",
        upstreamOpened: true,
        subscriptionSent: true,
        firstValidTickReceived: false,
      }),
    );
    expect(frames.at(-1).closeCode).toBe(
      closeCode === 4001 ? undefined : closeCode,
    );
    expect(
      JSON.stringify(frames) +
        JSON.stringify(vi.mocked(console.info).mock.calls),
    ).not.toContain("DO_NOT_DISPLAY");
  },
);
it("records the first valid fresh tick once, rejecting invalid/foreign/stale ticks without logging frames", async () => {
  const { frames } = await observed(),
    up = state.upstreams[0];
  up.emit("open");
  const tick = {
    instrument: "XAUUSDm",
    bid: 3900,
    ask: 3901,
    timestamp: new Date().toISOString(),
  };
  for (const invalid of [
    { ...tick, instrument: "EURUSD" },
    { ...tick, bid: -1 },
    { ...tick, timestamp: new Date(Date.now() - 60000).toISOString() },
  ])
    up.emit("message", Buffer.from(JSON.stringify(invalid)));
  up.emit("message", Buffer.from(JSON.stringify(tick)));
  await vi.waitFor(() =>
    expect(frames.filter((f) => f.type === "tick")).toHaveLength(1),
  );
  up.emit("close", 1001, Buffer.from("private reason"));
  await vi.waitFor(() =>
    expect(frames.at(-1)).toMatchObject({
      code: "WS_DISCONNECTED",
      phase: "OPEN",
      upstreamOpened: true,
      subscriptionSent: true,
      firstValidTickReceived: true,
      closeCode: 1001,
    }),
  );
  const logs = vi
    .mocked(console.info)
    .mock.calls.map(([line]) => JSON.parse(line));
  expect(logs.filter((l) => l.stage === "EXNESS_LIVE")).toHaveLength(1);
  for (const log of logs)
    expect(Object.keys(log)).toEqual(
      expect.arrayContaining([
        "event",
        "stage",
        "phase",
        "upstreamOpened",
        "subscriptionSent",
        "firstValidTickReceived",
      ]),
    );
  for (const secret of [
    "123456",
    "EXN-",
    "ap.exness.test",
    "synthetic-key",
    "private reason",
    "3900",
    "timestamp",
  ])
    expect(JSON.stringify(logs)).not.toContain(secret);
});
it.each([undefined, "not-the-documented-protocol"])(
  "reports a code-less subprotocol rejection without logging headers",
  async (protocol) => {
    const { frames } = await observed(),
      up = state.upstreams[0];
    const tls = await import("node:tls"),
      { EventEmitter } = await import("node:events"),
      connection = new EventEmitter();
    const connect = vi
      .spyOn(tls.default, "connect")
      .mockReturnValue(connection as any);
    try {
      up.options.createConnection({
        host: "ap.exness.test",
        port: 443,
        lookup: up.options.lookup,
      });
      connection.emit("connect");
      connection.emit("secureConnect");
      up.emit("upgrade", { headers: { "sec-websocket-protocol": protocol } });
      up.emit("error", new Error("raw handshake failure"));
      await vi.waitFor(() =>
        expect(frames).toContainEqual(
          expect.objectContaining({
            code: "WS_HANDSHAKE_FAILED",
            phase: "HANDSHAKE",
            upstreamOpened: false,
            internalCode: protocol
              ? "WS_SUBPROTOCOL_MISMATCH"
              : "WS_SUBPROTOCOL_MISSING",
          }),
        ),
      );
      expect(JSON.stringify(frames)).not.toContain(
        "not-the-documented-protocol",
      );
    } finally {
      connect.mockRestore();
    }
  },
);

it("keeps an exact correlated ACK candidate open, awaiting an independent valid tick", async () => {
  const { frames } = await observed(),
    up = state.upstreams[0];
  up.emit("open");
  const { id } = JSON.parse(up.send.mock.calls[0][0]);
  up.emit("message", Buffer.from(JSON.stringify({ id, code: 200 })));
  await vi.waitFor(() =>
    expect(frames).toContainEqual(
      expect.objectContaining({
        code: "UNKNOWN_BROKER_RESPONSE",
        internalCode: "ACK_CONTRACT_UNVERIFIED",
        subscriptionAckReceived: false,
        firstValidTickReceived: false,
      }),
    ),
  );
  expect(state.leased).toBe(true);
  expect(
    frames.some((f) => f.type === "tick" || f.code === "EXNESS_LIVE"),
  ).toBe(false);
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
  await vi.waitFor(() =>
    expect(frames.filter((f) => f.type === "tick")).toHaveLength(1),
  );
  expect(frames.filter((f) => f.type === "diagnostic").at(-1)).toMatchObject({
    subscriptionAckReceived: false,
    firstValidTickReceived: true,
  });
  const safe =
    JSON.stringify(frames) + JSON.stringify(vi.mocked(console.info).mock.calls);
  expect(safe).not.toContain(id);
  expect(safe).not.toContain('"brokerErrorCode":200');
});
it.each([
  [1002, "EXNESS_PERMISSION"],
  [3000, "EXNESS_SUBSCRIPTION_INVALID"],
  [3015, "RATE_LIMITED"],
] as const)(
  "handles correlated subscription error %s without raw broker text or request id",
  async (code, category) => {
    const { frames } = await observed(),
      up = state.upstreams[0];
    up.emit("open");
    const { id } = JSON.parse(up.send.mock.calls[0][0]);
    up.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id,
          code,
          error_message: "DO_NOT_DISPLAY_HOST_ACCOUNT_SIGNATURE",
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          code: category,
          brokerErrorCode: code,
          subscriptionAckReceived: false,
          firstValidTickReceived: false,
        }),
      ),
    );
    if (code === 3015) {
      expect(frames.at(-1).rateLimitSource).toBe("EXNESS_WS");
      expect(frames.at(-1).retryAfterSec).toBeUndefined();
    }
    expect(state.upstreams).toHaveLength(1);
    expect(state.leased).toBe(false);
    const safe =
      JSON.stringify(frames) +
      JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(safe).not.toContain(id);
    expect(safe).not.toContain("DO_NOT_DISPLAY");
  },
);
it.each(["mismatched_ack", "unknown_error", "invalid_ack", "malformed_json"])(
  "reports %s safely instead of permission denied",
  async (kind) => {
    const { frames } = await observed(),
      up = state.upstreams[0];
    up.emit("open");
    const { id } = JSON.parse(up.send.mock.calls[0][0]);
    const raw =
      kind === "mismatched_ack"
        ? { id: "foreign-private-request", code: 200 }
        : kind === "unknown_error"
          ? { id, code: 987654321, error_message: "PRIVATE" }
          : { id, code: 200, error_message: "PRIVATE" };
    up.emit(
      "message",
      Buffer.from(
        kind === "malformed_json"
          ? "PRIVATE INVALID JSON"
          : JSON.stringify(raw),
      ),
    );
    await vi.waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        code: "UNKNOWN_BROKER_RESPONSE",
        subscriptionAckReceived: false,
        firstValidTickReceived: false,
      }),
    );
    expect(frames.at(-1).brokerErrorCode).toBeUndefined();
    expect(state.leased).toBe(false);
    expect(JSON.stringify(frames)).not.toMatch(
      /PRIVATE|foreign-private-request|987654321|EXNESS_PERMISSION/,
    );
  },
);

it("does not replace an early ACK-candidate warning with a late subscription write callback", async () => {
  state.sendFailure = "pending";
  const { frames } = await observed(),
    up = state.upstreams[0];
  up.emit("open");
  const { id } = JSON.parse(up.send.mock.calls[0][0]);
  up.emit("message", Buffer.from(JSON.stringify({ id, code: 200 })));
  await vi.waitFor(() =>
    expect(frames.at(-1)).toMatchObject({
      code: "UNKNOWN_BROKER_RESPONSE",
      subscriptionSent: false,
      subscriptionAckReceived: false,
    }),
  );
  up.send.mock.calls[0][1]();
  await vi.waitFor(() =>
    expect(frames.at(-1)).toMatchObject({
      type: "diagnostic",
      subscriptionSent: true,
      subscriptionAckReceived: false,
    }),
  );
  expect(frames.filter((f) => f.type === "status").at(-1).code).toBe(
    "UNKNOWN_BROKER_RESPONSE",
  );
  expect(frames.some((f) => f.code === "WAITING_FOR_BROKER_TICK")).toBe(false);
});

it.each([
  ["revoked", "SESSION_REVOKED"],
  ["session-changed", "SESSION_CHANGED"],
  ["selection-changed", "SELECTED_CONNECTION_UNAVAILABLE"],
] as const)(
  "rechecks %s during upgrade bootstrap before exposing basis or dialing upstream",
  async (kind, code) => {
    let begin!: () => void, release!: () => void;
    const began = new Promise<void>((r) => (begin = r)),
      finish = new Promise<void>((r) => (release = r));
    state.duringBootstrap = async () => {
      begin();
      await finish;
    };
    const { frames } = await observed();
    await began;
    if (kind === "revoked") state.identity = false;
    if (kind === "session-changed")
      state.sessionId = "different-private-session";
    if (kind === "selection-changed") state.selected = false;
    release();
    await vi.waitFor(() =>
      expect(frames).toContainEqual(expect.objectContaining({ code })),
    );
    expect(state.upstreams).toHaveLength(0);
    expect(frames.some((f) => f.type === "basis" || f.type === "tick")).toBe(
      false,
    );
    expect(state.leased).toBe(false);
    expect(JSON.stringify(frames)).not.toContain("different-private-session");
  },
);
it("stops an open upstream when its original session is replaced, without automatically retrying", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { frames } = await observed(),
    up = state.upstreams[0];
  up.emit("open");
  state.sessionId = "replacement-private-session";
  await vi.advanceTimersByTimeAsync(2001);
  await vi.waitFor(() =>
    expect(frames).toContainEqual(
      expect.objectContaining({ code: "SESSION_CHANGED" }),
    ),
  );
  expect(state.upstreams).toHaveLength(1);
  expect(state.leased).toBe(false);
  expect(
    JSON.stringify(frames) + JSON.stringify(vi.mocked(console.info).mock.calls),
  ).not.toContain("replacement-private-session");
});
