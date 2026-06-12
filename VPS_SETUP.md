# VPS Setup Guide — JakTraffic

Panduan deploy JakTraffic dari nol ke VPS Ubuntu. Jalankan setiap langkah secara berurutan.

---

## Informasi Sistem Target

- OS: Ubuntu 22.04 / 24.04
- RAM: 4GB
- Repo: https://github.com/alfinalkhoiri/JakTraffic-AI-CCTV-Based-Predictive-Traffic-Intelligence-for-Greater-Jakarta
- Backend port: 5000 (Flask)
- Frontend: Nginx port 80
- DB: PostgreSQL, database `traffic_system`

---

## STEP 1 — Update sistem & install dependencies

```bash
sudo apt update && sudo apt upgrade -y

sudo apt install -y \
  python3 python3-pip python3-venv \
  postgresql postgresql-contrib \
  nginx git curl build-essential \
  libpq-dev libgl1 libglib2.0-0
```

Install Node.js 20:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verifikasi:
```bash
python3 --version
node --version
psql --version
nginx -v
```

---

## STEP 2 — Clone repo

```bash
cd /opt
sudo mkdir jaktraffic
sudo chown $USER:$USER jaktraffic
cd jaktraffic
git clone https://github.com/alfinalkhoiri/JakTraffic-AI-CCTV-Based-Predictive-Traffic-Intelligence-for-Greater-Jakarta.git .
```

---

## STEP 3 — Python virtual environment & install packages

```bash
cd /opt/jaktraffic
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r backend/requirements.txt
```

> Catatan: ultralytics akan otomatis download `yolo11n.pt` saat pertama kali backend dijalankan.
> Proses install bisa 5-10 menit tergantung koneksi VPS.

---

## STEP 4 — Setup PostgreSQL

Masuk ke PostgreSQL dan buat database:
```bash
sudo -u postgres psql
```

Jalankan di dalam psql:
```sql
CREATE USER jaktraffic WITH PASSWORD 'ganti_password_ini';
CREATE DATABASE traffic_system OWNER jaktraffic;
GRANT ALL PRIVILEGES ON DATABASE traffic_system TO jaktraffic;
\q
```

---

## STEP 5 — Restore database dari dump

Upload file dump dari laptop ke VPS terlebih dahulu:
```bash
# Jalankan di LAPTOP (PowerShell):
scp C:\Users\alfin\Desktop\traffic_system.dump user@IP_VPS:/tmp/
```

Lalu restore di VPS:
```bash
pg_restore -U jaktraffic -d traffic_system -h localhost /tmp/traffic_system.dump
```

Verifikasi:
```bash
psql -U jaktraffic -d traffic_system -c "SELECT COUNT(*) FROM cctv_locations;"
psql -U jaktraffic -d traffic_system -c "SELECT COUNT(*) FROM current_traffic;"
psql -U jaktraffic -d traffic_system -c "SELECT road_type, COUNT(*) FROM cctv_locations GROUP BY road_type;"
```

Hasil yang diharapkan: 36 kamera, road_type city=27 dan toll=9.

---

## STEP 6 — Buat file .env backend

```bash
cp /opt/jaktraffic/backend/.env.example /opt/jaktraffic/backend/.env
nano /opt/jaktraffic/backend/.env
```

Isi file `.env`:
```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=traffic_system
DB_USER=jaktraffic
DB_PASSWORD=ganti_password_ini
```

---

## STEP 7 — Test backend manual (pastikan berjalan)

```bash
cd /opt/jaktraffic/backend
source /opt/jaktraffic/venv/bin/activate
python app.py
```

Cek dari terminal lain:
```bash
curl http://localhost:5000/api/cctv_status | python3 -m json.tool | head -30
```

Harus muncul data 36 kamera. Jika sudah oke, stop dengan `Ctrl+C`.

---

## STEP 8 — Build React frontend

```bash
cd /opt/jaktraffic/frontend
npm install
npm run build
```

