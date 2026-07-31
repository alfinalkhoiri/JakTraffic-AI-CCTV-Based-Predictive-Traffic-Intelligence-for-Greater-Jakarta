"""
JakTraffic — Step 1: Download & merge dataset kendaraan Indonesia dari Roboflow

Dataset yang digunakan:
  A) DKI3 (Irfan Maulana)  — ~5000 gambar — angkot, becak, motor, mobil, truk
  B) SiangTapiFishEye (Dwi Ahmad) — 596 gambar — angkot, bajaj, sudut CCTV
  C) Kendaraan (Julia)     — ~200 gambar — angkot, bajaj, becak (lengkap)

Output: /tmp/jaktraffic_dataset/  (format YOLOv8, siap train)

Jalankan di GPU server (103.125.91.79) via Jupyter atau SSH.
Butuh: pip install roboflow ultralytics
"""

import os, shutil, yaml
from pathlib import Path

# ── GANTI INI DENGAN API KEY ROBOFLOW GRATIS KAMU ─────────────────────────
# Daftar di https://app.roboflow.com → Settings → API Key
ROBOFLOW_API_KEY = "GANTI_DENGAN_API_KEY_KAMU"
# ──────────────────────────────────────────────────────────────────────────

DEST = Path("/tmp/jaktraffic_dataset")

# Class mapping universal — normalisasi dari semua dataset ke 1 skema
# Key: nama class asli (lowercase) → Value: nama class target
CLASS_MAP = {
    # Kendaraan umum
    "car":        "car",     "mobil":      "car",     "sedan": "car",
    "motorcycle": "motor",   "motor":      "motor",   "sepeda motor": "motor",
    "bus":        "bus",     "bus besar":  "bus",     "bus sedang": "bus",
    "truck":      "truck",   "truk":       "truck",   "truk besar": "truck",
    "truk sedang":"truck",   "pick up":    "truck",   "pickup": "truck",
    "bicycle":    "bicycle", "sepeda":     "bicycle",
    "person":     "person",  "pedestrian": "person",
    # Kendaraan khas Indonesia ← target utama fine-tuning
    "angkot":     "angkot",  "minibus":    "angkot",
    "bajaj":      "bajaj",
    "becak":      "becak",   "becal":      "becak",   "pedicab": "becak",
    "gerobak":    "gerobak", "gerobag":    "gerobak",
    # Abaikan class tidak relevan untuk traffic counting
    "delman": None, "kapal": None, "perahu": None,
    "kereta": None, "plat":  None, "ambulance": None,
}

# Class final yang dipakai (urutan ini = index 0,1,2,...)
FINAL_CLASSES = ["car", "motor", "bus", "truck", "angkot", "bajaj", "becak", "bicycle", "person", "gerobak"]
CLASS_IDX     = {c: i for i, c in enumerate(FINAL_CLASSES)}


def download_datasets():
    from roboflow import Roboflow
    rf = Roboflow(api_key=ROBOFLOW_API_KEY)

    datasets = [
        # (workspace, project, version, alias)
        ("deteksikendaraanindonesia3", "deteksi-kendaraan-indonesia-3", 4, "dki3"),
        ("dwi-ahmad",                 "siangtapifisheye-2-sebelum-kelas", 1, "fisheye"),
        ("julia-yi3tv",               "kendaraan-bziug",                  1, "julia"),
    ]

    raw_dirs = []
    for ws, proj, ver, alias in datasets:
        dest = f"/tmp/rf_raw_{alias}"
        if Path(dest).exists():
            print(f"[SKIP] {alias} sudah ada di {dest}")
        else:
            print(f"[DL] Downloading {alias} ...")
            p = rf.workspace(ws).project(proj)
            p.version(ver).download("yolov8", location=dest)
            print(f"[OK] {alias} → {dest}")
        raw_dirs.append((alias, dest))

    return raw_dirs


