# SmartTrafficBDG — Real-Time Traffic Monitoring DKI Jakarta

Sistem pemantauan lalu lintas berbasis CCTV + Computer Vision + Data Analytics yang menampilkan kondisi lalu lintas real-time, prediksi 1 jam ke depan, routing cerdas (toll/non-toll), dan AI chatbot untuk analisis kondisi lalu lintas.

---

## Fitur Utama

### Peta Publik
- Peta interaktif berbasis Leaflet dengan 36 kamera CCTV DKI Jakarta
- Marker berbeda: lingkaran (jalan biasa) vs diamond/TOL (jalan tol)
- Status lalu lintas: HIJAU / KUNING / MERAH berdasarkan vehicle count + cuaca
- Filter mode rute: Semua / Non-Tol / Hanya Tol
- Routing OSRM gratis (non-tol menggunakan `exclude=motorway`)
- Visualisasi koridor tol: Tol Dalam Kota KG-PG (amber) & Tol BCKM (orange)
- ETA + prediksi 1 jam ke depan saat routing aktif

### Traffic Analytics
- Grafik perbandingan Now vs Usual (rata-rata 7 hari)
- Traffic Stability & Volatility chart
- Deteksi anomali: Normal / Waspada / Unusual

### Prediksi (1 Jam ke Depan)
- Berbasis pola historis, tren jam serupa, dan volatilitas
- Output: label (Lancar/Berpotensi Padat/Macet), confidence (LOW/MEDIUM/HIGH), % perubahan

### AI Chatbot
- Analisis kondisi lalu lintas via natural language
- Backend LLM (Ollama / API)

### Admin Dashboard
- CRUD kamera CCTV
- Live vehicle counting (YOLO11n)
- Snapshot monitoring & activity trend

---

## Tech Stack

| Layer | Teknologi |
|---|---|
| Frontend | React.js, Leaflet, Recharts, Tailwind CSS, Axios |
| Backend | Python 3.x, Flask |
| Computer Vision | YOLO11n (Ultralytics 8.4.65), OpenCV |
| Database | PostgreSQL 18.1 |
| Routing | OSRM (gratis, self-hosted compatible) |
| Stream Proxy (VPS) | MediaMTX |
| Deployment | Nginx + systemd (target: VPS 4GB) |

---

## Sumber CCTV (36 Kamera)

| Sumber | Jumlah | Jenis | Status |
|---|---|---|---|
| cctv.balitower.co.id | 27 | Jalan Kota | Tergantung IP (kadang DOWN) |
| camera.jtd.co.id | 6 | Tol KG-PG (Tol Dalam Kota) | LIVE |
| cctv.kkdm.co.id | 3 | Tol BCKM (Bekasi-Cawang-Kamp.Melayu) | LIVE |

> **Catatan:** `cctv.balitower.co.id` memblokir beberapa IP. Dari VPS dengan IP berbeda kemungkinan bisa diakses kembali.

---

## Arsitektur Sistem

```
CCTV Stream (HLS/HTTPS)
   ↓
OpenCV VideoCapture (HTTPS fix via OPENCV_FFMPEG_CAPTURE_OPTIONS)
   ↓
YOLO11n Vehicle Tracking (classes: car, motorcycle, bus, truck)
   ↓
PostgreSQL — current_traffic + traffic_logs + cctv_locations
   ↓
Flask REST API (:5000)
   ↓
React Frontend (:3000 dev / Nginx :80 prod)
```

---

## Cara Menjalankan (Development)

```bash
# Backend
cd backend
pip install -r requirements.txt
python app.py

# Frontend
cd frontend
npm install
npm start
```

---

## API Endpoint

```
GET /api/cctv_status                        # semua kamera + road_type
GET /api/traffic-history/<id>?range=1h      # historis per lokasi
GET /api/now-vs-usual/<id>                  # perbandingan real-time vs rata-rata
GET /api/predict-next-hour/<id>             # prediksi 1 jam ke depan
GET /api/chat                               # AI chatbot
```

---

## Struktur Project

