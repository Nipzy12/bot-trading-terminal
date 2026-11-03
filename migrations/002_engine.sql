BEGIN;
CREATE TABLE IF NOT EXISTS nexus_private.nexus_engine_pairing (
 user_id text PRIMARY KEY REFERENCES nexus_private."user"(id) ON DELETE CASCADE,
 code_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS nexus_private.nexus_engine_devices (
 user_id text PRIMARY KEY REFERENCES nexus_private."user"(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 60),
 paired_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz
);
REVOKE ALL ON nexus_private.nexus_engine_pairing FROM PUBLIC;
REVOKE ALL ON nexus_private.nexus_engine_devices FROM PUBLIC;
COMMIT;
