#!/usr/bin/env python3
"""
train_yolo11x.py — Fine-tune YOLO11x dengan dataset JakTraffic Indonesia
Jalankan di GPU server: python train_yolo11x.py
"""
import os
import time
import torch
import torch._dynamo
import torch.multiprocessing
from pathlib import Path
from ultralytics import YOLO

torch._dynamo.disable()                                  # Hindari AttributeError pada pod Kubernetes
torch.multiprocessing.set_sharing_strategy("file_system")  # Hindari /dev/shm penuh di pod


# ── CONFIG ────────────────────────────────────────────────────────────────────
DATA_YAML   = Path("./dataset/dataset.yaml")
BASE_MODEL  = "yolo11x.pt"          # Download otomatis dari Ultralytics
EPOCHS      = 100
IMGSZ       = 640
PROJECT     = "./runs"
RUN_NAME    = f"jaktraffic_yolo11x_{time.strftime('%Y%m%d_%H%M')}"
SG_VPS      = "root@jaktrafficai.f-mc.my.id"
SG_MODEL_PATH = "/var/www/JakTraffic-AI-CCTV-Based-Predictive-Traffic-Intelligence-for-Greater-Jakarta/backend/models/jaktraffic_yolo11x.pt"
# ─────────────────────────────────────────────────────────────────────────────


def get_gpu_info():
    if not torch.cuda.is_available():
        return None, 0
    name   = torch.cuda.get_device_name(0)
    vram   = torch.cuda.get_device_properties(0).total_memory / 1e9
    return name, vram


def auto_batch(vram_gb: float) -> int:
    """Hitung batch size optimal dari VRAM untuk YOLO11x @ 640px."""
    # YOLO11x butuh ~1.5GB/batch-8 di 640px
    b = int(vram_gb / 1.8) // 8 * 8
    return max(8, min(64, b))


def main():
    print("=" * 60)
    print("  JakTraffic — Training YOLO11x")
    print("=" * 60)

    # GPU info
    gpu_name, vram_gb = get_gpu_info()
    if gpu_name:
        batch     = auto_batch(vram_gb)
        device    = 0
        use_cache = False   # RAM cache crash di pod (shm terbatas ~64MB)
        print(f"  GPU    : {gpu_name}")
        print(f"  VRAM   : {vram_gb:.1f} GB")
        print(f"  Batch  : {batch}  |  Cache: {use_cache}")
    else:
        batch, device, use_cache = 4, "cpu", False
        print("  [WARNING] GPU tidak terdeteksi — training CPU sangat lambat")

    print(f"  Model  : {BASE_MODEL}")
    print(f"  Data   : {DATA_YAML}")
    print(f"  Epochs : {EPOCHS}  |  imgsz: {IMGSZ}")
    print("=" * 60 + "\n")

    if not DATA_YAML.exists():
        raise FileNotFoundError(f"dataset.yaml tidak ditemukan: {DATA_YAML}")

    # Load base model (download otomatis jika belum ada)
    model = YOLO(BASE_MODEL)

    # ── TRAINING ──────────────────────────────────────────────────────────────
    results = model.train(
        data    = str(DATA_YAML),
        epochs  = EPOCHS,
        imgsz   = IMGSZ,
        batch   = batch,
        device  = device,
        project = PROJECT,
        name    = RUN_NAME,

        # Optimizer
        optimizer    = "SGD",     # AdamW trigger torch._dynamo bug di pod ini
        lr0          = 0.01,      # SGD butuh LR lebih tinggi dari AdamW
        lrf          = 0.01,
        momentum     = 0.937,
        weight_decay = 0.0005,

        # Warmup
        warmup_epochs   = 3,
        warmup_momentum = 0.8,
        warmup_bias_lr  = 0.1,

        # Early stopping
        patience = 30,

        # Augmentation — mosaic & copy-paste bantu kelas langka (angkot, becak)
        hsv_h      = 0.015,
        hsv_s      = 0.7,
        hsv_v      = 0.4,
        fliplr     = 0.5,
        mosaic     = 1.0,
        mixup      = 0.15,
        copy_paste = 0.2,
        scale      = 0.5,
        translate  = 0.1,

        # Loss weights
        box = 7.5,
        cls = 0.5,
        dfl = 1.5,

        # Checkpoint & eval
        save        = True,
        save_period = 10,
        val         = True,
        plots       = True,
        workers     = 0,   # 0 = main process, nol shm usage
        cache       = use_cache,
        verbose     = True,
    )

    # ── HASIL ─────────────────────────────────────────────────────────────────
    best_pt = Path(PROJECT) / RUN_NAME / "weights" / "best.pt"

    print("\n" + "=" * 60)
    print("  TRAINING SELESAI")
    print("=" * 60)
    print(f"  Best model : {best_pt}")
    rd = results.results_dict
    print(f"  mAP50      : {rd.get('metrics/mAP50(B)', 0):.4f}")
    print(f"  mAP50-95   : {rd.get('metrics/mAP50-95(B)', 0):.4f}")
    print(f"  Precision  : {rd.get('metrics/precision(B)', 0):.4f}")
    print(f"  Recall     : {rd.get('metrics/recall(B)', 0):.4f}")

    # ── UPLOAD KE SG VPS ─────────────────────────────────────────────────────
    print(f"\n[UPLOAD] Mengirim model ke SG VPS...")
    ret = os.system(
        f"rsync -avz {best_pt} {SG_VPS}:{SG_MODEL_PATH}"
    )
    if ret == 0:
        print(f"[OK] Model tersimpan → backend/models/jaktraffic_yolo11x.pt")
        print(f"     Aktifkan di backend dengan update detektor atau via Admin → GPU tab")
    else:
        print(f"[WARN] Upload gagal. Copy manual:\n  rsync -avz {best_pt} {SG_VPS}:{SG_MODEL_PATH}")

    print("=" * 60)


if __name__ == "__main__":
    main()
