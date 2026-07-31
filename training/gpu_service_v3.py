"""
JakTraffic GPU Inference Service v3
- NVIDIA L40S
- Auto-detect class list dari model (support COCO + model Indonesia fine-tuned)
- FastAPI + Cloudflare Tunnel
- Auto-register URL ke JakTraffic backend + heartbeat 30s

Ganti MODEL_PATH untuk beralih antara model COCO dan model Indonesia.
"""

import subprocess, sys, os, time, threading, requests, uvicorn, base64, io
from fastapi import FastAPI, File, UploadFile, HTTPException
import numpy as np
import cv2

def pip(*pkgs):
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", *pkgs])

try:
    from ultralytics import YOLO
except ImportError:
    pip("ultralytics"); from ultralytics import YOLO

try:
    import torch
except ImportError:
    pip("torch"); import torch

# ── Config ────────────────────────────────────────────────────────────────────
PORT         = 8765
# Ganti ke path model Indonesia setelah fine-tuning:
# MODEL_PATH = "/tmp/jaktraffic_indonesia.pt"
MODEL_PATH   = "yolo11l.pt"
BACKEND_URL  = "https://jaktrafficai.f-mc.my.id"
HB_INTERVAL  = 30
TUNNEL_URL   = None

# ── Load model ────────────────────────────────────────────────────────────────
print(f"[GPU Service] Loading model: {MODEL_PATH}")
model = YOLO(MODEL_PATH)
device = "cuda" if torch.cuda.is_available() else "cpu"
model.to(device)
print(f"[GPU Service] Model loaded on {device.upper()}")

# ── Auto-detect class list dari model ────────────────────────────────────────
# Semua class yang dianggap sebagai "kendaraan" untuk traffic counting
_ALL_MODEL_NAMES = model.names  # dict {idx: name}

# Nama-nama yang dihitung sebagai kendaraan (case-insensitive)
VEHICLE_KEYWORDS = {
    "car", "truck", "bus", "motorcycle", "bicycle",
    "mobil", "motor", "truk", "sepeda",
    # Kendaraan Indonesia khas
    "angkot", "bajaj", "becak", "becal",
    "gerobak", "pickup", "pick up",
    "van", "minibus", "minivan",
    # Juga COCO class untuk kendaraan umum
    "motorbike",
}

VEHICLE_CLASSES = [
    idx for idx, name in _ALL_MODEL_NAMES.items()
    if name.lower() in VEHICLE_KEYWORDS
]
CLASS_NAMES = {idx: name for idx, name in _ALL_MODEL_NAMES.items()}

print(f"[GPU Service] Vehicle classes ({len(VEHICLE_CLASSES)}): "
      f"{[_ALL_MODEL_NAMES[i] for i in VEHICLE_CLASSES]}")

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="JakTraffic GPU Inference v3")

@app.get("/health")
def health():
    try:
        import pynvml
        pynvml.nvmlInit()
        h    = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(h)
        mem  = pynvml.nvmlDeviceGetMemoryInfo(h)
        vram = round(mem.total / 1e9, 1)
    except Exception:
        name = device.upper(); vram = 0

    return {
        "status":          "ok",
        "gpu":             name,
        "vram_gb":         vram,
        "model":           os.path.basename(MODEL_PATH),
        "model_path":      MODEL_PATH,
        "vehicle_classes": [_ALL_MODEL_NAMES[i] for i in VEHICLE_CLASSES],
        "is_indonesia_model": "angkot" in [_ALL_MODEL_NAMES[i].lower() for i in VEHICLE_CLASSES],
    }

@app.post("/detect")
async def detect(file: UploadFile = File(...)):
    data = await file.read()
    arr  = np.frombuffer(data, np.uint8)
    img  = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Cannot decode image")

    t0 = time.time()
    results = model(img, classes=VEHICLE_CLASSES, conf=0.15, iou=0.45, verbose=False)
    ms = round((time.time() - t0) * 1000, 1)

    boxes = results[0].boxes
    count = len(boxes)
    cls_counts = {}
    if boxes.cls is not None:
        for c in boxes.cls.cpu().numpy().astype(int):
            n = CLASS_NAMES.get(c, str(c))
            cls_counts[n] = cls_counts.get(n, 0) + 1

    annotated = results[0].plot()
    _, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])
    ann_b64 = base64.b64encode(buf).decode()

    return {
        "vehicle_count":   count,
        "class_counts":    cls_counts,
        "annotated_image": ann_b64,
        "inference_ms":    ms,
    }

# ── Cloudflare Tunnel ─────────────────────────────────────────────────────────
def _start_tunnel():
    global TUNNEL_URL
    cf_path = "/tmp/cloudflared"
    if not os.path.exists(cf_path):
        cf_path = "cloudflared"
    proc = subprocess.Popen(
        [cf_path, "tunnel", "--url", f"http://localhost:{PORT}", "--no-autoupdate"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    for line in proc.stdout:
        line = line.strip()
        if "trycloudflare.com" in line:
            import re
            m = re.search(r"https://[^\s]+\.trycloudflare\.com", line)
            if m:
                TUNNEL_URL = m.group(0)
                print(f"[GPU Service] Tunnel URL: {TUNNEL_URL}")
                _register()
                break
    proc.wait()

def _register():
    if not TUNNEL_URL:
        return
    try:
        import pynvml
        pynvml.nvmlInit()
        h = pynvml.nvmlDeviceGetHandleByIndex(0)
        gpu_name = pynvml.nvmlDeviceGetName(h)
        mem = pynvml.nvmlDeviceGetMemoryInfo(h)
        vram = round(mem.total / 1e9, 1)
    except Exception:
        gpu_name = "NVIDIA L40S"; vram = 47.7

    is_indo = "angkot" in [_ALL_MODEL_NAMES[i].lower() for i in VEHICLE_CLASSES]
    payload = {
        "url": TUNNEL_URL,
        "info": {
            "gpu": gpu_name,
            "vram_gb": vram,
            "model": os.path.basename(MODEL_PATH),
            "indonesia_model": is_indo,
        },
    }
    for attempt in range(5):
        try:
            r = requests.post(f"{BACKEND_URL}/api/gpu-register", json=payload, timeout=10)
            if r.status_code == 200:
                print(f"[GPU Service] ✅ Registered: {r.json()}")
                return
        except Exception as e:
            print(f"[GPU Service] Register attempt {attempt+1} error: {e}")
        time.sleep(5 * (attempt + 1))

def _heartbeat_loop():
    while True:
        time.sleep(HB_INTERVAL)
        try:
            r = requests.post(f"{BACKEND_URL}/api/gpu-heartbeat", timeout=5)
            if r.status_code != 200:
                print(f"[GPU Service] Heartbeat HTTP {r.status_code}")
        except Exception as e:
            print(f"[GPU Service] Heartbeat error: {e}")
            _register()

if __name__ == "__main__":
    threading.Thread(target=_start_tunnel, daemon=True).start()
    threading.Thread(target=_heartbeat_loop, daemon=True).start()
    print(f"[GPU Service] Starting FastAPI on port {PORT}...")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
