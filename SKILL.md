# SKILL.md — JakTraffic AI

**AI Open Innovation Challenge 2026 — Traffic Management Category**
**President University · Alfin Khoiri · alfin.khoiri@student.president.ac.id**

---

## Kompetensi Teknis yang Didemonstrasikan

### 1. Computer Vision — YOLO 11 Vehicle Detection
- Implementasi YOLOv11n (Ultralytics) untuk deteksi kendaraan dari gambar dan video
- Kelas deteksi: mobil (2), motor (3), bus (5), truk (7) — `conf=0.3`
- Output: jumlah kendaraan + anotasi bounding box + base64 image
- Fallback realistis saat stream tidak tersedia: simulasi berbasis pola jam WIB

**Skill:** PyTorch, OpenCV, Ultralytics, image processing, model inference

---

### 2. Machine Learning — Transformer Traffic Predictor
- Arsitektur: Transformer Encoder kustom (PyTorch)
- Input: 60 data historis per lokasi → output: prediksi 15 menit & 30 menit ke depan
- Dilatih dari data historis 49 lokasi di PostgreSQL
- Terintegrasi ke API dan peta real-time

**Skill:** PyTorch, sequence modeling, time-series forecasting, model training & inference

---

### 3. LLM Integration — SumoPod GPT-5 Nano
- Integrasi LLM via OpenAI-compatible API (`/v1/chat/completions`)
- Server-Sent Events (SSE) streaming untuk typewriter effect di frontend
- Multi-turn conversation dengan context data lalu lintas real-time
- Map intent detection: chatbot bisa zoom peta, set rute, highlight lokasi, compare 2 titik
- Injeksi konteks DB (kondisi 49 kamera + prediksi Transformer) ke system prompt

**Skill:** LLM API, prompt engineering, SSE streaming, NLP intent detection

---

### 4. Backend Engineering — Flask + APScheduler
- REST API dengan 20+ endpoint (CRUD, analitik, deteksi, prediksi, chat)
- Background job paralel (4 ThreadPoolExecutor workers) setiap 2 menit untuk 49 kamera
- Koneksi DB per-thread (psycopg2), in-process caching untuk TomTom API
- CORS, error handling, logging, modular struktur (`core/`, `database/`)

**Skill:** Python, Flask, APScheduler, concurrent.futures, PostgreSQL, psycopg2

---

### 5. Database — PostgreSQL
- Schema: `current_traffic` (status terkini), `traffic_logs` (historis per menit), `cctv_locations`
- 49 kamera seeded via `init_db.sql` dengan metadata lengkap (lat, lng, road_type, stream_url)
- Derived field `has_signal` dari `road_type` tanpa ALTER TABLE (solusi permission constraint)
- Time-series query untuk chart historis, perbandingan now-vs-usual, dan prediksi

**Skill:** PostgreSQL, SQL window functions, time-series queries, schema design

---

### 6. Adaptive Signal Recommendation
- Algoritma rekomendasi durasi lampu merah/hijau berbasis kepadatan kendaraan
- Tiga level prioritas: TINGGI (>40 kend → hijau 90s), NORMAL (20–40 → 60s), RENDAH (<20 → 30s)
- `has_signal` flag — jalan tol otomatis dikecualikan (tidak ada lampu merah di tol)
- Tampil di popup peta, sidebar analitik, dan admin dashboard

**Skill:** traffic engineering logic, real-time recommendation system

---

### 7. Frontend — React + Leaflet + Recharts
- Peta interaktif Leaflet dengan 49 marker animasi (pulsing circle + diamond tol)
- Routing OSRM: polyline berwarna per segmen berdasarkan kepadatan + turn-by-turn
- Marker popup dengan HLS live preview (hls.js), signal rec, dan status kendaraan
- Area chart volatility per kamera, prediction mode toggle (sekarang/15min/30min)
- Admin dashboard: CRUD kamera, activity trend chart, YOLO file upload, sinyal overview
- Responsive layout (mobile + desktop) dengan Tailwind CSS

**Skill:** React, Leaflet, Recharts, hls.js, Axios, Tailwind CSS, SSE client

---

### 8. External API Integration — TomTom Traffic
- **Traffic Flow API**: kecepatan nyata vs bebas hambatan per titik kamera (km/j)
- **Traffic Incidents API**: kecelakaan, kemacetan, penutupan jalan area Jakarta–Bekasi
- In-process cache (60s flow / 120s incidents) untuk efisiensi kuota API
- Graceful degradation: semua fitur tetap berjalan tanpa API key

**Skill:** REST API integration, caching strategy, external data enrichment

---

### 9. Routing & Geospatial
- OSRM open-source routing engine (gratis, tanpa API key)
- Deteksi CCTV di sepanjang rute (`detectIntermediateCCTVs`) dengan threshold 200m
- Per-leg ETA dengan multiplier kepadatan lalu lintas (1× / 1.25× / 1.5×)
- Polyline gradient warna sesuai kondisi zona kamera terdekat
- Toll corridor overlay: KG-PG & BCKM dari routing OSRM antar kamera tol
- Haversine distance untuk kalkulasi jarak geospatial

**Skill:** geospatial computation, OSRM API, routing algorithms

---

### 10. DevOps & Deployment
- VPS Ubuntu dengan Nginx sebagai reverse proxy
- PM2 untuk process management + auto-restart backend (Python) dan frontend (Node)
- GitHub SSH key authentication untuk deployment workflow
- Cloudflare Worker sebagai CCTV HLS proxy (bypass CORS/geo-block)
- `.env` based secrets management (API keys tidak pernah di-commit ke git)

**Skill:** Linux, Nginx, PM2, Git, SSH, Cloudflare Workers, secrets management

---

## Ringkasan Stack

| Kategori | Teknologi |
|---|---|
| Language | Python 3.12, JavaScript (ES2023) |
| AI / CV | YOLO 11n, PyTorch Transformer, OpenCV |
| LLM | SumoPod GPT-5 Nano (OpenAI-compatible) |
| Backend | Flask, APScheduler, psycopg2 |
| Frontend | React, Leaflet, Recharts, hls.js, Tailwind |
| Database | PostgreSQL |
| Routing | OSRM |
| Traffic Data | TomTom Traffic Flow & Incidents API |
| Deployment | Ubuntu VPS, Nginx, PM2, Cloudflare Workers |

---

## Metrik Sistem

| Metrik | Nilai |
|---|---|
| Jumlah kamera | 49 (DKI Jakarta + Bekasi) |
| Update interval | 2 menit (4 parallel workers) |
| Kamera persimpangan berlampu | 39 |
| Kamera jalan tol | 10 |
| API endpoints | 22+ |
| Transformer parameters | ~200K |
| Prediksi horizon | 15 menit & 30 menit |
| Chat context | 49 kamera + historis 1 jam + prediksi Transformer |

---

*JakTraffic AI — AI Open Innovation Challenge 2026*
*Traffic Management Category — President University*
