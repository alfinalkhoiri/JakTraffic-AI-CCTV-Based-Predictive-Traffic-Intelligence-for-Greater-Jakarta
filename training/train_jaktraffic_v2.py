#!/usr/bin/env python3
"""
train_jaktraffic_v2.py — Fine-tune lanjutan dari jaktraffic_yolo.pt
Diunduh dan dijalankan oleh GPU pod via /train/start endpoint.

Alur:
  1. Download dataset zip dari backend /api/dataset/zip
  2. Fine-tune dari existing Indonesia model (bukan dari scratch)
  3. Upload best.pt ke backend via /api/model/upload
"""
import argparse, os, sys, time, zipfile, io, subprocess
from pathlib import Path

BACKEND_URL = "https://jaktrafficai.f-mc.my.id"

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

parser = argparse.ArgumentParser()
parser.add_argument("--dataset", default="/home/jovyan/jaktraffic_dataset")
parser.add_argument("--batch",   default="16", type=int)
args = parser.parse_args()

DATASET_DIR = Path(args.dataset)
EPOCHS      = 80
IMGSZ       = 640

# ── Install deps ─────────────────────────────────────────────────────────────
try:
    from ultralytics import YOLO
    import torch
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q",
                           "ultralytics", "requests"])
    from ultralytics import YOLO
    import torch
    import requests

import torch._dynamo
import torch.multiprocessing
torch._dynamo.disable()
torch.multiprocessing.set_sharing_strategy("file_system")

# ── Download dataset dari backend ─────────────────────────────────────────────
if not (DATASET_DIR / "dataset.yaml").exists():
    log(f"Downloading dataset dari {BACKEND_URL}/api/dataset/zip ...")
    DATASET_DIR.mkdir(parents=True, exist_ok=True)
    r = requests.get(f"{BACKEND_URL}/api/dataset/zip", stream=True, timeout=600)
    r.raise_for_status()
    total = int(r.headers.get("content-length", 0))
    downloaded = 0
    buf = io.BytesIO()
    for chunk in r.iter_content(chunk_size=1024 * 1024):
        buf.write(chunk)
        downloaded += len(chunk)
        if total:
            log(f"  {downloaded/1e6:.1f}/{total/1e6:.1f} MB ({downloaded*100//total}%)")
    buf.seek(0)
    log("Mengekstrak dataset ...")
    with zipfile.ZipFile(buf) as zf:
        zf.extractall(DATASET_DIR)
    log(f"Dataset siap di {DATASET_DIR}")
else:
    log(f"Dataset sudah ada di {DATASET_DIR}")

# Update path di dataset.yaml agar sesuai lokasi pod
yaml_path = DATASET_DIR / "dataset.yaml"
yaml_text = yaml_path.read_text()
# Ganti path absolut lama dengan path pod
import re
yaml_text = re.sub(r"^path:.*$", f"path: {DATASET_DIR}", yaml_text, flags=re.MULTILINE)
yaml_path.write_text(yaml_text)
log(f"dataset.yaml diperbarui: path={DATASET_DIR}")

# Hitung stats dataset
n_train = len(list((DATASET_DIR/"images"/"train").glob("*.jpg")))
n_val   = len(list((DATASET_DIR/"images"/"val").glob("*.jpg")))
log(f"Dataset: train={n_train} val={n_val}")
if n_train < 100:
    log("ERROR: terlalu sedikit gambar training!")
    sys.exit(1)

# ── Load base model ───────────────────────────────────────────────────────────
# Prioritaskan jaktraffic_yolo11x.pt (110MB, Indonesia model penuh)
# bukan jaktraffic_yolo.pt yang mungkin hasil training sebelumnya (lebih kecil)
BASE_CANDIDATES = [
    "/home/jovyan/jaktraffic_yolo11x.pt",
    "/tmp/jaktraffic_yolo11x.pt",
    "/home/jovyan/jaktraffic_pseudo/jaktraffic_yolo11x.pt",
    "/home/jovyan/jaktraffic_yolo.pt",
    "/tmp/jaktraffic_yolo.pt",
]
base_model_path = next((p for p in BASE_CANDIDATES if os.path.exists(p) and os.path.getsize(p) > 50_000_000), None)
if not base_model_path:
    # Cek juga file kecil sebagai last resort
    base_model_path = next((p for p in BASE_CANDIDATES if os.path.exists(p)), None)

if base_model_path:
    size_mb = os.path.getsize(base_model_path) / 1e6
    log(f"Fine-tune dari: {base_model_path} ({size_mb:.0f} MB)")
    if size_mb < 50:
        log("PERINGATAN: Model base lebih kecil dari 50MB — bukan YOLO11x penuh!")
