# NEXUS V5 Trading Terminal

React/TypeScript/Vite frontend and Express/Vercel Functions backend. Public **DEMO**, private **Account Management**, and browser-local **paper trading**. No broker orders or live trading.

## Run and verify

Node.js 22.x:

```sh
npm ci
npm test
npm run build
npm run dev
```

Open `http://localhost:5173`. `/accounts` is the account page; Vite proxies `/api` to local Express. `npm run test:browser` checks paper trading and Android layouts. `npm run test:paper:browser` reproduces legacy DEMO positions switching to two mocked EXNESS connections and checks entry/mark/emergency isolation. `npm run test:accounts:browser` checks account forms and flows with mocked UI responses at 360/390/412px; real Better Auth password/session lifecycle and PostgreSQL credential isolation are exercised separately in backend tests using PGlite. No real Exness credentials are needed for any tests.

## Vercel and PostgreSQL setup from Android

1. Open Chrome → **Desktop site** if needed → Vercel project **bot-trading-terminal** → **Storage**. Connect PostgreSQL (for example Neon) and ensure `DATABASE_URL` is present for **Production**. Use a trusted TLS connection URL, a schema-owning backend role, and a provider-recommended pooled/direct endpoint. The app uses a private schema `nexus_private`; no credentials belong in an exposed public schema or frontend database client.
2. In **Settings → Environment Variables**, configure the backend-only values below. Never use `VITE_*`. The encryption key and auth secret must be independent Vercel **Secret** values. They have already been generated for this project's Production environment during development; do not replace them on every deployment.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL backend connection, TLS required for remote databases |
| `APP_ORIGIN` | Exact trusted origin, e.g. the project's production HTTPS domain, with no trailing slash |
| `BETTER_AUTH_SECRET` | Random session/auth secret, at least 32 characters, Vercel Secret |
| `CREDENTIALS_ENCRYPTION_KEY` | Exactly 32 random bytes encoded as padded standard Base64, a separate Vercel Secret |
| `EXNESS_ALLOWED_HOSTS` | Optional administrator-controlled Exness DNS suffix allowlist; defaults to `exness.com,exness-api.com` |

