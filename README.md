# NEXUS Trading Terminal V2

Terminal market bergaya TradingView, dibangun dengan React, TypeScript, Vite, Lightweight Charts dan Express. **Semua eksekusi adalah simulasi. Tidak ada integrasi order broker atau live trading.**

## Jalankan

Node.js 22+:

```sh
npm ci
npm run dev
```

Buka `http://localhost:5173`. Vite mem-proxy `/api` ke backend localhost:3001. `npm test` menjalankan pengujian backend; `npm run build` memeriksa TypeScript dan menghasilkan frontend di `dist/`. Untuk menjalankan API sendiri gunakan `npm run start:api`. Untuk deployment, layani `dist/` melalui reverse proxy dan arahkan `/api` ke backend; jangan mengekspos backend langsung ke internet tanpa autentikasi/rate limiting.

## Vercel (frontend + backend dalam satu project)

Import `Nipzy12/bot-trading-terminal` pada Vercel dan pilih branch `feat/trading-terminal` untuk deployment yang ingin diuji. Root Directory: root repository, Framework Preset: Vite, Node.js: 22.x. Konfigurasi tracked `vercel.json` menetapkan Build Command `npm run build`, Output Directory `dist`, dan satu Node.js Function `api/index.ts` dengan batas 15 detik.

Frontend statis dilayani dari `dist/`. Semua `/api/*` diteruskan ke handler Express yang sama tanpa `app.listen()`, sebelum fallback SPA. File `server/index.ts` hanya untuk development lokal. Tidak perlu server Express terpisah, konfigurasi CORS, atau URL backend di frontend. Route API yang tidak dikenal mengembalikan JSON 404, bukan HTML frontend. Respons API memakai `Cache-Control: no-store`.

**Demo tidak memerlukan environment variable apa pun.** Jika salah satu dari empat `EXN_*` wajib belum diisi, API memakai DEMO tanpa request Exness. Jika konfigurasi lengkap tetapi salah/ditolak, API mengembalikan error terstruktur, tidak menyamarkannya sebagai data demo. Ikuti konfigurasi Android di bawah. Private key hanya berada di Environment Variables backend, tanpa prefix `VITE_`. Batas total satu alur Exness 6,5 detik, di bawah batas function 15 detik.

Setelah deployment, periksa:

- `/` menampilkan terminal dan chart demo.
- `GET /api/health` → 200, `{"status":"ok","execution":"simulation","liveTrading":false}`.
- `GET /api/market?symbol=XAUUSD&interval=3600` → 200 dengan `source: "simulation"` dan 180 candle tanpa konfigurasi Exness.
- `POST /api/orders` → 403, `Live trading is disabled`.
- `/api/unknown` → JSON 404.

Robot tetap berjalan di browser selama tab terbuka; tidak dijalankan sebagai proses background serverless. Tidak ada penyimpanan state akun pada function atau filesystem Vercel. Jangan mengubah Production Branch atau melakukan merge untuk menguji branch ini; gunakan deployment branch/Preview sesuai konfigurasi project Vercel.

## Fitur

- Chart candlestick interaktif (zoom, pan, crosshair), enam instrumen dan lima timeframe.
- Watchlist searchable dengan snapshot demo yang dilabeli, dashboard saldo virtual.
- Order Buy/Sell paper trading dengan validasi volume 0.01–10 lot; tutup posisi dan riwayat lokal.
- Robot SMA20 opsional, default berhenti, interval 10 detik, 0.01 lot, maksimal tiga posisi termasuk order manual. Robot berhenti saat halaman ditutup. Ini demonstrasi sinyal dari candle terakhir, bukan backtest atau strategi produksi.
- Akun paper trading tersimpan di localStorage dengan schema versi 1: posisi, SL/TP, riwayat, batas harian dan kunci emergency. Robot selalu berhenti saat reload; status aktif tidak disimpan. Data rusak/tidak kompatibel kembali ke akun demo baru, dan kegagalan tulis storage menampilkan peringatan.
- Floating P&L, realized P&L, saldo awal $10.000 dan equity. Ukuran kontrak simulasi: XAUUSD 100 oz/lot, EURUSD/GBPUSD/USDJPY 100.000 unit/lot, BTCUSD/ETHUSD 1 unit/lot. P&L USDJPY dikonversi ke USD pada harga exit/mark. Ini asumsi demo, bukan spesifikasi kontrak akun Exness. Tidak menghitung spread, swap, komisi atau margin.
- Pengujian kontrak backend dan CI GitHub Actions.

