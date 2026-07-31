import cv2
import numpy as np
from ultralytics import YOLO
import time
import os
import threading
import requests
from database.db_handler import update_traffic_data

# Fix: allow OpenCV FFmpeg to open HTTPS/HLS streams
os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = (
    'user_agent;Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36|'
    'protocol_whitelist;file,crypto,data,http,https,tcp,tls,udp|'
    'timeout;15000000'
)

# ── GPU Inference Service ────────────────────────────────────────────────────
# Jika GPU_INFERENCE_URL diset di .env, semua inferensi dikirim ke GPU remote
# (NVIDIA L40S 44GB via Cloudflare Tunnel). Fallback ke CPU jika GPU tidak tersedia.
GPU_INFERENCE_URL = os.getenv("GPU_INFERENCE_URL", "").rstrip("/")

def _check_gpu_service():
    if not GPU_INFERENCE_URL:
        return False
    try:
        r = requests.get(f"{GPU_INFERENCE_URL}/health", timeout=5)
        if r.status_code == 200:
            info = r.json()
            print(f"[GPU] Remote service online: {info.get('gpu')} {info.get('vram_gb')}GB — model {info.get('model')}")
            return True
    except Exception as e:
        print(f"[GPU] Remote service unreachable: {e}")
    return False

_gpu_available = _check_gpu_service()

def _infer_remote(img_bgr):
    """Kirim frame ke GPU inference service, kembalikan (count, class_counts, annotated_b64, ms)."""
    _, buf = cv2.imencode('.jpg', img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
    r = requests.post(
        f"{GPU_INFERENCE_URL}/detect",
        files={"file": ("frame.jpg", buf.tobytes(), "image/jpeg")},
        timeout=20
    )
    d = r.json()
    return d.get("vehicle_count", 0), d.get("class_counts", {}), d.get("annotated_image"), d.get("inference_ms", 0)

# ── CPU fallback model ───────────────────────────────────────────────────────
print("Loading local YOLO model (CPU fallback)...")
model = YOLO('yolo11n.pt')
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
            if code <= 3: return "Cerah/Berawan"
            elif code <= 55: return "Gerimis"
            elif code <= 65: return "Hujan"
            elif code <= 82: return "Hujan Lebat"
            elif code >= 95: return "Badai"
    except:
        pass
    return "Cerah"


def calculate_traffic_score(vehicle_count, truck_count, weather_text):
    score = 0
    if vehicle_count > 40: score += 60
    elif vehicle_count >= 20: score += 20
    if truck_count > 3: score += 15
    w = weather_text.lower()
    if "badai" in w or "lebat" in w: score += 50
    elif "hujan" in w: score += 20
    elif "gerimis" in w: score += 10
    return min(score, 100)


class VideoDetector:
    def __init__(self):
        self.model = model

    def get_vehicle_count(self, stream_url, loc_id):
        cap = cv2.VideoCapture(stream_url)
        frames_read = 0
        best_frame = None

        start_time = time.time()
        while time.time() - start_time < 10:
            ret, frame = cap.read()
            if not ret:
                break
            frames_read += 1
            if frames_read == 1 or frames_read % 5 == 0:
                best_frame = frame.copy()

        cap.release()
        if frames_read == 0 or best_frame is None:
            return None

        # GPU path
        if _gpu_available:
            try:
                count, _, _, ms = _infer_remote(cv2.resize(best_frame, (640, 640)))
                return count
            except Exception as e:
                print(f"[GPU] Inference failed for loc {loc_id}: {e}, falling back to CPU")

        # CPU fallback
        frame = cv2.resize(best_frame, (1020, 576))
        with _inference_lock:
            results = self.model.track(
                frame, classes=[2, 3, 5, 7],
                conf=0.1, iou=0.5, persist=True, verbose=False
            )
        return len(results[0].boxes)

    def detect_file(self, file_path):
        """Run YOLO on uploaded image/video. Uses GPU if available."""
        import base64
        start = time.time()
        ext = os.path.splitext(file_path)[1].lower()
        is_video = ext in ('.mp4', '.avi', '.mov', '.mkv', '.webm')

        CLASS_NAMES = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}

        def _run_cpu(frame):
            frame = cv2.resize(frame, (1280, 720))
            with _inference_lock:
                return self.model(frame, classes=[2, 3, 5, 7], conf=0.15, iou=0.45, verbose=False)

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
                    if _gpu_available:
                        try:
                            count, cls_counts, ann_b64, _ = _infer_remote(frame)
                            if count > best_count:
                                best_count = count
                                best_classes = cls_counts
                                best_annotated = ann_b64  # already base64
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
            if _gpu_available:
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

        # best_annotated bisa base64 string (GPU) atau string (CPU sudah encode)
        ann_out = best_annotated if isinstance(best_annotated, str) else best_annotated

        return {
            'vehicle_count': best_count,
            'class_counts': best_classes,
            'annotated_image': ann_out,
            'processing_time_ms': int((time.time() - start) * 1000),
        }
