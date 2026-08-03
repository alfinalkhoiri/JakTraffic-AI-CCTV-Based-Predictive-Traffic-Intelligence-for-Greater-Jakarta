#!/usr/bin/env python3
"""
pseudo_label.py — Auto-label dataset JakTraffic menggunakan jaktraffic_yolo.pt

Cara pakai:
  # Di GPU server (setelah rsync dataset):
  python pseudo_label.py --model jaktraffic_yolo.pt --dataset ./dataset --batch 32

  # Di SG VPS (CPU, lebih lambat):
  python pseudo_label.py --model ../backend/models/jaktraffic_yolo.pt --dataset ../backend/dataset

  # Rsync dataset ke GPU server dulu:
  rsync -avz --progress root@jaktrafficai.f-mc.my.id:/var/www/JakTraffic-AI-CCTV-Based-Predictive-Traffic-Intelligence-for-Greater-Jakarta/backend/dataset/ ./dataset/

  # Setelah pseudo-label selesai, kirim labels balik:
  rsync -avz --progress ./dataset/labels/ root@jaktrafficai.f-mc.my.id:/var/www/JakTraffic-AI-CCTV-Based-Predictive-Traffic-Intelligence-for-Greater-Jakarta/backend/dataset/labels/
"""

import os
import sys
import time
import argparse
import shutil
from pathlib import Path

try:
    from tqdm import tqdm
except ImportError:
    class tqdm:
        def __init__(self, iterable, **kw): self.iterable = iterable; self.desc = kw.get('desc','')
        def __iter__(self): return iter(self.iterable)
        def set_postfix(self, **kw): pass


def parse_args():
    p = argparse.ArgumentParser(description='Pseudo-label dataset dengan jaktraffic_yolo.pt')
    p.add_argument('--model',    default='../backend/models/jaktraffic_yolo.pt',
                   help='Path ke model .pt')
    p.add_argument('--dataset',  default='../backend/dataset',
                   help='Root dataset (berisi images/train, images/val, labels/train, labels/val)')
    p.add_argument('--conf',     type=float, default=0.20,
                   help='Confidence threshold (default: 0.20 — lebih recall untuk training)')
    p.add_argument('--iou',      type=float, default=0.45,
                   help='NMS IoU threshold')
    p.add_argument('--imgsz',    type=int,   default=640,
                   help='Image size untuk inference (640 = kualitas lebih baik dari training)')
    p.add_argument('--batch',    type=int,   default=16,
                   help='Batch size (GPU: 32-64, CPU: 1)')
    p.add_argument('--device',   default='',
                   help='Device: "cuda", "cpu", "cuda:0" (default: auto-detect)')
    p.add_argument('--overwrite', action='store_true', default=True,
                   help='Overwrite label yang sudah ada dengan hasil model lebih baik')
    p.add_argument('--no-overwrite', dest='overwrite', action='store_false',
                   help='Skip gambar yang sudah punya label')
    p.add_argument('--splits',   nargs='+', default=['train', 'val'],
                   help='Split yang diproses (default: train val)')
    p.add_argument('--dry-run',  action='store_true',
                   help='Test tanpa menulis label')
    return p.parse_args()


def update_yaml(dataset_path: Path, class_names: dict):
    """Update dataset.yaml dengan 10 kelas Indonesia."""
    nc    = len(class_names)
    names = [class_names[i] for i in range(nc)]
    yaml  = dataset_path / 'dataset.yaml'

    content = f"""# JakTraffic Dataset — Auto-labeled dengan jaktraffic_yolo.pt
# Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}
path: {dataset_path}
train: images/train
val:   images/val

nc: {nc}
names: {names}
"""
    yaml.write_text(content)
    print(f"[OK] dataset.yaml diperbarui → {nc} kelas: {names}")


def process_split(model, split: str, dataset_path: Path, args, class_counts: dict) -> dict:
    img_dir = dataset_path / 'images' / split
    lbl_dir = dataset_path / 'labels' / split

    if not img_dir.exists():
        print(f"[SKIP] {img_dir} tidak ditemukan")
        return {}

    lbl_dir.mkdir(parents=True, exist_ok=True)

    images = sorted(list(img_dir.glob('*.jpg')) + list(img_dir.glob('*.png')))
    if not images:
        print(f"[SKIP] {split}: tidak ada gambar")
        return {}

    print(f"\n── {split.upper()} ── {len(images):,} gambar")

    stats = {'total': 0, 'labeled': 0, 'empty': 0, 'skipped': 0, 'error': 0}
    batch_size = max(1, args.batch)

    for i in tqdm(range(0, len(images), batch_size), desc=f'  {split}'):
        batch_imgs = images[i : i + batch_size]
        lbl_paths  = [lbl_dir / (img.stem + '.txt') for img in batch_imgs]

        # Filter jika tidak overwrite
        if not args.overwrite:
            pairs = [(img, lbl) for img, lbl in zip(batch_imgs, lbl_paths)
                     if not lbl.exists()]
            skipped = len(batch_imgs) - len(pairs)
            stats['skipped'] += skipped
            if not pairs:
                continue
            batch_imgs, lbl_paths = zip(*pairs)

        try:
            results = model(
                [str(img) for img in batch_imgs],
                conf    = args.conf,
                iou     = args.iou,
                imgsz   = args.imgsz,
                device  = args.device,
                verbose = False,
                stream  = False,
            )

            for result, lbl_path in zip(results, lbl_paths):
                stats['total'] += 1
                boxes = result.boxes

                if boxes is None or len(boxes) == 0:
                    if not args.dry_run:
                        lbl_path.write_text('')
                    stats['empty'] += 1
                    continue

                lines = []
                for box in boxes:
                    cls_id      = int(box.cls[0])
                    cx, cy, w, h = box.xywhn[0].tolist()
                    conf_val    = float(box.conf[0])
                    lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
                    class_counts[cls_id] = class_counts.get(cls_id, 0) + 1

                if not args.dry_run:
                    lbl_path.write_text('\n'.join(lines))
                stats['labeled'] += 1

        except Exception as e:
            print(f"\n[ERROR] batch {i}: {e}")
            stats['error'] += len(batch_imgs)

    return stats


