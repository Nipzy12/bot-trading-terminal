import { beforeEach, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
const state = vi.hoisted(() => ({
  signedIn: true,
  owner: "private-owner",
  session: "private-session-a",
  selected: "private-connection-a" as string | null,
  verified: true,
  exists: true,
  configured: true,
  rate: true,
  calls: 0,
  cookieForwarded: [] as boolean[],
  authFailure: false,
  selectionDbFailure: false,
  wait: undefined as undefined | (() => Promise<void>),
  afterSessionRead: undefined as undefined | (() => void),
}));
vi.mock("../server/auth", () => ({
  configured: () => state.configured,
  origin: () => "https://nexus.test",
  auth: () => ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        state.calls++;
        state.cookieForwarded.push(
          headers.get("cookie") === "synthetic-http-only-cookie",
        );
        if (state.calls > 1) state.afterSessionRead?.();
        if (state.authFailure) throw Error("DO_NOT_LOG_DATABASE_CONNECTION");
        return state.signedIn
          ? { user: { id: state.owner }, session: { id: state.session } }
          : null;
      },
    },
  }),
}));
const rates = vi.hoisted(() => ({ take: vi.fn() }));
vi.mock("../server/database", () => ({
  takeRate: rates.take,
  database: () => ({
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith("SELECT account_hash")) return { rows: [] };
      if (sql.includes("c.id,c.envelope"))
        return {
          rows:
            state.selected && state.verified && state.exists
              ? [{ id: state.selected, envelope: {} }]
              : [],
        };
      if (sql.startsWith("SELECT c.id")) {
        if (state.selectionDbFailure) throw Error("PRIVATE_DB_HOST");
        return {
          rows:
            state.exists && state.verified && state.selected === params[0]
              ? [{ id: state.selected }]
              : [],
        };
      }
      throw Error("unexpected test query");
    },
  }),
}));
vi.mock("../server/vault", () => ({
  decrypt: () => ({
    accountId: "123456",
    apiKey: "private-synthetic-key",
    privateKey: "private-synthetic-signing-key",
  }),
}));
vi.mock("../server/accounts", () => ({ productionReader: () => ({}) }));
const bootstrap = vi.hoisted(() => vi.fn());
vi.mock("../server/live-cache", () => ({ liveBootstrap: bootstrap }));
vi.mock("../server/ssrf", () => ({
  safeOrigin: (s: string) => s,
  resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
}));
import { livePreflight } from "../server/live-preflight";
function app() {
  const a = express();
  a.post("/api/live/preflight", (req, res) => {
    void livePreflight(req, res);
  });
  return a;
}
function preflight() {
  return request(app())
    .post("/api/live/preflight")
    .set("Origin", "https://nexus.test")
    .set("Cookie", "synthetic-http-only-cookie");
}
beforeEach(() => {
  Object.assign(state, {
    signedIn: true,
    owner: "private-owner",
    session: "private-session-a",
    selected: "private-connection-a",
    verified: true,
    exists: true,
    configured: true,
    rate: true,
    calls: 0,
    cookieForwarded: [],
    authFailure: false,
    selectionDbFailure: false,
    wait: undefined,
    afterSessionRead: undefined,
  });
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-long-auth-secret-only-for-tests");
  rates.take.mockReset().mockImplementation(async () => state.rate);
  bootstrap.mockReset().mockImplementation(async () => {
    await state.wait?.();
    return {
      prepared: { host: "https://private-ap.exness.test" },
      candles: [],
    };
  });
});
function safe(body: unknown) {
  const text = JSON.stringify(body);
  for (const s of [
    "private-owner",
    "private-session",
    "private-connection",
    "private-ap",
    "123456",
    "synthetic-http-only-cookie",
    "private-synthetic",
    "token",
    "sessionId",
    "accountId",
  ])
    expect(text).not.toContain(s);
}
it("requires the cookie-backed session and never bootstraps an unauthenticated request", async () => {
  state.signedIn = false;
  const r = await preflight();
  expect(r.status).toBe(401);
  expect(r.body.code).toBe("SESSION_MISSING");
  expect(bootstrap).not.toHaveBeenCalled();
  expect(rates.take).not.toHaveBeenCalled();
  safe(r.body);
});
it("returns readiness only after fresh session and selected verified connection checks", async () => {
  const r = await preflight();
  expect(r.status).toBe(200);
  expect(r.body).toEqual({
    ready: true,
    code: "READY",
    brokerLiveVerified: false,
  });
  expect(state.calls).toBe(2);
  expect(state.cookieForwarded).toEqual([true, true]);
  expect(bootstrap).toHaveBeenCalledOnce();
  expect(rates.take).toHaveBeenCalledOnce();
  expect(r.headers["cache-control"]).toBe("no-store");
  safe(r.body);
});
it.each([
  ["revoked", "SESSION_REVOKED", 401],
  ["same-user-new-session", "SESSION_CHANGED", 401],
  ["different-user", "SESSION_CHANGED", 401],
  ["selection-cleared", "SELECTED_CONNECTION_UNAVAILABLE", 409],
  ["selection-switched", "SELECTED_CONNECTION_UNAVAILABLE", 409],
  ["status-error", "SELECTED_CONNECTION_UNAVAILABLE", 409],
  ["credential-deleted", "SELECTED_CONNECTION_UNAVAILABLE", 409],
  ["revoked-and-selection-cleared", "SESSION_REVOKED", 401],
] as const)(
  "distinguishes %s during bootstrap I/O",
  async (kind, code, status) => {
    let begin!: () => void, release!: () => void;
    const began = new Promise<void>((r) => (begin = r)),
      finish = new Promise<void>((r) => (release = r));
    state.wait = async () => {
      begin();
      await finish;
    };
    const response = preflight().then((r) => r);
    await began;
    if (kind.includes("revoked")) state.signedIn = false;
    if (kind === "same-user-new-session") state.session = "private-session-b";
    if (kind === "different-user") state.owner = "private-other-owner";
    if (kind.includes("cleared")) state.selected = null;
    if (kind === "selection-switched") state.selected = "private-connection-b";
    if (kind === "status-error") state.verified = false;
    if (kind === "credential-deleted") state.exists = false;
    release();
    const r = await response;
    expect(r.status).toBe(status);
    expect(r.body).toMatchObject({
      ready: false,
      code,
      httpStatus: status,
      brokerLiveVerified: false,
    });
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(rates.take).toHaveBeenCalledOnce();
    safe(r.body);
  },
);
it("checks selection after the final auth lookup, including a change while that lookup completes", async () => {
  state.afterSessionRead = () => {
    state.selected = "private-connection-b";
  };
  const r = await preflight();
  expect(r.status).toBe(409);
  expect(r.body.code).toBe("SELECTED_CONNECTION_UNAVAILABLE");
  safe(r.body);
});
it.each(["selection-cleared", "status-error"])(
  "uses ACCOUNT_NOT_SELECTED for %s before I/O",
  async (kind) => {
    if (kind === "selection-cleared") state.selected = null;
    else state.verified = false;
    const r = await preflight();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ACCOUNT_NOT_SELECTED");
    expect(bootstrap).not.toHaveBeenCalled();
    safe(r.body);
  },
);
it.each([
  "not-configured",
  "lookup-error",
  "final-lookup-error",
  "selection-db-error",
])(
  "separates %s service failure from a missing/revoked session",
  async (kind) => {
    if (kind === "not-configured") state.configured = false;
    if (kind === "lookup-error") state.authFailure = true;
    if (kind === "final-lookup-error")
      state.wait = async () => {
        state.authFailure = true;
      };
    if (kind === "selection-db-error") state.selectionDbFailure = true;
    const r = await preflight();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe(
      kind === "selection-db-error"
        ? "ACCOUNT_SERVICE_UNAVAILABLE"
        : "AUTH_UNAVAILABLE",
    );
    safe(r.body);
  },
);
it("rejects alias/foreign Origin and cross-site before session/quota/provider reads", async () => {
  for (const [origin, site] of [
    ["https://branch.nexus.test", "same-origin"],
    ["https://nexus.test", "cross-site"],
  ]) {
    const r = await request(app())
      .post("/api/live/preflight")
      .set("Origin", origin)
      .set("Sec-Fetch-Site", site);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ORIGIN_REJECTED");
    safe(r.body);
  }
  expect(state.calls).toBe(0);
  expect(bootstrap).not.toHaveBeenCalled();
  expect(rates.take).not.toHaveBeenCalled();
});
it("keeps quota rejection as 429 without retries or bootstrap work", async () => {
  state.rate = false;
  const r = await preflight();
  expect(r.status).toBe(429);
  expect(r.body.code).toBe("RATE_LIMITED");
  expect(r.body.rateLimitSource).toBe("INTERNAL_USER");
  expect(bootstrap).not.toHaveBeenCalled();
  expect(rates.take).toHaveBeenCalledOnce();
  safe(r.body);
});