Hasil build ada di `/opt/jaktraffic/frontend/build/`.

---

## STEP 9 — Konfigurasi Nginx

Buat config Nginx:
```bash
sudo nano /etc/nginx/sites-available/jaktraffic
```

Isi:
```nginx
server {
    listen 80;
    server_name _;

    root /opt/jaktraffic/frontend/build;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }
}
```

Aktifkan:
```bash
sudo ln -s /etc/nginx/sites-available/jaktraffic /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

---

## STEP 10 — systemd service untuk backend

```bash
sudo nano /etc/systemd/system/jaktraffic-backend.service
```

Isi:
```ini
[Unit]
Description=JakTraffic Backend (Flask)
After=network.target postgresql.service

[Service]
User=www-data
Group=www-data
WorkingDirectory=/opt/jaktraffic/backend
EnvironmentFile=/opt/jaktraffic/backend/.env
ExecStart=/opt/jaktraffic/venv/bin/python app.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Ubah ownership folder:
```bash
sudo chown -R www-data:www-data /opt/jaktraffic
```

Aktifkan & jalankan:
```bash
sudo systemctl daemon-reload
sudo systemctl enable jaktraffic-backend
sudo systemctl start jaktraffic-backend
sudo systemctl status jaktraffic-backend
```

---

## STEP 11 — Firewall (UFW)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

---

## STEP 12 — Test stream Balitower dari VPS

Cek apakah Balitower bisa diakses dari IP VPS:
```bash
curl -I --max-time 10 https://cctv.balitower.co.id/Bendungan-Hilir-003-700014_2/index.m3u8
```

- Jika status `200` → stream bisa diakses, YOLO akan berjalan untuk kamera kota
- Jika `403` atau timeout → IP VPS tetap diblokir Balitower

---

## STEP 13 — Install Ollama (chatbot)

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Pull model (pilih salah satu):
```bash
ollama pull gemma3:1b      # ~800MB, cocok untuk VPS 4GB
# atau
ollama pull qwen2.5:3b     # ~1.9GB, lebih akurat
```

Aktifkan Ollama sebagai service:
```bash
sudo systemctl enable ollama
sudo systemctl start ollama
```

Test:
```bash
curl http://localhost:11434/api/tags
```

---

## STEP 14 — Verifikasi akhir

```bash
# Cek semua service berjalan
sudo systemctl status jaktraffic-backend
sudo systemctl status nginx
sudo systemctl status ollama
sudo systemctl status postgresql

# Cek log backend jika ada error
journalctl -u jaktraffic-backend -f

# Cek akses dari luar
curl http://localhost/api/cctv_status | python3 -m json.tool | head -20
```

Buka browser: `http://IP_VPS` — peta harus muncul dengan 36 marker.

---

## Troubleshooting

**Backend gagal start:**
```bash
journalctl -u jaktraffic-backend -n 50
```

**Nginx 502 Bad Gateway:**
```bash
sudo systemctl status jaktraffic-backend
# Pastikan Flask berjalan di port 5000
```

**PostgreSQL connection refused:**
```bash
sudo systemctl status postgresql
# Cek pg_hba.conf jika perlu
```

**YOLO tidak bisa buka stream HTTPS:**
Pastikan di `backend/core/detector.py` ada environment variable:
```python
os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = (
    'protocol_whitelist;file,crypto,data,http,https,tcp,tls,udp|'
    'timeout;15000000'
)
```

**Permission denied di /opt/jaktraffic:**
```bash
sudo chown -R www-data:www-data /opt/jaktraffic
sudo chmod -R 755 /opt/jaktraffic
```

---

## Perintah harian berguna

```bash
# Restart backend setelah update kode
sudo systemctl restart jaktraffic-backend

# Lihat log real-time
journalctl -u jaktraffic-backend -f

# Update kode dari GitHub
cd /opt/jaktraffic && git pull
sudo systemctl restart jaktraffic-backend

# Rebuild frontend setelah update
cd /opt/jaktraffic/frontend && npm run build
```