else:
    log("Model Indonesia tidak ditemukan — download jaktraffic_yolo11x.pt dari backend ...")
    # Download model Indonesia asli (bukan hasil training sebelumnya)
    r = requests.get(f"{BACKEND_URL}/api/yolo-model/download/base", stream=True, timeout=300)
    if r.status_code == 200:
        base_model_path = "/tmp/jaktraffic_yolo11x.pt"
        downloaded = 0
        with open(base_model_path, "wb") as f:
            for chunk in r.iter_content(1024*1024):
                f.write(chunk)
                downloaded += len(chunk)
        log(f"Model diunduh: {base_model_path} ({downloaded/1e6:.0f} MB)")
    else:
        log(f"Download base gagal ({r.status_code}) — fallback ke yolo11x.pt dari Ultralytics")
        base_model_path = "yolo11x.pt"

# GPU info
device   = 0 if torch.cuda.is_available() else "cpu"
vram_gb  = torch.cuda.get_device_properties(0).total_memory / 1e9 if device == 0 else 0
batch    = args.batch if device == 0 else 4
run_name = f"jaktraffic_v2_{time.strftime('%Y%m%d_%H%M')}"

log(f"GPU: {torch.cuda.get_device_name(0) if device==0 else 'CPU'} | VRAM: {vram_gb:.0f}GB | batch={batch}")
log(f"Epochs={EPOCHS} imgsz={IMGSZ} run={run_name}")

# ── Training ──────────────────────────────────────────────────────────────────
model = YOLO(base_model_path)
results = model.train(
    data    = str(yaml_path),
    epochs  = EPOCHS,
    imgsz   = IMGSZ,
    batch   = batch,
    device  = device,
    project = "/tmp/jak_runs",
    name    = run_name,

    # Optimizer — SGD lebih stabil di pod
    optimizer    = "SGD",
    lr0          = 0.005,     # Lebih kecil untuk fine-tune (bukan scratch)
    lrf          = 0.01,
    momentum     = 0.937,
    weight_decay = 0.0005,

    # Warmup
    warmup_epochs   = 2,
    warmup_momentum = 0.8,
    warmup_bias_lr  = 0.05,

    # Early stopping
    patience = 20,

    # Augmentation — mosaic & copy-paste bantu kelas langka (angkot, bajaj, becak)
    hsv_h      = 0.015,
    hsv_s      = 0.7,
    hsv_v      = 0.4,
    fliplr     = 0.5,
    mosaic     = 1.0,
    mixup      = 0.1,
    copy_paste = 0.3,   # Lebih tinggi — kelas langka butuh augmentasi lebih
    scale      = 0.5,
    translate  = 0.1,

    # Loss
    box = 7.5,
    cls = 0.5,
    dfl = 1.5,

    # Checkpoint
    save        = True,
    save_period = 10,
    val         = True,
    plots       = True,
    workers     = 0,   # pod Kubernetes: 0 = no shm issue
    cache       = False,
    verbose     = True,
)

# ── Hasil ─────────────────────────────────────────────────────────────────────
best_pt = Path("/tmp/jak_runs") / run_name / "weights" / "best.pt"
log(f"\nTraining selesai! Best model: {best_pt}")

rd = results.results_dict
log(f"mAP50    : {rd.get('metrics/mAP50(B)', 0):.4f}")
log(f"mAP50-95 : {rd.get('metrics/mAP50-95(B)', 0):.4f}")
log(f"Precision: {rd.get('metrics/precision(B)', 0):.4f}")
log(f"Recall   : {rd.get('metrics/recall(B)', 0):.4f}")

# ── Upload model ke backend ───────────────────────────────────────────────────
log(f"\nUploading model ke backend {BACKEND_URL}/api/model/upload ...")
with open(best_pt, "rb") as f:
    r = requests.post(
        f"{BACKEND_URL}/api/yolo-model/upload",
        files={"model": ("jaktraffic_yolo11x.pt", f, "application/octet-stream")},
        data={"token": "jaktraffic2026",
              "run_name": run_name,
              "map50": str(rd.get("metrics/mAP50(B)", 0)),
              "map50_95": str(rd.get("metrics/mAP50-95(B)", 0))},
        timeout=300,
    )
if r.status_code == 200:
    log(f"Model berhasil diupload! {r.json()}")
else:
    log(f"Upload gagal ({r.status_code}): {r.text[:200]}")
    log(f"Copy manual: scp pod:{best_pt} vps:/backend/models/jaktraffic_yolo11x.pt")

log("DONE")