it.each(["deleted", "revoked"])(
  "rechecks %s even when bootstrap fails during I/O",
  async (kind) => {
    const { ProviderError } = await import("../server/exness");
    state.wait = async () => {
      if (kind === "deleted") state.exists = false;
      else state.signedIn = false;
      throw new ProviderError("CONNECTION_DELETED", 409);
    };
    const r = await preflight();
    expect(r.status).toBe(kind === "deleted" ? 409 : 401);
    expect(r.body.code).toBe(
      kind === "deleted"
        ? "SELECTED_CONNECTION_UNAVAILABLE"
        : "SESSION_REVOKED",
    );
    expect(bootstrap).toHaveBeenCalledOnce();
    safe(r.body);
  },
);
it("does not overwrite a provider 429 or retry its bootstrap", async () => {
  const { ProviderError } = await import("../server/exness");
  state.wait = async () => {
    state.selected = null;
    throw new ProviderError("EXNESS_RATE_LIMIT", 429, 23, {
      rateLimitSource: "EXNESS_REST",
    });
  };
  const r = await preflight();
  expect(r.status).toBe(429);
  expect(r.body).toMatchObject({
    code: "RATE_LIMITED",
    retryAfterSec: 23,
    rateLimitSource: "EXNESS_REST",
  });
  expect(state.calls).toBe(1);
  expect(bootstrap).toHaveBeenCalledOnce();
  safe(r.body);
});

it("does not label a quota database failure as Origin/session rejection", async () => {
  rates.take.mockRejectedValueOnce(new Error("PRIVATE_DATABASE_CONNECTION"));
  const r = await preflight();
  expect(r.status).toBe(503);
  expect(r.body.code).toBe("ACCOUNT_SERVICE_UNAVAILABLE");
  expect(bootstrap).not.toHaveBeenCalled();
  safe(r.body);
});
