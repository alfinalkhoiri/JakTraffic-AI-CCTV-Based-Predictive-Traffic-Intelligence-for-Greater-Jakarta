import cv2
import numpy as np
from ultralytics import YOLO
import time
import os
import threading
import requests
from database.db_handler import update_traffic_data

os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = (
    'user_agent;Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36|'
    'protocol_whitelist;file,crypto,data,http,https,tcp,tls,udp|'
    'timeout;10000000'
)

# ── GPU Inference Service ────────────────────────────────────────────────────
# URL dapat diupdate saat runtime via set_gpu_url() (dari /api/gpu-register)
# Prioritas: runtime URL > .env URL
_GPU_ENV_URL      = os.getenv("GPU_INFERENCE_URL", "").rstrip("/")
_gpu_runtime_url  = None   # set saat GPU service register diri ke backend
_gpu_last_hb      = 0.0    # epoch seconds — terakhir terima heartbeat
_gpu_available    = False
_GPU_HB_TIMEOUT   = 90     # detik — jika tidak ada heartbeat, anggap GPU down

def get_gpu_url():
    if _gpu_runtime_url:
        return _gpu_runtime_url
    return _GPU_ENV_URL

def set_gpu_url(url: str):
    global _gpu_runtime_url, _gpu_available, _gpu_last_hb
    _gpu_runtime_url = url.rstrip("/")
    _gpu_last_hb = time.time()
    _gpu_available = True

def mark_gpu_heartbeat():
    global _gpu_last_hb, _gpu_available
    _gpu_last_hb = time.time()
    _gpu_available = True

def is_gpu_healthy():
    if not _gpu_available:
        return False
    return (time.time() - _gpu_last_hb) < _GPU_HB_TIMEOUT

def _check_gpu_service():
    global _gpu_available, _gpu_last_hb
    url = get_gpu_url()
    if not url:
        return False
    try:
        r = requests.get(f"{url}/health", timeout=5)
        if r.status_code == 200:
            info = r.json()
            _gpu_available = True
            _gpu_last_hb = time.time()
            print(f"[GPU] Remote service online: {info.get('gpu')} {info.get('vram_gb')}GB — {info.get('model')}")
            return True
    except Exception as e:
        print(f"[GPU] Remote service unreachable: {e}")
    return False

_gpu_available = _check_gpu_service()


def _infer_remote(img_bgr):
    """POST frame ke GPU service → (vehicle_count, class_counts, annotated_b64, ms)."""
    url = get_gpu_url()
    if not url:
        raise RuntimeError("No GPU URL configured")
    _, buf = cv2.imencode('.jpg', img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
    r = requests.post(
        f"{url}/detect",
        files={"file": ("frame.jpg", buf.tobytes(), "image/jpeg")},
        timeout=20
    )
    d = r.json()
    return d.get("vehicle_count", 0), d.get("class_counts", {}), d.get("annotated_image"), d.get("inference_ms", 0)


def infer_batch_remote(frames: list) -> list:
    """
    Kirim N frame sekaligus ke GPU service v4 /detect-batch.
    frames: [{"cam_id": int, "img": np.ndarray, "timestamp": float}]
    Returns: [{"cam_id", "vehicle_count", "class_counts", "speed_kmh", ...}]
    """
    import base64 as _b64, time as _time
    url = get_gpu_url()
    if not url:
        raise RuntimeError("No GPU URL configured")

    payload_frames = []
    for f in frames:
        img = cv2.resize(f["img"], (640, 640))
        _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        payload_frames.append({
            "cam_id":    f["cam_id"],
            "image_b64": _b64.b64encode(buf).decode(),
            "timestamp": f.get("timestamp", _time.time()),
        })

    r = requests.post(
        f"{url}/detect-batch",
        json={"frames": payload_frames, "conf": 0.15, "iou": 0.45},
        timeout=60,
    )
    r.raise_for_status()
    return r.json().get("results", [])


# ── CPU fallback model ───────────────────────────────────────────────────────
# Prioritas: yolo11x Indonesia → yolo11s Indonesia → yolo11s COCO
_MODELS_DIR     = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "models"))
_MODEL_11X_PATH = os.path.join(_MODELS_DIR, "jaktraffic_yolo11x.pt")
_ID_MODEL_PATH  = os.path.join(_MODELS_DIR, "jaktraffic_yolo.pt")

