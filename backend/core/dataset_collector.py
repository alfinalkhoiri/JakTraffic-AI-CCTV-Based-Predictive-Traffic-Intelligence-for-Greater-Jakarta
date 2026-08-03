"""
Dataset Collector — Otomatis ambil frame dari kamera aktif & auto-label dengan YOLO.

Prioritas kamera: hanya kamera yang dikonfirmasi GPU scan aktif (last_gpu_scan < 3 jam).
Kamera prioritas mendapat 3 frame per putaran; fallback 1 frame.

Format output: YOLO training format
  dataset/
    images/train/*.jpg
    images/val/*.jpg
    labels/train/*.txt
    labels/val/*.txt
    dataset.yaml

Label mapping Indonesia model (jaktraffic_yolo11x.pt — 9 kelas):
  0 = car       1 = motor     2 = bus       3 = truck
  4 = angkot    5 = bajaj     6 = becak     7 = bicycle
  8 = gerobak   (person cls 8 di-skip — bukan kendaraan)
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

# COCO model: class ID → dataset class ID
COCO_TO_LOCAL = {2: 0, 3: 1, 5: 2, 7: 3}

# Indonesia model (jaktraffic_yolo11x.pt): class ID → dataset class ID
# Kelas person (8) tidak masuk — bukan kendaraan
INDO_TO_LOCAL = {0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 9: 8}

# Dataset class names (Indonesia model — 9 kelas kendaraan)
CLASS_NAMES_INDO = ["car", "motor", "bus", "truck", "angkot", "bajaj", "becak", "bicycle", "gerobak"]
CLASS_NAMES_COCO = ["car", "motorcycle", "bus", "truck"]

VAL_RATIO    = 0.15   # 15% untuk validasi
CONF_THRESH  = 0.35   # lebih ketat dari 0.30 — kurangi label noise
MIN_BOX_AREA = 0.003  # abaikan box < 0.3% area frame

# Kamera prioritas: stream aktif + data akurat (dikonfirmasi GPU)
# ID dari query: kamera dengan last_gpu_scan < 2 jam
PRIORITY_CAM_IDS: set[int] = set()  # diisi saat runtime dari DB

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


def _is_indo_model(model) -> bool:
    """Cek apakah model adalah Indonesia fine-tuned (9 kelas) bukan COCO (80 kelas)."""
    try:
        nc = model.model.nc if hasattr(model, "model") else len(model.names)
        return nc <= 12  # Indonesia model: ~9 kelas; COCO: 80 kelas
    except Exception:
        return False


def _write_yaml(use_indo: bool = True):
    yaml_path = DATASET_DIR / "dataset.yaml"
    names = CLASS_NAMES_INDO if use_indo else CLASS_NAMES_COCO
    content = f"""# JakTraffic Dataset — Auto-collected dari kamera CCTV Indonesia
path: {DATASET_DIR}
train: images/train
val:   images/val

nc: {len(names)}
names: {names}
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