def remap_label_file(src_txt: Path, src_classes: list, dest_txt: Path):
    """Remap class indices dari dataset asal ke FINAL_CLASSES."""
    lines_out = []
    with open(src_txt) as f:
        for line in f:
            parts = line.strip().split()
            if not parts:
                continue
            orig_idx = int(parts[0])
            if orig_idx >= len(src_classes):
                continue
            orig_name  = src_classes[orig_idx].lower()
            target     = CLASS_MAP.get(orig_name)
            if target is None:
                continue  # class diabaikan
            new_idx = CLASS_IDX.get(target)
            if new_idx is None:
                continue
            lines_out.append(f"{new_idx} {' '.join(parts[1:])}\n")
    if lines_out:
        dest_txt.parent.mkdir(parents=True, exist_ok=True)
        with open(dest_txt, "w") as f:
            f.writelines(lines_out)
        return True
    return False


def merge_datasets(raw_dirs):
    for split in ("train", "valid", "test"):
        (DEST / split / "images").mkdir(parents=True, exist_ok=True)
        (DEST / split / "labels").mkdir(parents=True, exist_ok=True)

    total_imgs = 0
    for alias, raw_dir in raw_dirs:
        # Baca classes dari data.yaml dataset ini
        yaml_path = Path(raw_dir) / "data.yaml"
        if not yaml_path.exists():
            print(f"[WARN] {alias}: data.yaml tidak ditemukan, skip")
            continue
        with open(yaml_path) as f:
            info     = yaml.safe_load(f)
        src_classes  = info.get("names", [])
        print(f"\n[MERGE] {alias} — {len(src_classes)} classes: {src_classes}")

        for split in ("train", "valid", "test"):
            img_dir = Path(raw_dir) / split / "images"
            lbl_dir = Path(raw_dir) / split / "labels"
            if not img_dir.exists():
                continue
            for img_path in img_dir.glob("*.*"):
                lbl_path = lbl_dir / (img_path.stem + ".txt")
                if not lbl_path.exists():
                    continue
                dest_img = DEST / split / "images" / f"{alias}_{img_path.name}"
                dest_lbl = DEST / split / "labels" / f"{alias}_{img_path.stem}.txt"
                if remap_label_file(lbl_path, src_classes, dest_lbl):
                    shutil.copy2(img_path, dest_img)
                    total_imgs += 1

    print(f"\n[DONE] Total gambar di-merge: {total_imgs}")


def write_yaml():
    data = {
        "path":  str(DEST),
        "train": "train/images",
        "val":   "valid/images",
        "test":  "test/images",
        "nc":    len(FINAL_CLASSES),
        "names": FINAL_CLASSES,
    }
    with open(DEST / "data.yaml", "w") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)
    print(f"[YAML] {DEST}/data.yaml ditulis — {len(FINAL_CLASSES)} classes")


def count_stats():
    for split in ("train", "valid"):
        n = len(list((DEST / split / "images").glob("*.*")))
        print(f"  {split}: {n} gambar")
    # Hitung distribusi class
    from collections import Counter
    counter = Counter()
    for lbl in (DEST / "train" / "labels").glob("*.txt"):
        with open(lbl) as f:
            for line in f:
                idx = int(line.split()[0]) if line.strip() else -1
                if 0 <= idx < len(FINAL_CLASSES):
                    counter[FINAL_CLASSES[idx]] += 1
    print("\nDistribusi class (train):")
    for cls, n in sorted(counter.items(), key=lambda x: -x[1]):
        bar = "█" * min(30, n // 10)
        print(f"  {cls:12s} {n:5d}  {bar}")


if __name__ == "__main__":
    if ROBOFLOW_API_KEY == "GANTI_DENGAN_API_KEY_KAMU":
        print("ERROR: Ganti ROBOFLOW_API_KEY dengan key asli dari app.roboflow.com")
        exit(1)

    print("=== JakTraffic Dataset Downloader ===")
    raw_dirs = download_datasets()
    merge_datasets(raw_dirs)
    write_yaml()
    print("\n=== Statistik Dataset ===")
    count_stats()
    print(f"\nDataset siap di: {DEST}")
    print("Jalankan 02_train.py untuk mulai fine-tuning")