def main():
    args = parse_args()

    import torch
    from ultralytics import YOLO

    # Auto-detect device
    if not args.device:
        args.device = 'cuda' if torch.cuda.is_available() else 'cpu'

    print(f"{'='*55}")
    print(f"  JakTraffic Pseudo-Labeling")
    print(f"{'='*55}")
    print(f"  Device   : {args.device}")
    print(f"  Model    : {args.model}")
    print(f"  Dataset  : {args.dataset}")
    print(f"  Conf     : {args.conf}  |  IoU: {args.iou}  |  imgSz: {args.imgsz}")
    print(f"  Batch    : {args.batch}  |  Overwrite: {args.overwrite}")
    print(f"  Dry-run  : {args.dry_run}")
    print(f"{'='*55}\n")

    model_path   = Path(args.model).resolve()
    dataset_path = Path(args.dataset).resolve()

    if not model_path.exists():
        print(f"[ERROR] Model tidak ditemukan: {model_path}")
        sys.exit(1)
    if not dataset_path.exists():
        print(f"[ERROR] Dataset tidak ditemukan: {dataset_path}")
        sys.exit(1)

    print(f"[INFO] Loading model...")
    model       = YOLO(str(model_path))
    class_names = model.names
    nc          = len(class_names)
    print(f"[OK]   {nc} kelas: {[class_names[i] for i in range(nc)]}")

    if args.device == 'cuda':
        import torch
        vram = torch.cuda.get_device_properties(0).total_memory / 1e9
        gpu  = torch.cuda.get_device_name(0)
        print(f"[GPU]  {gpu} — {vram:.1f} GB VRAM")
        if args.batch == 16:
            # Auto-scale batch dari VRAM
            recommended = min(64, max(16, int(vram / 1.5)))
            print(f"[AUTO] Batch size → {recommended} (dari VRAM {vram:.0f}GB)")
            args.batch = recommended

    t0 = time.time()
    class_counts: dict = {}
    all_stats: dict    = {}

    for split in args.splits:
        s = process_split(model, split, dataset_path, args, class_counts)
        if s:
            all_stats[split] = s

    elapsed = time.time() - t0

    # Update dataset.yaml
    if not args.dry_run:
        update_yaml(dataset_path, class_names)

    # Ringkasan
    total     = sum(s.get('total', 0)   for s in all_stats.values())
    labeled   = sum(s.get('labeled', 0) for s in all_stats.values())
    empty     = sum(s.get('empty', 0)   for s in all_stats.values())
    skipped   = sum(s.get('skipped', 0) for s in all_stats.values())
    errors    = sum(s.get('error', 0)   for s in all_stats.values())
    total_box = sum(class_counts.values())

    print(f"\n{'='*55}")
    print(f"  SELESAI dalam {elapsed/60:.1f} menit")
    print(f"{'='*55}")
    print(f"  Diproses  : {total:,}")
    print(f"  Berlabel  : {labeled:,}  ({labeled/max(total,1)*100:.1f}%)")
    print(f"  Kosong    : {empty:,}   ({empty/max(total,1)*100:.1f}%)")
    print(f"  Diskip    : {skipped:,}")
    print(f"  Error     : {errors:,}")
    print(f"  Total box : {total_box:,}")
    print(f"\n  Distribusi kelas:")
    for cls_id in sorted(class_counts, key=lambda x: -class_counts[x]):
        name  = class_names.get(cls_id, str(cls_id))
        count = class_counts[cls_id]
        bar   = '█' * min(30, count // max(1, total_box // 300))
        print(f"    {name:12s} {count:6,}  {bar}")

    print(f"\n  Dataset YAML: {dataset_path / 'dataset.yaml'}")
    if labeled < 5000:
        print(f"\n  ⚠  Labeled frames masih {labeled:,} — pertimbangkan lanjut collect data")
    elif labeled < 15000:
        print(f"\n  ⚡ {labeled:,} labeled frames — cukup untuk YOLO11s/m, YOLO11x butuh lebih")
    else:
        print(f"\n  ✅ {labeled:,} labeled frames — siap fine-tune YOLO11x!")
    print(f"{'='*55}")


if __name__ == '__main__':
    main()
