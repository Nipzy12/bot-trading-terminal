import { Pool } from "pg";
export type Database = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>;
};
let pool: Pool | undefined;
export function database() {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_UNAVAILABLE");
  if (pool) return pool;
  const url = new URL(process.env.DATABASE_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    (process.env.NODE_ENV === "production" && local)
  )
    throw Error("DATABASE_UNAVAILABLE");
  for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(name);
  pool = new Pool({
    connectionString: url.toString(),
    ssl: local ? undefined : { rejectUnauthorized: true },
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: true,
  });
  pool.on("error", () => {
    /* Request handlers fail closed; never log a connection URL. */
  });
  return pool;
}
export async function takeRate(
  db: Database,
  key: string,
  max: number,
  seconds: number,
) {
  const result = await db.query(
    "SELECT nexus_private.nexus_take_rate($1,$2,$3) AS allowed",
    [key, max, seconds],
  );
  return result.rows[0]?.allowed === true;
}