```
/backend
 ├── app.py                  # Flask app + scheduler (APScheduler)
 ├── core/
 │   ├── detector.py         # YOLO11n + OpenCV stream reader
 │   ├── predictor.py        # prediksi 1 jam ke depan
 │   └── scoring.py          # risk score calculator
 ├── database/
 │   └── db_handler.py       # PostgreSQL handler + BACKUP_COORDS (36 lokasi)
 ├── yolo11n.pt              # model weights
 └── requirements.txt

/frontend
 ├── src/
 │   ├── App.js              # main map + routing + toll overlay
 │   └── components/
 │       └── ChatPopup.jsx   # AI chatbot UI
 └── package.json
```

---

## Checklist Sebelum Pindah ke VPS

> Target: VPS Ubuntu 22.04, RAM 4GB, CPU 2-4 core

### Kode (wajib selesai sebelum deploy)

- [ ] **Implementasi parallel mining dengan ThreadPoolExecutor**
  - File: `backend/app.py` — fungsi `mining_job()`
  - Ganti sequential loop dengan `ThreadPoolExecutor(max_workers=4)`
  - 36 kamera / 4 workers = 9 batch × ~10 detik = ~90 detik/siklus
  - Pastikan tidak ada race condition pada koneksi DB (buat koneksi baru per thread)

- [ ] **Ubah interval scheduler dari 1 menit ke 2 menit**
  - File: `backend/app.py` — `scheduler.add_job(..., minutes=1)` → `minutes=2`
  - Alasan: 36 kamera × 10 detik = 360 detik sequential; tanpa parallel ini akan overlap

- [ ] **Pastikan `road_type` tersimpan di DB** (sudah done, verifikasi ulang)
  ```sql
  SELECT id, name, road_type FROM cctv_locations ORDER BY id;
  ```

- [ ] **Build frontend production**
  ```bash
  cd frontend && npm run build
  ```

- [ ] **Siapkan file `.env` backend**
  ```
  DB_HOST=localhost
  DB_PORT=5432
  DB_NAME=traffic_system
  DB_USER=postgres
  DB_PASSWORD=your_password
  ```

---

### Setup VPS

- [ ] **Install dependencies sistem**
  ```bash
  sudo apt update && sudo apt upgrade -y
  sudo apt install -y python3.11 python3.11-venv python3-pip \
    postgresql postgresql-contrib nginx git curl
  ```

- [ ] **Install Node.js 20 LTS** (untuk build frontend jika belum di-build lokal)
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
  ```

- [ ] **Setup Python virtual environment**
  ```bash
  python3.11 -m venv /opt/smarttraffic/venv
  source /opt/smarttraffic/venv/bin/activate
  pip install -r requirements.txt
  ```

---

### Migrasi Database

- [ ] **Backup dari lokal (Windows)**
  ```powershell
  pg_dump -U postgres -d traffic_system -F c -f traffic_system.dump
  ```

- [ ] **Upload ke VPS**
  ```bash
  scp traffic_system.dump user@vps-ip:/tmp/
  ```

- [ ] **Restore di VPS**
  ```bash
  createdb -U postgres traffic_system
  pg_restore -U postgres -d traffic_system /tmp/traffic_system.dump
  ```

- [ ] **Verifikasi data**
  ```sql
  SELECT COUNT(*) FROM cctv_locations;   -- harus 36
  SELECT COUNT(*) FROM current_traffic;  -- harus 36
  SELECT road_type, COUNT(*) FROM cctv_locations GROUP BY road_type;
  ```

---

### MediaMTX (Stream Proxy)

MediaMTX digunakan agar OpenCV tidak perlu langsung buka HTTPS stream eksternal dari VPS — mengurangi beban CPU dan menghindari masalah koneksi.

- [ ] **Install MediaMTX**
  ```bash
  wget https://github.com/bluenviron/mediamtx/releases/latest/download/mediamtx_linux_amd64.tar.gz
  tar -xzf mediamtx_linux_amd64.tar.gz
  sudo mv mediamtx /usr/local/bin/
  ```

- [ ] **Konfigurasi `mediamtx.yml`** — tambahkan path untuk setiap stream URL yang ingin di-proxy

- [ ] **Ubah `stream_url` di DB** agar mengarah ke `rtsp://localhost:8554/<nama_path>` setelah MediaMTX aktif

