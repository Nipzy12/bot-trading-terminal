BEGIN;
CREATE TABLE IF NOT EXISTS nexus_private.nexus_engine_test_quotes (
 user_id text PRIMARY KEY REFERENCES nexus_private."user"(id) ON DELETE CASCADE,
 symbol text NOT NULL CHECK (symbol='XAUUSD'),
 bid double precision NOT NULL CHECK(bid>0),
 ask double precision NOT NULL CHECK(ask>=bid),
 quote_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON nexus_private.nexus_engine_test_quotes FROM PUBLIC;
COMMIT;
