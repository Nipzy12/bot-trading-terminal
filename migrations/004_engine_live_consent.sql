BEGIN;
CREATE TABLE IF NOT EXISTS nexus_private.nexus_engine_live_permission (
  user_id text PRIMARY KEY REFERENCES nexus_private."user"(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON nexus_private.nexus_engine_live_permission FROM PUBLIC;
COMMIT;
