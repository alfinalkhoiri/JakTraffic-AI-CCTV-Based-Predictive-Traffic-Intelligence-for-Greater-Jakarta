#!/usr/bin/env python3
"""
Re-label dataset via GPU pod /detect-boxes endpoint.
Jauh lebih cepat dari CPU — L40S 48GB bisa proses ratusan frame/menit.

Estimasi: 9k gambar × 16 parallel workers ≈ 20-30 menit
"""

import os, sys, time, base64, requests, threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter

ROOT        = Path(__file__).parent.parent.parent
DATASET_DIR = ROOT / "backend" / "dataset"
CONF_THRESH  = 0.35
MIN_BOX_AREA = 0.003
MAX_WORKERS  = 16   # paralel HTTP ke GPU pod

INDO_TO_LOCAL = {0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 9: 8}
CLASS_NAMES   = ["car", "motor", "bus", "truck", "angkot", "bajaj", "becak", "bicycle", "gerobak"]


def get_gpu_url() -> str:
    """Ambil URL GPU pod dari backend."""
    try:
        r = requests.get("https://jaktrafficai.f-mc.my.id/api/gpu-status", timeout=5)
        return r.json().get("url", "")
    except Exception:
        pass
    # fallback: baca dari detector
    sys.path.insert(0, str(ROOT / "backend"))
    from core.detector import get_gpu_url as _gu
    return _gu() or ""


def detect_boxes_gpu(gpu_url: str, img_path: Path) -> list[str] | None:
    """Kirim 1 gambar ke GPU pod, return list label YOLO."""
    try:
        with open(img_path, "rb") as f:
            img_bytes = f.read()
        r = requests.post(
            f"{gpu_url}/detect-boxes",
            files={"file": ("frame.jpg", img_bytes, "image/jpeg")},
            data={"conf": CONF_THRESH},
            timeout=15,
        )
        if r.status_code != 200:
            return None
        boxes = r.json().get("boxes", [])
        lines = []
        for box in boxes:
            local = INDO_TO_LOCAL.get(box.get("cls_id", -1))
            if local is None:
                continue
            cx, cy = box.get("cx", 0), box.get("cy", 0)
            bw, bh = box.get("bw", 0), box.get("bh", 0)
            if bw * bh < MIN_BOX_AREA:
                continue
            if box.get("conf", 0) < CONF_THRESH:
                continue
            lines.append(f"{local} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
        return lines
    except Exception:
        return None


def relabel_split(split: str, gpu_url: str, lock: threading.Lock,
                  counters: dict) -> int:
    img_dir   = DATASET_DIR / "images" / split
    label_dir = DATASET_DIR / "labels" / split
    label_dir.mkdir(parents=True, exist_ok=True)

    imgs = sorted(img_dir.glob("*.jpg"))
    if not imgs:
        return 0

    print(f"[{split:5s}] {len(imgs):,} gambar | {MAX_WORKERS} worker paralel")
    t0   = time.time()
    done = 0

    def _process(img_path: Path):
        label_path = label_dir / (img_path.stem + ".txt")
        labels = detect_boxes_gpu(gpu_url, img_path)

        if labels is None:
            # GPU gagal → pertahankan label lama (jangan hapus)
            return "skip"

        label_path.write_text("\n".join(labels))
        return "ok_obj" if labels else "ok_empty"

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(_process, p): p for p in imgs}
        for fut in as_completed(futs):
            result = fut.result()
            with lock:
                counters[result] = counters.get(result, 0) + 1
                done = counters.get("ok_obj", 0) + counters.get("ok_empty", 0)
                total_done = done + counters.get("skip", 0)
                pct  = total_done * 100 // len(imgs)
                rate = total_done / max(time.time() - t0, 1)
                eta  = (len(imgs) - total_done) / max(rate, 0.1)
                print(f"  [{split}] {total_done:,}/{len(imgs):,} ({pct}%) "
                      f"| {rate:.1f} img/s | ETA {eta/60:.1f} mnt | "
                      f"skip={counters.get('skip',0)}", end="\r", flush=True)

    elapsed = time.time() - t0
    ok      = counters.get("ok_obj", 0) + counters.get("ok_empty", 0)
    skip    = counters.get("skip", 0)
    print(f"\n  [{split}] SELESAI {ok:,} re-label | skip={skip} | {elapsed/60:.1f} mnt")
    return ok


def main():
    gpu_url = get_gpu_url()
    if not gpu_url:
        print("ERROR: GPU URL tidak ditemukan. Pastikan GPU pod online.")
        sys.exit(1)

    # Test koneksi ke /detect-boxes
    try:
        r = requests.get(f"{gpu_url}/health", timeout=5)
        print(f"[GPU] Terhubung: {gpu_url}")
        print(f"[GPU] Status: {r.json()}")
    except Exception as e:
        print(f"ERROR: Tidak bisa reach GPU pod: {e}")
        sys.exit(1)

    print()
    lock     = threading.Lock()
    counters = {}

    t_start = time.time()
    for split in ("train", "val"):
        counters.clear()
        relabel_split(split, gpu_url, lock, counters)

    total_time = time.time() - t_start

    # Update dataset.yaml
    yaml_path = DATASET_DIR / "dataset.yaml"
    yaml_path.write_text(f"""# JakTraffic Dataset — Re-labeled via GPU pod (Indonesia model)
path: {DATASET_DIR}
train: images/train
val:   images/val

nc: {len(CLASS_NAMES)}
names: {CLASS_NAMES}
""")

    # Distribusi kelas final
    print()
    print("=" * 55)
    print("DISTRIBUSI KELAS AKHIR")
    print("=" * 55)
    cls_counts = Counter()
    for split in ("train", "val"):
        for lf in (DATASET_DIR / "labels" / split).glob("*.txt"):
            for line in lf.read_text().splitlines():
                if line.strip():
                    cls_counts[int(line.split()[0])] += 1

    total_box = sum(cls_counts.values())
    for cls_id in sorted(cls_counts):
        name  = CLASS_NAMES[cls_id] if cls_id < len(CLASS_NAMES) else f"cls{cls_id}"
        count = cls_counts[cls_id]
        bar   = "█" * (count * 30 // max(total_box, 1))
        print(f"  {cls_id} {name:8s} {count:6,}  {bar}")

    n_train = len(list((DATASET_DIR / "images" / "train").glob("*.jpg")))
    n_val   = len(list((DATASET_DIR / "images" / "val").glob("*.jpg")))
    n_obj   = sum(1 for lf in (DATASET_DIR / "labels" / "train").glob("*.txt")
                  if lf.stat().st_size > 0)
    print()
    print(f"  Total frame : {n_train + n_val:,} (train={n_train:,} val={n_val:,})")
    print(f"  Ada kendaraan: {n_obj:,} ({n_obj*100//(n_train or 1)}% dari train)")
    print(f"  Total box   : {total_box:,}")
    print(f"  Waktu total : {total_time/60:.1f} menit")
    print()
    print("Re-labeling SELESAI — dataset siap untuk training!")


if __name__ == "__main__":
    main()
