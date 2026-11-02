import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { accountRouter, csrf, type Identity } from "../server/accounts";
import { LiveBootstrapCache } from "../server/live-cache";
import { encrypt, decrypt } from "../server/vault";
import { takeRate, type Database } from "../server/database";
import { connectionStages } from "../server/connection-test";
import { ProviderError } from "../server/exness";
let pg: PGlite;
let db: Database;
let principal: Identity | null;
const key = randomBytes(32);
const keyText = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const secret = {
  apiKey: "synthetic-test-api-key",
  privateKey: keyText.trim(),
  accountId: "123456",
  gateway: "https://gateway.exness.com",
};
const alice: Identity = {
  user: { id: "alice", name: "Alice" },
  session: { id: "session-alice" },
};
const bob: Identity = {
  user: { id: "bob", name: "Bob" },
  session: { id: "session-bob" },
};
const reader = vi.fn(() => ({
  testConnection: async () => ({
    success: true,
    stages: connectionStages.map((stage) => ({
      stage,
      status: "passed" as const,
    })),
  }),
  candles: vi
    .fn()
    .mockResolvedValue([
      { time: 1700000000, open: 1, high: 2, low: 0.5, close: 1 },
    ]),
}));
function app(override: Parameters<typeof accountRouter>[0] = {}) {
  const a = express();
  a.use(express.json());
  a.use(
    "/api/account",
    accountRouter({
      db: () => db,
      ready: () => true,
      identity: async () => principal,
      reader,
      ...override,
    }),
  );
  return a;
}
function headers() {
  return { Origin: "https://terminal.test", "X-CSRF-Token": csrf(principal!) };
}
async function connect() {
  return request(app())
    .post("/api/account/connections")
    .set(headers())
    .send({ label: "My account", ...secret });
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(await readFile("migrations/001_accounts.sql", "utf8"));
  db = {
    query: async (text, params) => {
      const r = await pg.query(text, params);
      return { rows: r.rows as any[], rowCount: r.affectedRows };
    },
  };
  await db.query(
    'INSERT INTO "user"(id,name,email) VALUES($1,$2,$3),($4,$5,$6)',
    ["alice", "Alice", "alice@example.test", "bob", "Bob", "bob@example.test"],
  );
});
afterAll(async () => pg.close());
beforeEach(async () => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", key.toString("base64"));
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "test-auth-secret-with-at-least-32-characters",
  );
  vi.stubEnv("APP_ORIGIN", "https://terminal.test");
  principal = alice;
  reader.mockClear();
  await pg.exec(
    "DELETE FROM nexus_selection; DELETE FROM nexus_credentials; DELETE FROM nexus_rate;",
  );
});
afterEach(() => vi.unstubAllEnvs());
describe("credential vault and private API", () => {
  it("AES-256-GCM uses independent nonces, authenticates owner/id and detects tampering", () => {
    const a = encrypt(secret, "alice", "a", key),
      b = encrypt(secret, "alice", "a", key);
    expect(a.iv).not.toBe(b.iv);
    expect(decrypt(a, "alice", "a", key)).toEqual(secret);
    expect(JSON.stringify(a)).not.toContain(secret.apiKey);
    expect(() => decrypt(a, "bob", "a", key)).toThrow();
    expect(() => decrypt(a, "alice", "b", key)).toThrow();
    expect(() =>
      decrypt(
        { ...a, tag: randomBytes(16).toString("base64") },
        "alice",
        "a",
        key,
      ),
    ).toThrow();
    expect(() => decrypt(a, "alice", "a", randomBytes(32))).toThrow();
  });
  it("requires a valid session on every private route before DB ownership operations", async () => {
    principal = null;
    for (const [method, path] of [
      ["get", "/session"],
      ["get", "/connections"],
      ["post", "/connections"],
      ["post", "/selection"],
      ["delete", "/connections/11111111-1111-4111-8111-111111111111"],
      ["get", "/market?symbol=XAUUSD"],
      ["get", "/backtest/history?symbol=XAUUSD"],
    ] as const) {
      expect((await request(app())[method]("/api/account" + path)).status).toBe(
        401,
      );
    }
  });
  it("fails closed when vault/database dependencies are unavailable", async () => {
    expect(
      (
        await request(app({ ready: () => false })).get(
          "/api/account/connections",
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await request(
          app({
            db: () => ({
              query: async () => {
                throw Error("private db connection secret");
              },
            }),
          }),
        ).get("/api/account/connections")
      ).body,
    ).toEqual({ error: "ACCOUNT_SERVICE_UNAVAILABLE" });
  });
  it("requires same-origin and session-bound CSRF; never echoes submitted fields", async () => {
    for (const h of [
      { Origin: "https://evil.test", "X-CSRF-Token": csrf(alice) },
      { Origin: "https://terminal.test", "X-CSRF-Token": csrf(bob) },
      { Origin: "https://terminal.test" },
    ]) {
      const r = await request(app())
        .post("/api/account/connections")
        .set(h)
        .send(secret);
      expect(r.status).toBe(403);
      expect(r.text).not.toContain(secret.apiKey);
    }
    expect(
      (
        await request(app())
          .post("/api/account/connections")
          .set(headers())
          .set("Sec-Fetch-Site", "cross-site")
          .send(secret)
      ).status,
    ).toBe(403);
  });
  it("persists only encrypted credentials, and returns safe metadata", async () => {
    const r = await connect();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ label: "My account", status: "saved" });
    const stored = await db.query(
      "SELECT envelope FROM nexus_credentials WHERE id=$1",
      [r.body.id],
    );
    expect(decrypt(stored.rows[0].envelope, "alice", r.body.id)).toEqual(
      secret,
    );
    for (const body of [
      r.text,
      (await request(app()).get("/api/account/connections")).text,
    ])
      for (const value of [
        secret.apiKey,
        secret.privateKey,
        secret.accountId,
        secret.gateway,
      ])
        expect(body).not.toContain(value);
  });
  it("prevents IDOR for list, test, selection and deletion; only owner can decrypt/test", async () => {
    const id = (await connect()).body.id;
    principal = bob;
    expect(
      (await request(app()).get("/api/account/connections")).body.accounts,
    ).toEqual([]);
    for (const [method, path, body] of [
      ["post", `/connections/${id}/test`, {}],
      ["post", "/selection", { id }],
      ["delete", `/connections/${id}`, {}],
    ] as const) {
      expect(
        (
          await request(app())
            [method]("/api/account" + path)
            .set(headers())
            .send(body)
        ).status,
      ).toBe(404);
    }
    expect(reader).not.toHaveBeenCalled();
    principal = alice;
    expect(
      (
        await request(app())
          .post(`/api/account/connections/${id}/test`)
          .set(headers())
      ).body,
    ).toMatchObject({ status: "verified", live: false });
    expect(reader).toHaveBeenCalledWith(secret, "alice", id);
  });
  it("requires successful test before selection and revokes selected data on disconnect", async () => {
    const id = (await connect()).body.id;
    expect(
      (
        await request(app())
          .post("/api/account/selection")
          .set(headers())
          .send({ id })
      ).status,
    ).toBe(404);
    await request(app())
      .post(`/api/account/connections/${id}/test`)
      .set(headers());
    expect(
      (
        await request(app())
          .post("/api/account/selection")
          .set(headers())
          .send({ id })
      ).status,
    ).toBe(200);
    const data = await request(app()).get("/api/account/market?symbol=XAUUSD");
    expect(data.body).toMatchObject({
      source: "exness",
      paperSource: { kind: "EXNESS", connectionId: id },
      label: "EXNESS",
      live: false,
    });
    for (const value of Object.values(secret))
      expect(data.text).not.toContain(value);
    expect(
      (
        await request(app())
          .delete(`/api/account/connections/${id}`)
          .set(headers())
      ).status,
    ).toBe(200);
    expect(
      (await db.query("SELECT * FROM nexus_credentials")).rows,
    ).toHaveLength(0);
    expect(
      (await request(app()).get("/api/account/market?symbol=XAUUSD")).status,
    ).toBe(409);
  });
  it("rejects data from a connection deleted during provider I/O", async () => {
    const id = (await connect()).body.id;
    await request(app())
      .post(`/api/account/connections/${id}/test`)
      .set(headers());
    await request(app())
      .post("/api/account/selection")
      .set(headers())
      .send({ id });
    const racing = app({
      reader: () => ({
        testConnection: async () => ({ success: true, stages: [] }),
        candles: async () => {
          await db.query(
            "DELETE FROM nexus_credentials WHERE id=$1 AND user_id=$2",
            [id, "alice"],
          );
          return [];
        },
      }),
    });
    const r = await request(racing).get("/api/account/market?symbol=XAUUSD");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "CONNECTION_DELETED" });
  });
  it("rejects an old connection response when selection changes during provider I/O", async () => {
    const id = (await connect()).body.id;
    const second = (await connect()).body.id;
    for (const key of [id, second])
      await request(app())
        .post(`/api/account/connections/${key}/test`)
        .set(headers());
    await request(app())
      .post("/api/account/selection")
      .set(headers())
      .send({ id });
    const racing = app({
      reader: () => ({
        testConnection: async () => ({ success: true, stages: [] }),
        candles: async () => {
          await db.query(
            "UPDATE nexus_selection SET credential_id=$1 WHERE user_id=$2",
            [second, "alice"],
          );
          return [];
        },
      }),
    });
    expect(
      (await request(racing).get("/api/account/market?symbol=XAUUSD")).status,
    ).toBe(409);
  });
  it("serves backtest pages only for the owner selected connection and revokes changed selection", async () => {
    const id = (await connect()).body.id;
    await request(app())
      .post(`/api/account/connections/${id}/test`)
      .set(headers());
    await request(app())
      .post("/api/account/selection")
      .set(headers())
      .send({ id });
    const page = {
      candles: [{ time: 1700000000, open: 1, high: 2, low: 0.5, close: 1 }],
      window: { from: 1699999200, to: 1700002800 },
      nextBefore: 1699999200,
      excludedBoundaryCandles: 0,
    };
    const historyPage = vi.fn().mockResolvedValue(page);
    const service = app({
      reader: () => ({
        testConnection: async () => ({ success: true, stages: [] }),
        candles: async () => [],
        historyPage,
      }),
    });
    const result = await request(service).get(
      "/api/account/backtest/history?symbol=XAUUSD&interval=3600&before=1700002800",
    );
    expect(result.status).toBe(200);
    expect(historyPage).toHaveBeenCalledWith(
      "XAUUSD",
      3600,
      1700002800,
      undefined,
    );
    expect(result.body).toMatchObject({
      ...page,
      source: "exness",
      paperSource: { kind: "EXNESS", connectionId: id },
      live: false,
    });
    for (const value of Object.values(secret))
      expect(result.text).not.toContain(value);
    principal = bob;
    expect(
      (
        await request(service).get(
          "/api/account/backtest/history?symbol=XAUUSD",
        )
      ).status,
    ).toBe(409);
    principal = alice;
    const revoked = app({
      reader: () => ({
        testConnection: async () => ({ success: true, stages: [] }),
        candles: async () => [],
        historyPage: async () => {
          await db.query("DELETE FROM nexus_selection WHERE user_id=$1", [
            "alice",
          ]);
          return page;
        },
      }),
    });
    expect(
      (
        await request(revoked).get(
          "/api/account/backtest/history?symbol=XAUUSD",
        )
      ).status,
    ).toBe(409);
  });
  it.each([
    ["EXNESS_INVALID_TIME_RANGE", 3004, 400],
    ["EXNESS_INVALID_COUNT", 3005, 422],
    ["EXNESS_INVALID_LIMIT", 3006, 400],
    ["EXNESS_DATA_UNAVAILABLE", 4004, 400],
    ["TIMEOUT", undefined, 504],
    ["EXNESS_RATE_LIMIT", undefined, 429],
    ["HISTORY_LIMIT_REACHED", undefined, 416],
    ["HISTORY_INTERNAL_FAILURE", undefined, 500],
  ] as const)(
    "returns structured safe backtest failure %s with progress",
    async (code, providerCode, status) => {
      const id = (await connect()).body.id;
      await request(app())
        .post(`/api/account/connections/${id}/test`)
        .set(headers());
      await request(app())
        .post("/api/account/selection")
        .set(headers())
        .send({ id });
      const failing = app({
        reader: () => ({
          testConnection: async () => ({ success: true, stages: [] }),
          candles: async () => [],
          historyPage: async () => {
            if (code === "HISTORY_INTERNAL_FAILURE")
              throw Error("secret key, private host and price");
            throw new ProviderError(
              code,
              status,
              code === "EXNESS_RATE_LIMIT" ? 60 : undefined,
              {
                providerCode,
                upstreamStatus: status,
                ...(code === "HISTORY_LIMIT_REACHED"
                  ? { limitCause: "PROVIDER_AGE" as const }
                  : {}),
              },
            );
          },
        }),
      });
      const r = await request(failing).get(
        "/api/account/backtest/history?symbol=XAUUSD&interval=3600&pageIndex=5&loadedIntervals=720&validCandles=540",
      );
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({
        error: code === "EXNESS_RATE_LIMIT" ? "RATE_LIMITED" : code,
        httpStatus: status,
        paperSource: { kind: "EXNESS", connectionId: id },
        diagnostic: { pageIndex: 5, loadedIntervals: 720, validCandles: 540 },
      });
      for (const forbidden of [
        ...Object.values(secret),
        "secret key, private host and price",
      ])
        expect(r.text).not.toContain(forbidden);
      if (providerCode) expect(r.body.providerCode).toBe(providerCode);
    },
  );
  it("revokes even an exhaustion error if selection changes during provider I/O", async () => {
    const id = (await connect()).body.id;
    await request(app())
      .post(`/api/account/connections/${id}/test`)
      .set(headers());
    await request(app())
      .post("/api/account/selection")
      .set(headers())
      .send({ id });
    const failing = app({
      reader: () => ({
        testConnection: async () => ({ success: true, stages: [] }),
        candles: async () => [],
        historyPage: async () => {
          await db.query("DELETE FROM nexus_selection WHERE user_id=$1", [
            "alice",
          ]);
          throw new ProviderError("EXNESS_DATA_UNAVAILABLE", 400, undefined, {
            providerCode: 4004,
          });
        },
      }),
    });
    const r = await request(failing).get(
      "/api/account/backtest/history?symbol=XAUUSD",
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("CONNECTION_DELETED");
    expect(r.body.paperSource).toBeUndefined();
  });
  it("reuses encrypted bootstrap across instances without sharing owner/symbol data", async () => {
    const a = new LiveBootstrapCache(),
      b = new LiveBootstrapCache(),
      build = vi.fn(async () => ({
        prepared: { host: "private-host", path: "private-account" },
        candles: [{ close: 1 }],
      }));
    const first = await a.reuse(db, "alice", "cache-id", "XAUUSD", 3600, build);
    expect(
      await b.reuse(db, "alice", "cache-id", "XAUUSD", 3600, build),
    ).toEqual(first);
    expect(build).toHaveBeenCalledTimes(1);
    await b.reuse(db, "bob", "cache-id", "XAUUSD", 3600, build);
    await a.reuse(db, "alice", "cache-id", "EURUSD", 3600, build);
    expect(build).toHaveBeenCalledTimes(3);
    const rows = await db.query(
      "SELECT envelope FROM nexus_private.nexus_live_bootstrap",
    );
    expect(JSON.stringify(rows.rows)).not.toContain("private-host");
  });
  it("deduplicates in-flight bootstrap and gates another Vercel instance while loading", async () => {
    const a = new LiveBootstrapCache(),
      b = new LiveBootstrapCache();
    let release!: (v: unknown) => void;
    const build = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = a.reuse(db, "alice", "pending-id", "XAUUSD", 3600, build),
      same = a.reuse(db, "alice", "pending-id", "XAUUSD", 3600, build);
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    await expect(
      b.reuse(db, "alice", "pending-id", "XAUUSD", 3600, build),
    ).rejects.toMatchObject({
      status: 429,
      details: { rateLimitSource: "INTERNAL_PROVIDER_REST" },
    });
    release({ safe: true });
    expect(await first).toEqual(await same);
    await db.query(
      "UPDATE nexus_private.nexus_live_bootstrap SET expires_at=now()-interval '1 second',lock_until=now()-interval '1 second'",
    );
    const fresh = vi.fn(async () => ({ safe: false }));
    expect(
      await b.reuse(db, "alice", "pending-id", "XAUUSD", 3600, fresh),
    ).toEqual({ safe: false });
    expect(fresh).toHaveBeenCalledTimes(1);
  });
  it("enforces one durable stream lease and allows recovery after TTL", async () => {
    const sql =
      "INSERT INTO nexus_private.nexus_stream_lease(account_hash,token,expires_at) VALUES($1,$2,now()+interval '30 seconds') ON CONFLICT(account_hash) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE nexus_stream_lease.expires_at<now() RETURNING token";
    expect(
      (await db.query(sql, ["synthetic-hash", "first"])).rows,
    ).toHaveLength(1);
    expect(
      (await db.query(sql, ["synthetic-hash", "second"])).rows,
    ).toHaveLength(0);
    await db.query(
      "UPDATE nexus_private.nexus_stream_lease SET expires_at=now()-interval '1 second' WHERE account_hash=$1",
      ["synthetic-hash"],
    );
    expect(
      (await db.query(sql, ["synthetic-hash", "third"])).rows[0].token,
    ).toBe("third");
  });
  it("enforces centralized atomic rate limits across independent application instances", async () => {
    const a = app(),
      b = app();
    for (let i = 0; i < 120; i++)
      expect(
        (await request(i % 2 ? a : b).get("/api/account/session")).status,
      ).toBe(200);
    expect((await request(app()).get("/api/account/session")).status).toBe(429);
    expect(await takeRate(db, "separate", 1, 60)).toBe(true);
    expect(await takeRate(db, "separate", 1, 60)).toBe(false);
  });
  it("never opens a network connection for invalid or disallowed Gateway URLs", async () => {
    for (const gateway of [
      "https://evil.test",
      "http://gateway.exness.com",
      "https://gateway.exness.com@evil.test",
      "https://127.0.0.1",
      "https://gateway.exness.com/path",
    ]) {
      const r = await request(app())
        .post("/api/account/connections")
        .set(headers())
        .send({ label: "test", ...secret, gateway });
      expect(r.status).toBe(400);
    }
    expect(reader).not.toHaveBeenCalled();
  });
  it.each([
    ["discovery", "EXNESS_AUTH", 502],
    ["account_details", "EXNESS_PERMISSION", 502],
    ["limits", "RATE_LIMITED", 429],
    ["candles", "TIMEOUT", 504],
  ] as const)(
    "returns safe stage %s and category %s",
    async (stage, error, status) => {
      const id = (await connect()).body.id;
      const failed = app({
        reader: () => ({
          candles: async () => [],
          testConnection: async () => ({
            success: false,
            stage,
            error,
            retryAfter: error === "RATE_LIMITED" ? 30 : undefined,
            stages: connectionStages.map((s) => ({
              stage: s,
              status:
                connectionStages.indexOf(s) < connectionStages.indexOf(stage)
                  ? "passed"
                  : s === stage
                    ? "failed"
                    : "not_run",
            })),
          }),
        }),
      });
      const r = await request(failed)
        .post(`/api/account/connections/${id}/test`)
        .set(headers());
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ stage, error, live: false });
      expect(r.text).not.toContain(secret.apiKey);
      if (status === 429) expect(r.headers["retry-after"]).toBe("30");
    },
  );
  it("sanitizes provider failures without exposing credentials or internal diagnostics", async () => {
    const id = (await connect()).body.id;
    const failed = app({
      reader: () => ({
        testConnection: async () => ({
          success: false,
          stage: "candles",
          error: "EXNESS_INVALID_RESPONSE",
          reason: "EMPTY_CANDLES",
          candleCount: 0,
          stages: connectionStages.map((stage) => ({
            stage,
            status:
              stage === "candles" ? ("failed" as const) : ("passed" as const),
          })),
        }),
        candles: async () => {
          throw Error(secret.apiKey + secret.privateKey);
        },
      }),
    });
    const r = await request(failed)
      .post(`/api/account/connections/${id}/test`)
      .set(headers());
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({
      error: "EXNESS_INVALID_RESPONSE",
      reason: "EMPTY_CANDLES",
      candleCount: 0,
      stage: "candles",
      live: false,
    });
    expect(r.text).not.toContain(secret.apiKey);
  });
});
