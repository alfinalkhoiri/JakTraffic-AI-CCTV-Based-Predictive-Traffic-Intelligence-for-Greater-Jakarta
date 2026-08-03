"""
JakTraffic GPU Inference Service v4
- NVIDIA L40S 48.3 GB VRAM — fully utilized
- ByteTrack per-camera multi-object tracking
- /detect-batch  : N kamera dalam 1 GPU forward pass (batch size up to 32)
- /track         : single-frame tracking + speed dari displacement
- Speed estimation via track centroid displacement (menggantikan optical flow)
- Auto-register + heartbeat ke backend JakTraffic
"""

import subprocess, sys, os, time, threading, requests, uvicorn
import base64, re, json
from collections import defaultdict, deque
from typing import List, Optional

def _pip(*pkgs):
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", *pkgs])

try:
    from ultralytics import YOLO
except ImportError:
    _pip("ultralytics"); from ultralytics import YOLO

try:
    import torch
except ImportError:
    _pip("torch"); import torch

try:
    import supervision as sv
except ImportError:
    _pip("supervision>=0.21.0"); import supervision as sv

try:
    import numpy as np
except ImportError:
    _pip("numpy"); import numpy as np

try:
    import cv2
except ImportError:
    _pip("opencv-python-headless"); import cv2

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Config ─────────────────────────────────────────────────────────────────────
PORT         = 8765
BACKEND_URL  = "https://jaktrafficai.f-mc.my.id"

# Prioritas model: yolo11x Indonesia → yolo11s Indonesia → yolo11x COCO
_MODEL_CANDIDATES = [
    "/home/jovyan/jaktraffic_yolo11x.pt",   # lokasi standar
    "/tmp/jaktraffic_yolo11x.pt",
    "/home/jovyan/jaktraffic_pseudo/runs/detect/runs/jaktraffic_yolo11x_20260802_1103/weights/best.pt",
    "/home/jovyan/jaktraffic_yolo.pt",
    "/tmp/jaktraffic_yolo.pt",
]
MODEL_PATH = next((p for p in _MODEL_CANDIDATES if os.path.exists(p)), "yolo11x.pt")
HB_INTERVAL  = 30
BATCH_SIZE   = 24    # L40S 48 GB: yolo11x ~28 GB @ batch 32 → aman di batch 24
PIX_PER_M    = 8.0   # pixel per meter (default, bisa dikalibrasi per kamera)
TRACK_HIST   = 15    # frame history per track untuk speed estimation
TUNNEL_URL   = None

# ── Load model ─────────────────────────────────────────────────────────────────
print(f"[GPU v4] Loading model: {MODEL_PATH}")
if not os.path.exists(MODEL_PATH):
    print(f"[GPU v4] {MODEL_PATH} tidak ditemukan, pakai yolo11x.pt")
    MODEL_PATH = "yolo11x.pt"

model  = YOLO(MODEL_PATH)
device = "cuda" if torch.cuda.is_available() else "cpu"
model.to(device)
# Warmup untuk menghindari cold-start latency pada inferensi pertama
if device == "cuda":
    dummy = torch.zeros(1, 3, 640, 640, device=device)
    model.model(dummy)
    print("[GPU v4] CUDA warmup selesai")
print(f"[GPU v4] Model: {os.path.basename(MODEL_PATH)} — {device.upper()} — {len(model.names)} class")

# ── Vehicle class mapping ───────────────────────────────────────────────────────
VEHICLE_KW = {
    "car","truck","bus","motorcycle","bicycle","motorbike","van","pickup",
    "mobil","motor","truk","sepeda","minibus",
    "angkot","bajaj","becak","gerobak",
}
_NAMES          = model.names
VEHICLE_CLASSES = [i for i, n in _NAMES.items() if n.lower() in VEHICLE_KW]
IS_INDO         = "angkot" in [_NAMES[i].lower() for i in VEHICLE_CLASSES]
print(f"[GPU v4] Kelas kendaraan ({len(VEHICLE_CLASSES)}): {[_NAMES[i] for i in VEHICLE_CLASSES]}")

