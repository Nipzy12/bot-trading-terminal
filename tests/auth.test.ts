import express from "express";
import request from "supertest";
import { fromNodeHeaders } from "better-auth/node";
import { accountRouter } from "../server/accounts";
import { it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createAuth, cookieOnlyResponse } from "../server/auth";
it("uses Better Auth real password hashing, secure session cookie, DB session expiry and logout revocation", async () => {
  const db = new PGlite();
  await db.exec(await readFile("migrations/001_accounts.sql", "utf8"));
  vi.stubEnv("APP_ORIGIN", "https://terminal.test");
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(48).toString("base64"));
  const pool = {
    connect: async () => ({
      query: async (
        input: string | { text: string; values: unknown[] },
        values?: unknown[],
      ) => {
        const sql = typeof input === "string" ? input : input.text;
        const params = typeof input === "string" ? values : input.values;
        const r = await db.query(sql, params);
        return { rows: r.rows, rowCount: r.affectedRows };
      },
      release: () => {},
    }),
    end: async () => {},
  } as unknown as Pool;
  const auth = createAuth(pool);
  const api = express();
  api.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  api.use(
    "/api/account",
    accountRouter({
      ready: () => true,
      db: () => ({
        query: async (text, params) => {
          const r = await db.query(text, params);
          return { rows: r.rows as any[], rowCount: r.affectedRows };
        },
      }),
      identity: (req) =>
        auth.api.getSession({ headers: fromNodeHeaders(req.headers) }),
    }),
  );
  try {
    const signup = await cookieOnlyResponse(
      await auth.handler(
        new Request("https://terminal.test/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            origin: "https://terminal.test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Synthetic Tester",
            email: "test@example.test",
            password: "synthetic-test-password-12345",
          }),
        }),
      ),
    );
    expect(signup.status).toBe(200);
    expect(await signup.clone().json()).not.toHaveProperty("token");
    const cookies = signup.headers.getSetCookie();
    expect(
      cookies.some(
        (c) =>
          c.includes("HttpOnly") &&
          c.includes("Secure") &&
          c.toLowerCase().includes("samesite=lax"),
      ),
    ).toBe(true);
    const sessionCookie = cookies.find((c) => c.includes("session_token"))!;
    expect(sessionCookie).toMatch(/(?:^|;)\s*Path=\//i);
    expect(sessionCookie).not.toMatch(/(?:^|;)\s*Domain=/i);
    const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user.email).toBe("test@example.test");
    expect((await request(api).get("/api/account/session")).status).toBe(401);
    expect(
      (
        await request(api)
          .get("/api/account/session")
          .set(
            "Cookie",
            "__Secure-better-auth.session_token=invalid-synthetic-signature",
          )
      ).status,
    ).toBe(401);
    const privateSession = await request(api)
      .get("/api/account/session")
      .set("Cookie", cookie);
    expect(privateSession.status).toBe(200);
    expect(Object.keys(privateSession.body).sort()).toEqual([
      "csrfToken",
      "user",
    ]);
    expect(privateSession.body.user).toEqual({ name: "Synthetic Tester" });
    expect(privateSession.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(privateSession.body)).not.toContain(
      session!.session.id,
    );
    expect(privateSession.body).not.toHaveProperty("token");
    const stored = await db.query("SELECT password FROM account");
    expect((stored.rows[0] as { password: string }).password).not.toBe(
      "synthetic-test-password-12345",
    );
    const rejected = await auth.handler(
      new Request("https://terminal.test/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          origin: "https://terminal.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "test@example.test",
          password: "incorrect-password",
        }),
      }),
    );
    expect(rejected.status).not.toBe(200);
    const logout = await auth.handler(
      new Request("https://terminal.test/api/auth/sign-out", {
        method: "POST",
        headers: {
          origin: "https://terminal.test",
          "content-type": "application/json",
          cookie,
        },
        body: "{}",
      }),
    );
    expect(logout.status).toBe(200);
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).toBeNull();
    expect(
      (await request(api).get("/api/account/session").set("Cookie", cookie))
        .status,
    ).toBe(401);
    const renewed = await cookieOnlyResponse(
      await auth.handler(
        new Request("https://terminal.test/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            origin: "https://terminal.test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: "test@example.test",
            password: "synthetic-test-password-12345",
          }),
        }),
      ),
    );
    expect(renewed.status).toBe(200);
    const renewedCookie = renewed.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(
      (
        await request(api)
          .get("/api/account/session")
          .set("Cookie", renewedCookie)
      ).status,
    ).toBe(200);
    await db.query(
      "UPDATE nexus_private.session SET \"expiresAt\"=now()-interval '1 second'",
    );
    expect(
      (
        await request(api)
          .get("/api/account/session")
          .set("Cookie", renewedCookie)
      ).status,
    ).toBe(401);
  } finally {
    await db.close();
    vi.unstubAllEnvs();
  }
}, 15000);
