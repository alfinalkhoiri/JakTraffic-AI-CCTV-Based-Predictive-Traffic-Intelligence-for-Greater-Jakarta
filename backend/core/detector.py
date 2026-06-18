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

print("Loading Model AI (Background Mode)...")
model = YOLO('yolo11n.pt')

# Lock untuk proteksi model.track() dari concurrent threads
# (YOLO tracker menyimpan state internal — harus serial)
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
        max_vehicle = 0
        max_truck = 0
        frames_read = 0

        start_time = time.time()
        while time.time() - start_time < 10:
            ret, frame = cap.read()
            if not ret:
                break

            frames_read += 1
            frame = cv2.resize(frame, (1020, 576))
            with _inference_lock:
                results = self.model.track(
                    frame, classes=[2, 3, 5, 7],
                    conf=0.1, iou=0.5, persist=True, verbose=False
                )

            boxes = results[0].boxes
            count = len(boxes)

            trucks = 0
            if boxes.cls is not None:
                cls = boxes.cls.cpu().numpy()
                trucks = np.sum((cls == 5) | (cls == 7))

            max_vehicle = max(max_vehicle, count)
            max_truck = max(max_truck, trucks)

        cap.release()
        # Kembalikan None jika tidak berhasil baca satu pun frame (stream tidak terjangkau)
        if frames_read == 0:
            return None
        return max_vehicle

    def detect_file(self, file_path):
        """
        Run YOLO 11 on an image or short video file uploaded by admin.
        Returns dict: {vehicle_count, class_counts, annotated_image (base64 JPEG), processing_time_ms}
        """
        import base64
        start = time.time()
        ext = os.path.splitext(file_path)[1].lower()
        is_video = ext in ('.mp4', '.avi', '.mov', '.mkv', '.webm')

        CLASS_NAMES = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}

        def _run_inference(frame):
            frame = cv2.resize(frame, (1280, 720))
            with _inference_lock:
                # conf=0.15 agar kendaraan jauh/malam tetap terdeteksi
                return self.model(frame, classes=[2, 3, 5, 7], conf=0.15, iou=0.45, verbose=False)

        def _count_classes(boxes):
            counts = {}
            if boxes.cls is not None:
                for c in boxes.cls.cpu().numpy().astype(int):
                    name = CLASS_NAMES.get(c, str(c))
                    counts[name] = counts.get(name, 0) + 1
            return counts

        def _encode(frame):
            _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            return base64.b64encode(buf).decode()

        best_count = 0
        best_annotated = None
        best_classes = {}

        if is_video:
            cap = cv2.VideoCapture(file_path)
            fps = cap.get(cv2.CAP_PROP_FPS) or 25
            step = max(1, int(fps * 0.5))  # sample every 0.5 s
            frame_idx = 0
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                if frame_idx % step == 0:
                    results = _run_inference(frame)
                    count = len(results[0].boxes)
                    if count > best_count:
                        best_count = count
                        best_annotated = results[0].plot()
                        best_classes = _count_classes(results[0].boxes)
                frame_idx += 1
            cap.release()
        else:
            frame = cv2.imread(file_path)
            if frame is None:
                return None
            results = _run_inference(frame)
            best_count = len(results[0].boxes)
            best_annotated = results[0].plot()
            best_classes = _count_classes(results[0].boxes)

        if best_annotated is None:
            return None

        return {
            'vehicle_count': best_count,
            'class_counts': best_classes,
            'annotated_image': _encode(best_annotated),
            'processing_time_ms': int((time.time() - start) * 1000),
        }

