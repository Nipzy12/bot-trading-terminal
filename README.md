# NEXUS Trading Terminal

Terminal market bergaya TradingView, dibangun dengan React, TypeScript, Vite, Lightweight Charts dan Express. **Semua eksekusi adalah simulasi. Tidak ada integrasi order broker atau live trading.**

## Jalankan

Node.js 22+:

```sh
npm ci
npm run dev
```

Buka `http://localhost:5173`. Vite mem-proxy `/api` ke backend localhost:3001. `npm test` menjalankan pengujian backend; `npm run build` memeriksa TypeScript dan menghasilkan frontend di `dist/`. Untuk menjalankan API sendiri gunakan `npm run start:api`. Untuk deployment, layani `dist/` melalui reverse proxy dan arahkan `/api` ke backend; jangan mengekspos backend langsung ke internet tanpa autentikasi/rate limiting.

## Fitur

- Chart candlestick interaktif (zoom, pan, crosshair), enam instrumen dan lima timeframe.
- Watchlist searchable dengan snapshot demo yang dilabeli, dashboard saldo virtual.
- Order Buy/Sell paper trading dengan validasi volume 0.01–10 lot; tutup posisi dan riwayat lokal.
- Robot SMA20 opsional, default berhenti, interval 10 detik, 0.01 lot, maksimal tiga posisi termasuk order manual. Robot berhenti saat halaman ditutup. Ini demonstrasi sinyal dari candle terakhir, bukan backtest atau strategi produksi.
- Posisi dan riwayat hanya disimpan di memori tab. Refresh mereset akun. Saldo virtual tetap $10.000; belum ada kalkulasi margin, fee, P&L, atau settlement.
- Pengujian kontrak backend dan CI GitHub Actions.

## Data Exness melalui backend

Secara default data candle sintetis; snapshot watchlist juga demo. Aplikasi **tidak mengklaim memakai endpoint REST Exness publik yang belum diverifikasi**. Integrasi memerlukan bridge data resmi/terotorisasi untuk akun Exness Anda (misalnya bridge MT5 yang Anda operasikan). Tanpa akses endpoint dan kredensial, koneksi Exness nyata belum dapat diverifikasi.

Konfigurasikan `EXNESS_DATA_URL` dan opsional `EXNESS_API_KEY` hanya di lingkungan backend/secret manager. URL harus HTTPS. Untuk pengembangan lokal, salin `.env.example` ke `.env` lalu gunakan `node --env-file=.env --import tsx server/index.ts` pada terminal terpisah dan `npx vite` pada terminal lain. `npm run dev` menggunakan variabel lingkungan yang sudah diekspor, tidak otomatis membaca `.env` ke Express. Jangan memakai prefix `VITE_` untuk rahasia.

Backend mengirim `GET <EXNESS_DATA_URL>?symbol=XAUUSD&interval=3600` dengan `Authorization: Bearer <EXNESS_API_KEY>` bila diatur. Bridge harus mengembalikan:

```json
{"candles":[{"time":1730000000,"open":2740,"high":2744,"low":2738,"close":2742},{"time":1730003600,"open":2742,"high":2746,"low":2741,"close":2745}]}
```

Timestamp Unix dalam detik, urut naik, minimal dua candle, maksimal 5000. OHLC harus positif dan konsisten. Backend memvalidasi payload, menolak redirect, menerapkan timeout 8 detik, dan mengembalikan error generik tanpa rahasia. Tidak ada fallback diam-diam ke demo ketika upstream gagal. Chart diambil kembali saat instrumen/timeframe berubah; streaming/polling belum diimplementasikan. Watchlist tetap snapshot demo walaupun bridge aktif.

API: `GET /api/health`, `GET /api/market?symbol=XAUUSD&interval=3600`. Semua metode `/api/orders` ditolak (403). API key tidak pernah dikirim ke frontend. `.env*`, log, build dan dependensi diabaikan Git.

## Batasan

Untuk edukasi dan pengembangan. Data simulasi dan sinyal robot tidak boleh dianggap sebagai rekomendasi investasi. Belum ada persistensi, autentikasi multiuser, ataupun koneksi broker yang teruji. Library chart: TradingView Lightweight Charts (Apache-2.0), atribusi: https://www.tradingview.com/ — antarmuka ini bukan produk atau afiliasi TradingView.

## Verifikasi browser

Dengan `npm run dev` aktif, jalankan `npm run test:browser`. Script menggunakan Chromium di `/usr/bin/chromium` (override dengan `CHROMIUM_PATH`), memeriksa chart, order, penutupan/riwayat, robot, timeframe, pemilihan market dan overflow mobile 390px. Screenshot QA ditulis di `/workspace/terminal-desktop.png` dan `/workspace/terminal-mobile.png`, di luar repository.

## Persiapan Git

Branch implementasi: `feat/trading-terminal`. Setelah meninjau perubahan staged:

```sh
git commit -m "feat: add simulation-first trading terminal"
git push -u origin feat/trading-terminal
```
