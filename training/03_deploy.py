"""
JakTraffic — Step 3: Deploy model yang sudah di-fine-tune ke GPU service

Jalankan di GPU server setelah 02_train.py selesai.
Ini mengganti yolo11l.pt (COCO) dengan jaktraffic_v1/best.pt (Indonesia)
"""

import shutil, subprocess, time
from pathlib import Path

MODEL_SRC  = "/tmp/jaktraffic_training/jaktraffic_v1/weights/best.pt"
MODEL_DEST = "/tmp/jaktraffic_indonesia.pt"
SERVICE    = "/tmp/gpu_service_v2.py"

# ── Salin model ────────────────────────────────────────────────────────────
if not Path(MODEL_SRC).exists():
    print(f"ERROR: {MODEL_SRC} tidak ditemukan. Jalankan 02_train.py dulu.")
    exit(1)

shutil.copy2(MODEL_SRC, MODEL_DEST)
print(f"[OK] Model disalin ke {MODEL_DEST}")

# ── Patch gpu_service_v2.py agar pakai model baru ─────────────────────────
with open(SERVICE) as f:
    code = f.read()

# Ganti path model di service
old_line = 'MODEL_PATH = "yolo11l.pt"'
new_line = f'MODEL_PATH = "{MODEL_DEST}"'

if old_line not in code:
    # Cari pattern alternatif
    import re
    code_new = re.sub(
        r'MODEL_PATH\s*=\s*["\'].*?["\']',
        f'MODEL_PATH = "{MODEL_DEST}"',
        code
    )
else:
    code_new = code.replace(old_line, new_line)

with open(SERVICE, "w") as f:
    f.write(code_new)

print(f"[OK] {SERVICE} diupdate untuk pakai {MODEL_DEST}")

# ── Reload service (kill + restart) ───────────────────────────────────────
print("\n[RESTART] Merestart GPU service...")
subprocess.run(["pkill", "-f", "gpu_service_v2.py"], capture_output=True)
time.sleep(2)

proc = subprocess.Popen(
    ["python3", SERVICE],
    stdout=open("/tmp/gpu_service_v2.log", "a"),
    stderr=subprocess.STDOUT,
)
time.sleep(5)
print(f"[OK] GPU service restart — PID {proc.pid}")

# ── Quick test ─────────────────────────────────────────────────────────────
import requests
try:
    r = requests.get("http://localhost:8765/health", timeout=5)
    data = r.json()
    print(f"\n[TEST] Service health: {data}")
    print(f"  Model: {data.get('model_path', '?')}")
    print(f"  Classes: {data.get('classes', [])}")
    print("\nDeploy selesai! Model Indonesia aktif.")
except Exception as e:
    print(f"[WARN] Health check gagal: {e} — cek log di /tmp/gpu_service_v2.log")