---

### Nginx (Serve React Build)

- [ ] **Config Nginx**
  ```nginx
  server {
      listen 80;
      server_name your-domain-or-ip;

      root /opt/smarttraffic/frontend/build;
      index index.html;

      location / {
          try_files $uri /index.html;
      }

      location /api/ {
          proxy_pass http://127.0.0.1:5000;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
      }
  }
  ```

- [ ] **Test & aktifkan**
  ```bash
  sudo nginx -t
  sudo ln -s /etc/nginx/sites-available/smarttraffic /etc/nginx/sites-enabled/
  sudo systemctl reload nginx
  ```

---

### systemd Services (Auto-restart)

- [ ] **Service untuk Flask backend** — `/etc/systemd/system/smarttraffic-backend.service`
  ```ini
  [Unit]
  Description=SmartTraffic Backend
  After=network.target postgresql.service

  [Service]
  User=www-data
  WorkingDirectory=/opt/smarttraffic/backend
  EnvironmentFile=/opt/smarttraffic/backend/.env
  ExecStart=/opt/smarttraffic/venv/bin/python app.py
  Restart=always
  RestartSec=5

  [Install]
  WantedBy=multi-user.target
  ```

- [ ] **Service untuk MediaMTX** — `/etc/systemd/system/mediamtx.service`

- [ ] **Aktifkan semua service**
  ```bash
  sudo systemctl enable smarttraffic-backend mediamtx
  sudo systemctl start smarttraffic-backend mediamtx
  ```

---

### Firewall (UFW)

- [ ] **Setup UFW**
  ```bash
  sudo ufw allow OpenSSH
  sudo ufw allow 'Nginx Full'
  sudo ufw enable
  ```

- [ ] Port 5000 (Flask) dan 8554 (MediaMTX RTSP) cukup internal — tidak perlu dibuka ke publik

---

### Ollama + LLM (Chatbot)

- [ ] **Install Ollama di VPS**
  ```bash
  curl -fsSL https://ollama.com/install.sh | sh
  ```

- [ ] **Pull model** (pilih salah satu sesuai RAM)
  ```bash
  ollama pull gemma3:1b    # ~800MB, cocok untuk VPS 4GB
  # atau
  ollama pull qwen2.5:3b   # ~1.9GB, lebih akurat
  ```

- [ ] **Update backend** agar chatbot menggunakan `http://localhost:11434` (Ollama API lokal)

---

### Testing Pasca Deploy

- [ ] Akses `http://your-vps-ip` — pastikan peta muncul dengan semua 36 marker
- [ ] Test stream balitower dari VPS IP (kemungkinan tidak diblokir):
  ```bash
  curl -I https://cctv.balitower.co.id/Bendungan-Hilir-003-700014_2/index.m3u8
  ```
- [ ] Cek logs backend: `journalctl -u smarttraffic-backend -f`
- [ ] Verifikasi toll cameras masih live: cek kamera ID 29-37 di dashboard
- [ ] Test routing Non-Tol dan Tol di peta
- [ ] Test chatbot via popup

---

## Estimasi Resource VPS

| Komponen | RAM |
|---|---|
| Python + Flask | ~200MB |
| YOLO11n inference (parallel 4 workers) | ~800MB |
| PostgreSQL | ~150MB |
| Nginx | ~20MB |
| Ollama + gemma3:1b | ~600MB |
| MediaMTX | ~30MB |
| **Total Estimasi** | **~1.8GB** |

> VPS 4GB RAM → sisa ~2.2GB sebagai buffer. Cukup untuk sistem ini.

---

## Status Kamera Saat Ini

- 27 kamera kota (balitower.co.id): menunggu akses dari IP VPS
- 9 kamera tol (JTD + KKDM): **LIVE**, vehicle count real-time aktif
  - Tol BCKM Cawang: ~10 kendaraan
  - Tol KG-PG Pulo Gadung: ~9 kendaraan
  - Tol KG-PG Duren Sawit, Cakung 1 & 2: data real-time tersedia
