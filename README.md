# JakTraffic AI — CCTV-Based Predictive Traffic Intelligence for Greater Jakarta

Sistem pemantauan dan prediksi lalu lintas berbasis AI untuk wilayah DKI Jakarta dan Bekasi. Menggabungkan computer vision (YOLO 11), large language model (SumoPod GPT-5 Nano), dan analisis historis untuk menghasilkan rekomendasi sinyal adaptif, prediksi kemacetan, dan navigasi cerdas secara real-time.

🌐 **Live Demo:** [jaktrafficai.f-mc.my.id](https://jaktrafficai.f-mc.my.id)

---

## Fitur Utama

### Peta Interaktif Real-Time
- 49 titik kamera CCTV DKI Jakarta + Bekasi
- Marker berbeda: lingkaran (jalan kota) vs diamond (jalan tol)
- Status lalu lintas: HIJAU / KUNING / MERAH berdasarkan jumlah kendaraan
- Popup per kamera: preview live, status, dan rekomendasi sinyal adaptif
- Filter mode rute: Semua / Non-Tol / Tol
- Overlay koridor tol: KG-PG (Kelapa Gading–Pulo Gebang) & BCKM (Bekasi–Cawang–Kamp. Melayu)

### Rekomendasi Sinyal Adaptif
- Hitung durasi optimal fase hijau & merah berdasarkan kepadatan kendaraan
- 3 level prioritas: TINGGI (>40 kend), NORMAL (20–40 kend), RENDAH (<20 kend)
- Hanya berlaku untuk persimpangan berlampu — jalan tol dikecualikan otomatis
- Tampil di popup peta, sidebar, dan admin dashboard

### Routing Cerdas
- Routing berbasis OSRM (gratis, tanpa API key)
- ETA real-time dengan koreksi kepadatan lalu lintas
- Turn-by-turn navigation (petunjuk arah Bahasa Indonesia)
- Prediksi kondisi 1 jam ke depan di sepanjang rute

### TomTom Traffic Integration
- **Traffic Flow API** — kecepatan nyata vs bebas hambatan per titik kamera (km/j)
- **Traffic Incidents API** — kecelakaan, kemacetan, penutupan jalan di peta Jakarta–Bekasi
- Efisiensi lajur ditampilkan di sidebar kamera terpilih
- Insiden ditampilkan sebagai marker kuning/merah langsung di peta

### YOLO 11 Vehicle Detection
- Model: `yolo11n.pt` — deteksi mobil, motor, bus, truk
- Upload gambar/video → deteksi + anotasi langsung
- Hasil update jumlah kendaraan di peta secara real-time
- Mode simulasi untuk demo tanpa sumber video

### AI Chatbot (SumoPod GPT-5 Nano)
- Analisis kondisi lalu lintas via natural language (Bahasa Indonesia)
- Kontrol peta: highlight lokasi, bandingkan 2 titik, set rute otomatis
- Streaming response real-time (Server-Sent Events)
- Context-aware: tahu kondisi semua 49 kamera saat ini

### Prediksi Lalu Lintas (Transformer)
- Prediksi 15 menit dan 30 menit ke depan
- Visualisasi prediksi langsung di peta (warna marker berubah)
- Live prediction test di admin dashboard

### Admin Dashboard
- CRUD kamera CCTV (tambah, edit, hapus)
- Activity trend chart per kamera (30m / 1h / 6h / 12h / 24h)
- YOLO file detection dengan drag-and-drop
- Sinyal overview: tabel semua persimpangan diurutkan prioritas
- Info Transformer model (arsitektur, parameter, training stats)

---

## Tech Stack

| Layer | Teknologi |
|---|---|
| Frontend | React.js, Leaflet, Recharts, Tailwind CSS, Axios |
| Backend | Python 3, Flask, APScheduler |
| AI / CV | YOLO 11n (Ultralytics), OpenCV |
| LLM | SumoPod GPT-5 Nano (OpenAI-compatible API) |
| Database | PostgreSQL |
| Routing | OSRM (open source) |
| Traffic Data | TomTom Traffic Flow + Incidents API |
| Deployment | Nginx + PM2 / systemd, VPS Ubuntu |

---

## Arsitektur Sistem

```
Browser
  ├── Peta Leaflet (React)          ← polling /api/cctv_status tiap 30 detik
  ├── AI Chatbot (SSE streaming)    ← /api/chat-stream
  └── Admin Panel                   ← CRUD, YOLO upload, signal overview

Flask Backend (:5000)
  ├── APScheduler (tiap ~1 menit)   → hitung kendaraan (simulasi / YOLO)
  ├── /api/cctv_status              → 49 kamera + has_signal + vehicles
  ├── /api/signal-recommendation    → rekomendasi sinyal adaptif
  ├── /api/predict-traffic          → prediksi Transformer 15/30 menit
  ├── /api/detect-upload            → YOLO file detection
  ├── /api/simulate-count           → update DB manual (admin)
  └── /api/chat-stream              → SSE proxy ke SumoPod LLM

PostgreSQL
  ├── current_traffic               → jumlah kendaraan terkini per lokasi
  ├── traffic_logs                  → historis setiap menit
  └── cctv_locations                → metadata kamera (lat, lng, road_type)
```

---

## Cara Menjalankan

### Prerequisites
- Python 3.10+
- Node.js 18+
- PostgreSQL
- (Opsional) GPU untuk YOLO inference lebih cepat

### Backend

```bash
cd backend
cp .env.example .env
# Edit .env: isi DB_PASSWORD dan SUMOPOD_API_KEY

python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Inisialisasi database
psql -U postgres -f init_db.sql

python app.py
```

### Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm start
```

Akses di `http://localhost:3000`

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
```

> `REACT_APP_CCTV_PROXY` — opsional, untuk proxy stream HLS via Cloudflare Worker.

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
| GET | `/api/tomtom-flow?lat=<lat>&lng=<lng>` | TomTom Traffic Flow — kecepatan nyata vs bebas hambatan |
| GET | `/api/tomtom-incidents` | TomTom Incidents — kecelakaan & gangguan Jakarta–Bekasi |
| POST | `/api/chat` | AI chatbot (non-streaming) |
| POST | `/api/chat-stream` | AI chatbot (SSE streaming) |
| GET | `/api/model-info` | Info Transformer model |

---

## Struktur Project

```
├── backend/
│   ├── app.py                  # Flask app + APScheduler + semua endpoints
│   ├── core/
│   │   ├── detector.py         # YOLO 11 VideoDetector
│   │   ├── predictor.py        # Transformer traffic predictor
│   │   └── scoring.py          # Risk score calculator
│   ├── database/
│   │   └── db_handler.py       # PostgreSQL handler + 49 lokasi BACKUP_COORDS
│   ├── init_db.sql             # Schema + seed data 49 kamera
│   ├── requirements.txt
│   └── .env.example
│
├── frontend/
│   ├── src/
│   │   ├── App.js              # Peta utama + routing + chatbot
│   │   ├── pages/
│   │   │   └── Admin.js        # Admin dashboard
│   │   ├── components/
│   │   │   ├── MapPopup.jsx    # Popup kamera di peta
│   │   │   ├── ChatPopup.jsx   # AI chatbot UI
│   │   │   └── ChatButton.jsx
│   │   └── services/
│   │       └── chat.js         # SumoPod API client
│   └── .env.example
│
├── cloudflare-worker.js        # CCTV proxy worker (Cloudflare)
├── ecosystem.config.js         # PM2 config
└── README.md
```

---

## Catatan Teknis

### Kenapa Data Kendaraan Menggunakan Simulasi?
Server CCTV pemerintah Jakarta (Dishub, ATCS) memblokir akses dari IP VPS asing. Sistem menggunakan simulasi realistis berbasis pola jam WIB untuk 49 kamera. YOLO aktif otomatis jika `stream_url` kamera diisi dengan URL yang bisa diakses dari VPS.

### Rekomendasi Sinyal Adaptif
Logika sederhana namun efektif:

| Kendaraan | Hijau | Merah | Prioritas |
|---|---|---|---|
| > 40 | 90 detik | 30 detik | TINGGI |
| 20 – 40 | 60 detik | 45 detik | NORMAL |
| < 20 | 30 detik | 60 detik | RENDAH |

Kamera jalan tol (`road_type = "toll"`) otomatis dikecualikan karena tidak memiliki lampu merah.

### `has_signal` Flag
Diderivasi langsung dari `road_type` di backend — tidak butuh kolom DB tambahan:
```python
data["has_signal"] = data.get("road_type") != "toll"
```

---

## Lisensi

MIT License — bebas digunakan untuk keperluan edukasi dan penelitian.

---

*Dibuat untuk AI Open Innovation Challenge 2026 — Kategori Traffic Management*
*President University · Alfin Khoiri · 2026*
