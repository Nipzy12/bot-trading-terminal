// Idempotent schema installation runs only against the configured backend database.
if (process.env.DATABASE_URL) await import("./migrate.mjs");
else
  console.log(
    "Account Management disabled: PostgreSQL not configured. Public DEMO remains available.",
  );
