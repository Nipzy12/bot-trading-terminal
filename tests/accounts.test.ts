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
      label: "EXNESS",
      live: false,
    });
    expect(data.text).not.toContain(secret.apiKey);
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
      stage: "candles",
      live: false,
    });
    expect(r.text).not.toContain(secret.apiKey);
  });
});