# ── Per-camera ByteTrack state ──────────────────────────────────────────────────
_trackers: dict[int, sv.ByteTrack] = {}
_track_hist: dict[int, dict]       = {}   # cam_id → {track_id: deque[(cx,cy,ts)]}
_track_lock = threading.Lock()

def _tracker(cam_id: int) -> sv.ByteTrack:
    if cam_id not in _trackers:
        _trackers[cam_id] = sv.ByteTrack(
            track_activation_threshold=0.25,
            lost_track_buffer=30,
            minimum_matching_threshold=0.8,
            frame_rate=5,
        )
        _track_hist[cam_id] = defaultdict(lambda: deque(maxlen=TRACK_HIST))
    return _trackers[cam_id]

def _update_tracks(cam_id: int, boxes, ts: float):
    """Update ByteTrack dan simpan histori posisi centroid."""
    if boxes is None or len(boxes) == 0:
        return
    dets = sv.Detections(
        xyxy       = boxes.xyxy.cpu().numpy(),
        confidence = boxes.conf.cpu().numpy(),
        class_id   = boxes.cls.cpu().numpy().astype(int),
    )
    with _track_lock:
        trk  = _tracker(cam_id)
        hist = _track_hist[cam_id]
    tracked = trk.update_with_detections(dets)
    if tracked.tracker_id is None:
        return
    with _track_lock:
        for i, tid in enumerate(tracked.tracker_id):
            x1, y1, x2, y2 = tracked.xyxy[i]
            cx = float((x1 + x2) / 2)
            cy = float((y1 + y2) / 2)
            hist[int(tid)].append((cx, cy, ts))

def _speed_from_tracks(cam_id: int) -> Optional[float]:
    """Hitung kecepatan rata-rata dari displacement centroid track (km/h)."""
    with _track_lock:
        hist = dict(_track_hist.get(cam_id, {}))
    speeds = []
    for pts in hist.values():
        if len(pts) < 3:
            continue
        p0, pn = pts[0], pts[-1]
        dt = pn[2] - p0[2]
        if dt < 0.2:
            continue
        px_disp = ((pn[0]-p0[0])**2 + (pn[1]-p0[1])**2) ** 0.5
        if px_disp < 3:
            continue
        kmh = (px_disp / PIX_PER_M) / dt * 3.6
        if 1 < kmh < 150:
            speeds.append(kmh)
    return round(sum(speeds)/len(speeds), 1) if speeds else None

# ── Helpers ─────────────────────────────────────────────────────────────────────
def _b64_to_img(b64: str):
    data = base64.b64decode(b64)
    arr  = np.frombuffer(data, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)

def _img_to_b64(img) -> str:
    _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])
    return base64.b64encode(buf).decode()

def _cls_counts(boxes) -> dict:
    counts = {}
    if boxes.cls is not None:
        for c in boxes.cls.cpu().numpy().astype(int):
            n = _NAMES.get(c, str(c))
            counts[n] = counts.get(n, 0) + 1
    return counts

# ── FastAPI ─────────────────────────────────────────────────────────────────────
app = FastAPI(title="JakTraffic GPU Inference v4")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class FrameItem(BaseModel):
    cam_id:    int
    image_b64: str           # JPEG → base64
    timestamp: float = 0.0   # unix epoch

class BatchRequest(BaseModel):
    frames: List[FrameItem]
    conf:   float = 0.15
    iou:    float = 0.45

@app.get("/health")
def health():
    try:
        import pynvml; pynvml.nvmlInit()
        h    = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(h)
        mem  = pynvml.nvmlDeviceGetMemoryInfo(h)
        vram      = round(mem.total / 1e9, 1)
        vram_used = round(mem.used  / 1e9, 1)
        vram_free = round(mem.free  / 1e9, 1)
    except Exception:
        name = device.upper(); vram = vram_used = vram_free = 0
    return {
        "status": "ok", "version": "v4",
        "gpu": name, "vram_gb": vram,
        "vram_used_gb": vram_used, "vram_free_gb": vram_free,
        "model": os.path.basename(MODEL_PATH), "model_path": MODEL_PATH,
        "vehicle_classes": [_NAMES[i] for i in VEHICLE_CLASSES],
        "is_indonesia_model": IS_INDO,
        "active_trackers": len(_trackers),
        "batch_size_max": BATCH_SIZE,
        "batch_capable": True,
    }

