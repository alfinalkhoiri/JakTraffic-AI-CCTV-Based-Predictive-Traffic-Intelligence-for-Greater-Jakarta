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

        start_time = time.time()
        while time.time() - start_time < 10:
            ret, frame = cap.read()
            if not ret:
                break

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
        return max_vehicle
