# NEXUS Trading Terminal

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

**Demo tidak memerlukan environment variable apa pun.** Biarkan `EXNESS_DATA_URL` dan `EXNESS_API_KEY` tidak diatur untuk memakai candle simulasi. Jika bridge data terotorisasi sudah tersedia, tambahkan kedua variabel melalui Vercel Project Settings → Environment Variables pada environment yang sesuai (Preview/Production), lalu redeploy. Jangan gunakan prefix `VITE_`, menaruh rahasia di `vercel.json`, atau mengunggah `.env`. API key hanya dibaca oleh function backend. Timeout bridge 8 detik berada di bawah batas function 15 detik. Jika bridge yang dikonfigurasi gagal, API mengembalikan 502; tidak menyamarkannya sebagai demo.

Setelah deployment, periksa:

- `/` menampilkan terminal dan chart demo.
- `GET /api/health` → 200, `{"status":"ok","execution":"simulation","liveTrading":false}`.
- `GET /api/market?symbol=XAUUSD&interval=3600` → 200 dengan `source: "simulation"` dan 180 candle tanpa konfigurasi bridge.
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

## Data Exness melalui backend

Secara default data candle sintetis; snapshot watchlist juga demo. Aplikasi **tidak mengklaim memakai endpoint REST Exness publik yang belum diverifikasi**. Integrasi memerlukan bridge data resmi/terotorisasi untuk akun Exness Anda (misalnya bridge MT5 yang Anda operasikan). Tanpa akses endpoint dan kredensial, koneksi Exness nyata belum dapat diverifikasi.

Konfigurasikan `EXNESS_DATA_URL` dan opsional `EXNESS_API_KEY` hanya di lingkungan backend/secret manager. URL harus HTTPS. Untuk pengembangan lokal, salin `.env.example` ke `.env` lalu gunakan `node --env-file=.env --import tsx server/index.ts` pada terminal terpisah dan `npx vite` pada terminal lain. `npm run dev` menggunakan variabel lingkungan yang sudah diekspor, tidak otomatis membaca `.env` ke Express. Jangan memakai prefix `VITE_` untuk rahasia.

Backend mengirim `GET <EXNESS_DATA_URL>?symbol=XAUUSD&interval=3600` dengan `Authorization: Bearer <EXNESS_API_KEY>` bila diatur. Bridge harus mengembalikan:

```json
{"candles":[{"time":1730000000,"open":2740,"high":2744,"low":2738,"close":2742},{"time":1730003600,"open":2742,"high":2746,"low":2741,"close":2745}]}
```

Timestamp Unix dalam detik, urut naik, minimal dua candle, maksimal 5000. OHLC harus positif dan konsisten. Backend memvalidasi payload, menolak redirect, menerapkan timeout 8 detik, dan mengembalikan error generik tanpa rahasia. Tidak ada fallback diam-diam ke demo ketika upstream gagal. Chart diambil kembali saat instrumen/timeframe berubah. Kuotasi untuk instrumen terpilih dan semua posisi terbuka dipolling setiap 5 detik. Pada sumber simulasi, mark memiliki variasi sinus kecil untuk mendemonstrasikan P&L; ini bukan harga live. Watchlist tetap snapshot demo walaupun bridge aktif.

API: `GET /api/health`, `GET /api/market?symbol=XAUUSD&interval=3600`. Semua metode `/api/orders` ditolak (403). API key tidak pernah dikirim ke frontend. `.env*`, log, build dan dependensi diabaikan Git.

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
