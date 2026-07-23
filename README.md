# JakTraffic AI — CCTV-Based Predictive Traffic Intelligence for Greater Jakarta

Sistem pemantauan dan prediksi lalu lintas berbasis AI untuk wilayah DKI Jakarta dan Bekasi. Menggabungkan computer vision (YOLO 11), large language model (SumoPod GPT-5 Nano), dan analisis historis untuk menghasilkan rekomendasi sinyal adaptif, prediksi kemacetan, dan navigasi cerdas secara real-time.

🌐 **Live Demo:** [jaktrafficai.f-mc.my.id](https://jaktrafficai.f-mc.my.id)

---

## Tampilan

### Tampilan User (Pengendara)
Peta full-screen dengan panel info mengambang. Dirancang agar mudah digunakan saat berkendara.

- Navbar floating dengan ringkasan LANCAR / RAMAI / PADAT real-time
- Panel kiri context-aware: idle guide → CCTV detail → routing → compare
- Klik marker CCTV: status, kecepatan TomTom, grafik tren, rekomendasi sinyal
- Klik 2× peta: buat rute A→B dengan petunjuk arah Bahasa Indonesia
- Panduan suara (Web Speech API): auto-announce rute & kondisi CCTV
- Pencarian lokasi geocoding (Nominatim): ketik nama tempat untuk titik awal/tujuan

### Tampilan Operator Dishub
Dashboard command-center dengan sidebar tetap. Fokus pada monitoring dan pengelolaan.

- Sidebar 220px dengan navigasi 5 tab
- **Monitor** — daftar kamera diurutkan kepadatan + detail chart per kamera
- **Analitik** — top 10 tersibuk, distribusi status, grafik tren
- **Sinyal** — tabel rekomendasi lampu merah/hijau seluruh persimpangan
- **AI Deteksi** — upload YOLO, simulasi kendaraan, info model Transformer
- **Manajemen** — CRUD kamera CCTV
- Login terproteksi password (akses terbatas operator Dishub)

---

## Fitur Utama

### Peta Interaktif Real-Time
- **100 titik kamera CCTV** — DKI Jakarta, Bekasi, dan ruas tol
- Marker berbeda: lingkaran pulsing (jalan kota) vs diamond (jalan tol)
- Status warna: HIJAU / KUNING / MERAH berdasarkan jumlah kendaraan terdeteksi
- Overlay koridor tol: KG-PG, BCKM, JORR, Tol Dalam Kota, Tol Bekasi
- Insiden TomTom langsung di peta (kecelakaan, kemacetan, penutupan jalan)
- **Overlay zona rawan banjir** — 10 zona BPBD DKI Jakarta, 3 level risiko

### Routing Cerdas
- Routing via OSRM (open source, tanpa API key)
- **Rute alternatif** — hingga 3 pilihan rute dengan ETA & kondisi masing-masing
- Polyline berwarna per segmen sesuai kepadatan zona CCTV terdekat
- ETA real-time dengan koreksi kepadatan (1× / 1.25× / 1.5×)
- Turn-by-turn navigation dengan petunjuk arah Bahasa Indonesia
- Auto fit-bounds: peta otomatis zoom ke seluruh rute saat rute terbentuk
- **Estimasi tarif tol** — deteksi koridor tol yang dilintasi, hitung biaya Rp per koridor
- Prediksi kondisi 1 jam ke depan di sepanjang rute

### Panduan Suara
- Toggle 🔊/🔇 di navbar
- Auto-announce saat rute selesai: nama asal→tujuan + jarak + ETA + langkah pertama + jumlah rute alternatif
- Auto-announce saat klik kamera: nama lokasi + kondisi + jumlah kendaraan
- Tombol "Baca" untuk membacakan semua petunjuk arah berurutan
- Web Speech API bawaan browser, bahasa id-ID, tanpa library tambahan

### AI Chatbot (SumoPod GPT-5 Nano)
- Natural language Bahasa Indonesia
- Context-aware: tahu kondisi 100 kamera + prediksi Transformer saat ini
- Kontrol peta: zoom lokasi, set rute, highlight, bandingkan 2 titik
- Streaming response real-time (Server-Sent Events)
- **Voice input** (STT mic 🎤) + **voice reply** (TTS 🔊) bawaan browser
- Mode edit tersembunyi dari user — hanya terlihat di panel /admin

### Notifikasi Browser
- Toggle 🔔 di navbar — meminta izin notifikasi browser
- Push notification otomatis saat kondisi rute berubah (LANCAR → PADAT dst.)
- Notifikasi insiden TomTom jika ada kecelakaan/kemacetan dalam radius 800m dari rute

### WebSocket Real-Time
- Koneksi persisten browser ↔ server via Socket.IO
- Server push data kamera langsung ke semua client setelah setiap mining job (tiap ~2 menit)
- Status dot hijau/kuning di navbar menandakan koneksi WebSocket aktif atau fallback polling
- HTTP polling dipertahankan sebagai fallback (interval 90 detik)

### Rekomendasi Sinyal Adaptif
- Durasi optimal fase hijau & merah berdasarkan kepadatan
- 3 level: TINGGI (>40 kend → hijau 90s), NORMAL (20–40 → 60s), RENDAH (<20 → 30s)
- Jalan tol dikecualikan otomatis (tidak ada lampu merah)

### TomTom Traffic Integration
- **Flow API** — kecepatan nyata vs bebas hambatan per kamera (km/j)
- **Incidents API** — kecelakaan, kemacetan, penutupan jalan area Jakarta–Bekasi
- Cache in-process 60s (flow) / 120s (incidents) untuk efisiensi kuota

### YOLO 11 Vehicle Detection
- Model: `yolo11n.pt` — deteksi mobil, motor, bus, truk
- Upload gambar/video → deteksi + anotasi → update kamera di peta
- Auto-aktif jika `stream_url` kamera bisa diakses dari VPS
- Mode simulasi realistis berbasis pola jam WIB saat stream tidak tersedia

### Prediksi Lalu Lintas (Transformer)
- Arsitektur Transformer Encoder kustom (PyTorch)
- Prediksi 15 menit dan 30 menit ke depan
- Visualisasi prediksi langsung di peta (warna marker berubah)

### Mobile App (Flutter)
- Peta live CCTV dengan marker status real-time
- Prediksi AI dan rute draggable
- Chat streaming dengan AI
- Tersedia untuk Android & iOS

---

## Tech Stack

| Layer | Teknologi |
|---|---|
| Web Frontend | React.js, Leaflet, Recharts, Axios, Socket.IO Client |
| Mobile | Flutter (Android & iOS) |
| Backend | Python 3, Flask, Flask-SocketIO, APScheduler |
| AI / CV | YOLO 11n (Ultralytics), OpenCV |
| ML | PyTorch Transformer (time-series predictor) |
| LLM | SumoPod GPT-5 Nano (OpenAI-compatible API) |
| Database | PostgreSQL |
| Routing | OSRM (open source) |
| Geocoding | Nominatim / OpenStreetMap |
| Traffic Data | TomTom Traffic Flow + Incidents API |
| Voice | Web Speech API (browser native, STT + TTS) |
| Real-time | WebSocket (Flask-SocketIO + Nginx upgrade proxy) |
| Deployment | Nginx + PM2, VPS Ubuntu |

---

## Arsitektur Sistem

```
Browser / Mobile App
  ├── Peta Leaflet (React)          ← WebSocket push tiap ~2 menit + polling fallback 90s
  ├── AI Chatbot (SSE streaming)    ← /api/chat-stream
  └── Admin Dashboard               ← CRUD, YOLO upload, signal overview (auth required)

Flask Backend (:5000)
  ├── APScheduler (tiap ~2 menit)   → YOLO / simulasi → update DB → emit WebSocket
  ├── Flask-SocketIO                → push traffic_update ke semua client
  ├── /api/cctv_status              → 100 kamera + has_signal + vehicles
  ├── /api/signal-recommendation    → rekomendasi sinyal adaptif
  ├── /api/predict-traffic          → Transformer 15/30 menit
  ├── /api/predict-next-hour/<id>   → prediksi 1 jam ke depan
  ├── /api/detect-upload            → YOLO file detection
  ├── /api/tomtom-flow              → kecepatan jalan TomTom
  ├── /api/tomtom-incidents         → insiden TomTom
  └── /api/chat-stream              → SSE proxy ke SumoPod LLM

PostgreSQL
  ├── current_traffic               → status kendaraan terkini per kamera
  ├── traffic_logs                  → historis setiap menit
  └── cctv_locations                → metadata kamera (lat, lng, road_type, stream_url)

Nginx
  ├── /                             → React build (static)
  ├── /api/                         → proxy ke Flask :5000
  └── /socket.io/                   → WebSocket proxy (Upgrade: websocket)
```

---

## Cara Menjalankan

### Prerequisites
- Python 3.10+
- Node.js 18+
- PostgreSQL
- Flutter SDK (untuk mobile)
- (Opsional) GPU untuk YOLO inference lebih cepat

### Backend

```bash
cd backend
cp .env.example .env
# Edit .env: isi DB_PASSWORD dan SUMOPOD_API_KEY

python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Inisialisasi database
psql -U postgres -f init_db.sql

python app.py
```

### Web Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm start
```

Akses di `http://localhost:3000` (user) dan `http://localhost:3000/admin-login` (operator)

### Mobile App

```bash
cd mobile
flutter pub get
flutter run
```

---

## Konfigurasi

### `backend/.env`
```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=traffic_system
DB_USER=jaktraffic
DB_PASSWORD=your_password_here

SUMOPOD_API_KEY=your_sumopod_api_key_here
SUMOPOD_URL=https://ai.sumopod.com/v1/chat/completions
SUMOPOD_MODEL=gpt-5-nano

# Opsional — aktifkan TomTom Traffic (daftar gratis di developer.tomtom.com)
TOMTOM_API_KEY=your_tomtom_api_key_here
```

### `frontend/.env`
```env
HOST=0.0.0.0
PORT=3000
BROWSER=none
REACT_APP_CCTV_PROXY=https://your-worker.workers.dev

# Opsional — override password default panel operator
REACT_APP_ADMIN_PASS=your_admin_password_here
```

> `REACT_APP_CCTV_PROXY` — opsional, untuk proxy stream HLS via Cloudflare Worker guna bypass CORS/geo-block.

---

## API Endpoints

| Method | Endpoint | Deskripsi |
|---|---|---|
| GET | `/api/cctv_status` | Semua kamera + status + `has_signal` |
| GET | `/api/traffic-history/<id>?range=1h` | Historis kendaraan per lokasi |
| GET | `/api/now-vs-usual/<id>` | Perbandingan sekarang vs biasanya |
| GET | `/api/predict-next-hour/<id>` | Prediksi 1 jam ke depan |
| GET | `/api/predict-traffic?horizon=15` | Prediksi semua lokasi (15/30 menit) |
| GET | `/api/signal-recommendation` | Rekomendasi sinyal semua persimpangan |
| GET | `/api/signal-recommendation/<id>` | Rekomendasi sinyal satu kamera |
| POST | `/api/simulate-count` | Update jumlah kendaraan manual |
| POST | `/api/detect-upload` | YOLO detection dari file gambar/video |
| GET | `/api/tomtom-flow?lat=&lng=` | Kecepatan jalan TomTom |
| GET | `/api/tomtom-incidents` | Insiden TomTom area Jakarta–Bekasi |
| POST | `/api/chat` | AI chatbot (non-streaming) |
| POST | `/api/chat-stream` | AI chatbot (SSE streaming) |
| GET | `/api/model-info` | Info Transformer model |
| WS | `/socket.io/` | WebSocket — push `traffic_update` tiap ~2 menit |

---

## Struktur Project

```
├── backend/
│   ├── app.py                  # Flask app + SocketIO + APScheduler + semua endpoints
│   ├── core/
│   │   ├── detector.py         # YOLO 11 VideoDetector
│   │   ├── predictor.py        # Transformer traffic predictor
│   │   └── scoring.py          # Risk score calculator
│   ├── database/
│   │   └── db_handler.py       # PostgreSQL handler + BACKUP_COORDS 100 kamera
│   ├── init_db.sql             # Schema + seed data
│   ├── requirements.txt
│   └── .env.example
│
├── frontend/
│   ├── src/
│   │   ├── App.js              # Tampilan User — peta + routing + suara + chatbot + WebSocket
│   │   ├── pages/
│   │   │   ├── Admin.js        # Tampilan Operator Dishub — 5-tab dashboard
│   │   │   └── AdminLogin.js   # Halaman login panel operator
│   │   ├── components/
│   │   │   ├── MapPopup.jsx    # Popup kamera di peta
│   │   │   ├── ChatPopup.jsx   # AI chatbot UI (voice STT/TTS)
│   │   │   └── ChatButton.jsx
│   │   └── services/
│   │       └── chat.js         # SumoPod API client
│   └── .env.example
│
├── mobile/                     # Flutter app (Android & iOS)
│   ├── lib/
│   │   ├── main.dart
│   │   ├── screens/            # home, chat, prediction
│   │   ├── providers/          # traffic, chat, route, prediction
│   │   ├── services/           # api, chat, route, traffic
│   │   └── widgets/
│   └── pubspec.yaml
│
├── cloudflare-worker.js        # CCTV HLS proxy (Cloudflare)
├── ecosystem.config.js         # PM2 config
└── README.md
```

---

## Catatan Teknis

### Kenapa Data Kendaraan Menggunakan Simulasi?
Server CCTV pemerintah Jakarta (Dishub, ATCS) memblokir akses dari IP VPS asing. Sistem menggunakan simulasi realistis berbasis pola jam WIB. YOLO aktif otomatis jika `stream_url` kamera bisa diakses langsung dari VPS.

### Rekomendasi Sinyal Adaptif

| Kendaraan | Hijau | Merah | Prioritas |
|---|---|---|---|
| > 40 | 90 detik | 30 detik | TINGGI |
| 20–40 | 60 detik | 45 detik | NORMAL |
| < 20 | 30 detik | 60 detik | RENDAH |

Kamera `road_type = "toll"` dikecualikan otomatis — tidak ada lampu merah di tol.

### COALESCE Strategy (Two-Table Schema)
Tabel `cctv_locations` adalah sumber kebenaran untuk koordinat dan nama kamera. Tabel `current_traffic` menyimpan data live. Query menggunakan `COALESCE(cl.lat, ct.lat)` agar data `cctv_locations` selalu menang, mencegah null crash di Leaflet.

### Estimasi Tarif Tol
Tarif berlaku untuk kendaraan Golongan I (sedan, jeep, pickup). Koridor yang didukung: KG–PG, BCKM Cawang, BCKM Bekasi Barat, Bekasi Timur. Deteksi otomatis berdasarkan kedekatan rute dengan kamera tol (radius 700m).

### WebSocket
Backend menggunakan `flask-socketio` dengan `async_mode='threading'` agar kompatibel dengan APScheduler. Nginx dikonfigurasi dengan blok `/socket.io/` khusus yang meneruskan header `Upgrade: websocket` ke backend. Socket.IO otomatis fallback ke HTTP long-polling jika WebSocket tidak tersedia.

---

## Kontributor

- **Alfin Khoiri** — Web frontend, backend, AI/ML, deployment
- **Hamid** — Flutter mobile app

---

## Lisensi

MIT License — bebas digunakan untuk keperluan edukasi dan penelitian.

---

*Dibuat untuk AI Open Innovation Challenge 2026 — Kategori Traffic Management*
*President University · 2026*
