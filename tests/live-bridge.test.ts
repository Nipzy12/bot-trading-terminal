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
}));
vi.mock("ws", async () => {
  const actual = await vi.importActual<typeof import("ws")>("ws"),
    { EventEmitter } = await import("node:events");
  class Upstream extends EventEmitter {
    static OPEN = 1;
    send = vi.fn();
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
  resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
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
