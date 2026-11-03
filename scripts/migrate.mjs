import { Pool } from "pg";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL)
  throw Error("Set DATABASE_URL in a secure backend environment");
let db;
try {
  const url = new URL(process.env.DATABASE_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    (process.env.NODE_ENV === "production" && local)
  )
    throw Error();
  for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(name);
  db = new Pool({
    connectionString: url.toString(),
    ssl: local ? undefined : { rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
  });
  await db.query(
    await readFile(
      new URL("../migrations/001_accounts.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.query(await readFile(new URL("../migrations/002_engine.sql", import.meta.url), "utf8"));
  console.log("NEXUS account and Windows engine schema ready");
} catch {
  console.error(
    "Migration failed; verify database connectivity and schema permissions.",
  );
  process.exitCode = 1;
} finally {
  await db?.end();
}
