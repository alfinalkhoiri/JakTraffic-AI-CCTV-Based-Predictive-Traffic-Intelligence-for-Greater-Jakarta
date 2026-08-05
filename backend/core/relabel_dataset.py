#!/usr/bin/env python3
"""
Re-label seluruh dataset dengan Indonesia model mapping yang benar.
Jalankan sekali untuk memperbaiki dataset yang dikumpulkan sebelum fix INDO_TO_LOCAL.

Sebelumnya: COCO_TO_LOCAL {2:0, 3:1, 5:2, 7:3} — salah total untuk model Indonesia
Sekarang:   INDO_TO_LOCAL {0:0, 1:1, 2:2, ..., 7:7, 9:8} — sesuai jaktraffic_yolo11x.pt
"""

import os, sys, time
from pathlib import Path

# Pastikan dijalankan dari root project
ROOT = Path(__file__).parent.parent.parent
os.chdir(ROOT)

DATASET_DIR = ROOT / "backend" / "dataset"
MODEL_PATH  = ROOT / "backend" / "models" / "jaktraffic_yolo11x.pt"
CONF_THRESH  = 0.35
MIN_BOX_AREA = 0.003
BATCH_SIZE   = 16  # CPU-safe batch size

# Indonesia model: class ID → dataset class ID (skip person=8)
INDO_TO_LOCAL = {0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 9: 8}
VEHICLE_CLS   = list(INDO_TO_LOCAL.keys())
CLASS_NAMES   = ["car", "motor", "bus", "truck", "angkot", "bajaj", "becak", "bicycle", "gerobak"]

print(f"[Relabel] Model : {MODEL_PATH}")
print(f"[Relabel] Dataset: {DATASET_DIR}")
print(f"[Relabel] conf={CONF_THRESH}, min_box={MIN_BOX_AREA}, batch={BATCH_SIZE}")
print()

try:
    from ultralytics import YOLO
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "ultralytics"])
    from ultralytics import YOLO

import torch
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"[Relabel] Loading model pada {device.upper()} ...")
model = YOLO(str(MODEL_PATH))
model.to(device)
print(f"[Relabel] Model OK — nc={model.model.nc}, kelas: {[model.names[i] for i in VEHICLE_CLS]}")
print()


def relabel_split(split: str) -> dict:
    img_dir   = DATASET_DIR / "images" / split
    label_dir = DATASET_DIR / "labels" / split
    label_dir.mkdir(parents=True, exist_ok=True)

    imgs = sorted(img_dir.glob("*.jpg"))
    if not imgs:
        print(f"[{split:5s}] (kosong, skip)")
        return {"total": 0, "with_obj": 0, "empty": 0, "boxes": 0}

    print(f"[{split:5s}] {len(imgs):,} gambar → mulai re-label ...")
    t0 = time.time()

    total_boxes = 0
    with_obj    = 0
    done        = 0

    for i in range(0, len(imgs), BATCH_SIZE):
        batch_paths = imgs[i : i + BATCH_SIZE]
        try:
            results = model(
                [str(p) for p in batch_paths],
                classes=VEHICLE_CLS,
                conf=CONF_THRESH,
                iou=0.45,
                imgsz=640,
                verbose=False,
            )
        except Exception as e:
            print(f"\n  WARN batch {i}: {e}")
            continue

        for path, res in zip(batch_paths, results):
            lines = []
            boxes = res.boxes
            h, w  = res.orig_shape

            if boxes is not None and len(boxes):
                for box in boxes:
                    cls_id = int(box.cls.item())
                    local  = INDO_TO_LOCAL.get(cls_id)
                    if local is None:
                        continue
                    conf = float(box.conf.item())
                    if conf < CONF_THRESH:
                        continue
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    bw = (x2 - x1) / w
                    bh = (y2 - y1) / h
                    if bw * bh < MIN_BOX_AREA:
                        continue
                    cx = ((x1 + x2) / 2) / w
                    cy = ((y1 + y2) / 2) / h
                    lines.append(f"{local} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")

            label_file = label_dir / (path.stem + ".txt")
            label_file.write_text("\n".join(lines))

            if lines:
                with_obj    += 1
                total_boxes += len(lines)

        done += len(batch_paths)
        pct   = done * 100 // len(imgs)
        eta_s = (time.time() - t0) / done * (len(imgs) - done) if done else 0
        print(f"  [{split:5s}] {done:,}/{len(imgs):,} ({pct}%) | ETA {eta_s/60:.1f} mnt", end="\r", flush=True)

    elapsed = time.time() - t0
    empty   = len(imgs) - with_obj
    avg_box = total_boxes / max(with_obj, 1)
    print(f"\n  [{split:5s}] SELESAI {len(imgs):,} label | ada objek: {with_obj:,} | kosong: {empty:,} | avg box: {avg_box:.1f} | {elapsed/60:.1f} mnt")
    return {"total": len(imgs), "with_obj": with_obj, "empty": empty, "boxes": total_boxes}


t_start = time.time()
stats_train = relabel_split("train")
stats_val   = relabel_split("val")
total_time  = time.time() - t_start

print()
print("=" * 60)
print("RINGKASAN RE-LABELING")
print("=" * 60)
for split, s in [("train", stats_train), ("val", stats_val)]:
    if s["total"] == 0:
        continue
    pct_obj = s["with_obj"] * 100 // s["total"]
    print(f"  {split:5s}: {s['total']:,} frame | {s['with_obj']:,} ({pct_obj}%) ada kendaraan | {s['boxes']:,} total box")
print(f"  Waktu total: {total_time/60:.1f} menit")
print()

# Update dataset.yaml dengan kelas Indonesia
yaml_path = DATASET_DIR / "dataset.yaml"
yaml_path.write_text(f"""# JakTraffic Dataset — Re-labeled dengan Indonesia model
path: {DATASET_DIR}
train: images/train
val:   images/val

nc: {len(CLASS_NAMES)}
names: {CLASS_NAMES}
""")
print(f"[Relabel] dataset.yaml diperbarui → {yaml_path}")

# Distribusi kelas akhir
print()
print("[Relabel] Distribusi kelas akhir:")
from collections import Counter
cls_counts = Counter()
for split in ("train", "val"):
    for lf in (DATASET_DIR / "labels" / split).glob("*.txt"):
        for line in lf.read_text().splitlines():
            if line.strip():
                cls_counts[int(line.split()[0])] += 1

for cls_id in sorted(cls_counts):
    name = CLASS_NAMES[cls_id] if cls_id < len(CLASS_NAMES) else f"cls{cls_id}"
    print(f"  {cls_id} ({name:8s}): {cls_counts[cls_id]:,}")

print()
print("[Relabel] SELESAI — siap untuk training!")