def _yolo_label(results, img_h: int, img_w: int, is_indo: bool = False) -> list[str]:
    """Konversi hasil YOLO ke format label .txt (YOLO normalized xywh)."""
    lines = []
    boxes = results[0].boxes
    if boxes is None or len(boxes) == 0:
        return lines

    cls_map = INDO_TO_LOCAL if is_indo else COCO_TO_LOCAL

    for box in boxes:
        raw_cls = int(box.cls.item())
        local_cls = cls_map.get(raw_cls)
        if local_cls is None:
            continue  # skip person (cls 8) dan kelas tidak dikenal
        conf = float(box.conf.item())
        if conf < CONF_THRESH:
            continue

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
    Coba inferensi via GPU service /detect-boxes (mengembalikan bounding box per objek).
    Return list label strings, atau None jika GPU offline atau endpoint tidak tersedia.

    GPU endpoint /detect hanya mengembalikan counts, bukan boxes — tidak bisa dipakai.
    Endpoint /detect-boxes harus ditambahkan di gpu_service_v4.py.
    """
    from core.detector import is_gpu_healthy, get_gpu_url
    import requests as req

    if not is_gpu_healthy():
        return None
    try:
        _, buf = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
        r = req.post(
            f"{get_gpu_url()}/detect-boxes",
            files={"file": ("frame.jpg", buf.tobytes(), "image/jpeg")},
            data={"conf": CONF_THRESH},
            timeout=12,
        )
        if r.status_code != 200:
            return None
        boxes_raw = r.json().get("boxes", [])
        # [{cls_id: int, cls_name: str, conf: float, cx: float, cy: float, bw: float, bh: float}]
        lines = []
        for box in boxes_raw:
            conf = box.get("conf", 0)
            if conf < CONF_THRESH:
                continue
            cls_id = box.get("cls_id", -1)
            local_cls = INDO_TO_LOCAL.get(cls_id)
            if local_cls is None:
                continue
            cx, cy = box.get("cx", 0), box.get("cy", 0)
            bw, bh = box.get("bw", 0), box.get("bh", 0)
            if bw * bh < MIN_BOX_AREA:
                continue
            lines.append(f"{local_cls} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
        return lines
    except Exception as e:
        logger.debug("[Dataset] GPU infer error: %s", e)
        return None


def collect_frame(cam_id: int, cam_name: str, stream_url: str, model,
                  n_frames: int = 1) -> int:
    """
    Ambil n_frames frame dari kamera, label dengan YOLO, simpan gambar + label.
    Return jumlah frame yang berhasil disimpan.
    """
    from core.detector import _inference_lock

    is_indo = _is_indo_model(model)
    saved = 0

    for i in range(n_frames):
        if i > 0:
            time.sleep(random.uniform(1.5, 4.0))  # variasi waktu antar frame

        frame = _grab_frame(stream_url)
        if frame is None:
            break

        img = cv2.resize(frame, (640, 640))

        # GPU path — /detect-boxes jika online
        labels = _infer_gpu(img)

        # CPU fallback — Indonesia model atau COCO
        if labels is None:
            cls_filter = list(INDO_TO_LOCAL.keys()) if is_indo else list(COCO_TO_LOCAL.keys())
            with _inference_lock:
                results = model(img, classes=cls_filter,
                                conf=CONF_THRESH, iou=0.45, imgsz=640, verbose=False)
            labels = _yolo_label(results, 640, 640, is_indo=is_indo)

        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:19]
        stem = f"cam{cam_id:03d}_{ts}"

        is_val = random.random() < VAL_RATIO
        img_dir   = IMAGES_VAL  if is_val else IMAGES_TRAIN
        label_dir = LABELS_VAL  if is_val else LABELS_TRAIN

        cv2.imwrite(str(img_dir / f"{stem}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        (label_dir / f"{stem}.txt").write_text("\n".join(labels))
        saved += 1

        with _lock:
            _stats["total_frames"] += 1
            _stats["total_labels"] += len(labels)

        logger.debug("[Dataset] cam%03d %s frame%d → %d label (%s)",
                     cam_id, cam_name, i + 1, len(labels), "val" if is_val else "train")

    return saved


def _get_active_cameras(db_handler) -> tuple[list, list]:
    """
    Kembalikan (priority_cams, fallback_cams):
    - priority_cams: kamera dengan GPU scan aktif dalam 3 jam terakhir (stream terbukti aktif)
    - fallback_cams: sisa kamera dengan stream_url (fallback jika priority kosong)
    """
    import psycopg2.extras
    try:
        conn = db_handler.get_db_connection()
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        # Kamera prioritas: dikonfirmasi GPU scan + ada kendaraan terdeteksi
        cur.execute("""
            SELECT id, name, stream_url, vehicles
            FROM cctv_locations
            WHERE stream_url IS NOT NULL AND stream_url != ''
              AND last_gpu_scan > NOW() - INTERVAL '3 hours'
              AND vehicles >= 1
            ORDER BY vehicles DESC, last_gpu_scan DESC
        """)
        priority = cur.fetchall()

        # Fallback: kamera lain dengan stream_url (jika priority kosong)
        if not priority:
            cur.execute("""
                SELECT id, name, stream_url, 0 AS vehicles
                FROM cctv_locations
                WHERE stream_url IS NOT NULL AND stream_url != ''
                ORDER BY id
            """)
            fallback = cur.fetchall()
        else:
            fallback = []

        conn.close()
        return list(priority), list(fallback)
    except Exception as e:
        logger.error("[Dataset] DB error saat ambil kamera aktif: %s", e)
        return [], []


def run_collection_round(db_handler, model):
    """
    Jalankan 1 putaran pengumpulan dari kamera prioritas (aktif + GPU-confirmed).
    Kamera prioritas mendapat 3 frame; fallback mendapat 1 frame.
    Dipanggil dari scheduler setiap 30 menit.
    """
    import concurrent.futures

    _ensure_dirs()
    is_indo = _is_indo_model(model)
    _write_yaml(use_indo=is_indo)

    priority_cams, fallback_cams = _get_active_cameras(db_handler)

    if priority_cams:
        logger.info("[Dataset] %d kamera prioritas (GPU aktif) | mode: %s",
                    len(priority_cams), "Indonesia" if is_indo else "COCO")
        cams_to_use = priority_cams
        frames_per_cam = 3  # lebih banyak frame dari kamera berkualitas
    else:
        logger.warning("[Dataset] Tidak ada kamera GPU aktif — fallback ke %d kamera biasa",
                       len(fallback_cams))
        cams_to_use = fallback_cams
        frames_per_cam = 1

    random.shuffle(cams_to_use)

    with _lock:
        _stats["cameras_collected"] = 0

    total_frames = 0

    def _collect(cam):
        try:
            n = collect_frame(cam["id"], cam["name"], cam["stream_url"], model,
                              n_frames=frames_per_cam)
            if n > 0:
                with _lock:
                    _stats["cameras_collected"] += 1
            return n
        except Exception as e:
            logger.warning("[Dataset] cam%d error: %s", cam["id"], e)
            return 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(_collect, cams_to_use))
        total_frames = sum(results)

    with _lock:
        _stats["last_collection"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cams_ok = _stats["cameras_collected"]

    n_train = len(list(IMAGES_TRAIN.glob("*.jpg")))
    n_val   = len(list(IMAGES_VAL.glob("*.jpg")))

    logger.info("[Dataset] Selesai — %d frame dari %d/%d kamera | train=%d val=%d total=%d",
                total_frames, cams_ok, len(cams_to_use), n_train, n_val, n_train + n_val)
    return total_frames


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
