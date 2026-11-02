BEGIN;
CREATE SCHEMA IF NOT EXISTS nexus_private;
REVOKE ALL ON SCHEMA nexus_private FROM PUBLIC;
SET search_path TO nexus_private;
-- Better Auth email/password sessions, and the isolated NEXUS credential vault.
CREATE TABLE IF NOT EXISTS "user" (
 id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 "emailVerified" boolean NOT NULL DEFAULT false, image text,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS session (
 id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
 "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_user_idx ON session("userId");
CREATE TABLE IF NOT EXISTS account (
 id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
 "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 "accessToken" text, "refreshToken" text, "idToken" text,
 "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
 scope text, password text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_user_idx ON account("userId");
CREATE TABLE IF NOT EXISTS verification (
 id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nexus_credentials (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 label varchar(60) NOT NULL, envelope jsonb NOT NULL,
 status text NOT NULL DEFAULT 'saved' CHECK(status IN ('saved','verified','error')),
 created_at timestamptz NOT NULL DEFAULT now(), tested_at timestamptz
);
CREATE INDEX IF NOT EXISTS nexus_credentials_owner_idx ON nexus_credentials(user_id);
CREATE TABLE IF NOT EXISTS nexus_selection (
 user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
 credential_id uuid REFERENCES nexus_credentials(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS nexus_rate (
 key text PRIMARY KEY, stamps timestamptz[] NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
-- Atomic sliding window: a row lock coordinates all Vercel instances.
CREATE OR REPLACE FUNCTION nexus_take_rate(k text, maximum integer, seconds integer)
RETURNS boolean LANGUAGE plpgsql SET search_path = nexus_private, pg_temp AS $$
DECLARE times timestamptz[]; current_time_value timestamptz := clock_timestamp();
BEGIN
 IF maximum < 1 OR seconds < 1 THEN RETURN false; END IF;
 INSERT INTO nexus_rate(key) VALUES(k) ON CONFLICT DO NOTHING;
 SELECT stamps INTO times FROM nexus_rate WHERE key=k FOR UPDATE;
 SELECT coalesce(array_agg(t),'{}') INTO times FROM unnest(times) t
 WHERE t > current_time_value-make_interval(secs=>seconds);
 IF cardinality(times)>=maximum THEN RETURN false; END IF;
 UPDATE nexus_rate SET stamps=array_append(times,current_time_value),updated_at=current_time_value WHERE key=k;
 RETURN true;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA nexus_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nexus_private FROM PUBLIC;
CREATE OR REPLACE FUNCTION nexus_credential_cap() RETURNS trigger LANGUAGE plpgsql
SET search_path = nexus_private, pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id,0));
 IF (SELECT count(*) FROM nexus_credentials WHERE user_id=NEW.user_id)>=10 THEN
  RAISE EXCEPTION 'ACCOUNT_LIMIT';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nexus_credential_cap_trigger ON nexus_credentials;
CREATE TRIGGER nexus_credential_cap_trigger BEFORE INSERT ON nexus_credentials FOR EACH ROW EXECUTE FUNCTION nexus_credential_cap();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nexus_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS nexus_private.nexus_stream_lease (account_hash text PRIMARY KEY, token text NOT NULL, expires_at timestamptz NOT NULL);
REVOKE ALL ON nexus_private.nexus_stream_lease FROM PUBLIC;
COMMIT;