## Exness Trader API resmi: read-only

Adapter mengikuti [OpenAPI Trader API v1.0.2](https://www.exness-api.com/openapi/trading.public.yaml), [host discovery](https://www.exness-api.com/trading/get-started/access-point-host-discovery), [request signing](https://www.exness-api.com/authentication/request-signing), [candle history](https://www.exness-api.com/reference/trading/get-candle-history), dan [limits](https://www.exness-api.com/trading/guides/api-configuration-and-limits). Kontrak diperiksa 2 November 2026. Implementasi divalidasi dengan mock; belum terverifikasi terhadap akun Exness nyata tanpa kredensial yang sah.

Alur backend:

1. Ambil Gateway **yang benar dari DNS widget Key Management**, bukan host contoh atau URL Access Point yang ditebak.
2. Signed GET `/v1/trading/access-point?account_id=…`, validasi URL HTTPS origin tanpa userinfo/path/query/port serta account ID yang dikembalikan. ID dipertahankan sebagai string uint64 agar tidak kehilangan presisi.
3. Gunakan `access_point` untuk signed GET `/v1/configuration/accounts/{account_id}/limits`. Cache AP pada warm instance, refresh konfigurasi limits setiap 5 menit dan setelah rate limit; HTTP 404 menginvalidasi AP untuk discovery pada permintaan berikutnya.
4. Signed GET `/v1/market-data/accounts/{account_id}/candles?instrument=…&price_type=bid&timeframe=…&from=…&count=…`. `from` berupa ISO UTC dan inklusif. Ambil sampai 180 candle tertutup, dibatasi `max_candles_per_request` dan constraint rentang/umur yang dikembalikan limits. Jika batas candle tidak tersedia, hentikan dengan error; tidak menganggap quota tidak terbatas. Tidak memakai `to` bersamaan dengan `count`.
5. Validasi bentuk payload, angka OHLC positif/finite dan konsisten, timestamp ISO dengan offset, urutan waktu unik menaik, rentang request dan jumlah hasil. Normalisasi timestamp ke Unix detik untuk chart. Respons kosong/rusak ditolak.

| UI / interval detik | Exness timeframe |
| --- | --- |
| 5m / 300 | M5 |
| 15m / 900 | M15 |
| 1h / 3600 | H1 |
| 4h / 14400 | H4 |
| 1D / 86400 | D1 |

Tanda tangan memakai Ed25519 melalui `node:crypto`: JSON UTF-8 ditandatangani sebagai bytes yang sama persis dengan payload `EXN-DATA`; `EXN-DATA` dan `EXN-SIGN` base64url tanpa padding. Header `EXN-API-KEY`, `EXN-IDEMPOTENCY-KEY` (wajib, string kosong untuk GET), `EXN-TIMESTAMP` (milidetik), `EXN-SIGN-VERSION: 1` dikirim pada setiap request dengan timestamp/signature baru. `path` meliputi query tepat sebagaimana dikirim; hash body adalah SHA-256 bytes kosong. Tidak mengikuti redirect agar header autentikasi tidak diteruskan ke tujuan lain.

### Label dan paper trading

`/api/market` mengembalikan `source: simulation`, `label: DEMO`, `kind: synthetic`, `live: false` tanpa konfigurasi lengkap. Respons Exness yang lolos validasi memakai `source: exness`, `label: EXNESS`, `kind: candle-history`, `live: false`. Label EXNESS menunjukkan **asal candle history**, bukan koneksi ticks live atau akun broker live. UI menampilkan `UNVERIFIED` saat chart belum tersedia/gagal. Tidak ada WebSocket/ticks live dan tidak ada eksekusi broker.

Chart dimuat saat instrumen/timeframe berubah. Mark paper untuk instrumen terpilih dan posisi terbuka dipolling setiap 5 detik dari candle M5 terakhir yang tertutup; mark Exness ini **bukan harga eksekusi live**. Pada DEMO saja, mark diberi variasi sinus kecil untuk memperlihatkan floating P&L. Watchlist/ticker tetap snapshot **DEMO**, termasuk ketika chart memakai Exness. Paper trading, localStorage, batas risiko, SL/TP simulasi dan emergency tetap berlaku.

### Rate limit dan error

- Gunakan rate window global dan per-operation dari limits untuk accounting warm instance. Cache candle 5 detik dan gabungkan request identik yang sedang berjalan. Jangan hardcode batas quota provider.
- HTTP 429 atau public error `REQUEST_RATE_LIMIT` (3015) tidak di-retry otomatis. Teruskan HTTP 429, header `Retry-After`, JSON `{error:"EXNESS_RATE_LIMIT",retryAfter:…}`. Baca header detik/tanggal atau body `retry_after`; bila provider tidak memberi petunjuk, cooldown defensif 60 detik (ini bukan nilai quota Exness). Frontend menghentikan polling, menghapus mark, menghentikan robot dan meminta **Coba lagi** manual setelah masa tunggu.
- Error autentikasi → 502 `EXNESS_AUTH`; konfigurasi key/host tidak valid → 502 `EXNESS_CONFIGURATION`; data tidak valid → 502 `EXNESS_INVALID_RESPONSE`; jaringan/timeout → 502 `EXNESS_NETWORK`; kegagalan provider lain → 502 `EXNESS_UPSTREAM`. Tidak meneruskan diagnostic text upstream, account ID, private key atau signed headers ke browser/log.
- Cache/accounting ada **per warm instance**, bukan quota global lintas instance/region Vercel. Provider tetap otoritatif; 429 tetap ditangani. Untuk banyak pengguna, tambahkan koordinasi quota terpusat dan kontrol akses sebelum membuka penggunaan luas. Backend ini bukan proxy umum: akun/host hanya dari environment, instrumen dan timeframe dibatasi allowlist.

### Konfigurasi hanya melalui Android

1. Di Chrome Android (aktifkan **Situs desktop** bila diperlukan), buka Personal Area/portal Exness → **Key Management**. Pastikan produk Trader API tersedia bagi akun Anda. Pilih akun dan izin **Trading read access saja**, tanpa izin mutasi/order. Bila fitur tidak tersedia, konfirmasi akses melalui Exness; jangan mengambil key dari layanan tidak resmi.
2. Buat key melalui flow resmi Exness, catat identifier API key, private signing key, account ID, dan Gateway dari DNS widget. Untuk flow Exness-generated, private key berupa **128 karakter hex (64 bytes: seed + public key)**. Adapter juga mendukung private key Ed25519 PKCS#8 PEM milik Anda, termasuk newline literal `\n`; public half hex dicek terhadap seed. Tidak perlu membuat key baru jika sudah punya key read-only yang valid.
3. Buka Vercel Dashboard → project **bot-trading-terminal** → **Settings → Environment Variables**. Tambahkan nilai berikut langsung di dashboard, **jangan kirim lewat chat, screenshot, GitHub atau localStorage**:

| Variable backend | Isi |
| --- | --- |
| `EXN_API_KEY` | Identifier API key dari Key Management |
| `EXN_PRIVATE_KEY` | Private signing key hex 128 karakter atau PKCS#8 PEM |
| `EXN_ACCOUNT_ID` | ID akun desimal, bukan nomor JavaScript |
| `EXN_DISCOVERY_BASE_URL` | HTTPS Gateway origin dari DNS widget |

4. Pilih environment yang sesuai deployment (**Production** untuk domain produksi, **Preview** untuk preview), simpan sebagai **Secret** jika tersedia. Jangan memakai nama `VITE_*`. Tidak perlu mengisi Access Point secara manual atau `EXN_API_BASE_URL`; adapter selalu melakukan discovery. Jangan menaruh credential di `vercel.json`.
5. Redeploy branch `feat/trading-terminal` dari tab Deployments. Buka `/api/health` (hanya kesehatan aplikasi dan execution simulasi), lalu `/api/market?symbol=XAUUSD&interval=3600`. Hanya setelah respons 200 dengan `label: EXNESS` dan candle valid, asal data Exness terverifikasi untuk request tersebut; ini tetap candle history, bukan ticks live. 401/403 upstream: cek expiry, read scope, akun dan pembatasan IP melalui portal. Jangan mengubah key menjadi memiliki izin order untuk mengatasi error data.
6. Jika belum siap, biarkan empat nilai belum dikonfigurasi untuk DEMO. Konfigurasi parsial juga DEMO; konfigurasi lengkap tetapi invalid menghasilkan error. Variabel bridge lama `EXNESS_DATA_URL`/`EXNESS_API_KEY` **tidak lagi dipakai**; hapus manual dari dashboard jika masih ada, tanpa mengubahnya menjadi `VITE_*`.

`.env.example` hanya berisi nama variabel kosong. Semua `.env*` aktual diabaikan Git. Tidak ada kode signing, credential, atau import `server/` dalam frontend. Pengujian memakai pasangan key sementara yang dibuat di memori, bukan key produksi. `npm test` mencakup adapter mock dan kontrol paper trading; `npm run build` memeriksa TypeScript dan membuat frontend produksi.

API lokal tetap `GET /api/health`, `GET /api/market?symbol=XAUUSD&interval=3600`. Semua metode `/api/orders` ditolak 403 dan rute API lain JSON 404. Robot selalu berhenti saat halaman dibuka.

## Batasan

Untuk edukasi dan pengembangan. Data simulasi dan sinyal robot tidak boleh dianggap sebagai rekomendasi investasi. Persistensi hanya pada browser/perangkat yang sama; tidak ada sinkronisasi antarperangkat, autentikasi multiuser, ataupun koneksi broker yang teruji. Library chart: TradingView Lightweight Charts (Apache-2.0), atribusi: https://www.tradingview.com/ — antarmuka ini bukan produk atau afiliasi TradingView.

## Verifikasi browser

Dengan `npm run dev` aktif, jalankan `npm run test:browser`. Script menggunakan Chromium di `/usr/bin/chromium` (override dengan `CHROMIUM_PATH`), memeriksa chart, SL/TP, persistensi posisi/riwayat setelah reload, robot manual, emergency stop, batas rugi dan layout desktop serta Android 360/390/412px. Screenshot QA ditulis di `/workspace/terminal-desktop.png` dan `/workspace/terminal-mobile.png`, di luar repository.

## Persiapan Git

Branch implementasi: `feat/trading-terminal`. Setelah meninjau perubahan staged:

```sh
git commit -m "feat: add simulation-first trading terminal"
git push -u origin feat/trading-terminal
```

## Kontrol risiko paper trading

- Stop Loss / Take Profit opsional diisi sebagai **harga**, bukan nominal USD. Buy: SL < harga masuk < TP; Sell: TP < harga masuk < SL. Posisi ditutup pada mark pertama yang melewati batas, bukan dijamin tepat di harga SL/TP. Pemantauan hanya berjalan ketika halaman terbuka dan feed tersedia.
- Riwayat mencatat waktu masuk/keluar, harga exit, alasan penutupan, volume dan P&L. Maksimal 100 posisi manual dan 5.000 transaksi riwayat. Tidak ada endpoint order broker.
- Batas rugi robot default $100 per hari UTC: jumlah kerugian realized hari ini ditambah floating loss, tanpa mengurangi kerugian dengan profit. Setelah tersentuh, robot terkunci sampai hari UTC berikutnya meskipun harga pulih atau batas diperbesar. Robot harus dinyalakan lagi secara manual. Batas harian menghentikan pembukaan oleh robot; posisi yang ada tetap mengikuti SL/TP, dan order manual tetap tersedia kecuali emergency aktif.
- Emergency stop menghentikan robot, menutup semua posisi dengan kuotasi tersedia, dan menyimpan kunci emergency. Posisi tanpa kuotasi menunggu feed pulih. Buka kunci secara manual setelah semua posisi ditutup; tindakan ini tidak menyalakan robot.
- Kuotasi yang gagal diperbarui dihapus dan robot dihentikan; posisi menunggu feed untuk valuasi/penutupan. Tidak ada eksekusi saat tab ditutup. Gunakan satu tab untuk paper trading: localStorage bukan database transaksi multi-tab. Penghapusan storage browser mereset akun dan batas risiko.