@app.post("/detect-batch")
async def detect_batch(req: BatchRequest):
    """
    Proses N kamera dalam SATU GPU forward pass.
    Jauh lebih efisien dari N /detect terpisah.
    Mendukung ByteTrack per kamera + speed estimation.
    """
    if not req.frames:
        return {"results": [], "batch_size": 0, "total_inference_ms": 0}

    ts_now = time.time()

    # Decode semua frame (paralel bisa tapi decode cepat)
    imgs, valid_idx = [], []
    for i, f in enumerate(req.frames):
        img = _b64_to_img(f.image_b64)
        if img is not None:
            imgs.append(cv2.resize(img, (640, 640)))
            valid_idx.append(i)

    if not imgs:
        return {"results": [{"cam_id": f.cam_id, "error": "decode failed"} for f in req.frames]}

    t0 = time.time()
    # SATU forward pass untuk semua frame
    all_results = model(
        imgs,
        classes=VEHICLE_CLASSES,
        conf=req.conf, iou=req.iou,
        verbose=False,
    )
    total_ms = round((time.time() - t0) * 1000, 1)

    output = [None] * len(req.frames)
    for result, vi in zip(all_results, valid_idx):
        fi    = req.frames[vi]
        cam_id = fi.cam_id
        ts    = fi.timestamp or ts_now
        boxes = result.boxes
        count = len(boxes)

        # Update ByteTrack
        _update_tracks(cam_id, boxes, ts)
        speed = _speed_from_tracks(cam_id) if count >= 2 else None

        cls_c     = _cls_counts(boxes)
        ann_b64   = _img_to_b64(result.plot())

        output[vi] = {
            "cam_id":        cam_id,
            "vehicle_count": count,
            "class_counts":  cls_c,
            "speed_kmh":     speed,
            "annotated_image": ann_b64,
        }

    # Fill frame yang gagal decode
    for i, o in enumerate(output):
        if o is None:
            output[i] = {"cam_id": req.frames[i].cam_id, "error": "decode failed",
                         "vehicle_count": 0, "class_counts": {}, "speed_kmh": None}

    return {
        "results":            output,
        "batch_size":         len(imgs),
        "total_inference_ms": total_ms,
        "ms_per_frame":       round(total_ms / max(len(imgs), 1), 1),
    }

@app.post("/detect")
async def detect(file: UploadFile = File(...)):
    """Legacy single-frame endpoint — backward compatible."""
    data = await file.read()
    arr  = np.frombuffer(data, np.uint8)
    img  = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Cannot decode image")
    t0      = time.time()
    results = model(img, classes=VEHICLE_CLASSES, conf=0.15, iou=0.45, verbose=False)
    ms      = round((time.time() - t0) * 1000, 1)
    boxes   = results[0].boxes
    count   = len(boxes)
    _, buf  = cv2.imencode(".jpg", results[0].plot(), [cv2.IMWRITE_JPEG_QUALITY, 80])
    return {
        "vehicle_count":   count,
        "class_counts":    _cls_counts(boxes),
        "annotated_image": base64.b64encode(buf).decode(),
        "inference_ms":    ms,
    }

@app.delete("/trackers/{cam_id}")
def reset_tracker(cam_id: int):
    """Reset ByteTrack state untuk satu kamera (debug/calibrate)."""
    with _track_lock:
        _trackers.pop(cam_id, None)
        _track_hist.pop(cam_id, None)
    return {"reset": cam_id}

@app.get("/trackers")
def list_trackers():
    """Daftar kamera yang sedang ditrack."""
    with _track_lock:
        info = {
            cam_id: {
                "active_tracks": len(h),
                "total_points": sum(len(v) for v in h.values()),
            }
            for cam_id, h in _track_hist.items()
        }
    return {"trackers": info, "count": len(info)}

