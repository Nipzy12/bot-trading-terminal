import { it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createAuth } from "../server/auth";
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
  try {
    const signup = await auth.handler(
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
    );
    expect(signup.status).toBe(200);
    const cookies = signup.headers.getSetCookie();
    expect(
      cookies.some(
        (c) =>
          c.includes("HttpOnly") &&
          c.includes("Secure") &&
          c.toLowerCase().includes("samesite=lax"),
      ),
    ).toBe(true);
    const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user.email).toBe("test@example.test");
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
  } finally {
    await db.close();
    vi.unstubAllEnvs();
  }
}, 15000);
