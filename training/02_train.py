"""
JakTraffic — Step 2: Fine-tune YOLO11l dengan dataset kendaraan Indonesia

Jalankan di GPU server (103.125.91.79) setelah 01_download_datasets.py selesai.
Estimasi waktu: 1-2 jam (50 epoch, L40S GPU)
Output: /tmp/jaktraffic_training/weights/best.pt
"""

from ultralytics import YOLO
from pathlib import Path
import torch, yaml

DATASET_YAML = "/tmp/jaktraffic_dataset/data.yaml"
OUTPUT_DIR   = "/tmp/jaktraffic_training"
BASE_MODEL   = "yolo11l.pt"   # pretrained COCO — fine-tuning dari sini

# ── Cek GPU ────────────────────────────────────────────────────────────────
print(f"CUDA available : {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU            : {torch.cuda.get_device_name(0)}")
    print(f"VRAM           : {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

# ── Cek dataset ────────────────────────────────────────────────────────────
if not Path(DATASET_YAML).exists():
    print(f"ERROR: Dataset belum ada. Jalankan 01_download_datasets.py dulu.")
    exit(1)

with open(DATASET_YAML) as f:
    info = yaml.safe_load(f)
print(f"\nDataset        : {DATASET_YAML}")
print(f"Classes ({info['nc']}): {info['names']}")

# ── Load model ─────────────────────────────────────────────────────────────
print(f"\nLoading base model: {BASE_MODEL}")
model = YOLO(BASE_MODEL)

# ── Training config ────────────────────────────────────────────────────────
# L40S 44GB VRAM → batch 32 aman, image size 640
TRAIN_CONFIG = dict(
    data        = DATASET_YAML,
    epochs      = 60,
    imgsz       = 640,
    batch       = 32,
    device      = 0,             # GPU 0
    workers     = 8,
    project     = OUTPUT_DIR,
    name        = "jaktraffic_v1",
    exist_ok    = True,
    # Augmentasi — berguna karena dataset kecil
    hsv_h       = 0.015,
    hsv_s       = 0.7,
    hsv_v       = 0.4,
    degrees     = 5.0,           # rotasi kecil (kamera CCTV agak miring)
    translate   = 0.1,
    scale       = 0.5,
    flipud      = 0.0,           # kendaraan tidak terbalik
    fliplr      = 0.5,
    mosaic      = 1.0,           # mosaic augmentation — sangat membantu dataset kecil
    mixup       = 0.1,
    # Optimizer
    optimizer   = "AdamW",
    lr0         = 0.001,
    lrf         = 0.01,
    warmup_epochs = 3,
    # Early stopping — hentikan jika tidak ada improvement
    patience    = 20,
    # Transfer learning — freeze backbone 10 layer pertama (COCO knowledge)
    freeze      = 10,
    # Logging
    verbose     = True,
    save_period = 10,            # simpan checkpoint tiap 10 epoch
)

print("\n=== Mulai Training ===")
print(f"Epochs  : {TRAIN_CONFIG['epochs']}")
print(f"Batch   : {TRAIN_CONFIG['batch']}")
print(f"ImgSize : {TRAIN_CONFIG['imgsz']}")
print(f"Freeze  : backbone {TRAIN_CONFIG['freeze']} layer")
print(f"Output  : {OUTPUT_DIR}/jaktraffic_v1/weights/best.pt")
print()

results = model.train(**TRAIN_CONFIG)

# ── Evaluasi ───────────────────────────────────────────────────────────────
print("\n=== Evaluasi Model ===")
metrics = model.val(data=DATASET_YAML, device=0)
print(f"mAP50   : {metrics.box.map50:.4f}")
print(f"mAP50-95: {metrics.box.map:.4f}")
print(f"Precision: {metrics.box.mp:.4f}")
print(f"Recall   : {metrics.box.mr:.4f}")

best_path = f"{OUTPUT_DIR}/jaktraffic_v1/weights/best.pt"
print(f"\nModel tersimpan di: {best_path}")
print("Jalankan 03_deploy.py untuk deploy ke GPU service")