# ── Training YOLO11l ───────────────────────────────────────────────────────────
TRAIN_LOG  = "/tmp/jak_train.log"
TRAIN_SCRIPT = "/tmp/jak_train.py"

_train_state = {
    "status":   "idle",          # idle | running | done | error
    "progress": "",
    "started":  None,
    "elapsed":  None,
    "pid":      None,
}
_train_proc = None

@app.get("/train/status")
def train_status():
    s = dict(_train_state)
    if s["started"]:
        s["elapsed"] = round(time.time() - s["started"])
    # Baca 30 baris terakhir log
    try:
        with open(TRAIN_LOG, "r") as f:
            lines = f.readlines()
            s["log_tail"] = "".join(lines[-30:])
    except Exception:
        s["log_tail"] = ""
    # Cek apakah proses masih jalan
    global _train_proc
    if _train_proc and _train_proc.poll() is not None:
        if _train_state["status"] == "running":
            rc = _train_proc.returncode
            _train_state["status"] = "done" if rc == 0 else "error"
            _train_state["progress"] = "Selesai!" if rc == 0 else f"Error (exit {rc})"
        s["status"]   = _train_state["status"]
        s["progress"] = _train_state["progress"]
    return s

@app.get("/train/check")
def train_check():
    """Cek apakah environment siap untuk training."""
    import glob
    dataset_dir = "/home/jovyan/jaktraffic/dataset_merged"
    yaml_files  = glob.glob(f"{dataset_dir}/*.yaml")
    vram_gb     = 0.0
    try:
        import pynvml; pynvml.nvmlInit()
        h    = pynvml.nvmlDeviceGetHandleByIndex(0)
        mem  = pynvml.nvmlDeviceGetMemoryInfo(h)
        vram_gb = round(mem.free / 1e9, 1)
    except Exception:
        pass
    return {
        "dataset_found":  bool(yaml_files),
        "dataset_dir":    dataset_dir,
        "yaml_file":      yaml_files[0] if yaml_files else None,
        "vram_free_gb":   vram_gb,
        "train_ready":    bool(yaml_files) and vram_gb > 10,
        "train_status":   _train_state["status"],
    }

@app.post("/train/start")
def start_training(dataset: str = "/home/jovyan/jaktraffic/dataset_merged"):
    """Mulai training YOLO11l di background. Download script dari backend, lalu run."""
    global _train_proc
    if _train_state["status"] == "running":
        return {"ok": False, "msg": "Training sudah berjalan"}

    def _run():
        global _train_proc
        _train_state["status"]  = "running"
        _train_state["started"] = time.time()
        _train_state["pid"]     = None
        try:
            # Download training script
            _train_state["progress"] = "Mengunduh training script..."
            import urllib.request
            urllib.request.urlretrieve(f"{BACKEND_URL}/api/training/yolo11x", TRAIN_SCRIPT)
            _train_state["progress"] = "Training dimulai..."
            with open(TRAIN_LOG, "w") as log:
                _train_proc = subprocess.Popen(
                    [sys.executable, TRAIN_SCRIPT, "--dataset", dataset, "--batch", "16"],
                    stdout=log, stderr=log,
                )
                _train_state["pid"] = _train_proc.pid
                _train_proc.wait()
            rc = _train_proc.returncode
            if rc == 0:
                _train_state["status"]   = "done"
                _train_state["progress"] = "Training selesai! Model diupload ke backend."
            else:
                _train_state["status"]   = "error"
                _train_state["progress"] = f"Proses keluar dengan kode {rc}. Cek log."
        except Exception as e:
            _train_state["status"]   = "error"
            _train_state["progress"] = str(e)

    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True, "msg": "Training dimulai di background", "log": TRAIN_LOG}

@app.post("/train/stop")
def stop_training():
    global _train_proc
    if _train_proc and _train_proc.poll() is None:
        _train_proc.terminate()
        _train_state["status"]   = "idle"
        _train_state["progress"] = "Dihentikan oleh operator"
        return {"ok": True, "msg": "Training dihentikan"}
    return {"ok": False, "msg": "Tidak ada training yang berjalan"}

