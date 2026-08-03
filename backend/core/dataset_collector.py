"""
Dataset Collector — Otomatis ambil frame dari kamera aktif & auto-label dengan YOLO.

Format output: YOLO training format
  dataset/
    images/train/*.jpg
    images/val/*.jpg
    labels/train/*.txt
    labels/val/*.txt
    dataset.yaml

Label mapping (subset COCO yang relevan untuk lalu lintas Indonesia):
  0 = car         (COCO class 2)
  1 = motorcycle  (COCO class 3)
  2 = bus         (COCO class 5)
  3 = truck       (COCO class 7)
"""

import cv2
import os
import time
import random
import logging
import threading
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
DATASET_DIR   = Path(__file__).parent.parent / "dataset"
IMAGES_TRAIN  = DATASET_DIR / "images" / "train"
IMAGES_VAL    = DATASET_DIR / "images" / "val"
LABELS_TRAIN  = DATASET_DIR / "labels" / "train"
LABELS_VAL    = DATASET_DIR / "labels" / "val"

# COCO class ID → dataset class ID
COCO_TO_LOCAL = {2: 0, 3: 1, 5: 2, 7: 3}
CLASS_NAMES   = ["car", "motorcycle", "bus", "truck"]

VAL_RATIO     = 0.15   # 15% untuk validasi
CONF_THRESH   = 0.30   # hanya simpan deteksi dengan confidence ≥ 0.30
MIN_BOX_AREA  = 0.003  # abaikan box terlalu kecil (< 0.3% frame area — kemungkinan noise)

_lock = threading.Lock()
_stats = {
    "total_frames": 0,
    "total_labels": 0,
    "last_collection": None,
    "cameras_collected": 0,
}


def _ensure_dirs():
    for d in [IMAGES_TRAIN, IMAGES_VAL, LABELS_TRAIN, LABELS_VAL]:
        d.mkdir(parents=True, exist_ok=True)


def _write_yaml():
    yaml_path = DATASET_DIR / "dataset.yaml"
    content = f"""# JakTraffic Dataset — Auto-collected dari kamera CCTV Indonesia
path: {DATASET_DIR}
train: images/train
val:   images/val

nc: {len(CLASS_NAMES)}
names: {CLASS_NAMES}
"""
    yaml_path.write_text(content)


def _grab_frame(stream_url: str, timeout_s: int = 6):
    """Ambil 1 frame dari stream HLS."""
    os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = (
        'user_agent;Mozilla/5.0|protocol_whitelist;file,crypto,data,http,https,tcp,tls,udp|timeout;6000000'
    )
    cap = cv2.VideoCapture(stream_url)
    frame = None
    start = time.time()
    while time.time() - start < timeout_s:
        ret, f = cap.read()
        if ret:
            frame = f
            break
    cap.release()
    return frame


