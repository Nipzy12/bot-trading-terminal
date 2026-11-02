import { betterAuth } from "better-auth";
import { PostgresDialect } from "kysely";
import { database } from "./database.js";
import { encryptionKey } from "./vault.js";
export function origin() {
  const value = process.env.APP_ORIGIN ?? "";
  const url = new URL(value);
  if (
    url.origin !== value ||
    (url.protocol !== "https:" &&
      !(process.env.NODE_ENV !== "production" && url.hostname === "localhost"))
  )
    throw Error("AUTH_UNAVAILABLE");
  return value;
}
export function configured() {
  try {
    encryptionKey();
    origin();
    return (
      !!process.env.DATABASE_URL &&
      (process.env.BETTER_AUTH_SECRET?.length ?? 0) >= 32
    );
  } catch {
    return false;
  }
}
export function createAuth(connection = database()) {
  return betterAuth({
    database: {
      dialect: new PostgresDialect({ pool: connection }),
      type: "postgres",
      schemaName: "nexus_private",
      transaction: true,
    },
    baseURL: origin(),
    secret: process.env.BETTER_AUTH_SECRET!,
    trustedOrigins: [origin()],
    rateLimit: { enabled: false },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: origin().startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    logger: { disabled: true },
  });
}
let instance: ReturnType<typeof createAuth> | undefined;
export function auth() {
  if (!configured()) throw Error("AUTH_UNAVAILABLE");
  return (instance ??= createAuth());
}

// The browser uses HttpOnly cookies only. Do not echo bearer session tokens in JSON.
export async function cookieOnlyResponse(response: Response) {
  if (!response.headers.get("content-type")?.includes("application/json"))
    return response;
  const data = await response.json();
  if (data && typeof data === "object") {
    delete data.token;
    if (data.session && typeof data.session === "object")
      delete data.session.token;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(data), {
    status: response.status,
    headers,
  });
}