if os.path.exists(_MODEL_11X_PATH):
    print(f"Loading YOLO11x Indonesia model (CPU): {_MODEL_11X_PATH}")
    model = YOLO(_MODEL_11X_PATH)
    _model_is_id = True
elif os.path.exists(_ID_MODEL_PATH):
    print(f"Loading Indonesia model (CPU): {_ID_MODEL_PATH}")
    model = YOLO(_ID_MODEL_PATH)
    _model_is_id = True
else:
    print("Loading yolo11s.pt (CPU fallback, COCO)...")
    model = YOLO('yolo11s.pt')
    _model_is_id = False

_inference_lock = threading.Lock()

DEBUG_FOLDER = "debug_views"
os.makedirs(DEBUG_FOLDER, exist_ok=True)


def get_weather_data(lat, lng):
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lng}&current_weather=true"
        response = requests.get(url, timeout=2)
        if response.status_code == 200:
            data = response.json()
            code = data['current_weather']['weathercode']
            if code <= 3:   return "Cerah/Berawan"
            elif code <= 55: return "Gerimis"
            elif code <= 65: return "Hujan"
            elif code <= 82: return "Hujan Lebat"
            elif code >= 95: return "Badai"
    except:
        pass
    return "Cerah"


def calculate_traffic_score(vehicle_count, truck_count, weather_text):
    score = 0
    if vehicle_count > 40:   score += 60
    elif vehicle_count >= 20: score += 20
    if truck_count > 3:       score += 15
    w = weather_text.lower()
    if "badai" in w or "lebat" in w: score += 50
    elif "hujan" in w:  score += 20
    elif "gerimis" in w: score += 10
    return min(score, 100)


def _grab_frame(stream_url, timeout_s=4):
    """Buka stream HLS, ambil frame pertama yang berhasil decode dalam timeout_s detik."""
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