def _yolo_label(results, img_h: int, img_w: int) -> list[str]:
    """Konversi hasil YOLO ke format label .txt (YOLO normalized xywh)."""
    lines = []
    boxes = results[0].boxes
    if boxes is None or len(boxes) == 0:
        return lines

    for box in boxes:
        coco_cls = int(box.cls.item())
        local_cls = COCO_TO_LOCAL.get(coco_cls)
        if local_cls is None:
            continue
        conf = float(box.conf.item())
        if conf < CONF_THRESH:
            continue

        # Koordinat absolut (xyxy)
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        bw = (x2 - x1) / img_w
        bh = (y2 - y1) / img_h
        if bw * bh < MIN_BOX_AREA:
            continue
        cx = ((x1 + x2) / 2) / img_w
        cy = ((y1 + y2) / 2) / img_h
        lines.append(f"{local_cls} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
    return lines


def _infer_gpu(img_bgr) -> list[str] | None:
    """
    Coba inferensi via GPU service. Return list label strings, atau None jika GPU offline.
    GPU model Indonesia punya kelas berbeda dari COCO — semua kelas dianggap 'kendaraan'.
    Remap ke class 0 (generic vehicle) jika bukan kelas COCO standar.
    """
    from core.detector import is_gpu_healthy, get_gpu_url
    import base64, requests as req

    if not is_gpu_healthy():
        return None
    try:
        _, buf = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
        b64 = base64.b64encode(buf).decode()
        r = req.post(
            f"{get_gpu_url()}/detect",
            files={"file": ("frame.jpg", buf.tobytes(), "image/jpeg")},
            timeout=10,
        )
        d = r.json()
        boxes_raw = d.get("boxes", [])  # [{cls, conf, x1,y1,x2,y2}] normalized
        # GPU model Indonesia: semua kelas adalah kendaraan, map ke local ID
        # Gunakan class_counts untuk mengetahui tipe, tapi simpan sebagai bounding box
        lines = []
        for box in boxes_raw:
            conf = box.get("conf", 0)
            if conf < CONF_THRESH:
                continue
            cls_name = str(box.get("cls_name", "")).lower()
            # Map nama kelas GPU ke local ID
            local_cls = {"car": 0, "motor": 1, "motorcycle": 1, "bus": 2,
                         "truck": 3, "angkot": 0, "bajaj": 1, "becak": 1,
                         "bicycle": 1, "gerobak": 3}.get(cls_name, 0)
            cx = box.get("cx", 0); cy = box.get("cy", 0)
            bw = box.get("bw", 0); bh = box.get("bh", 0)
            if bw * bh < MIN_BOX_AREA:
                continue
            lines.append(f"{local_cls} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
        return lines
    except Exception as e:
        logger.debug("[Dataset] GPU infer error: %s", e)
        return None


def collect_frame(cam_id: int, cam_name: str, stream_url: str, model) -> bool:
    """
    Ambil 1 frame dari kamera, jalankan YOLO (GPU diprioritaskan), simpan gambar + label.
    Return True jika berhasil menyimpan.
    """
    from core.detector import _inference_lock

    frame = _grab_frame(stream_url)
    if frame is None:
        return False

    # Resize ke 640×640 untuk konsistensi training
    img = cv2.resize(frame, (640, 640))

    # GPU path — gunakan model Indonesia fine-tune jika online
    labels = _infer_gpu(img)

    # CPU fallback — yolo11s jika GPU tidak tersedia
    if labels is None:
        with _inference_lock:
            results = model(img, classes=list(COCO_TO_LOCAL.keys()),
                            conf=CONF_THRESH, iou=0.45, imgsz=640, verbose=False)
        labels = _yolo_label(results, 640, 640)

    # Simpan frame meski tidak ada deteksi (jalan kosong = label valid untuk negatif)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = f"cam{cam_id:03d}_{ts}"

    is_val = random.random() < VAL_RATIO
    img_dir   = IMAGES_VAL  if is_val else IMAGES_TRAIN
    label_dir = LABELS_VAL  if is_val else LABELS_TRAIN

    cv2.imwrite(str(img_dir / f"{stem}.jpg"), img,
                [cv2.IMWRITE_JPEG_QUALITY, 92])

    label_path = label_dir / f"{stem}.txt"
    label_path.write_text("\n".join(labels))

    with _lock:
        _stats["total_frames"] += 1
        _stats["total_labels"] += len(labels)
        _stats["cameras_collected"] += 1

    logger.debug("[Dataset] cam%03d %s → %d label (%s)",
                 cam_id, cam_name, len(labels), "val" if is_val else "train")
    return True


def run_collection_round(db_handler, model):
    """
    Jalankan 1 putaran pengumpulan: ambil 1 frame per kamera aktif secara paralel.
    Dipanggil dari scheduler setiap 30 menit.
    """
    import concurrent.futures

    _ensure_dirs()
    _write_yaml()

    try:
        conn = db_handler.get_db_connection()
        import psycopg2.extras
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT id, name, stream_url FROM cctv_locations "
            "WHERE stream_url IS NOT NULL AND stream_url != '' ORDER BY id"
        )
        cameras = cur.fetchall()
        conn.close()
    except Exception as e:
        logger.error("[Dataset] DB error: %s", e)
        return

    # Acak urutan agar tidak selalu kamera sama yang kena batas koneksi
    cams = list(cameras)
    random.shuffle(cams)

    success = 0
    with _lock:
        _stats["cameras_collected"] = 0

    def _collect(cam):
        try:
            ok = collect_frame(cam["id"], cam["name"], cam["stream_url"], model)
            return ok
        except Exception as e:
            logger.warning("[Dataset] cam%d error: %s", cam["id"], e)
            return False

    # Max 8 thread — terlalu banyak koneksi HLS sekaligus bisa timeout
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(_collect, cams))
        success = sum(results)

    with _lock:
        _stats["last_collection"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Hitung total frame yang ada di dataset
    n_train = len(list(IMAGES_TRAIN.glob("*.jpg")))
    n_val   = len(list(IMAGES_VAL.glob("*.jpg")))

    logger.info("[Dataset] Putaran selesai — %d/%d kamera OK | train=%d val=%d total=%d",
                success, len(cams), n_train, n_val, n_train + n_val)
    return success


def get_stats() -> dict:
    """Statistik koleksi dataset untuk API."""
    _ensure_dirs()
    n_train = len(list(IMAGES_TRAIN.glob("*.jpg")))
    n_val   = len(list(IMAGES_VAL.glob("*.jpg")))
    n_labels_train = len(list(LABELS_TRAIN.glob("*.txt")))

    # Hitung total bounding box dari sample labels
    total_boxes = 0
    sample_labels = list(LABELS_TRAIN.glob("*.txt"))[:200]
    for lp in sample_labels:
        lines = [l for l in lp.read_text().splitlines() if l.strip()]
        total_boxes += len(lines)
    avg_boxes = round(total_boxes / max(len(sample_labels), 1), 1)

    size_mb = sum(f.stat().st_size for f in DATASET_DIR.rglob("*") if f.is_file()) / 1e6

    with _lock:
        return {
            "train_images": n_train,
            "val_images":   n_val,
            "total_images": n_train + n_val,
            "avg_boxes_per_frame": avg_boxes,
            "size_mb": round(size_mb, 1),
            "dataset_dir": str(DATASET_DIR),
            "yaml_path":   str(DATASET_DIR / "dataset.yaml"),
            "last_collection": _stats["last_collection"],
            "ready_for_training": (n_train >= 500),
        }
