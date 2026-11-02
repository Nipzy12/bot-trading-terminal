# NEXUS V3 security boundaries

No live broker order code exists. Exness connections use GET-only discovery, configuration limits and candle history. The application cannot establish that a submitted key lacks broker-mutation permissions: users must choose a read-only key in Exness Key Management. The backend itself never calls a mutating broker operation.

## Deployment prerequisites

Private management is unavailable until PostgreSQL, the exact trusted APP_ORIGIN, BETTER_AUTH_SECRET and CREDENTIALS_ENCRYPTION_KEY are configured. Database outages, missing migration tables, rate-store failures and vault failures deny private access. There is no production test-user header, mock login, memory database fallback or public credential read-back API. Tests inject dependencies only through an internal router factory.

Use the private `nexus_private` schema on a trusted database, with PUBLIC access revoked. Do not grant browser/anonymous Data API roles access. Migrations require a schema-owning backend role. Use provider-managed TLS and backups, keep the DB connection and secrets out of logs, and keep Preview credentials separate. The encryption key must not be stored in the database.

The Vercel edge's trusted `x-vercel-forwarded-for` is used only when VERCEL=1 for hashed authentication IP throttling; local development uses the socket address, never arbitrary client X-Forwarded-For. Credential operations are independently limited per authenticated user and provider identity in the shared database. If hosting behind a different proxy, preserve this trust boundary rather than enabling broad Express trust-proxy settings.

## Key rotation and deletion

- Credential changes: disconnect and delete the saved record, revoke the old API key in Exness Key Management, then create/reconnect a new read-only key. No credentials can be retrieved through the app.
- Vault key rotation: do not replace CREDENTIALS_ENCRYPTION_KEY while expecting old ciphertext to decrypt. Disconnect existing credentials first, rotate the Vercel Secret, redeploy, and reconnect. A lost key makes old records unrecoverable. A future online rotation must explicitly decrypt/re-encrypt records in a trusted maintenance environment; no rotation endpoint is exposed.
- Auth secret rotation invalidates cookie signatures and CSRF tokens. Sign in again after rotation. DB-backed sessions are revocable with logout; expiry is checked on every private API operation.
- Deletion removes the application's active ciphertext and selection. Backups, WAL and provider retention may retain encrypted historical copies. Manage retention in the database provider. A provider request already sent before deletion cannot be recalled; subsequent calls and final response ownership checks fail closed.
- The running server briefly holds decrypted credentials in memory to sign requests; warm reader caches have a five-minute eligibility TTL and local entries are invalidated on deletion. An idle instance may retain transient memory until reclaimed; every provider call and final result still rechecks the active credential record. Credentials never enter browser persistence, API responses, source, application logs or telemetry.

## Database maintenance

A trusted administrator may periodically remove expired rate rows:

```sql
DELETE FROM nexus_private.nexus_rate
WHERE updated_at < now() - interval '2 days';
```

Use a retention period greater than every configured provider rate window. Delete expired sessions/verification rows with Better Auth's documented maintenance process. Do not log query parameter values or HTTP request bodies on credential/auth routes. This app disables Better Auth's diagnostic logger and uses generic errors; infrastructure-level body capture/APM must also stay disabled for these paths.

## Verification

`npm test` includes real PostgreSQL-compatible SQL tests (PGlite), actual Better Auth signup, hashing, secure cookie/session and logout lifecycle, IDOR rejection for two users, AAD/ciphertext tamper checks, CSRF rejection, centralized rate accounting across router instances, fail-closed dependencies, credential deletion/selection revocation, SSRF range checks and DNS pinning/redirect policy, plus Exness adapter mocks and paper-risk tests.

Browser tests use synthetic credentials with mocked account API responses for mobile forms and isolate these from the real backend security tests. Do not run browser screenshots or test scripts with actual Exness keys. Account-management production activation and a full deployed sign-up/connect flow must be verified after the real database is provisioned. No real Exness credential is requested during development.

Email verification, password recovery email and MFA are not configured. A registered application user owns their credential rows by server-issued user ID; email ownership or Exness legal identity is not asserted. The UI is protected against framing and production CSP limits scripts/connections to the same origin. Any new analytics, OAuth or external scripts must be reviewed before relaxing those rules.