class VideoDetector:
    def __init__(self):
        self.model = model

    def get_vehicle_count(self, stream_url, loc_id):
        """
        GPU path: ambil 1 frame (max 4s), kirim ke GPU service.
        CPU path: baca 10s frames, track.
        Return vehicle count atau None jika stream tidak bisa dibuka.
        """
        if is_gpu_healthy():
            frame = _grab_frame(stream_url, timeout_s=4)
            if frame is None:
                return None
            try:
                count, _, _, _ = _infer_remote(cv2.resize(frame, (640, 640)))
                return count
            except Exception as e:
                print(f"[GPU] Inference failed for loc {loc_id}: {e}, falling back to CPU")

        # CPU fallback — ambil 4 frame selama max 3 detik, return median
        # Median lebih robust dari max: 1 frame noise tidak akan spike count
        import statistics as _stats
        # Indonesia model: semua kelas (0-9) adalah kendaraan — jangan filter per class
        # COCO model: hanya ambil car=2, motorcycle=3, bus=5, truck=7
        _cls_filter = None if _model_is_id else [2, 3, 5, 7]
        cap = cv2.VideoCapture(stream_url)
        counts = []
        frames_read = 0
        last_infer = 0.0
        start_time = time.time()
        while time.time() - start_time < 3.5 and len(counts) < 4:
            ret, frame = cap.read()
            if not ret:
                break
            frames_read += 1
            now = time.time()
            if now - last_infer >= 0.7:
                last_infer = now
                # imgsz=320 — 4x lebih cepat dari 640, akurasi cukup untuk counting
                frame_s = cv2.resize(frame, (320, 320))
                with _inference_lock:
                    results = self.model(
                        frame_s, classes=_cls_filter,
                        conf=0.28, iou=0.45, imgsz=320, verbose=False
                    )
                counts.append(len(results[0].boxes))
        cap.release()
        if not counts:
            return None
        return int(round(_stats.median(counts)))

    def estimate_speed(self, stream_url, loc_id, pixel_per_meter=8.0):
        """
        Estimasi kecepatan rata-rata kendaraan via optical flow (km/h).
        Capture 2 frame berjarak ~1 detik, hitung mean flow magnitude.
        pixel_per_meter: kalibrasi perspektif (8px ≈ 1m, default untuk kamera jalan tol).
        """
        cap = cv2.VideoCapture(stream_url)
        gray_frames = []
        frame_times = []
        start = time.time()

        while time.time() - start < 4 and len(gray_frames) < 2:
            ret, frame = cap.read()
            if not ret:
                break
            if not gray_frames:
                gray = cv2.cvtColor(cv2.resize(frame, (640, 360)), cv2.COLOR_BGR2GRAY)
                gray_frames.append(gray)
                frame_times.append(time.time())
            elif time.time() - frame_times[0] >= 0.8:
                gray = cv2.cvtColor(cv2.resize(frame, (640, 360)), cv2.COLOR_BGR2GRAY)
                gray_frames.append(gray)
                frame_times.append(time.time())
        cap.release()

        if len(gray_frames) < 2:
            return None

        dt = frame_times[1] - frame_times[0]
        flow = cv2.calcOpticalFlowFarneback(
            gray_frames[0], gray_frames[1], None,
            pyr_scale=0.5, levels=3, winsize=15,
            iterations=3, poly_n=5, poly_sigma=1.2, flags=0
        )
        mag, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])

        # Threshold 2.5px menyaring artefak kompresi video (DCT noise) yang
        # pada frame HLS malam hari bisa menghasilkan 1-2px motion palsu.
        # Juga butuh minimum 0.3% pixel bergerak — jika lebih sedikit, itu noise.
        moving = mag[mag > 2.5]
        min_pixels = mag.size * 0.003
        if len(moving) == 0 or len(moving) < min_pixels:
            return 0.0

        mean_px = float(np.mean(moving))
        speed_ms = (mean_px / pixel_per_meter) / max(dt, 0.05)
        speed_kmh = speed_ms * 3.6
        return round(min(speed_kmh, 150), 1)

    def detect_file(self, file_path):
        """Run YOLO pada image/video yang diupload. GPU-first, CPU fallback."""
        import base64
        start = time.time()
        ext = os.path.splitext(file_path)[1].lower()
        is_video = ext in ('.mp4', '.avi', '.mov', '.mkv', '.webm')

        if _model_is_id:
            CLASS_NAMES  = {0: 'car', 1: 'motor', 2: 'bus', 3: 'truck',
                            4: 'angkot', 5: 'bajaj', 6: 'becak', 7: 'bicycle',
                            8: 'person', 9: 'gerobak'}
            _cls_filter = None   # semua kelas Indonesia adalah kendaraan
        else:
            CLASS_NAMES  = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}
            _cls_filter = [2, 3, 5, 7]

        def _run_cpu(frame):
            frame = cv2.resize(frame, (1280, 720))
            with _inference_lock:
                return self.model(frame, classes=_cls_filter, conf=0.15, iou=0.45, verbose=False)

        def _encode(frame):
            _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            return base64.b64encode(buf).decode()

        best_count = 0
        best_annotated = None
        best_classes = {}

        if is_video:
            cap = cv2.VideoCapture(file_path)
            fps = cap.get(cv2.CAP_PROP_FPS) or 25
            step = max(1, int(fps * 0.5))
            frame_idx = 0
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                if frame_idx % step == 0:
                    if is_gpu_healthy():
                        try:
                            count, cls_counts, ann_b64, _ = _infer_remote(frame)
                            if count > best_count:
                                best_count = count
                                best_classes = cls_counts
                                best_annotated = ann_b64
                            frame_idx += 1
                            continue
                        except Exception:
                            pass
                    results = _run_cpu(frame)
                    count = len(results[0].boxes)
                    if count > best_count:
                        best_count = count
                        best_annotated = _encode(results[0].plot())
                        best_classes = {}
                        if results[0].boxes.cls is not None:
                            for c in results[0].boxes.cls.cpu().numpy().astype(int):
                                n = CLASS_NAMES.get(c, str(c))
                                best_classes[n] = best_classes.get(n, 0) + 1
                frame_idx += 1
            cap.release()
        else:
            frame = cv2.imread(file_path)
            if frame is None:
                return None
            if is_gpu_healthy():
                try:
                    best_count, best_classes, best_annotated, _ = _infer_remote(frame)
                except Exception:
                    pass
            if best_annotated is None:
                results = _run_cpu(frame)
                best_count = len(results[0].boxes)
                best_annotated = _encode(results[0].plot())
                if results[0].boxes.cls is not None:
                    for c in results[0].boxes.cls.cpu().numpy().astype(int):
                        n = CLASS_NAMES.get(c, str(c))
                        best_classes[n] = best_classes.get(n, 0) + 1

        if best_annotated is None:
            return None

        return {
            'vehicle_count': best_count,
            'class_counts': best_classes,
            'annotated_image': best_annotated,
            'processing_time_ms': int((time.time() - start) * 1000),
        }