# ── Cloudflare Tunnel ──────────────────────────────────────────────────────────
def _start_tunnel():
    global TUNNEL_URL
    cf = "/tmp/cloudflared"
    if not os.path.exists(cf):
        cf = "cloudflared"
    proc = subprocess.Popen(
        [cf, "tunnel", "--url", f"http://localhost:{PORT}", "--no-autoupdate"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    for line in proc.stdout:
        m = re.search(r"https://[^\s]+\.trycloudflare\.com", line)
        if m:
            TUNNEL_URL = m.group(0)
            print(f"[GPU v4] Tunnel: {TUNNEL_URL}")
            _register()
            break
    proc.wait()

def _register():
    if not TUNNEL_URL:
        return
    try:
        import pynvml; pynvml.nvmlInit()
        h    = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(h)
        mem  = pynvml.nvmlDeviceGetMemoryInfo(h)
        vram = round(mem.total / 1e9, 1)
    except Exception:
        name = "NVIDIA L40S"; vram = 48.3
    for attempt in range(5):
        try:
            r = requests.post(f"{BACKEND_URL}/api/gpu-register", json={
                "url": TUNNEL_URL,
                "info": {
                    "gpu": name, "vram_gb": vram,
                    "model": os.path.basename(MODEL_PATH),
                    "indonesia_model": IS_INDO,
                    "version": "v4",
                    "batch_capable": True,
                    "batch_size_max": BATCH_SIZE,
                },
            }, timeout=10)
            if r.status_code == 200:
                print(f"[GPU v4] Registered: {r.json()}")
                return
        except Exception as e:
            print(f"[GPU v4] Register err {attempt+1}: {e}")
        time.sleep(5 * (attempt + 1))

def _heartbeat():
    while True:
        time.sleep(HB_INTERVAL)
        try:
            requests.post(f"{BACKEND_URL}/api/gpu-heartbeat",
                          json={"url": TUNNEL_URL}, timeout=5)
        except Exception:
            _register()

@app.post("/model/push")
async def model_push():
    """Push model aktif ke backend (/api/yolo-model/upload) untuk backup permanen."""
    if not os.path.exists(MODEL_PATH):
        return {"error": f"Model tidak ditemukan: {MODEL_PATH}"}
    try:
        size_mb = round(os.path.getsize(MODEL_PATH) / 1e6, 2)
        val = model.val(verbose=False) if hasattr(model, "val") else None
        map50    = round(float(val.box.map50), 4) if val else 0.0
        map50_95 = round(float(val.box.map),   4) if val else 0.0
        with open(MODEL_PATH, "rb") as f:
            r = requests.post(
                f"{BACKEND_URL}/api/yolo-model/upload",
                headers={"X-Upload-Token": "jaktraffic2026"},
                files={"model": (os.path.basename(MODEL_PATH), f, "application/octet-stream")},
                data={
                    "map50": str(map50), "map50_95": str(map50_95),
                    "classes": ",".join(_NAMES.values()),
                    "version": "indonesia-finetune-v1",
                },
                timeout=300,
            )
        return {"ok": r.status_code == 200, "size_mb": size_mb,
                "backend_response": r.json(), "map50": map50}
    except Exception as e:
        return {"error": str(e)}

@app.get("/model/info")
async def model_info():
    """Info model aktif di GPU service."""
    return {
        "model": os.path.basename(MODEL_PATH),
        "path":  MODEL_PATH,
        "size_mb": round(os.path.getsize(MODEL_PATH) / 1e6, 2) if os.path.exists(MODEL_PATH) else 0,
        "classes": list(_NAMES.values()),
        "is_indonesia_model": IS_INDO,
        "n_classes": len(_NAMES),
    }

if __name__ == "__main__":
    threading.Thread(target=_start_tunnel, daemon=True).start()
    threading.Thread(target=_heartbeat,   daemon=True).start()
    print(f"[GPU v4] FastAPI on :{PORT} — batch_size={BATCH_SIZE}")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