3. Redeploy **feat/trading-terminal**. `npm run vercel-build` runs the idempotent `migrations/001_accounts.sql` against the configured database, then builds Vite. Without `DATABASE_URL`, deployment succeeds with account management disabled and public DEMO available. A configured but inaccessible database causes migration/deployment to fail rather than pretending account storage works. For manual schema installation in a trusted environment: `npm run db:migrate`.
4. Open `/accounts`, register an application user with a password of at least 12 characters, and sign in. Use an application password, **not your Exness password**. Better Auth manages hashed passwords and database-backed sessions. Email verification and password recovery email delivery are not configured in this release; registration proves possession of the application password, not ownership of an email inbox.
5. In Exness **Key Management**, create/select a Trader API key with **Trading read access only**. Follow the [official key and host setup](https://www.exness-api.com/authentication/api-key-and-host-setup). Copy the account ID and **Gateway from the DNS widget**, not a sample hostname or a guessed Access Point. Do not send any of these values through chat, screenshots, GitHub, or browser storage.
6. Click **Connect Exness**. Enter a connection label, API Key, Private Signing Key, Account ID and Gateway URL. The private signing key may be Exness-generated 128-character hex (seed + public key), or your Ed25519 PKCS#8 PEM. Submit directly through the HTTPS form. Fields are cleared after submission; there is no read-back endpoint for any credential field.
7. Click **Test Connection**. This performs fresh signed GET tests in order: Gateway discovery → read-only account details → limits → XAUUSD H1 candle history. Each stage is reported as passed, failed or not_run; later stages are not attempted after failure. A valid result marks the connection **EXNESS · history teruji**. Select that account, then **Buka chart EXNESS history**. If XAUUSD is not available for the account, the test fails without claiming connectivity; only the six supported instruments are available in this release.
8. **Disconnect & hapus** deletes the active encrypted credential record, clears selection by foreign key, and invalidates its reader cache. It does not revoke the API key at Exness; revoke that separately in Key Management if needed. Database backups/WAL may retain ciphertext according to your database provider's retention policy.

For Preview, set a separate database/auth/encryption configuration and exact stable `APP_ORIGIN` for the branch alias. Do not reuse Production secret values in untrusted previews. Never expose a database or encryption key through public build variables. V3 no longer uses global `EXN_*` or the V1 bridge variables; the public endpoint always returns DEMO, even if obsolete global variables remain configured.

## Private account architecture

- Auth: Better Auth email/password and opaque, signed HttpOnly/Secure/SameSite cookies over HTTPS. Sessions are checked against the database on every private endpoint, with a 12-hour expiry and no cookie session cache. Bearer session tokens are stripped from JSON responses; only HttpOnly cookies carry authentication. Only email sign-up/sign-in and sign-out are exposed from Better Auth. No frontend session/localStorage token or client-provided user ID is used for authorization. Sign out deletes the DB session.
- Vault: AES-256-GCM, fresh 96-bit nonce per record, 128-bit authentication tag. AAD binds ciphertext to the authenticated user ID and connection UUID. The database holds only a versioned encryption envelope plus a non-secret user label/status. The key stays in a separate Vercel Secret.
- Ownership: every list, test, selection, delete and private-market query includes the server-authenticated user ID. A foreign connection ID returns 404. Account ID, Gateway, API key, private key and signed headers are never returned, logged, or copied into localStorage.
- CSRF: exact `APP_ORIGIN` and rejection of cross-site Fetch Metadata for mutations, plus timing-safe validation of an HMAC token bound to the current session on credential mutations. Better Auth's own origin/CSRF checks remain enabled. Auth endpoints also require the trusted Origin on mutations.
- SSRF: HTTPS origin only; no userinfo, path, query, fragment, non-default port or IP literal. Gateway and discovered Access Point must match an administrator-controlled Exness domain boundary. Every network call resolves all A/AAAA answers and rejects private, loopback, metadata, CGNAT, link-local, reserved, and mapped private IPv6 addresses. Approved addresses are pinned into the HTTP agent's DNS lookup while TLS hostname/certificate verification stays enabled. Redirects are forbidden. Responses are size-limited.
- Central rate limits: PostgreSQL row-lock sliding windows span all Vercel instances. They cover authentication, private API operations, connection tests and every provider request. Exness effective global/per-operation quotas are also applied centrally per HMAC account identity. No database/in-memory fallback permits requests when central accounting fails. Old rate records can be removed by the maintenance query in `SECURITY.md`.
- Revocation: no credential edits/read-back. Replace via Disconnect then Connect. Requests recheck ownership before provider I/O; private market results are checked again after I/O to reject concurrent deletion or a changed selection. A credential disconnect does not reset the paper account.

Database schema installation is idempotent and uses a private, non-public schema with PUBLIC privileges revoked. Backend SQL is parameterized. Use a dedicated database and appropriately restricted backend role; do not expose the schema via PostgREST/Data API. See [SECURITY.md](SECURITY.md) for operational boundaries, key rotation and testing evidence.

## Data routes and labels

| Route | Access / behavior |
| --- | --- |
| `GET /api/health` | Public; app health, execution simulation, liveTrading false |
| `GET /api/market?symbol=XAUUSD&interval=3600` | Public DEMO, always synthetic |
| `GET /api/account/config` | Public readiness flag only, no settings/secret values |
| `/api/auth/*` | Better Auth, origin checks and centralized rate limiting |
| `GET /api/account/session` | Authenticated user display name + session-bound CSRF token |
| `GET/POST /api/account/connections` | Owner-only safe list / encrypted creation |
| `POST /api/account/connections/:id/test` | Owner-only read-only provider test + CSRF |
| `POST /api/account/selection` | Owner-only tested account selection + CSRF |
| `DELETE /api/account/connections/:id` | Owner-only credential deletion + CSRF |
| `GET /api/account/market` | Authenticated user's selected tested account candle history |
| `/api/orders` | All methods denied 403, no broker implementation |

Exness integration follows [Gateway/AP discovery](https://www.exness-api.com/trading/get-started/access-point-host-discovery), [Ed25519 EXN signing](https://www.exness-api.com/authentication/request-signing), [candle history](https://www.exness-api.com/reference/trading/get-candle-history) and current effective [limits](https://www.exness-api.com/trading/guides/api-configuration-and-limits). Signed GET paths/queries match bytes sent; idempotency is empty and body hash is SHA-256 of empty bytes. PEM/hex keys and public-half consistency are validated.

UI seconds map `300→M5`, `900→M15`, `3600→H1`, `14400→H4`, `86400→D1`. Only valid, ordered, positive and coherent OHLC histories are accepted. **EXNESS is candle history, not ticks live**; `live:false` remains explicit. Watchlist/ticker remain DEMO snapshots. HTTP 429 pauses polling and the robot until a manual retry after the cooldown. Provider error details and credentials are sanitized.

## Paper trading retained

Mobile position cards, floating/realized P&L, equity, optional price-based SL/TP, history and browser-local persistence are separated into **DEMO** and **EXNESS per connection** paper accounts. The backend returns an opaque internal connection UUID (`paperSource`), never the broker Account ID or credentials. Replacing a connection creates a different paper account; disconnecting does not delete its local positions. Select a saved paper account from the terminal account selector. Feed DEMO and Feed EXNESS history links select the requested price environment; the chart's verified identity selects its corresponding paper account. Viewing a saved account with a different feed pauses marking, closes, SL/TP and its robot. Its floating P&L/equity display **Menunggu** instead of a cross-source or partial total. The watchlist and ticker remain explicitly DEMO snapshots.

Persistence uses `nexus.paper.v2` with separate positions/history, daily budget, halt and emergency state per account. Legacy source-less `nexus.paper.v1` positions and history migrate to DEMO with the same IDs, entry/exit prices, SL/TP and risk settings. Migration never closes, deletes or reprices a position; the original v1 storage remains as a backup. Historical realized P&L is preserved as recorded, not recalculated. Storage contains paper state and opaque source identifiers only; no credentials. Account-specific P&L, SL/TP, manual/emergency closes, new entries and robot signals reject marks from a different source/connection. Missing marks suspend the robot and hide unvalued floating/equity totals.

The robot always starts stopped; running state is never persisted and account/feed changes stop it. Its default UTC daily loss budget is $100 per paper account, counting realized losses plus floating losses without netting gains. Emergency stop applies only to the selected paper account, closes positions with matching quotes, queues unmatched/unquoted positions until its own feed returns, and persists its manual-unlock latch. These are paper execution rules, not broker instructions.

SL/TP, paper valuation and the robot run only while the page is open. Marks are DEMO synthetic values or the last closed M5 candle from the selected private Exness account; they are not broker execution prices. Public DEMO is always the default. Contract sizes and USDJPY conversion are simulation assumptions; fees, margin and real execution are not modeled. This is not investment advice.

## Diagnostik Test Connection

Kontrak dicek kembali pada 2 November 2026 terhadap [request signing](https://www.exness-api.com/authentication/request-signing), [discovery](https://www.exness-api.com/trading/get-started/access-point-host-discovery), dan [OpenAPI Trader API](https://www.exness-api.com/openapi/trading.public.yaml). Endpoint account details adalah signed GET `/v1/configuration/accounts/{account_id}/account`; `account_id` harus cocok dan `create_date` harus ISO date-time sesuai schema. Data account details tidak diteruskan ke frontend.

Test manual memakai probe baru agar cache chart tidak menyembunyikan kegagalan. Urutan tetap `discovery`, `account_details`, `limits`, `candles`. Pada kegagalan, respons aman memuat `stage`, `error`, `stages` (status `passed`/`failed`/`not_run`) dan opsional `retryAfter`. Tidak memuat account ID, URL host/IP, key, signed header, body provider atau diagnostic text mentah. Riwayat status tahap ditampilkan pada hasil test saat ini; metadata koneksi tetap hanya menyimpan status dan waktu test terakhir.

| Kategori | Arti |
| --- | --- |
| EXNESS_AUTH | HTTP 401 / kode autentikasi Exness 1000 atau 1001 pada tahap yang ditampilkan |
| EXNESS_PERMISSION | HTTP 403 / kode 1002 atau pembatasan akun; periksa akses akun, read scope dan IP, jangan full access |
| EXNESS_NETWORK | Kegagalan DNS, TLS atau jaringan |
| TIMEOUT | Deadline tahap atau test keseluruhan tercapai; HTTP 504 |
| EXNESS_SSRF | Host/IP ditolak oleh allowlist atau proteksi SSRF |
| EXNESS_INVALID_RESPONSE | Bentuk respons, account ID, waktu atau OHLC tidak valid |
| EXNESS_LIMITS_UNAVAILABLE | Batas candle yang diperlukan belum tersedia; gagal pada tahap limits |
| EXNESS_MARKET_DATA | Instrumen/candle tidak tersedia (4000/4004), bukan kesimpulan bahwa key salah |
| RATE_LIMITED | Quota lokal/provider tercapai; HTTP 429 dan Retry-After, tanpa retry otomatis |
| EXNESS_UPSTREAM | Provider menolak/gagal tanpa kategori di atas |
| EXNESS_CONFIGURATION | Persiapan/dekripsi/format konfigurasi tidak dapat dipakai; tidak ada diagnosis key API ditolak |
| ACCOUNT_SERVICE_UNAVAILABLE | Gangguan layanan database/accounting, bukan kegagalan autentikasi Exness |

Setiap tahap dibatasi 4,5 detik dan total test 20 detik, di bawah function 30 detik; DNS lookup juga memiliki deadline dan hasil DNS dipin ke TLS lookup. Transport dihentikan setelah respons atau abort. Timestamp/signature dibuat setelah quota guard selesai agar waktu request tetap segar. Tidak ada redirect, perluasan allowlist otomatis, peningkatan izin atau broker mutation. Kegagalan tahap candle mempertahankan hasil lulus discovery/account details/limits; lihat tahap dan kategori sebelum mengubah konfigurasi. Tidak ada test dengan kredensial Exness nyata selama pengembangan.

### Candle history dan simbol akun

Tahap candle kini terlebih dahulu menjalankan signed GET `/v1/configuration/accounts/{account_id}/instruments` (`getAvailableInstrumentList`), mengikuti [daftar instrumen resmi](https://www.exness-api.com/reference/trading/get-available-instrument-list). Respons harus berisi `instruments: string[]`, dengan nama sesuai schema OpenAPI (1–11 karakter ASCII alfanumerik/titik/underscore/hyphen). Daftar terverifikasi disimpan hanya pada reader backend akun tersebut selama 5 menit; probe manual selalu membaca daftar baru.

Pemetaan UI `XAUUSD` mengutamakan nama persis jika tersedia. Jika tidak, hanya satu varian berawalan `XAUUSD` dengan suffix lowercase/digit/titik/underscore/hyphen yang benar-benar ada dalam daftar akun yang dapat dipilih. Ini mencakup `XAUUSDm`, `XAUUSDc`, `XAUUSDz` atau varian terdaftar seperti `XAUUSD.pro`. Tidak ada request percobaan ke suffix yang ditebak. Jika beberapa varian tersedia tanpa nama persis, hentikan sebagai `AMBIGUOUS_INSTRUMENT`; jika tidak ada, `INSTRUMENT_NOT_FOUND`. Nama yang berbeda secara semantik seperti `GOLD` atau `XAUUSDT` tidak dianggap setara hanya dari nama, karena endpoint daftar tidak menyediakan metadata pasangan mata uang. Instrumen UI lain tetap memerlukan nama persis. Nama aktual/daftar akun tidak dimasukkan ke diagnostik frontend atau log.

Query menggunakan `price_type=bid`, timeframe terdokumentasi, ISO UTC `from` inklusif dan `to` eksklusif, tanpa `count` (count provider bersifat bidirectional). `to` dibekukan pada pembukaan candle berjalan; `from` dihitung dari maksimal 180 interval tertutup, dibatasi `max_candles_per_request`, `history_range_days` dan `history_age_days`. Validasi menerima gap sesi/weekend dan jumlah lebih sedikit, termasuk 123 candle dalam jendela 180 jam. Timestamp harus unik dan menaik dalam `[from,to)`, seluruh candle sudah tertutup, OHLC valid, serta jumlah tidak melebihi kapasitas jendela. Candle invalid ditolak, bukan disaring. Diagnostik OUT_OF_RANGE hanya menambahkan subkategori aman `BEFORE_FROM`, `AT_TO`, `AFTER_TO`, `UNFINISHED_CANDLE` atau `TOO_MANY_CANDLES` dan jumlah candle; tidak menyertakan timestamp atau harga.

`EXNESS_INVALID_RESPONSE` pada candle sekarang menyertakan `reason` aman dan `candleCount` (jumlah bar yang diterima bila array tersedia, bukan jumlah bar yang diterima sebagai valid):

| Reason | Kondisi |
| --- | --- |
| EMPTY_CANDLES | Array candle valid secara struktur tetapi kosong; count 0 |
| INVALID_SCHEMA | Wrapper/field/tipe tidak sesuai schema, termasuk numeric string dan JSON tidak dapat dibaca |
| INVALID_OHLC | Harga non-finite/non-positif atau relasi high/low/open/close tidak konsisten |
| INVALID_TIMESTAMP | Bukan ISO dengan offset, waktu tidak valid atau bukan Unix detik yang valid |
| OUT_OF_RANGE | Melebihi count/batas, di luar from, atau candle belum tertutup saat request |
| INVALID_ORDER | Timestamp duplikat atau tidak naik |

Masalah pemetaan memakai kategori `EXNESS_MARKET_DATA` dengan reason `INSTRUMENT_NOT_FOUND` atau `AMBIGUOUS_INSTRUMENT`, count 0. Schema daftar instrumen yang rusak memakai `INVALID_SCHEMA`. Test yang lulus menyertakan hanya jumlah candle; tidak mengembalikan harga, actual symbol, account ID, host, body provider atau signing material. Tiga tahap yang sudah lulus tetap tercatat lulus. Diagnostik tidak melonggarkan validasi dan tidak meminta peningkatan izin.

Pengecualian boundary provider: tepat satu candle terakhir dengan `time === to` boleh dikeluarkan hanya jika masih berjalan pada waktu permintaan dibentuk. Semua baris, termasuk boundary, harus lolos schema, OHLC, timestamp dan urutan terlebih dahulu. Test Connection melaporkan `excludedBoundaryCandles: 1` dan jumlah candle tertutup yang digunakan; UI menampilkan jumlah pengecualian. Candle setelah `to`, boundary duplikat, candle rusak, candle berjalan selain boundary, atau hasil tanpa candle tertutup tetap gagal. Batas jumlah diterapkan kembali pada data yang digunakan. Tidak ada timestamp, harga, atau rahasia dalam diagnostik.


## NEXUS V4 Strategy Lab (`/backtest`)

Open Terminal → Backtest, including from Android Chrome. DEMO is public and selected by default. For EXNESS, sign in through Accounts, test/select a read-only connection, then choose EXNESS in Strategy Lab. Do not paste Exness keys into Backtest, chat, screenshots or logs. A test run never writes paper-account storage, positions, balance, history or robot state. Existing paper bots remain browser-local and explicitly started; no server-side bot or broker order endpoint is added.

Configure EMA fast/slow (default 9/21), Wilder RSI (14), RSI long/short thresholds, percentage SL/TP and risk budget, initial USD capital, fixed spread/slippage and USD commission per lot per side. Supported USD-quoted instruments are XAUUSD (100 units/lot), EURUSD (100,000) and BTCUSD (1). Fractional sizing up to 10 lots is a simulation assumption, not verified broker contract/minimum-volume rules. Costs are visible assumptions, not fees verified against the account. EMA uses an SMA seed; Wilder RSI has an initial mean gain/loss. Signals require a closed crossover candle and RSI threshold; entries use the **next available candle open**, never the signal close. A session gap can delay that entry.

There is at most one position per segment. Stops/targets are tested against bid OHLC for longs and synthetic ask OHLC (bid + spread) for shorts. Both touched on one bar means **SL first**, even if the true tick sequence might have favored TP. Stops crossed by an opening gap fill at the worse open plus adverse slippage; TP receives no favorable gap fill. Risk sizing includes estimated round-trip friction; opening gaps can exceed the planned loss. Fees apply to both sides. The equity curve and maximum drawdown use candle-close equity with estimated exit costs; intrabar excursions, financing, margin, liquidation, latency, changing spread and real fills are not modeled.

The chronological in-sample percentage is configurable (50–90%). Each segment starts with independent capital, carries no position into the other segment and liquidates any remaining position at its own final close. OOS indicators may warm up from earlier closes only; thresholds are not automatically optimized. Reports include net P&L, win rate, profit factor (N/A without losses), close-equity maximum drawdown and trade count. There are explicit warnings for small history, fewer than 20 OOS trades and session/history gaps. Results are labeled DEMO or EXNESS + opaque connection UUID, remain in page memory only, and are discarded on reload. Do not infer profitability from a small sample or repeated OOS tuning.

History endpoints:

- `GET /api/backtest/history?symbol=XAUUSD&interval=3600[&before=<exclusive-end-seconds>]`: public closed DEMO candles.
- `GET /api/account/backtest/history?...`: existing authenticated selected connection only; rechecks ownership, verified status and selection after provider I/O. It returns only validated history, an opaque paper-source identity and pagination metadata, never broker account IDs, Gateway/AP URLs, keys or signed headers.

The backend plans aligned `from` inclusive / `to` exclusive pages of at most 180 intervals, also constrained by provider maximum count, range and any explicitly declared age. `history_range_days` bounds each page duration; `history_age_days` bounds the oldest requested open time. Missing age means **unknown availability**, with no 365-day fallback or guarantee. It signs only read-only GET requests. Pages progress backward without overlap. Client runs cap at 12 sequential pages / 2,160 intervals and 60 seconds; each request has a 10-second client deadline and an 8-second adapter deadline, below the Vercel function limit. Provider responses are limited to 2 MiB. Warm-instance cache holds at most 24 validated pages per owner/connection reader for two minutes, never in browser storage or shared across connection identities. Existing centralized PostgreSQL quota rules still apply on provider calls; HTTP API responses are `no-store`. Quota errors stop the run, with manual retry rather than an automatic retry loop. Cache is opportunistic, not durable or a guarantee across Vercel instances.

Gaps and fewer returned candles are not filled or fabricated. For backtest pagination only, a schema-valid empty candle array is explicitly returned as `emptyWindow:true`, counted and warned as a historical/session gap. Empty windows advance the bounded cursor; a run with fewer than two valid candles fails. Test Connection retains its strict EMPTY_CANDLES failure behavior. Invalid OHLC, ordering, future candles, source changes mid-run and invalid page boundaries fail the run. The explicitly reported single unfinished boundary-candle exception is retained for the current page; historical closed boundaries require the identical-candle proof described below. Declared age exhaustion or an older signed NO_QUOTES (4004) response stops pagination with HISTORY_LIMIT_REACHED. A 12-page budget exhaustion is separately labeled PAGE_BUDGET_REACHED; a deadline is a hard TIMEOUT failure. A truncated sample is never backtested automatically: the user must explicitly select “Gunakan sampel tersedia (terpotong)”. Its report and session summary retain the truncation warning, and IS/OOS are recalculated only on that smaller sample.

Validation: `npm test`, `npm run build`, `npm run test:paper:browser`, `npm run test:backtest:browser`. Browser checks use actual public DEMO requests and mocked private EXNESS responses at desktop and Android widths 360/390/412px, preserve seeded legacy/paper storage byte-for-byte during backtesting, and require no real broker credentials.


### Diagnosing long EXNESS backtest runs

The official [candle contract](https://www.exness-api.com/reference/trading/get-candle-history) and [OpenAPI](https://www.exness-api.com/openapi/trading.public.yaml) distinguish request range, count/limit and actual data availability. H1+ history has no universal 365-day availability guarantee. Pages use contiguous `before = previous from`, signed ISO `from` inclusive / `to` exclusive and no `count`. The last page is capped by the remaining requested intervals, provider count and per-request range. Provider age is checked separately on every request; requests beyond a declared age stop locally instead of sending an invalid range.

Safe failures include the actual HTTP status, 1-based page index, successfully loaded calendar intervals, validated candle count, and optional allowlisted provider code/upstream HTTP status, OHLC/schema reason or range subcategory. No timestamp, price, broker Account ID, host, raw response, signed header or credential is included in these diagnostics. Backend progress fields (`pageIndex`, `loadedIntervals`, `validCandles`) are bounded client-reported context, not an authentication or quota mechanism; the loader computes its own validated progress rather than trusting echoed counters. HTTP 0 in the diagnostic object means no response was received and is shown as “tanpa respons”.

| Category | Interpretation / action |
| --- | --- |
| `EXNESS_HISTORY_WINDOW` | Local future/unaligned/invalid cursor; fails the run. |
| `EXNESS_INVALID_TIME_RANGE` (3004) | Provider rejects the time range; not automatically called exhausted history. |
| `EXNESS_INVALID_COUNT` (3005), `EXNESS_INVALID_LIMIT` (3006) | Provider rejects count/limit shape; hard failure, no partial backtest. |
| `EXNESS_INVALID_CURSOR` (3007) | Provider rejects the cursor; hard failure. |
| `EXNESS_DATA_UNAVAILABLE` (4004) | No quotes. First-page failure has no usable sample; after valid older-page probing, allows a clearly truncated sample under `HISTORY_LIMIT_REACHED`, cause `PROVIDER_DATA_UNAVAILABLE`. This does not claim a known maximum history age. |
| `HISTORY_LIMIT_REACHED` | Declared provider age / cursor floor, or an older 4004 from the same still-selected connection. Shows validated sample count and requires explicit acceptance before backtesting. |
| `EXNESS_INVALID_RESPONSE` | Invalid schema/OHLC/time/range/order. Includes safe boundary subcategory; a closed `time === to` bar or a bar after `to` remains invalid. Only the existing single unfinished current-boundary exception is retained. |
| `RATE_LIMITED` | Quota/provider 429; no automatic retry and no partial result offered. PostgreSQL quota and scoped caches remain in place. |
| `TIMEOUT`, `EXNESS_NETWORK` | Deadline or network failure, with progress at the failed page; no partial backtest. |
| `EXNESS_INTERNAL_FAILURE`, `HISTORY_INTERNAL_FAILURE` | Provider internal code 3 versus internal/unrecognized application failure, without arbitrary error text. |

Android: choose EXNESS → 1440 or 2160 intervals → Run. If it fails, read the category, HTTP status and page/counts shown. For HISTORY_LIMIT_REACHED, review the count and choose the explicit truncated-sample button only if that reduced history is acceptable. OOS covers fewer bars and can have too few trades; the result is not comparable to the originally requested window. Do not send keys, account IDs, raw candles or screenshots containing credentials when reporting the safe diagnostic.

Regression mocks cover full 720/1440/2160 intervals, final-page remainder caps, missing age, declared age exhaustion, older 4004, 3004/3005/3006/3007, empty historical windows, strict old-boundary rejection, selection revocation during errors, internal-text redaction and quota stop without retry. Android checks exercise the long requests, failure page/count display and explicit truncated-sample acceptance without changing paper storage.


Historical boundary compatibility: pagination remains signed `from` inclusive / `to` exclusive. If a historical response contains exactly one final candle at `time === to`, all rows first pass schema, OHLC, volume, timestamp and order validation. The boundary is excluded only when identical to the newer candle (time, OHLC, volume including presence). Proof comes from the same connection/symbol/timeframe validated page cache; a cold instance performs a quota-controlled signed read-only `from + count=1` lookup of the newer candle, with strict single-candle range validation and no `to` on that proof request. Missing/mismatched proof fails. The combined result never includes the duplicate. `HISTORICAL_BOUNDARY_DUPLICATE` and `historicalBoundaryExcluded` explicitly report exclusions without prices, timestamps or credentials. The single current unfinished-boundary exception remains separate. EMA/RSI is unchanged.


## V5 private broker ticks

Three explicit terminal feeds: `/` DEMO synthetic/public, `/?feed=exness` private EXNESS HISTORY, `/?feed=live` private EXNESS LIVE. LIVE is labeled verified only after a fresh broker tick; successful socket connection or historical bootstrap alone is not proof of live data. This release's automated broker tests use synthetic mocks, not real Exness credentials.

`/api/live` exports an HTTP server with WebSocket upgrades on Vercel Functions (Fluid Compute required). Routing keeps the bridge separate from the Express HTTP API. Duration is 30 seconds; the bridge closes at 25 seconds and releases its lease. No idle background service or server-side trading robot exists. Browser reconnects at 5/10/20 seconds, at most three times for explicit duration/normal disconnect, each receiving fresh historical bootstrap. Handshake rejection, permission, quota or unknown errors require a manual retry, never a 429 retry loop. Hiding/navigating away closes the socket; visibility resume requires a new authenticated handshake. Session and selected ownership are rechecked every two seconds; logout/deletion stops the stream on revalidation. There can be a two-second revocation propagation window.

Gateway/AP discovery, verified instrument mapping, encrypted server credentials and read-only account/limits checks use the existing reader. The upstream GET handshake signs the exact `/v1/server-events/accounts/{account_id}/ws/ticks` path with Ed25519; only a ticks subscription is sent. No trading scopes are changed. `trading_disabled` or missing/invalid WebSocket limits fail closed. Validated DNS addresses are pinned in TLS lookup; HTTPS/WSS allowlists and certificate verification remain enabled, redirects disabled. Origin must equal APP_ORIGIN and Better Auth cookies are mandatory. API keys, signing keys, EXN headers, broker Account IDs and internal hosts never leave the backend.

PostgreSQL `nexus_stream_lease` enforces a conservative **one upstream socket per broker account** across instances (HMAC identifier, unique row, conditional atomic acquisition, 30-second TTL). Provider/global/endpoint connection and subscription bucket rules are charged centrally; conservative fixed-window budgets use min(limit, burst). User attempts cap at 12/minute. The lease is token-scoped on release and recovers by TTL after crashes. Provider streams elsewhere may consume additional quota: provider 429 is terminal. Run the normal idempotent migration; no new credentials/env variables are needed. The connection table has no public privileges.

Ticks require matching mapped symbol and connection context, finite positive Bid/Ask, Ask ≥ Bid, ISO timestamp, ≤10-second age, ≤2-second future skew and strictly increasing time. Foreign or invalid frames cannot update marks. Broker account IDs, if present, must match the signed stream. Frames cap at 16 KiB and downstream buffering at 64 KiB; client commands are forbidden. The browser independently checks identity/order/freshness and removes quotes on stale/disconnected/error. REST M5 polling is completely disabled in LIVE mode. Ask/spread is displayed separately; paper fills remain simulation assumptions, not broker fills.

Charts mount once and use `series.update()` for ticks, `setData()` for bootstrap/backfill. Bid ticks aggregate UTC M5/M15/H1/H4/D1; missing periods/weekends are not fabricated. Active OHLC is **observed/throttled tick OHLC**, partial after initial connection/reconnect, not authoritative broker candle extremes. Reconnect replaces observed history with closed broker candles; the robot uses closed candles only in LIVE mode. Tick time freshness is enforced again by the paper engine at action time.

Paper source `EXNESS_LIVE:<opaque connection UUID>` is separate from legacy DEMO and EXNESS HISTORY accounts. Existing storage key/version and every prior account remain readable without conversion or deletion. LIVE quotes mark only the selected live symbol; other-symbol positions wait without marks, blocking new automated risk-taking until a matching quote exists. Emergency settlement, SL/TP, P&L and robot actions reject expired or foreign quotes. Broker orders remain HTTP 403.

Verification: `npm test`, `npm run build`, `npm run test:live:browser`, existing paper/strategy browser suites. Live browser tests use mocked sockets at 360/390/412px, retain the same chart canvas and verify no REST polling and quota stop. An unauthenticated production handshake tests the bridge's rejection only. A real broker verification requires the account owner to select a read-only connection, open LIVE and observe fresh ticks; never send credentials or signed frames through chat/logs. A Vercel READY deployment by itself does not prove successful upstream streaming.


### V5 LIVE preflight and CSP diagnostics

Account details follow the official `AccountDetailsResponse`: `account_id`, ISO `create_date` and nested `settings` (currency, leverage, account_status, execution_mode, **settings.trade_mode**). LIVE accepts `enabled` and explicitly rejects `trading_disabled`; no scope, credential or trading permission is changed. Missing/invalid settings fail bootstrap rather than falling back to a guessed top-level field.

Before every socket attempt the browser sends `POST /api/live/preflight?symbol=XAUUSD&interval=3600`, with same-origin cookies. Origin and Better Auth session are mandatory. The read-only preflight checks selection/ownership, active lease, account settings, provider WS limits, historical bootstrap and DNS/SSRF; it rechecks session and selection after I/O. It never reserves a connection or opens an upstream socket. It charges a separate per-user preflight rate budget and existing provider REST quotas. Actual upgrade repeats authorization, lease acquisition and provider quota checks; readiness is not a reservation or a guarantee of HTTP 101. If an upgrade fails without a safe frame, one additional HTTP preflight diagnoses changed session/quota; it does not retry the socket. A still-ready preflight produces `WEBSOCKET_UPGRADE_FAILED`, not an invented provider diagnosis.

Safe preflight categories: `SESSION_INVALID`, `ORIGIN_REJECTED`, `ACCOUNT_NOT_SELECTED`, `ACCOUNT_TRADE_MODE_DISABLED`, `LIMITS_INVALID`, `CONNECTION_QUOTA`, `RATE_LIMITED`, `BOOTSTRAP_FAILED`, `WEBSOCKET_UPGRADE_FAILED`. Responses contain readiness/category/HTTP status and `brokerLiveVerified:false`, never account details, hostnames, credentials, signed headers or raw provider messages. Preflight success cannot label the feed LIVE; only validated fresh broker ticks do so. Errors and hidden/disconnected state continue clearing quotes and stopping automatic actions.

Production CSP explicitly permits `wss://bot-trading-terminal.vercel.app` alongside `'self'`, with no wildcard or broad `wss:` grant. Other deployment aliases are not added to this trusted WSS list; use the canonical production origin matching APP_ORIGIN. `/api/live` and `/api/live/preflight` route to `api/live.ts` before the Express API catch-all, with maxDuration 30 seconds. Fluid Compute was verified enabled from project resource metadata; no environment secrets were retrieved or changed.

`npm run test:live:csp` uses real Chromium WebSocket HTTP 101 against a local mock server under an explicit CSP and checks foreign-host blocking at widths 360/390/412px. This is a real transport handshake with a **mock server**, not an authenticated production or Exness tick verification. `npm run test:live:browser` checks live rendering and rejected preflight without opening a socket. Official-shape Exness adapter tests and preflight category integration tests need no real credentials. Authenticated broker ticks remain a separate owner-side verification; never report mock 101 as real Exness streaming.
