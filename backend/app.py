from flask import Flask, jsonify, render_template, request, send_file
from flask_cors import CORS
from flask_socketio import SocketIO
from apscheduler.schedulers.background import BackgroundScheduler
import concurrent.futures
from concurrent.futures import ThreadPoolExecutor, as_completed
import logging
from datetime import datetime, timedelta
from core.scoring import evaluate_now_vs_usual, calculate_decision
from database.db_handler import get_usual_traffic
import requests
import psycopg2.extras
import os
import json
import ast
import difflib
import shutil
import tempfile
import time
import subprocess
import random
import threading
import math

# ── Timezone helper ──────────────────────────────────────────────────────────
WIB_OFFSET = timedelta(hours=7)   # Jakarta = UTC+7

def _jak_now() -> datetime:
    """Real current time in WIB (UTC+7). Always uses wall clock, never simulation time."""
    return datetime.utcnow() + WIB_OFFSET

def _jak_hour() -> int:
    """Current hour in WIB (UTC+7) — real clock, not simulation time."""
    return _jak_now().hour

# SumoPod (OpenAI-compatible) config
SUMOPOD_API_KEY = os.environ.get("SUMOPOD_API_KEY", "")
SUMOPOD_URL     = os.environ.get("SUMOPOD_URL", "https://ai.sumopod.com/v1/chat/completions")
SUMOPOD_MODEL   = os.environ.get("SUMOPOD_MODEL", "gpt-5-nano")

# TomTom Traffic API
TOMTOM_API_KEY      = os.environ.get("TOMTOM_API_KEY", "")
_TOMTOM_FLOW_CACHE  = {}          # key → {ts, data}
_TOMTOM_INC_CACHE   = {"ts": 0, "data": []}
TOMTOM_CACHE_TTL    = 60          # seconds — flow cache TTL
TOMTOM_INC_TTL      = 120         # seconds — incidents cache TTL
JAKARTA_BBOX        = "106.6,-6.4,107.1,-6.05"


def _tomtom_flow(lat, lng):
    """Fetch TomTom Traffic Flow Segment Data for a road point. Returns dict or None."""
    if not TOMTOM_API_KEY:
        return None
    cache_key = f"{round(lat, 4)},{round(lng, 4)}"
    now = time.time()
    if cache_key in _TOMTOM_FLOW_CACHE and now - _TOMTOM_FLOW_CACHE[cache_key]["ts"] < TOMTOM_CACHE_TTL:
        return _TOMTOM_FLOW_CACHE[cache_key]["data"]
    try:
        resp = requests.get(
            "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json",
            params={"point": f"{lat},{lng}", "key": TOMTOM_API_KEY},
            timeout=5,
        )
        if resp.ok:
            data = resp.json().get("flowSegmentData", {})
            _TOMTOM_FLOW_CACHE[cache_key] = {"ts": now, "data": data}
            return data
        logger.warning("TomTom flow HTTP %s for %s,%s", resp.status_code, lat, lng)
    except Exception as e:
        logger.warning("TomTom flow %s,%s: %s", lat, lng, e)
    return None


# --- IMPORT INTERNAL ---
from database import db_handler
from core.detector import VideoDetector
from core.predictor import TrafficPredictor

# --- FLASK SETUP ---
app = Flask(__name__)
CORS(app, origins="*")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading", logger=False, engineio_logger=False)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- INIT YOLO DETECTOR ---
detector = VideoDetector()

# ======================================================
# 🔁 BACKGROUND JOB: MINING DATA REALTIME (PARALLEL)
# ======================================================

def _simulate_vehicle_count(loc_id: int, ts: datetime = None) -> int:
    """Generate realistic Jakarta traffic counts when no stream URL is available.
    Uses time-of-day pattern (WIB = UTC+7) + per-location variation.
    """
    now = ts or datetime.utcnow()
    hour_wib = (now.hour + 7) % 24  # convert UTC → WIB

    # Pola volume kendaraan per jam (Jakarta)
    hourly_base = {
        0: 4, 1: 3, 2: 2, 3: 2, 4: 3, 5: 8,
        6: 18, 7: 38, 8: 42, 9: 32, 10: 22, 11: 20,
        12: 26, 13: 24, 14: 18, 15: 20, 16: 30,
        17: 44, 18: 46, 19: 38, 20: 28, 21: 18, 22: 12, 23: 7,
    }
    base = hourly_base.get(hour_wib, 10)

    # Smooth interpolation ke jam berikutnya
    next_base = hourly_base.get((hour_wib + 1) % 24, base)
    frac = (now.minute % 60) / 60.0
    interpolated = base + (next_base - base) * frac

    # Per-location offset (beberapa lokasi lebih ramai)
    loc_factor = 1.0 + math.sin(loc_id * 1.3) * 0.35

    # Noise deterministik per lokasi+menit agar tidak terlalu acak
    seed = loc_id * 1000 + now.hour * 60 + now.minute // 2
    rng = random.Random(seed)
    noise = rng.gauss(0, max(2, interpolated * 0.15))

    count = round(interpolated * loc_factor + noise)
    return max(0, count)


_BEKASI_PUBLIC_PREFIX = "https://jaktrafficai.f-mc.my.id/stream-proxy/bekasi/"
_BEKASI_INTERNAL_PREFIX = "http://localhost:18088/bekasi/"

def _resolve_stream_url(url: str) -> str:
    """Konversi URL publik Bekasi ke URL internal untuk cv2/YOLO backend."""
    if url and url.startswith(_BEKASI_PUBLIC_PREFIX):
        return _BEKASI_INTERNAL_PREFIX + url[len(_BEKASI_PUBLIC_PREFIX):]
    return url


def _process_single_camera(cctv, timestamp):
    """Proses satu kamera: baca stream, hitung kendaraan, simpan ke DB.
    Dipanggil dari thread pool — setiap thread membuka koneksi DB sendiri.
    Kamera dengan consecutive_errors ≥ 5 langsung pakai simulasi (skip stream).
    """
    loc_id = cctv.get("id")
    name = cctv.get("name", f"Lokasi {loc_id}")
    stream_url = _resolve_stream_url(cctv.get("stream_url"))
    try:
        ts_dt = datetime.strptime(timestamp, "%Y-%m-%d %H:%M:%S") if isinstance(timestamp, str) else timestamp
        consec_err = _cam_health.get(loc_id, {}).get("consecutive_errors", 0)
        if not stream_url or consec_err >= 5:
            # Skip stream — langsung simulasi agar tidak blocking thread pool
            vehicle_count = _simulate_vehicle_count(loc_id, ts_dt)
        else:
            yolo_count = detector.get_vehicle_count(stream_url, loc_id)
            if yolo_count is None:
                logger.warning(f"[YOLO] Lokasi {loc_id} ({name}): stream gagal, pakai simulasi")
                _cam_health_err(loc_id)
                vehicle_count = _simulate_vehicle_count(loc_id, ts_dt)
            else:
                _cam_health_ok(loc_id)
                vehicle_count = yolo_count
        # Hitung status dan risk_score berdasarkan jumlah kendaraan
        weather_text = cctv.get("weather") or "Cerah"
        new_status, _ = calculate_decision(vehicle_count, weather_text)
        risk = 0
        if vehicle_count > 40:
            risk = 60
        elif vehicle_count >= 20:
            risk = 20
        if "hujan" in weather_text.lower() or "rain" in weather_text.lower():
            risk = min(risk + 20, 100)
        elif "badai" in weather_text.lower() or "thunder" in weather_text.lower():
            risk = min(risk + 50, 100)

        db_handler.insert_log(loc_id, vehicle_count, timestamp)
        conn = db_handler.get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "UPDATE current_traffic SET vehicles = %s, status = %s, risk_score = %s, last_update = %s WHERE id = %s",
            (vehicle_count, new_status, risk, timestamp, loc_id)
        )
        conn.commit()
        conn.close()
        logger.info(f"Update Lokasi {loc_id} ({name}): {vehicle_count} kend → {new_status} (score={risk})")
        return loc_id, vehicle_count, None
    except Exception as e:
        logger.error(f"Gagal proses lokasi {loc_id} ({name}): {e}")
        return loc_id, 0, str(e)


def mining_job():
    import core.detector as _det
    gpu_ok = _det.get_gpu_url() and _det.is_gpu_healthy()

    cctv_list = db_handler.get_all_cctv_status()
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if gpu_ok:
        # GPU aktif → gpu_scan_job sudah handle kamera dengan stream.
        # mining_job hanya proses kamera TANPA stream (simulasi) agar tidak redundan.
        sim_cams = [c for c in cctv_list if not c.get("stream_url")]
        logger.info("[MiningJob] GPU aktif — skip %d kamera berstream, proses %d kamera simulasi",
                    len(cctv_list) - len(sim_cams), len(sim_cams))
        targets = sim_cams
    else:
        # GPU offline → proses semua kamera via CPU (fallback)
        logger.info("[MiningJob] GPU offline — proses %d kamera via CPU", len(cctv_list))
        targets = cctv_list

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(_process_single_camera, cctv, timestamp): cctv
            for cctv in targets
        }
        for future in as_completed(futures):
            try:
                future.result()
            except Exception as e:
                cctv = futures[future]
                logger.error(f"Thread error lokasi {cctv.get('id')}: {e}")

    logger.info("=== Mining selesai (%d kamera) ===", len(targets))

    # Push live update ke semua WebSocket client
    try:
        updated = db_handler.get_all_cctv_status()
        for row in (updated if isinstance(updated, list) else []):
            for k, v in list(row.items()):
                if isinstance(v, datetime):
                    row[k] = v.strftime("%Y-%m-%d %H:%M:%S")
        socketio.emit("traffic_update", updated)
    except Exception as _ws_err:
        logger.warning("[WS] emit error: %s", _ws_err)


# ── Camera Health (in-memory, updated setiap scan) ───────────────────────────
# cam_id → {last_seen, error_count, success_count, consecutive_errors, last_count}
_cam_health: dict = {}

def _cam_health_ok(cam_id: int):
    """Tandai kamera berhasil discan."""
    h = _cam_health.get(cam_id, {"error_count": 0, "success_count": 0, "consecutive_errors": 0})
    h["last_seen"]          = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    h["success_count"]      = h.get("success_count", 0) + 1
    h["consecutive_errors"] = 0
    _cam_health[cam_id]     = h

def _cam_health_err(cam_id: int):
    """Tandai kamera gagal discan."""
    h = _cam_health.get(cam_id, {"error_count": 0, "success_count": 0, "consecutive_errors": 0})
    h["error_count"]        = h.get("error_count", 0) + 1
    h["consecutive_errors"] = h.get("consecutive_errors", 0) + 1
    _cam_health[cam_id]     = h

# ── Incident Detection (in-memory, updated setiap scan) ──────────────────────
_incident_counters: dict = {}   # cam_id → {type: consecutive_cycles}
_active_incidents:  dict = {}   # cam_id → incident payload

_INC_CONFIRM = 3    # siklus berturut-turut sebelum insiden dikonfirmasi
_INC_RESOLVE = 2    # siklus normal berturut-turut sebelum insiden diselesaikan

def _run_incident_detection(cam_id: int, cam_name: str, lat: float, lng: float,
                             count: int, speed, prev_count: int) -> bool:
    """
    Analisis anomali untuk 1 kamera. Return True jika ada perubahan state insiden
    (baru muncul, berubah tipe, atau selesai) — trigger WebSocket emit.
    """
    c = _incident_counters.get(cam_id, {
        "kemacetan": 0, "lonjakan": 0, "vol_ekstrem": 0, "_normal": 0
    })
    spd = speed if isinstance(speed, (int, float)) else 999

    is_kemacetan  = count > 40 and spd < 8
    is_lonjakan   = prev_count > 5 and count > prev_count * 1.7 and count > 25
    is_vol_ext    = count > 65

    c["kemacetan"]  = c["kemacetan"]  + 1 if is_kemacetan else max(0, c["kemacetan"]  - 1)
    c["lonjakan"]   = c["lonjakan"]   + 1 if is_lonjakan  else max(0, c["lonjakan"]   - 1)
    c["vol_ekstrem"]= c["vol_ekstrem"]+ 1 if is_vol_ext   else max(0, c["vol_ekstrem"]- 1)
    c["_normal"]    = c["_normal"]    + 1 if not (is_kemacetan or is_lonjakan or is_vol_ext) else 0
    _incident_counters[cam_id] = c

    new_inc = None
    if c["kemacetan"] >= _INC_CONFIRM:
        new_inc = {"type": "kemacetan_total",   "label": "Kemacetan Total",   "severity": "critical", "color": "#ef4444"}
    elif c["vol_ekstrem"] >= _INC_CONFIRM:
        new_inc = {"type": "volume_ekstrem",    "label": "Volume Ekstrem",    "severity": "warning",  "color": "#f59e0b"}
    elif c["lonjakan"] >= _INC_CONFIRM:
        new_inc = {"type": "lonjakan_mendadak", "label": "Lonjakan Mendadak", "severity": "warning",  "color": "#f97316"}

    prev_inc = _active_incidents.get(cam_id)

    if prev_inc and c["_normal"] >= _INC_RESOLVE and new_inc is None:
        del _active_incidents[cam_id]
        return True   # resolved

    if new_inc:
        payload = {
            **new_inc,
            "cam_id": cam_id, "cam_name": cam_name,
            "lat": lat, "lng": lng,
            "vehicle_count": count, "speed_kmh": speed,
            "ts": time.time(),
        }
        if prev_inc is None or prev_inc.get("type") != new_inc["type"]:
            _active_incidents[cam_id] = payload
            return True   # new / type-changed
        # update angka tapi bukan state change
        _active_incidents[cam_id].update({"vehicle_count": count, "speed_kmh": speed})

    return False

# Init DB extensions
try:
    db_handler.init_extensions()
except Exception as _init_err:
    logger.warning("[init] DB extensions: %s", _init_err)

# ── GPU State ────────────────────────────────────────────────────────────────
_gpu_state = {
    "url": "",          # tidak pakai .env — wajib tunggu pod register via heartbeat/register
    "last_heartbeat": 0.0,
    "gpu_info": {},
    "scan_stats": {
        "last_scan": None,
        "cameras_scanned": 0,
        "errors": 0,
        "avg_count": 0.0,
    },
}


# ── GPU Background Camera Scanner ────────────────────────────────────────────
def gpu_scan_job():
    """
    Scan semua kamera dengan GPU v4 batch inference.
    Arsitektur baru:
      1. Grab semua frame paralel (I/O bound → ThreadPoolExecutor)
      2. Kirim SATU batch request ke GPU service
      3. GPU proses semua frame dalam 1 forward pass (jauh lebih efisien)
      4. Update DB paralel
    Sebelumnya: N HTTP requests → N GPU inferences (sequential per call)
    Sekarang  : 1 HTTP request  → 1 GPU batch forward pass (32x lebih cepat)
    """
    import core.detector as det
    import base64 as _b64

    if not det.is_gpu_healthy():
        logger.debug("[GPU Scanner] GPU tidak sehat, skip scan")
        return

    # Skip scan jika GPU sedang training — hindari VRAM contention
    # Jika check gagal (timeout/error), anggap training sedang jalan dan skip
    try:
        _tr = requests.get(f"{det.get_gpu_url()}/train/status", timeout=3)
        if not _tr.ok or _tr.json().get("status") == "running":
            logger.debug("[GPU Scanner] Training aktif di pod, skip scan")
            return
    except Exception:
        logger.debug("[GPU Scanner] Training status check gagal, skip scan")
        return

    try:
        conn = db_handler.get_db_connection()
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT id, name, stream_url, lat, lng FROM cctv_locations "
            "WHERE stream_url IS NOT NULL AND stream_url != '' "
            "ORDER BY id"
        )
        cameras = cur.fetchall()
        conn.close()
    except Exception as e:
        logger.error("[GPU Scanner] DB fetch error: %s", e)
        return

    if not cameras:
        return

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ts_unix   = time.time()
    scanned   = 0
    errors    = 0
    total_count = 0

    # ── Step 1: Grab semua frame secara paralel (I/O bound) ───────────────────
    def _grab(cam):
        from core.detector import _grab_frame
        try:
            frame = _grab_frame(_resolve_stream_url(cam["stream_url"]), timeout_s=4)
            if frame is not None:
                return {"cam_id": cam["id"], "cam": cam, "img": frame, "timestamp": ts_unix}
            else:
                _cam_health_err(cam["id"])
        except Exception as e:
            logger.warning("[GPU Scanner] grab cam %s: %s", cam.get("id"), e)
            _cam_health_err(cam["id"])
        return None

    # Batas waktu total fase grab: 50 detik untuk semua kamera.
    # Tidak pakai 'with' agar executor.shutdown(wait=False) — kamera yg belum selesai ditinggal.
    _GRAB_DEADLINE = 50
    ex = ThreadPoolExecutor(max_workers=24)
    futs = {ex.submit(_grab, cam): cam for cam in cameras}
    done, _ = concurrent.futures.wait(futs.keys(), timeout=_GRAB_DEADLINE)
    ex.shutdown(wait=False)   # jangan tunggu sisa thread — executor tasks sudah di-abandon
    grabbed = []
    for f in done:
        try:
            r = f.result()
            if r is not None:
                grabbed.append(r)
        except Exception:
            pass

    if not grabbed:
        logger.warning("[GPU Scanner] Tidak ada frame berhasil diambil")
        return

    logger.info("[GPU Scanner] Grabbed %d/%d frame (deadline %ds)",
                len(grabbed), len(cameras), _GRAB_DEADLINE)

    # ── Step 2 & 3: Kirim batch ke GPU — 1 forward pass untuk semua frame ─────
    CHUNK = 32   # sesuai BATCH_SIZE di gpu_service_v4 (VRAM L40S aman hingga 32)
    batch_results = []
    use_batch = False

    try:
        for i in range(0, len(grabbed), CHUNK):
            chunk = grabbed[i:i+CHUNK]
            res   = det.infer_batch_remote(chunk)
            batch_results.extend(res)
        use_batch = True
        logger.info("[GPU Scanner] Batch inference selesai — %d hasil", len(batch_results))
    except Exception as e:
        logger.warning("[GPU Scanner] Batch gagal (%s), fallback 1-by-1", e)

    # ── Fallback: jika batch endpoint belum ada (gpu_service v3) ──────────────
    if not use_batch:
        vdet = det.VideoDetector()
        for item in grabbed:
            try:
                count, _, _, _ = det._infer_remote(item["img"])
                batch_results.append({
                    "cam_id": item["cam_id"],
                    "vehicle_count": count,
                    "class_counts": {},
                    "speed_kmh": None,
                })
            except Exception as e:
                errors += 1
                logger.warning("[GPU Scanner] fallback cam %s: %s", item["cam_id"], e)

    # ── Step 4: Update DB paralel ──────────────────────────────────────────────
    cam_map = {c["id"]: c for c in cameras}

    def _update_db(res):
        nonlocal scanned, errors, total_count
        cam_id = res.get("cam_id")
        count  = res.get("vehicle_count", 0)
        speed  = res.get("speed_kmh")
        if count is None or "error" in res:
            return
        try:
            # Simpan annotated frame GPU ke disk sebagai fallback preview
            ann_b64 = res.get("annotated_image")
            if ann_b64:
                import base64 as _b64
                frame_path = os.path.join("/tmp/gpu_frames", f"{cam_id}.jpg")
                os.makedirs("/tmp/gpu_frames", exist_ok=True)
                with open(frame_path, "wb") as fh:
                    fh.write(_b64.b64decode(ann_b64))

            cam = cam_map.get(cam_id, {})
            _, new_status = calculate_decision(count, "Cerah"), calculate_decision(count, "Cerah")
            new_status = calculate_decision(count, "Cerah")[0]
            risk = min(60 if count > 40 else (20 if count >= 20 else 0), 100)
            db_handler.insert_log(cam_id, count, timestamp)
            conn2 = db_handler.get_db_connection()
            cur2  = conn2.cursor()
            cur2.execute(
                """UPDATE current_traffic
                   SET vehicles=%s, status=%s, risk_score=%s,
                       last_update=%s, last_gpu_scan=%s, speed_kmh=%s
                   WHERE id=%s""",
                (count, new_status, risk, timestamp, timestamp, speed, cam_id)
            )
            conn2.commit(); conn2.close()
            scanned     += 1
            total_count += count
            prev_count = _cam_health.get(cam_id, {}).get("last_count", 0)
            h = _cam_health.get(cam_id, {})
            h["last_count"] = count
            h["speed_kmh"]  = speed
            _cam_health_ok(cam_id)
            # Incident detection — emit jika ada perubahan state
            cam_info = cam_map.get(cam_id, {})
            inc_changed = _run_incident_detection(
                cam_id,
                cam_info.get("name", f"Kamera {cam_id}"),
                cam_info.get("lat") or 0.0,
                cam_info.get("lng") or 0.0,
                count, speed, prev_count,
            )
            if inc_changed:
                try:
                    socketio.emit("incident_alert", {
                        "incidents": list(_active_incidents.values()),
                        "cam_id":    cam_id,
                        "ts":        time.time(),
                    })
                except Exception:
                    pass
        except Exception as e:
            errors += 1
            _cam_health_err(cam_id)
            logger.warning("[GPU Scanner] DB update cam %s: %s", cam_id, e)

    with ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(_update_db, batch_results))

    avg = round(total_count / scanned, 1) if scanned else 0
    _gpu_state["scan_stats"].update({
        "last_scan":       timestamp,
        "cameras_scanned": scanned,
        "errors":          errors,
        "avg_count":       avg,
    })
    logger.info("[GPU Scanner] ✅ %d/%d kamera | avg %.1f kend | %d error | batch=%s",
                scanned, len(cameras), avg, errors, use_batch)

    try:
        updated = db_handler.get_all_cctv_status()
        # Konversi datetime ke string agar JSON-serializable
        for row in (updated if isinstance(updated, list) else []):
            for k, v in list(row.items()):
                if isinstance(v, datetime):
                    row[k] = v.strftime("%Y-%m-%d %H:%M:%S")
        socketio.emit("traffic_update", updated)
        socketio.emit("gpu_scan_complete", {
            "timestamp":       timestamp,
            "cameras_scanned": scanned,
            "avg_count":       avg,
            "batch_mode":      use_batch,
        })
    except Exception as e:
        logger.warning("[GPU Scanner] emit error: %s", e)


from core.dataset_collector import run_collection_round, get_stats as _ds_get_stats

def _dataset_collection_job():
    """Ambil 1 frame per kamera aktif, auto-label, simpan ke dataset/ setiap 30 menit."""
    run_collection_round(db_handler, detector.model)


def speed_estimation_job():
    """
    Estimasi kecepatan untuk 20 kamera tersibuk via optical flow (setiap 5 menit).
    GPU mode: delegasi ke /speed-batch — pod grab stream sendiri, paralel, ~90 detik.
    CPU fallback: optical flow lokal jika GPU offline.
    """
    try:
        conn = db_handler.get_db_connection()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT ct.id, ct.vehicles, cl.stream_url
            FROM current_traffic ct
            JOIN cctv_locations cl ON ct.id = cl.id
            WHERE cl.stream_url IS NOT NULL AND cl.stream_url != ''
              AND ct.vehicles >= 2
            ORDER BY ct.vehicles DESC
            LIMIT 20
        """)
        cameras = cur.fetchall()
        conn.close()
    except Exception as e:
        logger.error("[SpeedJob] DB error: %s", e)
        return

    import core.detector as _det
    gpu_url = _det.get_gpu_url()
    gpu_ok  = bool(gpu_url and _det.is_gpu_healthy())

    if gpu_ok:
        # GPU mode: filter kamera yang streamnya sering gagal (pod grab sendiri, mahal)
        healthy_cams = [
            c for c in cameras
            if _cam_health.get(c["id"], {}).get("consecutive_errors", 0) < 5
        ]
    else:
        # CPU fallback: pakai semua kamera, optical flow handle error per-kamera
        healthy_cams = cameras

    if not healthy_cams:
        logger.info("[SpeedJob] Tidak ada kamera dengan vehicles≥2 (%d tersedia)", len(cameras))
        return

    if gpu_ok:
        # Delegasi ke GPU service — pod grab stream sendiri, lebih efisien
        payload = {
            "cameras": [
                {"cam_id": c["id"], "stream_url": _resolve_stream_url(c["stream_url"])}
                for c in healthy_cams
            ],
            "pix_per_m": 8.0,
            "frame_gap_s": 1.0,
        }
        try:
            resp = requests.post(f"{gpu_url}/speed-batch", json=payload, timeout=120)
            resp.raise_for_status()
            results = resp.json().get("results", [])
            logger.info("[SpeedJob] GPU speed-batch: %d kamera → %d hasil",
                        len(healthy_cams), len(results))
        except Exception as e:
            logger.error("[SpeedJob] GPU speed-batch gagal: %s", e)
            results = []
    else:
        # CPU fallback — optical flow lokal (lebih lambat)
        results = []
        for cam in healthy_cams:
            try:
                spd = detector.estimate_speed(
                    _resolve_stream_url(cam["stream_url"]), cam["id"])
                results.append({"cam_id": cam["id"], "speed_kmh": spd, "ok": True})
            except Exception:
                pass

    updated = 0
    for res in results:
        speed = res.get("speed_kmh")
        if speed is None:
            continue
        cam_id = res["cam_id"]
        try:
            conn2 = db_handler.get_db_connection()
            cur2  = conn2.cursor()
            cur2.execute("UPDATE current_traffic SET speed_kmh=%s WHERE id=%s",
                         (speed, cam_id))
            conn2.commit(); conn2.close()
            h = _cam_health.get(cam_id, {})
            h["speed_kmh"] = speed
            _cam_health[cam_id] = h
            updated += 1
        except Exception as e:
            logger.debug("[SpeedJob] DB update cam %s: %s", cam_id, e)

    logger.info("[SpeedJob] Speed diperbarui %d/%d kamera (via %s)",
                updated, len(healthy_cams), "GPU" if gpu_ok else "CPU")


scheduler = BackgroundScheduler()
scheduler.add_job(func=mining_job,  trigger="interval", minutes=2,  max_instances=1, coalesce=True)
scheduler.add_job(func=gpu_scan_job, trigger="interval", seconds=60, max_instances=1, coalesce=True, id="gpu_scanner")
scheduler.add_job(func=speed_estimation_job, trigger="interval", minutes=5,
                  max_instances=1, coalesce=True, id="speed_estimator")
scheduler.add_job(func=_dataset_collection_job, trigger="interval", minutes=30,
                  max_instances=1, coalesce=True, id="dataset_collector",
                  next_run_time=datetime.now())   # jalankan langsung saat start
scheduler.start()

logger.info("✅ Mode LIVE aktif — Mining & YOLO diaktifkan. Data diperbarui setiap 2 menit (4 parallel workers).")
logger.info("✅ GPU Scanner aktif — scan %d kamera JTD setiap 60 detik jika GPU online.", 0)
logger.info("✅ Dataset Collector aktif — ambil frame tiap 30 menit, auto-label dengan YOLO.")


def _ts_str(v):
    """Konversi datetime object atau string ke format string timestamp."""
    if v is None:
        return None
    if isinstance(v, str):
        return v
    return v.strftime("%Y-%m-%d %H:%M:%S")


def _dict_cur(conn):
    return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

# --- INIT PREDICTOR ---
predictor = TrafficPredictor()


def sync_current_traffic():
    """
    Sync current_traffic.vehicles dengan nilai aktual di traffic_logs
    pada waktu last_update (jam 18:00), bukan data lama.
    """
    conn = db_handler.get_db_connection()
    cur = _dict_cur(conn)

    cur.execute("SELECT id, last_update FROM current_traffic")
    rows = cur.fetchall()

    updated = 0
    for row in rows:
        loc_id      = row["id"]
        last_update = row["last_update"]
        if not last_update:
            continue

        cur.execute("""
            SELECT vehicles FROM traffic_logs
            WHERE location_id = %s
              AND timestamp <= %s
            ORDER BY timestamp DESC
            LIMIT 1
        """, (loc_id, last_update))
        log_row = cur.fetchone()
        if log_row:
            cur.execute(
                "UPDATE current_traffic SET vehicles = %s WHERE id = %s",
                (log_row["vehicles"], loc_id)
            )
            updated += 1

    conn.commit()
    cur.close()
    conn.close()
    logger.info(f"[sync] current_traffic.vehicles diperbarui dari traffic_logs untuk {updated} lokasi.")


# Sinkronisasi otomatis saat backend start
sync_current_traffic()

# ── Camera snapshot proxy cache ────────────────────────────────────────────
_SNAP_INDEX_CACHE  = {"ts": 0, "data": {}}   # cam_path → latest thumb URL
_SNAP_IMAGE_CACHE  = {}                        # cam_path → {ts, bytes, ct}
SNAP_INDEX_TTL     = 30    # detik — refresh URL index
SNAP_IMAGE_TTL     = 12    # detik — cache bytes gambar

def _refresh_snap_index():
    """Scrape lewatmana.com homepage untuk URL snapshot terbaru semua kamera."""
    import re as _re
    now = time.time()
    if now - _SNAP_INDEX_CACHE["ts"] < SNAP_INDEX_TTL and _SNAP_INDEX_CACHE["data"]:
        return _SNAP_INDEX_CACHE["data"]
    # /traffic/ redirects to homepage — use homepage directly
    for url in ["https://lewatmana.com/", "https://www.lewatmana.com/"]:
        try:
            resp = requests.get(url, timeout=10, allow_redirects=True,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                         "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"})
            pattern = r'media\.lewatmana\.com/cam/([^/]+)/(\d+)/([^\s"\'<>]+-thumb\.jpg)'
            cam_map = {}
            for cat, cid, fname in _re.findall(pattern, resp.text):
                cam_map[f"{cat}/{cid}"] = f"https://media.lewatmana.com/cam/{cat}/{cid}/{fname}"
            if cam_map:
                _SNAP_INDEX_CACHE["ts"]   = now
                _SNAP_INDEX_CACHE["data"] = cam_map
                logger.info("[snapshot] index refreshed: %d cameras from %s", len(cam_map), url)
                return cam_map
        except Exception as e:
            logger.warning("[snapshot] index refresh failed (%s): %s", url, e)
    return _SNAP_INDEX_CACHE["data"]

# ======================================================
# 🌍 ROUTES
# ======================================================
@app.route("/")
def index():
    return render_template("index.html")

# ======================================================
# 📍 CCTV REALTIME (MAP + SIDEBAR)
# ======================================================
@app.route("/api/cctv_status")
def cctv_status():
    return jsonify(db_handler.get_all_cctv_status())


_WEATHER_CACHE = {"ts": 0, "data": None}
WEATHER_TTL    = 1800  # 30 menit

@app.route("/api/weather-jakarta")
def weather_jakarta():
    """Cuaca terkini Jakarta via wttr.in (no API key, cache 30 menit)."""
    now = time.time()
    if _WEATHER_CACHE["data"] and now - _WEATHER_CACHE["ts"] < WEATHER_TTL:
        return jsonify(_WEATHER_CACHE["data"])
    try:
        r = requests.get(
            "https://wttr.in/Jakarta?format=j1", timeout=10,
            headers={"User-Agent": "JakTrafficAI/1.0 (traffic monitoring)"}
        )
        if not r.ok:
            raise ValueError(f"HTTP {r.status_code}")
        raw   = r.json()
        cond  = raw["current_condition"][0]
        rain  = float(cond.get("precipMM", 0))
        cloud = int(cond.get("cloudcover", 0))
        data  = {
            "temp_c":      int(cond["temp_C"]),
            "feels_c":     int(cond.get("FeelsLikeC", cond["temp_C"])),
            "humidity":    int(cond["humidity"]),
            "description": cond["weatherDesc"][0]["value"],
            "rain_mm":     rain,
            "wind_kmph":   int(cond["windspeedKmph"]),
            "cloud_pct":   cloud,
            "is_raining":  rain > 0,
            "heavy_rain":  rain >= 5,
            "icon":        "🌧️" if rain >= 5 else "🌦️" if rain > 0 else ("🌤️" if cloud < 50 else "☁️"),
        }
        _WEATHER_CACHE["ts"]   = now
        _WEATHER_CACHE["data"] = data
        return jsonify(data)
    except Exception as e:
        logger.warning("[weather] %s", e)
        # Return safe default — bukan error agar frontend tetap berjalan
        return jsonify({"rain_mm": 0, "is_raining": False, "heavy_rain": False,
                        "temp_c": 30, "description": "N/A", "icon": "🌤️", "error": str(e)})


@app.route("/api/report-incident", methods=["POST"])
def report_incident():
    """Terima laporan insiden dari user di lapangan."""
    data = request.json or {}
    inc_type = data.get("type", "Tidak diketahui")
    desc     = data.get("description", "")
    lat      = data.get("lat", 0)
    lng      = data.get("lng", 0)
    ts       = data.get("timestamp", "")
    logger.info("[SOS] Insiden=%s | lat=%s,lng=%s | %s | %s", inc_type, lat, lng, ts, desc[:100])
    # Simpan ke log (bisa juga dikirim ke email/webhook di sini)
    return jsonify({"success": True, "message": f"Laporan '{inc_type}' diterima, terima kasih."})


@app.route("/api/cameras-live")
def cameras_live():
    """Daftar kamera yang saat ini tersedia dari lewatmana.com."""
    cam_map = _refresh_snap_index()
    return jsonify({"cameras": list(cam_map.keys()), "count": len(cam_map)})


@app.route("/api/camera-snapshot/<path:cam_path>")
def camera_snapshot(cam_path):
    """
    Proxy snapshot terbaru dari lewatmana.com.
    cam_path contoh: lintek/192  atau  kotabekasi/366
    """
    from flask import send_file
    import io

    now = time.time()

    # Cek cache gambar
    cached = _SNAP_IMAGE_CACHE.get(cam_path)
    if cached and now - cached["ts"] < SNAP_IMAGE_TTL:
        resp = app.response_class(cached["data"], mimetype="image/jpeg")
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Cache-Control"]               = f"public, max-age={SNAP_IMAGE_TTL}"
        return resp

    # Ambil URL snapshot terbaru dari index
    cam_map  = _refresh_snap_index()
    thumb_url = cam_map.get(cam_path)

    if not thumb_url:
        return jsonify({"error": "camera not in index", "available": list(cam_map.keys())}), 404

    try:
        img_r = requests.get(
            thumb_url, timeout=10,
            headers={"User-Agent": "Mozilla/5.0 Chrome/124",
                     "Referer": "https://www.lewatmana.com/"}
        )
        if img_r.status_code != 200:
            return jsonify({"error": f"upstream {img_r.status_code}"}), 502

        _SNAP_IMAGE_CACHE[cam_path] = {"ts": now, "data": img_r.content}
        resp = app.response_class(img_r.content, mimetype="image/jpeg")
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Cache-Control"]               = f"public, max-age={SNAP_IMAGE_TTL}"
        return resp

    except Exception as e:
        logger.error("[snapshot] fetch failed %s: %s", cam_path, e)
        return jsonify({"error": str(e)}), 502


@app.route("/api/gpu-frame/<int:cam_id>")
def gpu_frame(cam_id):
    """Frame terakhir dari GPU scan — fallback preview saat stream HLS tidak bisa dibuka."""
    frame_path = f"/tmp/gpu_frames/{cam_id}.jpg"
    if not os.path.exists(frame_path):
        return jsonify({"error": "frame not available"}), 404
    age = time.time() - os.path.getmtime(frame_path)
    if age > 1800:  # lebih dari 30 menit → terlalu lama
        return jsonify({"error": "frame too old"}), 404
    resp = send_file(frame_path, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    # Header usia frame agar frontend bisa tampilkan waktu snapshot
    resp.headers["X-Frame-Age-Seconds"] = str(int(age))
    return resp

# ======================================================
# 🕐 SIMULASI: SET/GET WAKTU SIMULASI
# ======================================================
@app.route("/api/sim-time-range", methods=["GET"])
def sim_time_range():
    """
    Kembalikan range timestamp yang tersedia di traffic_logs
    dan current_time simulasi sekarang (last_update di current_traffic).
    """
    conn = db_handler.get_db_connection()
    cur  = _dict_cur(conn)
    cur.execute("SELECT MIN(timestamp) AS mn, MAX(timestamp) AS mx FROM traffic_logs")
    row = cur.fetchone()
    cur.execute("SELECT last_update FROM current_traffic LIMIT 1")
    cur_row = cur.fetchone()
    cur.close()
    conn.close()
    return jsonify({
        "min_timestamp": _ts_str(row["mn"]) if row else None,
        "max_timestamp": _ts_str(row["mx"]) if row else None,
        "current_sim_time": _ts_str(cur_row["last_update"]) if cur_row else None,
    })


@app.route("/api/set-sim-time", methods=["POST"])
def set_sim_time():
    """
    Ganti waktu simulasi ke timestamp yang diminta user.
    Body: { "timestamp": "YYYY-MM-DD HH:MM:SS" }
    atau { "time": "HH:MM" }  ← pakai tanggal dari entry terakhir traffic_logs

    Langkah:
    1. Validasi timestamp ada di range traffic_logs
    2. Update last_update di semua current_traffic
    3. Sync vehicles dari traffic_logs pada waktu itu
    """
    data = request.json or {}
    raw_ts = data.get("timestamp") or data.get("time", "")
    if not raw_ts:
        return jsonify({"error": "Parameter 'timestamp' atau 'time' diperlukan"}), 400

    conn = db_handler.get_db_connection()
    cur  = _dict_cur(conn)

    # Dapatkan range traffic_logs
    cur.execute("SELECT MIN(timestamp) AS mn, MAX(timestamp) AS mx FROM traffic_logs")
    rng = cur.fetchone()
    if not rng or not rng["mn"]:
        cur.close()
        conn.close()
        return jsonify({"error": "Tidak ada data di traffic_logs"}), 404

    # Parse timestamp — jika hanya jam:menit, gabungkan dengan tanggal dari MAX timestamp
    from datetime import datetime as _dt
    target_dt = None

    # Coba parse berbagai format
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            target_dt = _dt.strptime(raw_ts.strip(), fmt)
            break
        except ValueError:
            pass

    if target_dt is None:
        # Coba format HH:MM atau HH:MM:SS saja
        for fmt in ("%H:%M:%S", "%H:%M"):
            try:
                t = _dt.strptime(raw_ts.strip(), fmt)
                cur.execute("SELECT last_update FROM current_traffic WHERE last_update IS NOT NULL LIMIT 1")
                sim_row = cur.fetchone()
                if sim_row and sim_row["last_update"]:
                    lu = sim_row["last_update"]
                    base_dt = lu if isinstance(lu, _dt) else _dt.strptime(_ts_str(lu)[:10], "%Y-%m-%d")
                    base_dt = base_dt.replace(hour=0, minute=0, second=0, microsecond=0)
                else:
                    mn = rng["mn"]
                    base_dt = mn if isinstance(mn, _dt) else _dt.strptime(_ts_str(mn)[:10], "%Y-%m-%d")
                    base_dt = base_dt.replace(hour=0, minute=0, second=0, microsecond=0)
                target_dt = base_dt.replace(hour=t.hour, minute=t.minute, second=0)
                break
            except ValueError:
                pass

    if target_dt is None:
        cur.close()
        conn.close()
        return jsonify({"error": f"Format timestamp tidak dikenal: '{raw_ts}'. Gunakan HH:MM atau YYYY-MM-DD HH:MM"}), 400

    target_str = target_dt.strftime("%Y-%m-%d %H:%M:%S")

    # Cek apakah ada data di traffic_logs sekitar waktu itu (±60 menit)
    cur.execute("""
        SELECT COUNT(*) AS cnt FROM traffic_logs
        WHERE timestamp BETWEEN (%s::timestamp - INTERVAL '60 minutes')
                            AND (%s::timestamp + INTERVAL '60 minutes')
    """, (target_str, target_str))
    cnt_row = cur.fetchone()
    if not cnt_row or cnt_row["cnt"] == 0:
        cur.close()
        conn.close()
        return jsonify({
            "error": f"Tidak ada data traffic_logs di sekitar waktu {target_str}",
            "available_range": {"from": _ts_str(rng["mn"]), "to": _ts_str(rng["mx"])},
        }), 404

    # Update last_update di semua current_traffic
    cur.execute("UPDATE current_traffic SET last_update = %s", (target_str,))

    # Sync vehicles dari traffic_logs pada waktu itu
    cur.execute("SELECT id FROM current_traffic")
    loc_ids = [r["id"] for r in cur.fetchall()]
    synced = 0
    for loc_id in loc_ids:
        cur.execute("""
            SELECT vehicles FROM traffic_logs
            WHERE location_id = %s AND timestamp <= %s
            ORDER BY timestamp DESC LIMIT 1
        """, (loc_id, target_str))
        log_row = cur.fetchone()
        if log_row:
            cur.execute("UPDATE current_traffic SET vehicles = %s WHERE id = %s",
                        (log_row["vehicles"], loc_id))
            synced += 1

    conn.commit()
    cur.close()
    conn.close()

    logger.info("set-sim-time: waktu simulasi diubah ke %s (%d lokasi disync)", target_str, synced)
    return jsonify({
        "success": True,
        "sim_time": target_str,
        "synced_locations": synced,
        "message": f"Waktu simulasi berhasil diubah ke {target_str}. {synced} lokasi disync.",
    })


# ======================================================
# 📊 HISTORY API (UNTUK CHART)
# ======================================================
@app.route("/api/traffic-history/<int:location_id>")
def traffic_history(location_id):

    range_param = request.args.get("range", "30m")

    delta_map = {
        "30m": timedelta(minutes=30),
        "1h": timedelta(hours=1),
        "6h": timedelta(hours=6),
        "12h": timedelta(hours=12),
        "24h": timedelta(hours=24)
    }

    delta = delta_map.get(range_param, timedelta(minutes=30))
    time_fmt = "%H:%M" if range_param in ["30m", "1h"] else "%Y-%m-%d %H:00"

    conn = db_handler.get_db_connection()
    cur = _dict_cur(conn)

    cur.execute(
        "SELECT last_update FROM current_traffic WHERE id = %s",
        (location_id,)
    )
    ref_row = cur.fetchone()
    ref_dt = None
    if ref_row and ref_row["last_update"]:
        lu = ref_row["last_update"]
        ref_dt = lu if isinstance(lu, datetime) else datetime.strptime(_ts_str(lu), "%Y-%m-%d %H:%M:%S")

    if ref_dt is None:
        cur.execute(
            "SELECT MAX(timestamp) AS latest FROM traffic_logs WHERE location_id = %s",
            (location_id,)
        )
        max_row = cur.fetchone()
        if max_row and max_row["latest"]:
            lu = max_row["latest"]
            ref_dt = lu if isinstance(lu, datetime) else datetime.strptime(_ts_str(lu), "%Y-%m-%d %H:%M:%S")

    if ref_dt is None:
        ref_dt = datetime.now()

    end_time   = ref_dt.strftime("%Y-%m-%d %H:%M:%S")
    start_time = (ref_dt - delta).strftime("%Y-%m-%d %H:%M:%S")

    pg_fmt = "HH24:MI" if range_param in ["30m", "1h"] else "YYYY-MM-DD HH24:00"

    cur.execute(f"""
        SELECT
            TO_CHAR(timestamp, '{pg_fmt}') AS label,
            AVG(vehicles) AS avg_vehicle
        FROM traffic_logs
        WHERE location_id = %s
          AND timestamp >= %s
          AND timestamp <= %s
        GROUP BY label
        ORDER BY label
    """, (location_id, start_time, end_time))

    rows = cur.fetchall()

    if not rows:
        limit_map = {"30m": 30, "1h": 60, "6h": 72, "12h": 144, "24h": 288}
        limit = limit_map.get(range_param, 30)

        cur.execute(f"""
            SELECT
                TO_CHAR(timestamp, '{pg_fmt}') AS label,
                AVG(vehicles) AS avg_vehicle,
                MAX(timestamp) AS latest_ts
            FROM traffic_logs
            WHERE location_id = %s
              AND timestamp IS NOT NULL
              AND timestamp <= %s
            GROUP BY label
            ORDER BY latest_ts DESC
            LIMIT %s
        """, (location_id, end_time, limit))

        rows = list(reversed(cur.fetchall()))

    cur.close()
    conn.close()

    return jsonify([
        {"label": r["label"], "avg_vehicle": int(r["avg_vehicle"])}
        for r in rows
    ])

# ======================================================
# ENDPOINT NOW VS USUAL
# ======================================================
@app.route("/api/now-vs-usual/<int:location_id>")
def now_vs_usual(location_id):
    conn = db_handler.get_db_connection()
    cur = _dict_cur(conn)

    # NOW
    cur.execute("""
        SELECT vehicles
        FROM current_traffic
        WHERE id = %s
    """, (location_id,))
    row = cur.fetchone()

    if not row:
        cur.close()
        conn.close()
        return jsonify({"error": "Location not found"}), 404

    now_value = row["vehicles"]

    # USUAL (fungsi kamu yang sudah ada)
    usual_value = get_usual_traffic(location_id)

    cur.close()
    conn.close()

    current_hour = _jak_hour()

    result = evaluate_now_vs_usual(
        now=now_value,
        usual=usual_value,
        hour=current_hour
    )

    result["location_id"] = location_id
    return jsonify(result)

# ======================================================
#  ADD CAMERA
# ======================================================
@app.route("/api/add-camera", methods=["POST"])
def add_camera():
    data = request.json

    name = data.get("name")
    stream_url = data.get("url")
    lat = data.get("lat")
    lng = data.get("lng")

    if not all([name, stream_url, lat, lng]):
        return jsonify({"error": "Invalid payload"}), 400

    conn = db_handler.get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        INSERT INTO current_traffic (name, stream_url, lat, lng, vehicles, last_update)
        VALUES (%s, %s, %s, %s, 0, %s)
    """, (
        name,
        stream_url,
        lat,
        lng,
        datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ))

    conn.commit()
    cur.close()
    conn.close()

    return jsonify({"status": "ok"})

# ======================================================
# UPDATE CAMERA
# ======================================================
@app.route("/api/update-camera/<int:camera_id>", methods=["PUT"])
def update_camera(camera_id):
    data = request.json

    conn = db_handler.get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        UPDATE current_traffic
        SET name = %s, stream_url = %s, lat = %s, lng = %s
        WHERE id = %s
    """, (
        data.get("name"),
        data.get("url"),
        data.get("lat"),
        data.get("lng"),
        camera_id
    ))

    conn.commit()
    cur.close()
    conn.close()

    return jsonify({"status": "updated"})


# ======================================================
# DELETE CAMERA (OPTIONAL)
# ======================================================
@app.route("/api/delete-camera/<int:camera_id>", methods=["DELETE"])
def delete_camera(camera_id):
    conn = db_handler.get_db_connection()
    cur = conn.cursor()

    cur.execute("DELETE FROM current_traffic WHERE id = %s", (camera_id,))
    conn.commit()
    cur.close()
    conn.close()

    return jsonify({"status": "deleted"})

# ======================================================
# 1 HOUR PREDICTION
# ======================================================
@app.route("/api/predict-next-hour/<int:location_id>")
def predict_next_hour(location_id):
    conn = db_handler.get_db_connection()
    cur = _dict_cur(conn)

    # NOW
    cur.execute(
        "SELECT vehicles FROM current_traffic WHERE id = %s",
        (location_id,)
    )
    row = cur.fetchone()
    if not row:
        cur.close()
        conn.close()
        return jsonify({"error": "Not found"}), 404

    now_val = int(row["vehicles"] or 0)

    next_hour = (_jak_hour() + 1) % 24
    usual_next = float(db_handler.get_hourly_usual_traffic(location_id, next_hour) or 0)

    predicted = int((0.6 * usual_next) + (0.4 * now_val))
    delta_pct = ((predicted - now_val) / max(now_val, 1)) * 100

    if delta_pct > 30:
        status = "POTENTIAL_JAM"
        label = "Berpotensi Macet"
        confidence = "HIGH"
    elif delta_pct > 10:
        status = "DENSE"
        label = "Berpotensi Padat"
        confidence = "MEDIUM"
    else:
        status = "SMOOTH"
        label = "Diperkirakan Lancar"
        confidence = "HIGH"

    return jsonify({
        "location_id": location_id,
        "now": now_val,
        "predicted": predicted,
        "next_hour": next_hour,
        "next_hour_label": f"{String(next_hour).zfill(2)}:00" if False else f"{next_hour:02d}:00",
        "change_percent": round(delta_pct, 1),
        "status": status,
        "label": label,
        "confidence": confidence,
        "note": "Prediksi berbasis pola historis dan tren jam serupa"
    })


# ======================================================
# 🔮 PREDICT TRAFFIC (TRANSFORMER)
# ======================================================
@app.route("/api/predict-traffic")
def predict_traffic():
    horizon = request.args.get("horizon", "15")
    if horizon not in ("15", "30"):
        return jsonify({"error": "horizon must be 15 or 30"}), 400

    horizon_int = int(horizon)
    cctv_list = db_handler.get_all_cctv_status()
    predictions = []

    for cctv in cctv_list:
        loc_id = cctv["id"]
        last_update = cctv.get("last_update")

        # Get last 60 records for this location up to last_update
        conn = db_handler.get_db_connection()
        cur = _dict_cur(conn)

        if last_update:
            cur.execute("""
                SELECT vehicles, timestamp
                FROM traffic_logs
                WHERE location_id = %s AND timestamp IS NOT NULL AND timestamp <= %s
                ORDER BY timestamp DESC
                LIMIT 60
            """, (loc_id, last_update))
        else:
            cur.execute("""
                SELECT vehicles, timestamp
                FROM traffic_logs
                WHERE location_id = %s AND timestamp IS NOT NULL
                ORDER BY timestamp DESC
                LIMIT 60
            """, (loc_id,))

        rows = cur.fetchall()
        cur.close()
        conn.close()

        # Reverse to chronological order
        history = [(r["vehicles"], _ts_str(r["timestamp"])) for r in reversed(rows)]

        pred = predictor.predict(loc_id, history)

        if pred:
            predicted_vehicles = pred[f"pred_{horizon_int}min"]
        else:
            # Fallback: use current value
            predicted_vehicles = cctv.get("vehicles", 0)

        # Determine status
        if predicted_vehicles > 30:
            status = "PADAT"
        elif predicted_vehicles > 15:
            status = "RAMAI"
        else:
            status = "LANCAR"

        predictions.append({
            "location_id": loc_id,
            "name": cctv.get("name", f"Lokasi {loc_id}"),
            "lat": cctv.get("lat"),
            "lng": cctv.get("lng"),
            "current_vehicles": cctv.get("vehicles", 0),
            "predicted_vehicles": predicted_vehicles,
            "status": status,
        })

    return jsonify({
        "horizon": horizon_int,
        "predictions": predictions
    })


# ======================================================
# 🗨️ CHAT API
# ======================================================

def get_traffic_context_for_chat():
    """
    Query traffic_system.db dan kembalikan konteks lalu lintas lengkap:
    - Kondisi terkini tiap lokasi
    - Statistik (total, max, min, rata-rata)
    - Tren 1 jam terakhir (per lokasi)
    - Waktu server
    """
    try:
        conn = db_handler.get_db_connection()
        cur = _dict_cur(conn)
        server_now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 1. Data current traffic
        cur.execute("SELECT id, name, vehicles, last_update FROM current_traffic ORDER BY vehicles DESC")
        current_rows = cur.fetchall()

        # Cari last_update terbaru dari semua lokasi — ini adalah waktu data terakhir
        latest_update_str = None
        latest_update_dt  = None
        for r in current_rows:
            lu = r['last_update']
            if not lu:
                continue
            try:
                lu_dt = lu if isinstance(lu, datetime) else datetime.strptime(_ts_str(lu), "%Y-%m-%d %H:%M:%S")
                if latest_update_dt is None or lu_dt > latest_update_dt:
                    latest_update_dt  = lu_dt
                    latest_update_str = _ts_str(lu)
            except Exception:
                pass

        # Hitung waktu prediksi berdasarkan last_update (bukan datetime.now())
        if latest_update_dt:
            pred_15_str = (latest_update_dt + timedelta(minutes=15)).strftime("%H:%M")
            pred_30_str = (latest_update_dt + timedelta(minutes=30)).strftime("%H:%M")
            data_ref_str = latest_update_dt.strftime("%Y-%m-%d %H:%M:%S")
        else:
            # Fallback ke waktu server jika tidak ada last_update
            latest_update_dt  = datetime.now()
            data_ref_str = server_now_str
            pred_15_str = (latest_update_dt + timedelta(minutes=15)).strftime("%H:%M")
            pred_30_str = (latest_update_dt + timedelta(minutes=30)).strftime("%H:%M")

        # 2. Log terbaru — ambil berdasarkan last_update, bukan datetime.now()
        cur.execute("""
            SELECT tl.location_id, ct.name, tl.vehicles, tl.timestamp
            FROM traffic_logs tl
            JOIN current_traffic ct ON tl.location_id = ct.id
            WHERE tl.timestamp >= (%s::timestamp - INTERVAL '1 hour')
              AND tl.timestamp <= %s
            ORDER BY tl.timestamp DESC
            LIMIT 120
        """, (data_ref_str, data_ref_str))
        log_rows = cur.fetchall()

        # 3. Rata-rata tiap lokasi 1 jam terakhir (relatif ke data_ref)
        cur.execute("""
            SELECT ct.name, AVG(tl.vehicles) as avg_v, MAX(tl.vehicles) as max_v, MIN(tl.vehicles) as min_v
            FROM traffic_logs tl
            JOIN current_traffic ct ON tl.location_id = ct.id
            WHERE tl.timestamp >= (%s::timestamp - INTERVAL '1 hour')
              AND tl.timestamp <= %s
            GROUP BY tl.location_id, ct.name
            ORDER BY avg_v DESC
        """, (data_ref_str, data_ref_str))
        stat_rows = cur.fetchall()

        # 4. Metadata database penuh — range & statistik historis
        cur.execute("""
            SELECT MIN(timestamp) mn, MAX(timestamp) mx,
                   COUNT(*) total_rows,
                   COUNT(DISTINCT timestamp::date) total_days
            FROM traffic_logs
        """)
        meta = cur.fetchone()

        # 5. Statistik per hari (avg kendaraan semua lokasi)
        cur.execute("""
            SELECT TO_CHAR(timestamp, 'YYYY-MM-DD') AS day,
                   AVG(vehicles) avg_v, MAX(vehicles) peak_v,
                   COUNT(*) rows
            FROM traffic_logs
            GROUP BY day
            ORDER BY day
        """)
        daily_rows = cur.fetchall()

        # 6. Jam tersibuk secara historis (per lokasi)
        cur.execute("""
            SELECT ct.name, tl.timestamp, tl.vehicles
            FROM traffic_logs tl
            JOIN current_traffic ct ON tl.location_id = ct.id
            ORDER BY tl.vehicles DESC
            LIMIT 5
        """)
        peak_rows = cur.fetchall()

        cur.close()
        conn.close()

        # --- Format current traffic ---
        current_lines = [
            f"  {'🔴' if r['vehicles'] >= 20 else '🟡' if r['vehicles'] >= 10 else '🟢'} "
            f"{r['name']}: {r['vehicles']} kendaraan (update: {_ts_str(r['last_update'])})"
            for r in current_rows
        ]
        current_text = "\n".join(current_lines) if current_lines else "  (tidak ada data)"

        # --- Ringkasan statistik ---
        if current_rows:
            total    = sum(r['vehicles'] for r in current_rows)
            max_loc  = current_rows[0]
            min_loc  = current_rows[-1]
            avg_all  = total / len(current_rows)
            stat_summary = (
                f"  Total kendaraan semua lokasi : {total}\n"
                f"  Rata-rata per lokasi         : {avg_all:.1f}\n"
                f"  Paling padat  : {max_loc['name']} ({max_loc['vehicles']} kendaraan)\n"
                f"  Paling sepi   : {min_loc['name']} ({min_loc['vehicles']} kendaraan)"
            )
        else:
            stat_summary = "  (tidak ada data statistik)"

        # --- Tren 1 jam (per lokasi) ---
        trend_lines = [
            f"  {r['name']}: avg={r['avg_v']:.1f}, max={r['max_v']}, min={r['min_v']}"
            for r in stat_rows
        ] if stat_rows else ["  (belum ada data 1 jam terakhir)"]
        trend_text = "\n".join(trend_lines)

        # --- Log terbaru (15 entri ringkas) ---
        log_lines = [
            f"  [{r['timestamp']}] {r['name']}: {r['vehicles']}"
            for r in log_rows[:15]
        ]
        log_text = "\n".join(log_lines) if log_lines else "  (tidak ada log)"

        # --- Metadata database ---
        if meta and meta['mn']:
            db_meta_text = (
                f"  Range data : {_ts_str(meta['mn'])}  s/d  {_ts_str(meta['mx'])}\n"
                f"  Total data : {meta['total_rows']:,} baris ({meta['total_days']} hari)\n"
                f"  Interval   : 1 menit per lokasi (8 lokasi)"
            )
        else:
            db_meta_text = "  (tidak ada data)"

        # --- Statistik per hari ---
        daily_lines = [
            f"  {r['day']}: avg={r['avg_v']:.1f} kendaraan/menit, peak={r['peak_v']}, rows={r['rows']:,}"
            for r in daily_rows
        ] if daily_rows else ["  (tidak ada)"]
        daily_text = "\n".join(daily_lines)

        # --- Momen paling padat sepanjang sejarah ---
        peak_lines = [
            f"  [{r['timestamp']}] {r['name']}: {r['vehicles']} kendaraan"
            for r in peak_rows
        ] if peak_rows else ["  (tidak ada)"]
        peak_text = "\n".join(peak_lines)

        context = (
            f"=== DATA LALU LINTAS DKI JAKARTA (MODE SIMULASI) ===\n"
            f"Waktu data aktif (last_update): {data_ref_str}\n"
            f"Waktu server saat ini         : {server_now_str}\n"
            f"[PENTING] Sistem berjalan dalam MODE SIMULASI — data historis, bukan real-time.\n"
            f"Prediksi model dihitung dari waktu data terakhir:\n"
            f"  → Prediksi 15 menit = {pred_15_str}\n"
            f"  → Prediksi 30 menit = {pred_30_str}\n\n"
            f"[DATABASE — INFORMASI LENGKAP]\n{db_meta_text}\n\n"
            f"[STATISTIK PER HARI (seluruh database)]\n{daily_text}\n\n"
            f"[5 MOMEN PALING PADAT SEPANJANG SEJARAH]\n{peak_text}\n\n"
            f"[KONDISI TERKINI — diurutkan dari terpadat]\n{current_text}\n\n"
            f"[STATISTIK KESELURUHAN]\n{stat_summary}\n\n"
            f"[TREN 1 JAM TERAKHIR — per lokasi (relatif ke last_update)]\n{trend_text}\n\n"
            f"[LOG TERBARU (15 entri)]\n{log_text}\n"
            f"=== AKHIR DATA ===\n"
        )
        return context

    except Exception as e:
        logger.warning("get_traffic_context_for_chat failed: %s", e)
        return ""




@app.route("/api/chat", methods=["POST"])
def chat_proxy():
    data = request.json or {}
    message  = data.get("message", "")
    mode     = data.get("mode", "chat")
    history  = data.get("history", [])   # list of {role, content} — dari frontend

    # Log incoming chat requests for easier debugging
    logger.info("Chat request received: mode=%s turns=%d message=%s",
                mode, len(history), (message[:200] + '...') if len(message) > 200 else message)

    # ── EDIT MODE ──────────────────────────────────────────────────────────
    if mode == "edit":
        edit_messages = [
            {"role": "system", "content": (
                "You are a careful assistant that outputs concise, structured JSON instructions "
                "for minimal, safe code changes when asked to modify UI or data. "
                "Respond with a plain-text JSON object containing keys: summary, changes. "
                "Each change should be an object with: path (relative to project root), and either 'content' "
                "(the full file content to write) OR 'patch' (a unified diff). Prefer 'content' when possible."
            )},
            {"role": "user", "content": message},
        ]
        try:
            logger.info("SumoPod edit mode request model=%s", SUMOPOD_MODEL)
            resp = requests.post(
                SUMOPOD_URL,
                headers=_sumopod_headers(),
                json={"model": SUMOPOD_MODEL, "messages": edit_messages, "stream": True},
                timeout=90,
                stream=True,
            )
            if resp.ok:
                text = _collect_openai_stream(resp)
                return jsonify({"reply": text})
            else:
                logger.warning("SumoPod returned status %s: %s", resp.status_code, resp.text[:200])
        except Exception:
            logger.exception("SumoPod proxy failed (edit mode)")

        fallback = {"summary": "LLM unavailable. Provide instructions offline.", "changes": []}
        return jsonify({"reply": str(fallback)})

    # ── TIME CHANGE INTENT (sebelum LLM) ───────────────────────────────────
    time_reply = detect_and_apply_time_change(message)
    if time_reply:
        return jsonify({"reply": time_reply})

    # ── CHAT MODE ──────────────────────────────────────────────────────────
    db_context   = get_traffic_context_for_chat()
    pred_context = get_prediction_context_for_chat(message)
    system_content = (
        "Kamu adalah asisten AI cerdas untuk sistem Smart Traffic Monitoring kota DKI Jakarta.\n"
        "Kamu bisa menjawab berbagai jenis pertanyaan:\n"
        "  1. Kondisi lalu lintas real-time (padat/sepi, jumlah kendaraan, lokasi, tren)\n"
        "  2. Prediksi kondisi lalu lintas 15–30 menit ke depan (menggunakan Transformer AI)\n"
        "  3. Perbandingan antar lokasi\n"
        "  4. Saran rute berdasarkan kepadatan\n"
        "  5. Pertanyaan umum seputar lalu lintas DKI Jakarta\n"
        "  6. Pertanyaan umum lainnya (cuaca, tips berkendara, dll)\n"
        "Selalu jawab dalam Bahasa Indonesia yang jelas dan informatif.\n"
        "Jika ada data traffic tersedia, gunakan data itu untuk menjawab secara spesifik.\n"
        "Jangan menolak pertanyaan — selalu berikan jawaban terbaik yang bisa kamu berikan.\n"
        "ATURAN PREDIKSI WAKTU: Sistem berjalan dalam MODE SIMULASI (data historis, tidak real-time).\n"
        "Ketika pengguna bertanya tentang kondisi lalu lintas ke depan (nanti, X menit lagi, dll),\n"
        "WAJIB gunakan data dari blok [PREDIKSI TRANSFORMER AI] jika tersedia.\n"
        "WAJIB sebutkan nama lokasi spesifik dan jumlah kendaraan prediksinya.\n"
        "WAJIB sebutkan lokasi mana yang paling padat dan paling sepi berdasarkan angka prediksi.\n"
        "Format jawaban prediksi: sebutkan top 3 terpadat dengan nama + angka kendaraan prediksi.\n"
        "JANGAN memberi jawaban umum/generik jika data prediksi sudah tersedia.\n"
        + (f"\n{db_context}" if db_context else "")
        + (pred_context if pred_context else "")
    )

    # ── CHAT MODE: SumoPod multi-turn ──────────────────────────────────
    messages_payload = [{"role": "system", "content": system_content}]
    for turn in history[-10:]:
        role    = turn.get("role", "user")
        content = str(turn.get("content", ""))
        if role in ("user", "assistant") and content:
            messages_payload.append({"role": role, "content": content})
    messages_payload.append({"role": "user", "content": message})

    try:
        logger.info("SumoPod chat request (%d turns) model=%s", len(history), SUMOPOD_MODEL)
        resp = requests.post(
            SUMOPOD_URL,
            headers=_sumopod_headers(),
            json={"model": SUMOPOD_MODEL, "messages": messages_payload, "stream": False},
            timeout=90,
        )
        if resp.ok:
            data_j = resp.json()
            text = (data_j.get("choices") or [{}])[0].get("message", {}).get("content", "")
            return jsonify({"reply": text})
        else:
            logger.warning("SumoPod returned status %s: %s", resp.status_code, resp.text[:300])
    except Exception:
        logger.exception("SumoPod chat failed")

    return jsonify({"reply": f"(LLM tidak tersedia) Echo: {message}"})


# ======================================================
# 🟢 LLM STATUS CHECK
# ======================================================
@app.route("/api/llm-status", methods=["GET"])
def llm_status():
    """Ping SumoPod untuk cek koneksi LLM. Timeout singkat agar tidak memblok UI."""
    try:
        resp = requests.post(
            SUMOPOD_URL,
            headers=_sumopod_headers(),
            json={"model": SUMOPOD_MODEL, "messages": [{"role": "user", "content": "ping"}], "stream": False},
            timeout=8,
        )
        if resp.ok:
            return jsonify({"online": True, "model": SUMOPOD_MODEL, "provider": "SumoPod"})
        else:
            return jsonify({"online": False, "model": SUMOPOD_MODEL, "error": f"HTTP {resp.status_code}"})
    except requests.exceptions.Timeout:
        return jsonify({"online": False, "model": SUMOPOD_MODEL, "error": "SumoPod timeout"})
    except Exception as exc:
        return jsonify({"online": False, "model": SUMOPOD_MODEL, "error": str(exc)})


# ======================================================
# 🗺️  MAP INTENT DETECTION
# ======================================================

# Mapping nama/alias lokasi Jakarta → location_id
LOCATION_ALIASES = {
    # ID 1 — Bendungan Hilir
    "bendungan hilir": 1, "benhil": 1,
    # ID 2 — Gelora
    "gelora": 2, "gelora bung karno": 2, "gbk": 2, "senayan gelora": 2,
    # ID 3 — Tanjung Duren
    "tanjung duren": 3, "tanjdur": 3,
    # ID 4 — Tomang
    "tomang": 4,
    # ID 5 — Jati Pulo
    "jati pulo": 5, "jatipulo": 5,
    # ID 6 — Kemanggisan
    "kemanggisan": 6,
    # ID 7 — Menteng
    "menteng": 7,
    # ID 8 — Pasar Manggis
    "pasar manggis": 8, "manggis": 8,
    # ID 9 — Senayan
    "senayan": 9,
    # ID 10 — Kuningan Barat
    "kuningan barat": 10, "kuningan": 10,
    # ID 11 — Cikoko
    "cikoko": 11,
    # ID 12 — Cengkareng Barat
    "cengkareng barat": 12, "cengkareng": 12,
    # ID 14 — Gambir
    "gambir": 14, "stasiun gambir": 14,
    # ID 15 — Cempaka Putih
    "cempaka putih": 15, "cempaka": 15,
    # ID 16 — Rawa Sari
    "rawa sari": 16, "rawasari": 16,
    # ID 17 — Kalideres
    "kalideres": 17,
    # ID 18 — Penjaringan
    "penjaringan": 18,
    # ID 19 — Meruya Selatan
    "meruya selatan": 19, "meruya": 19,
    # ID 20 — Ragunan
    "ragunan": 20, "kebun binatang": 20,
    # ID 21 — Lebak Bulus
    "lebak bulus": 21, "lebakbulus": 21,
    # ID 22 — Grogol Utara
    "grogol utara": 22, "grogol": 22,
    # ID 23 — Jatinegara
    "jatinegara": 23,
    # ID 24 — Kampung Melayu
    "kampung melayu": 24, "kampungmelayu": 24,
    # ID 25 — Cakung Timur
    "cakung timur": 25, "cakung": 25,
    # ID 26 — Kelapa Gading
    "kelapa gading": 26,
    # ID 27 — Sunter Jaya
    "sunter jaya": 27, "sunter": 27,
    # ID 28 — Sunter Agung
    "sunter agung": 28,
    # ID 29 — Tol KG-PG Kayu Putih
    "kayu putih": 29, "tol kayu putih": 29,
    # ID 30 — Tol KG-PG Pulo Gadung
    "pulo gadung": 30, "pulogadung": 30,
    # ID 31 — Tol KG-PG Rawa Terate
    "rawa terate": 31, "rawaterate": 31,
    # ID 32 — Tol KG-PG Cakung 1
    "cakung 1": 32,
    # ID 33 — Tol KG-PG Cakung 2
    "cakung 2": 33,
    # ID 34 — Tol KG-PG Kelapa Gading
    "tol kelapa gading": 34,
    # ID 35 — Tol BCKM Cawang
    "cawang": 35, "tol cawang": 35, "bckm cawang": 35,
    # ID 36 — Tol BCKM Duren Sawit
    "duren sawit": 36, "durensawit": 36,
    # ID 37 — Tol BCKM Bekasi Barat
    "bekasi barat": 37, "tol bekasi barat": 37,
    # ── Bekasi ──────────────────────────────────────────────────────────────
    # ID 38 — Simpang Lima Bekasi
    "simpang lima bekasi": 38, "simpang lima": 38, "simpang bekasi": 38,
    # ID 39 — Jl. Ahmad Yani - Kayuringin
    "kayuringin": 39, "ahmad yani bekasi": 39, "yani kayuringin": 39,
    # ID 40 — Jl. Cut Meutia - KH Noer Ali
    "cut meutia": 40, "noer ali": 40, "kh noer ali": 40,
    # ID 41 — Jl. Sudirman Bekasi
    "sudirman bekasi": 41,
    # ID 42 — Jl. Raya Bekasi - Sumber Arta
    "sumber arta": 42, "raya bekasi sumber arta": 42,
    # ID 43 — Tol Bekasi Timur
    "bekasi timur": 43, "tol bekasi timur": 43,
    # ID 44 — Jl. Raya Jatiwaringin
    "jatiwaringin": 44, "raya jatiwaringin": 44,
    # ID 45 — Harapan Indah
    "harapan indah": 45, "harapan indah bekasi": 45,
    # ID 46 — Pondok Gede
    "pondok gede": 46,
    # ID 47 — Jl. Raya Babelan
    "babelan": 47, "raya babelan": 47,
    # ID 48 — Lingkar Selatan Bekasi
    "lingkar selatan bekasi": 48, "lingkar selatan": 48,
    # ID 49 — Kranji Bekasi Barat
    "kranji": 49, "kranji bekasi": 49,
    # ID 50 — Jl. Ir. H. Juanda Bekasi
    "juanda bekasi": 50, "ir juanda": 50, "ir h juanda": 50,
    # Alias umum untuk "bekasi" → arahkan ke Simpang Lima sebagai pusat
    "bekasi": 38,
}

# Koordinat tiap lokasi Jakarta untuk fly_to
LOCATION_COORDS = {
    1:  {"lat": -6.2095, "lng": 106.8190},
    2:  {"lat": -6.2168, "lng": 106.8003},
    3:  {"lat": -6.1800, "lng": 106.7737},
    4:  {"lat": -6.1753, "lng": 106.7972},
    5:  {"lat": -6.1848, "lng": 106.8032},
    6:  {"lat": -6.1897, "lng": 106.7870},
    7:  {"lat": -6.1965, "lng": 106.8310},
    8:  {"lat": -6.2218, "lng": 106.8411},
    9:  {"lat": -6.2272, "lng": 106.8014},
    10: {"lat": -6.2336, "lng": 106.8238},
    11: {"lat": -6.2442, "lng": 106.8513},
    12: {"lat": -6.1260, "lng": 106.7235},
    14: {"lat": -6.1793, "lng": 106.8229},
    15: {"lat": -6.1762, "lng": 106.8676},
    16: {"lat": -6.1887, "lng": 106.8704},
    17: {"lat": -6.1473, "lng": 106.7180},
    18: {"lat": -6.1284, "lng": 106.8050},
    19: {"lat": -6.2095, "lng": 106.7381},
    20: {"lat": -6.3076, "lng": 106.8274},
    21: {"lat": -6.3123, "lng": 106.7814},
    22: {"lat": -6.2175, "lng": 106.7818},
    23: {"lat": -6.1963, "lng": 106.9052},
    24: {"lat": -6.2368, "lng": 106.8709},
    25: {"lat": -6.1771, "lng": 106.9485},
    26: {"lat": -6.1519, "lng": 106.8976},
    27: {"lat": -6.1508, "lng": 106.8794},
    28: {"lat": -6.1272, "lng": 106.8550},
    29: {"lat": -6.1754, "lng": 106.9181},
    30: {"lat": -6.1781, "lng": 106.9182},
    31: {"lat": -6.1828, "lng": 106.9378},
    32: {"lat": -6.1849, "lng": 106.9465},
    33: {"lat": -6.1857, "lng": 106.9507},
    34: {"lat": -6.1648, "lng": 106.9125},
    35: {"lat": -6.2427, "lng": 106.8972},
    36: {"lat": -6.2492, "lng": 106.9370},
    37: {"lat": -6.2476, "lng": 106.9772},
    # Bekasi
    38: {"lat": -6.2392, "lng": 106.9936},
    39: {"lat": -6.2363, "lng": 107.0057},
    40: {"lat": -6.2271, "lng": 106.9991},
    41: {"lat": -6.2213, "lng": 106.9974},
    42: {"lat": -6.2146, "lng": 107.0131},
    43: {"lat": -6.2604, "lng": 107.0278},
    44: {"lat": -6.2549, "lng": 106.9855},
    45: {"lat": -6.2099, "lng": 107.0001},
    46: {"lat": -6.2804, "lng": 106.9739},
    47: {"lat": -6.1874, "lng": 107.0323},
    48: {"lat": -6.2888, "lng": 106.9901},
    49: {"lat": -6.2172, "lng": 107.0003},
    50: {"lat": -6.2303, "lng": 106.9872},
}


def _calc_zoom(lat1, lng1, lat2, lng2):
    """Hitung zoom level Leaflet berdasarkan jarak antar dua titik."""
    import math
    dist_km = math.sqrt((lat1 - lat2) ** 2 + (lng1 - lng2) ** 2) * 111
    if dist_km < 1.5:
        return 15
    elif dist_km < 3.5:
        return 14
    elif dist_km < 7:
        return 13
    else:
        return 12


def _resolve_location_ids(text):
    """Cari semua location_id yang disebut dalam teks (case-insensitive, longest-match)."""
    text_lower = text.lower()
    found = {}
    for alias in sorted(LOCATION_ALIASES.keys(), key=len, reverse=True):
        if alias in text_lower:
            loc_id = LOCATION_ALIASES[alias]
            if loc_id not in found:
                found[loc_id] = alias
    return list(found.keys())


def _match_alias(name):
    """Cocokkan nama lokasi ke ID via exact atau partial match."""
    name = name.lower().strip()
    if name in LOCATION_ALIASES:
        return LOCATION_ALIASES[name]
    for alias, lid in sorted(LOCATION_ALIASES.items(), key=lambda x: len(x[0]), reverse=True):
        if name in alias or alias in name:
            return lid
    return None


def _extract_route_regex(message):
    """
    Coba ekstrak asal/tujuan dari pola regex umum bahasa Indonesia:
    'dari X ke/menuju Y', 'X ke Y', 'navigasi X ke Y', dsb.
    Return: (from_id, to_id) atau (None, None).
    """
    import re
    msg = message.lower()
    patterns = [
        r'dari\s+(.+?)\s+(?:ke|menuju|menuju ke|ke arah)\s+(.+?)(?:\s*$|[,.])',
        r'dari\s+(.+?)\s+(?:ke|menuju)\s+(.+)',
        r'(?:rute|navigasi|arahkan)\s+(?:dari\s+)?(.+?)\s+(?:ke|menuju)\s+(.+)',
    ]
    for pat in patterns:
        m = re.search(pat, msg)
        if m:
            from_id = _match_alias(m.group(1).strip())
            to_id   = _match_alias(m.group(2).strip())
            if from_id and to_id and from_id != to_id:
                return from_id, to_id
    return None, None


def _extract_route_llm(message):
    """
    Gunakan SumoPod untuk ekstrak titik asal dan tujuan dari kalimat natural.
    Return: (from_id, to_id) atau (None, None) jika gagal.
    """
    if not SUMOPOD_API_KEY:
        return None, None

    loc_list = "\n".join(f"- {name}" for name in sorted(set(LOCATION_ALIASES.keys())))
    prompt = (
        "Kamu adalah parser intent rute untuk sistem traffic Jakarta.\n"
        "Daftar lokasi yang tersedia:\n"
        f"{loc_list}\n\n"
        "Dari pesan pengguna berikut, identifikasi titik ASAL dan TUJUAN rute.\n"
        "Cocokkan dengan nama dari daftar di atas (bisa sebagian).\n"
        "Jawab HANYA dengan JSON valid, tidak ada teks lain:\n"
        '{"from": "<nama_lokasi_atau_null>", "to": "<nama_lokasi_atau_null>"}\n\n'
        f"Pesan: {message}"
    )
    try:
        resp = requests.post(
            SUMOPOD_URL,
            headers=_sumopod_headers(),
            json={"model": SUMOPOD_MODEL, "messages": [{"role": "user", "content": prompt}], "stream": False},
            timeout=15,
        )
        if not resp.ok:
            return None, None
        content = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content", "")
        # strip markdown code fences if present
        content = content.strip().strip("```json").strip("```").strip()
        parsed  = json.loads(content)
        from_name = (parsed.get("from") or "").lower().strip()
        to_name   = (parsed.get("to")   or "").lower().strip()

        from_id = LOCATION_ALIASES.get(from_name)
        to_id   = LOCATION_ALIASES.get(to_name)

        # fuzzy fallback: partial match
        if not from_id and from_name:
            for alias, lid in LOCATION_ALIASES.items():
                if from_name in alias or alias in from_name:
                    from_id = lid
                    break
        if not to_id and to_name:
            for alias, lid in LOCATION_ALIASES.items():
                if to_name in alias or alias in to_name:
                    to_id = lid
                    break

        return from_id, to_id
    except Exception as e:
        logger.warning("_extract_route_llm failed: %s", e)
        return None, None


def _get_all_predictions():
    """
    Jalankan Transformer predictor untuk semua lokasi.
    Mengembalikan list dict: {id, name, current, pred_15, pred_30, lat, lng}
    """
    try:
        cctv_list = db_handler.get_all_cctv_status()
        results = []
        for cctv in cctv_list:
            loc_id     = cctv["id"]
            last_update = cctv.get("last_update")
            conn = db_handler.get_db_connection()
            cur  = _dict_cur(conn)
            if last_update:
                cur.execute("""
                    SELECT vehicles, timestamp FROM traffic_logs
                    WHERE location_id = %s AND timestamp <= %s
                    ORDER BY timestamp DESC LIMIT 60
                """, (loc_id, last_update))
            else:
                cur.execute("""
                    SELECT vehicles, timestamp FROM traffic_logs
                    WHERE location_id = %s ORDER BY timestamp DESC LIMIT 60
                """, (loc_id,))
            rows = cur.fetchall()
            cur.close()
            conn.close()
            history = [(r["vehicles"], _ts_str(r["timestamp"])) for r in reversed(rows)]
            pred = predictor.predict(loc_id, history)
            p15  = pred["pred_15min"] if pred else cctv.get("vehicles", 0)
            p30  = pred["pred_30min"] if pred else cctv.get("vehicles", 0)
            coord = LOCATION_COORDS.get(loc_id, {})
            results.append({
                "id":      loc_id,
                "name":    cctv.get("name", f"Lokasi {loc_id}"),
                "current": cctv.get("vehicles", 0),
                "pred_15": p15,
                "pred_30": p30,
                "lat":     coord.get("lat"),
                "lng":     coord.get("lng"),
            })
        return results
    except Exception as e:
        logger.warning("_get_all_predictions failed: %s", e)
        return []


def detect_and_apply_time_change(message):
    """
    Deteksi intent perubahan waktu simulasi dari pesan user.
    Jika terdeteksi, langsung eksekusi UPDATE ke PostgreSQL dan return konfirmasi.
    Return None jika bukan perintah ganti waktu.
    """
    import re
    msg_lower = message.lower()

    time_keywords = [
        "ganti waktu", "ubah waktu", "set waktu", "pindah waktu",
        "ganti jam", "ubah jam", "set jam", "mundur ke jam", "maju ke jam",
        "tampilkan jam", "data jam", "ke jam", "ganti timestamp",
        "ubah timestamp", "pindah ke", "simulasi jam", "waktu ke",
        "geser ke jam", "geser waktu", "loncat ke jam", "skip ke jam",
    ]

    if not any(kw in msg_lower for kw in time_keywords):
        return None

    from datetime import datetime as _dt

    target_str = None

    # Cari format lengkap: YYYY-MM-DD HH:MM atau datetime ISO
    full_match = re.search(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?', message)
    if full_match:
        target_str = full_match.group(0).replace('T', ' ')

    # Cari format jam saja: HH:MM atau HH.MM
    if not target_str:
        time_match = re.search(r'\b(\d{1,2})[:\.](\d{2})\b', message)
        if time_match:
            target_str = f"{time_match.group(1)}:{time_match.group(2)}"

    if not target_str:
        return None

    conn = db_handler.get_db_connection()
    cur  = _dict_cur(conn)

    try:
        cur.execute("SELECT MIN(timestamp) AS mn, MAX(timestamp) AS mx FROM traffic_logs")
        rng = cur.fetchone()
        if not rng or not rng["mn"]:
            return "Tidak ada data di database."

        target_dt = None

        # Parse format lengkap
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                target_dt = _dt.strptime(target_str.strip(), fmt)
                break
            except ValueError:
                pass

        # Parse format jam saja — gunakan tanggal dari sim time aktif
        if target_dt is None:
            for fmt in ("%H:%M:%S", "%H:%M"):
                try:
                    t = _dt.strptime(target_str.strip(), fmt)
                    cur.execute("SELECT last_update FROM current_traffic WHERE last_update IS NOT NULL LIMIT 1")
                    sim_row = cur.fetchone()
                    if sim_row and sim_row["last_update"]:
                        lu = sim_row["last_update"]
                        base_dt = lu if isinstance(lu, _dt) else _dt.strptime(_ts_str(lu)[:10], "%Y-%m-%d")
                    else:
                        mn = rng["mn"]
                        base_dt = mn if isinstance(mn, _dt) else _dt.strptime(_ts_str(mn)[:10], "%Y-%m-%d")
                    base_dt = base_dt.replace(hour=0, minute=0, second=0, microsecond=0)
                    target_dt = base_dt.replace(hour=t.hour, minute=t.minute, second=0)
                    break
                except ValueError:
                    pass

        if target_dt is None:
            return f"Format waktu tidak dikenal: '{target_str}'. Gunakan format HH:MM atau YYYY-MM-DD HH:MM."

        final_str = target_dt.strftime("%Y-%m-%d %H:%M:%S")

        # Cek apakah ada data di sekitar waktu itu
        cur.execute("""
            SELECT COUNT(*) AS cnt FROM traffic_logs
            WHERE timestamp BETWEEN (%s::timestamp - INTERVAL '60 minutes')
                                AND (%s::timestamp + INTERVAL '60 minutes')
        """, (final_str, final_str))
        cnt_row = cur.fetchone()
        if not cnt_row or cnt_row["cnt"] == 0:
            return (f"Tidak ada data traffic di sekitar waktu **{final_str}**.\n"
                    f"Range data tersedia: {_ts_str(rng['mn'])} s/d {_ts_str(rng['mx'])}.")

        # Update last_update semua lokasi
        cur.execute("UPDATE current_traffic SET last_update = %s", (final_str,))

        # Sync vehicles dari traffic_logs
        cur.execute("SELECT id FROM current_traffic")
        loc_ids = [r["id"] for r in cur.fetchall()]
        synced = 0
        for loc_id in loc_ids:
            cur.execute("""
                SELECT vehicles FROM traffic_logs
                WHERE location_id = %s AND timestamp <= %s
                ORDER BY timestamp DESC LIMIT 1
            """, (loc_id, final_str))
            log_row = cur.fetchone()
            if log_row:
                cur.execute("UPDATE current_traffic SET vehicles = %s WHERE id = %s",
                            (log_row["vehicles"], loc_id))
                synced += 1

        conn.commit()
        logger.info("Chatbot: sim time diubah ke %s (%d lokasi disync)", final_str, synced)

        return (f"Waktu simulasi berhasil diubah ke **{final_str}**.\n"
                f"Data {synced} lokasi telah diperbarui. **Refresh peta** untuk melihat perubahan.")

    except Exception as e:
        conn.rollback()
        logger.error("detect_and_apply_time_change error: %s", e)
        return f"Gagal mengubah waktu: {e}"

    finally:
        cur.close()
        conn.close()


def get_prediction_context_for_chat(message):
    """
    Jika pesan mengandung kata kunci prediksi, jalankan Transformer dan
    kembalikan hasilnya sebagai teks konteks tambahan untuk system prompt LLM.
    Dipanggil dari endpoint chat-stream dan /api/chat.
    """
    msg_lower = message.lower()
    pred_keywords = [
        "menit lagi", "menit ke depan", "menit kedepan", "kedepan",
        "prediksi", "bakal", "nanti", "akan",
        "15 menit", "30 menit", "setengah jam", "jam ke depan", "sejam lagi",
        "akan macet", "akan padat", "akan ramai", "macet nanti", "padat nanti",
    ]
    if not any(kw in msg_lower for kw in pred_keywords):
        return ""

    preds = _get_all_predictions()
    if not preds:
        return ""

    def _icon(v):
        return "🔴 PADAT" if v > 30 else "🟡 RAMAI" if v > 15 else "🟢 LANCAR"

    sorted_15 = sorted(preds, key=lambda x: x["pred_15"], reverse=True)
    sorted_30 = sorted(preds, key=lambda x: x["pred_30"], reverse=True)

    lines_15 = [
        f"  {_icon(p['pred_15'])} {p['name']}: "
        f"sekarang {p['current']} kend → prediksi {p['pred_15']} kend"
        for p in sorted_15
    ]
    lines_30 = [
        f"  {_icon(p['pred_30'])} {p['name']}: "
        f"sekarang {p['current']} kend → prediksi {p['pred_30']} kend"
        for p in sorted_30
    ]

    busiest_15 = sorted_15[0]
    busiest_30 = sorted_30[0]
    quietest_15 = sorted_15[-1]
    quietest_30 = sorted_30[-1]

    return (
        "\n[PREDIKSI TRANSFORMER AI — MODEL MACHINE LEARNING]\n"
        "Data ini dihitung oleh model Transformer yang sudah dilatih dari data historis.\n"
        "GUNAKAN data prediksi ini untuk menjawab pertanyaan tentang kondisi masa depan.\n\n"
        "Prediksi 15 menit ke depan (urut paling padat):\n"
        + "\n".join(lines_15)
        + f"\n  → Paling padat  : {busiest_15['name']} ({busiest_15['pred_15']} kend)"
        + f"\n  → Paling sepi   : {quietest_15['name']} ({quietest_15['pred_15']} kend)"
        + "\n\nPrediksi 30 menit ke depan (urut paling padat):\n"
        + "\n".join(lines_30)
        + f"\n  → Paling padat  : {busiest_30['name']} ({busiest_30['pred_30']} kend)"
        + f"\n  → Paling sepi   : {quietest_30['name']} ({quietest_30['pred_30']} kend)"
        + "\n"
    )


def detect_map_actions(message):
    """
    Deteksi intent dari pesan user dan kembalikan list actions untuk peta.
    Rule-based — tidak butuh LLM kedua.

    Action types:
      select_pin      : klik 1 pin di peta
      highlight_pins  : highlight multi pin (perbandingan)
      fly_to          : zoom peta ke koordinat
      set_route       : set titik rute start & end
      clear_selection : hapus semua seleksi
    """
    import re
    msg   = message.strip().lower()
    actions = []

    # ── Reset / clear ────────────────────────────────────────────────────────
    if re.search(r"reset\s*(peta|semua|pilihan)?|hapus\s*(pilihan|seleksi|pin)", msg):
        actions.append({"type": "clear_selection"})
        return actions

    # ── Cari semua lokasi yang disebut ────────────────────────────────────────
    mentioned_ids = _resolve_location_ids(msg)

    # ── Deteksi intent PERBANDINGAN ───────────────────────────────────────────
    compare_keywords = ["banding", "vs", " dan ", " dengan ", "dibanding", "compare", "versus"]
    is_compare = any(kw in msg for kw in compare_keywords)

    # ── Deteksi intent RUTE ───────────────────────────────────────────────────
    route_keywords = [
        "dari", "menuju", "ke ", "rute", "jalan ke", "arah",
        "navigasi", "navigate", "route", "buat rute", "tampilkan rute",
        "arahkan", "perjalanan dari", "pergi ke", "tuju", "set rute",
        "direction", "perjalanan ke",
    ]
    is_route = any(kw in msg for kw in route_keywords)

    # ── Deteksi PALING PADAT / PALING SEPI ───────────────────────────────────
    is_busiest = re.search(
        r"paling\s*(padat|macet|ramai|sibuk)"           # "paling macet"
        r"|lokasi\s*(yang\s+)?(macet|padat|ramai)"      # "lokasi yang macet"
        r"|mana\s*(yang\s+)?(macet|padat|ramai)"        # "mana yang macet"
        r"|(macet|padat|ramai)\s*(dimana|ada\s*di|lokasinya|daerah)",  # "macet dimana"
        msg
    )
    is_emptiest = re.search(
        r"paling\s*(sepi|kosong|lengang)"
        r"|lokasi\s*(yang\s+)?(sepi|kosong|lengang)"
        r"|mana\s*(yang\s+)?(sepi|lengang)",
        msg
    )

    if is_busiest or is_emptiest:
        # Cek apakah pertanyaan tentang MASA DEPAN (gunakan Transformer)
        pred_kws = ["menit lagi", "menit ke depan", "prediksi", "nanti",
                    "15 menit", "30 menit", "setengah jam", "bakal", "akan"]
        is_future = any(kw in msg for kw in pred_kws)
        pred_horizon = 30 if any(kw in msg for kw in ["30", "setengah jam"]) else 15

        if is_future:
            try:
                preds = _get_all_predictions()
                if preds:
                    key   = f"pred_{pred_horizon}"
                    target = min(preds, key=lambda x: x[key]) if is_emptiest \
                             else max(preds, key=lambda x: x[key])
                    actions.append({"type": "select_pin", "location_id": target["id"]})
                    if target.get("lat"):
                        actions.append({"type": "fly_to",
                                        "lat": target["lat"], "lng": target["lng"], "zoom": 16})
            except Exception as e:
                logger.warning("detect_map_actions prediction busiest failed: %s", e)
        else:
            try:
                conn = db_handler.get_db_connection()
                cur  = _dict_cur(conn)
                if is_busiest:
                    cur.execute("SELECT id, lat, lng FROM current_traffic ORDER BY vehicles DESC LIMIT 1")
                else:
                    cur.execute("SELECT id, lat, lng FROM current_traffic ORDER BY vehicles ASC LIMIT 1")
                row = cur.fetchone()
                cur.close()
                conn.close()
                if row:
                    actions.append({"type": "select_pin", "location_id": row["id"]})
                    actions.append({"type": "fly_to",     "lat": row["lat"], "lng": row["lng"]})
            except Exception as e:
                logger.warning("detect_map_actions busiest query failed: %s", e)
        return actions

    # ── RUTE ─────────────────────────────────────────────────────────────────
    if is_route:
        start_id, end_id = None, None

        if len(mentioned_ids) >= 2:
            # Rule-based: 2+ lokasi ditemukan langsung dari teks
            # Coba regex dulu agar urutan asal→tujuan tepat
            rx_from, rx_to = _extract_route_regex(message)
            if rx_from and rx_to:
                start_id, end_id = rx_from, rx_to
            else:
                start_id, end_id = mentioned_ids[0], mentioned_ids[1]
        else:
            # Regex extraction untuk pola "dari X ke Y"
            start_id, end_id = _extract_route_regex(message)
            if not (start_id and end_id):
                # Fallback terakhir: tanya LLM untuk ekstrak lokasi
                start_id, end_id = _extract_route_llm(message)

        if start_id and end_id:
            start_coord = LOCATION_COORDS.get(start_id, {})
            end_coord   = LOCATION_COORDS.get(end_id,   {})
            actions.append({
                "type":       "set_route",
                "start_id":   start_id,
                "end_id":     end_id,
                "start_lat":  start_coord.get("lat"),
                "start_lng":  start_coord.get("lng"),
                "end_lat":    end_coord.get("lat"),
                "end_lng":    end_coord.get("lng"),
            })
            if start_coord and end_coord:
                zoom = _calc_zoom(
                    start_coord["lat"], start_coord["lng"],
                    end_coord["lat"],   end_coord["lng"],
                )
                actions.append({
                    "type": "fly_to",
                    "lat":  (start_coord["lat"] + end_coord["lat"]) / 2,
                    "lng":  (start_coord["lng"] + end_coord["lng"]) / 2,
                    "zoom": zoom,
                })
            return actions

    # ── PERBANDINGAN (≥2 lokasi) ──────────────────────────────────────────────
    if is_compare and len(mentioned_ids) >= 2:
        actions.append({"type": "highlight_pins", "location_ids": mentioned_ids})
        c1 = LOCATION_COORDS.get(mentioned_ids[0], {})
        c2 = LOCATION_COORDS.get(mentioned_ids[1], {})
        if c1 and c2:
            zoom = _calc_zoom(c1["lat"], c1["lng"], c2["lat"], c2["lng"])
            actions.append({
                "type": "fly_to",
                "lat":  (c1["lat"] + c2["lat"]) / 2,
                "lng":  (c1["lng"] + c2["lng"]) / 2,
                "zoom": zoom,
            })
        return actions

    # ── SELECT SINGLE PIN ─────────────────────────────────────────────────────
    if len(mentioned_ids) == 1:
        loc_id = mentioned_ids[0]
        coord  = LOCATION_COORDS.get(loc_id, {})
        actions.append({"type": "select_pin", "location_id": loc_id})
        if coord:
            actions.append({"type": "fly_to", "lat": coord["lat"], "lng": coord["lng"], "zoom": 16})
        return actions

    # ── MULTI-PIN tapi bukan compare / route ─────────────────────────────────
    if len(mentioned_ids) > 1:
        actions.append({"type": "highlight_pins", "location_ids": mentioned_ids})

    return actions


# ======================================================
# 🌊 CHAT STREAM (SSE — untuk typewriter effect)
# ======================================================
@app.route("/api/chat-stream", methods=["POST"])
def chat_stream():
    """Streaming SSE endpoint. Format: data: {chunk/done/error/actions}"""
    from flask import Response, stream_with_context

    data         = request.json or {}
    message      = data.get("message", "")
    history      = data.get("history", [])
    user_context = data.get("user_context", {})

    # ── TIME CHANGE INTENT (sebelum LLM) ───────────────────────────────────
    time_reply = detect_and_apply_time_change(message)
    if time_reply:
        def _instant_sse():
            yield f"data: {json.dumps({'chunk': time_reply}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        return Response(
            stream_with_context(_instant_sse()),
            content_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    db_context   = get_traffic_context_for_chat()
    pred_context = get_prediction_context_for_chat(message)
    system_content = (
        "Kamu adalah asisten AI cerdas untuk sistem Smart Traffic Monitoring kota DKI Jakarta.\n"
        "Kamu bisa menjawab berbagai jenis pertanyaan:\n"
        "  1. Kondisi lalu lintas real-time (padat/sepi, jumlah kendaraan, lokasi, tren)\n"
        "  2. Prediksi kondisi lalu lintas 15–30 menit ke depan (menggunakan Transformer AI)\n"
        "  3. Perbandingan antar lokasi\n"
        "  4. Saran rute berdasarkan kepadatan\n"
        "  5. Pertanyaan umum seputar lalu lintas DKI Jakarta\n"
        "  6. Pertanyaan umum lainnya (cuaca, tips berkendara, dll)\n"
        "Selalu jawab dalam Bahasa Indonesia yang jelas dan informatif.\n"
        "Gunakan format Markdown (bold, list, header kecil) agar jawaban mudah dibaca.\n"
        "Jika ada data traffic tersedia, gunakan data itu untuk menjawab secara spesifik.\n"
        "Jangan menolak pertanyaan — selalu berikan jawaban terbaik yang bisa kamu berikan.\n"
        "ATURAN PREDIKSI WAKTU: Sistem berjalan dalam MODE SIMULASI (data historis, tidak real-time).\n"
        "Ketika pengguna bertanya tentang kondisi lalu lintas ke depan (nanti, X menit lagi, dll),\n"
        "WAJIB gunakan data dari blok [PREDIKSI TRANSFORMER AI] jika tersedia.\n"
        "WAJIB sebutkan nama lokasi spesifik dan jumlah kendaraan prediksinya.\n"
        "WAJIB sebutkan lokasi mana yang paling padat dan paling sepi berdasarkan angka prediksi.\n"
        "Format jawaban prediksi: sebutkan top 3 terpadat dengan nama + angka kendaraan prediksi.\n"
        "JANGAN memberi jawaban umum/generik jika data prediksi sudah tersedia.\n"
        + (f"\n{db_context}" if db_context else "")
        + (pred_context if pred_context else "")
    )

    # ── Tambah konteks user (kendaraan, rute aktif, tol, BBM, banjir, traffic) ──
    if user_context:
        ctx = []

        # Live traffic snapshot — selalu ada dari frontend
        lt = user_context.get("live_traffic", {})
        if lt:
            padat_list  = lt.get("padat", [])
            lancar_list = lt.get("lancar", [])
            total_cams  = lt.get("total_cameras", 0)
            if padat_list:
                padat_str = ", ".join(f"{c['name']} ({c['vehicles']} kend)" for c in padat_list)
                ctx.append(f"📍 LOKASI PADAT SAAT INI ({len(padat_list)} dari {total_cams}): {padat_str}")
            else:
                ctx.append(f"📍 Tidak ada lokasi PADAT saat ini dari {total_cams} kamera.")
            if lancar_list:
                lancar_str = ", ".join(f"{c['name']} ({c['vehicles']} kend)" for c in lancar_list)
                ctx.append(f"✅ LOKASI PALING LANCAR: {lancar_str}")

        if user_context.get("vehicle"):
            ctx.append(f"Kendaraan user: {user_context['vehicle']}")
        if user_context.get("fuel"):
            ctx.append(f"Jenis BBM: {user_context['fuel']}")
        if user_context.get("route"):
            r = user_context["route"]
            ctx.append(
                f"Rute aktif: {r.get('from','?')} → {r.get('to','?')}, "
                f"{r.get('distance','?')} km, estimasi {r.get('time','?')} menit"
            )
        if user_context.get("toll"):
            t = user_context["toll"]
            corridors = ", ".join(t.get("corridors", []))
            ctx.append(f"Estimasi tarif tol: Rp {int(t.get('total', 0)):,} ({corridors})")
        if user_context.get("fuel_cost"):
            fc = user_context["fuel_cost"]
            ctx.append(f"Estimasi BBM: {fc.get('liters', 0)} liter ≈ Rp {int(fc.get('cost', 0)):,}")
        if user_context.get("flood_warning"):
            zones = ", ".join(f"{z['name']} ({z['risk']})" for z in user_context["flood_warning"])
            ctx.append(f"⚠️ RUTE MELEWATI ZONA RAWAN BANJIR: {zones}")

        # Route cameras — sekarang berupa objek {name, vehicles, status}
        route_cams = user_context.get("route_cameras", [])
        if route_cams:
            if isinstance(route_cams[0], dict):
                cam_lines = [f"{c['name']} → {c['status']} ({c['vehicles']} kend)" for c in route_cams]
                ctx.append(f"📹 Kondisi CCTV di sepanjang rute:\n  " + "\n  ".join(cam_lines))
            else:
                ctx.append(f"Kamera CCTV di rute: {', '.join(route_cams)}")

        # Kemacetan di rute aktif
        congested = user_context.get("congested_on_route", [])
        if congested:
            names = ", ".join(c["name"] for c in congested)
            ctx.append(
                f"🚨 PERINGATAN: {len(congested)} titik PADAT di rute ini: {names}. "
                f"Rekomendasikan rute alternatif jika ditanya."
            )

        if ctx:
            system_content += (
                "\n\n=== KONTEKS REAL-TIME USER ===\n"
                + "\n".join(ctx)
                + "\n\nINSTRUKSI: Gunakan data traffic di atas untuk memberi saran rute yang konkret. "
                "Sebutkan nama jalan spesifik yang lancar atau padat. "
                "Jika rute user melewati titik PADAT, sarankan rute alternatif berdasarkan lokasi yang LANCAR."
            )

    def _sse(obj):
        return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

    def _generate_stream():
        messages_payload = [{"role": "system", "content": system_content}]
        for turn in history[-10:]:
            role    = turn.get("role", "user")
            content = str(turn.get("content", ""))
            if role in ("user", "assistant") and content:
                messages_payload.append({"role": role, "content": content})
        messages_payload.append({"role": "user", "content": message})

        try:
            logger.info("SSE stream via SumoPod: %d turns, model=%s", len(history), SUMOPOD_MODEL)
            resp = requests.post(
                SUMOPOD_URL,
                headers=_sumopod_headers(),
                json={"model": SUMOPOD_MODEL, "messages": messages_payload, "stream": True},
                timeout=120,
                stream=True,
            )

            if not resp.ok:
                yield _sse({"error": f"SumoPod error: {resp.status_code} — {resp.text[:200]}"})
                return

            # Parse OpenAI SSE format: "data: {...}" lines
            for line in resp.iter_lines(decode_unicode=True):
                if not line or not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if raw == "[DONE]":
                    break
                try:
                    part  = json.loads(raw)
                    chunk = (part.get("choices") or [{}])[0].get("delta", {}).get("content", "")
                    if chunk:
                        yield _sse({"chunk": chunk})
                except Exception:
                    continue

            map_actions = detect_map_actions(message)
            if map_actions:
                yield _sse({"actions": map_actions})
            yield _sse({"done": True})

        except Exception as exc:
            logger.exception("SSE stream error")
            yield _sse({"error": str(exc)})

    return Response(
        stream_with_context(_generate_stream()),
        content_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def _sumopod_headers():
    return {
        "Authorization": f"Bearer {SUMOPOD_API_KEY}",
        "Content-Type": "application/json",
    }


def _collect_openai_stream(resp):
    """Parse OpenAI-compatible SSE streaming response.
    Format: data: {"choices":[{"delta":{"content":"..."},"finish_reason":null}]}
    """
    text = ""
    try:
        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            raw = line[5:].strip()
            if raw == "[DONE]":
                break
            try:
                part = json.loads(raw)
                chunk = (part.get("choices") or [{}])[0].get("delta", {}).get("content", "")
                if chunk:
                    text += chunk
            except Exception:
                continue
    except Exception:
        pass
    if not text:
        try:
            j = resp.json()
            text = (j.get("choices") or [{}])[0].get("message", {}).get("content", "") or j.get("text", "") or j.get("reply", "")
        except Exception:
            text = resp.text
    return text






# ======================================================
# 📷 DETECT SINGLE FRAME (Webcam — browser sends JPEG)
# ======================================================
def _signal_rec(vehicles):
    if vehicles > 40:
        return {"status": "PADAT",  "priority": "TINGGI", "green_seconds": 90, "red_seconds": 30,
                "label": "Perpanjang Fase Hijau",      "note": "Volume tinggi — prioritaskan pergerakan kendaraan"}
    if vehicles > 20:
        return {"status": "SEDANG", "priority": "NORMAL", "green_seconds": 60, "red_seconds": 45,
                "label": "Pertahankan Siklus Normal",  "note": "Volume sedang — pertahankan siklus standar"}
    return     {"status": "LANCAR", "priority": "RENDAH", "green_seconds": 30, "red_seconds": 60,
                "label": "Kurangi Fase Hijau",         "note": "Volume rendah — alihkan waktu ke jalur persimpangan"}


@app.route("/api/signal-recommendation")
def signal_recommendation_all():
    """Rekomendasi sinyal adaptif — hanya untuk kamera di persimpangan berlampu."""
    try:
        cctv_list = db_handler.get_all_cctv_status()
        # Hanya kamera dengan lampu merah (has_signal=True)
        sig_cams = [c for c in cctv_list if c.get("has_signal", True)]
        result = []
        for c in sorted(sig_cams, key=lambda x: x.get("vehicles", 0), reverse=True):
            rec = _signal_rec(c.get("vehicles", 0))
            result.append({"id": c["id"], "name": c["name"], "vehicles": c.get("vehicles", 0), **rec})
        summary = {
            "with_signal":    len(sig_cams),
            "without_signal": len(cctv_list) - len(sig_cams),
            "tinggi": sum(1 for r in result if r["priority"] == "TINGGI"),
            "normal": sum(1 for r in result if r["priority"] == "NORMAL"),
            "rendah": sum(1 for r in result if r["priority"] == "RENDAH"),
        }
        return jsonify({"cameras": result, "summary": summary})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/signal-recommendation/<int:camera_id>")
def signal_recommendation_one(camera_id):
    """Rekomendasi sinyal adaptif untuk satu kamera (hanya jika berlampu)."""
    try:
        cctv_list = db_handler.get_all_cctv_status()
        cam = next((c for c in cctv_list if c["id"] == camera_id), None)
        if not cam:
            return jsonify({"error": "Kamera tidak ditemukan"}), 404
        if not cam.get("has_signal", True):
            return jsonify({"id": camera_id, "name": cam["name"], "has_signal": False,
                            "message": "Jalan tol — tidak ada lampu merah"}), 200
        rec = _signal_rec(cam.get("vehicles", 0))
        return jsonify({"id": camera_id, "name": cam["name"], "vehicles": cam.get("vehicles", 0),
                        "has_signal": True, **rec})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/simulate-count", methods=["POST"])
def simulate_count():
    data = request.get_json(silent=True) or {}
    camera_id = data.get("camera_id")
    count = data.get("count")
    if not camera_id or count is None:
        return jsonify({"error": "camera_id dan count diperlukan"}), 400
    try:
        db_handler.update_traffic_data(camera_id, int(count))
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, "camera_id": camera_id, "count": count})


# ======================================================
# 🛰️ TOMTOM TRAFFIC API
# ======================================================
@app.route("/api/tomtom-flow")
def tomtom_flow_endpoint():
    """TomTom Traffic Flow: kecepatan nyata vs bebas hambatan untuk satu titik jalan.
    Query params: lat, lng
    """
    if not TOMTOM_API_KEY:
        return jsonify({"error": "TOMTOM_API_KEY belum dikonfigurasi"}), 503
    try:
        lat = float(request.args.get("lat", ""))
        lng = float(request.args.get("lng", ""))
    except (TypeError, ValueError):
        return jsonify({"error": "Parameter lat dan lng diperlukan"}), 400
    data = _tomtom_flow(lat, lng)
    if data:
        return jsonify(data)
    return jsonify({"error": "Tidak ada data dari TomTom"}), 502


@app.route("/api/tomtom-incidents")
def tomtom_incidents():
    """TomTom Traffic Incidents: kecelakaan & gangguan di area Jakarta–Bekasi."""
    global _TOMTOM_INC_CACHE
    if not TOMTOM_API_KEY:
        return jsonify({"error": "TOMTOM_API_KEY belum dikonfigurasi"}), 503
    now = time.time()
    if _TOMTOM_INC_CACHE["ts"] and now - _TOMTOM_INC_CACHE["ts"] < TOMTOM_INC_TTL:
        return jsonify(_TOMTOM_INC_CACHE["data"])
    try:
        resp = requests.get(
            "https://api.tomtom.com/traffic/services/5/incidentDetails",
            params={
                "bbox": JAKARTA_BBOX,
                "key": TOMTOM_API_KEY,
                "fields": "{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description,code},from,to,startTime,endTime}}}",
                "language": "id-ID",
                "timeValidityFilter": "present",
            },
            timeout=10,
        )
        if not resp.ok:
            return jsonify({"error": f"TomTom HTTP {resp.status_code}"}), 502

        incidents = resp.json().get("incidents", [])
        result = []
        for inc in incidents:
            props = inc.get("properties", {})
            geom  = inc.get("geometry", {})
            coords = geom.get("coordinates", [])
            gtype  = geom.get("type", "")
            if gtype == "Point" and len(coords) >= 2:
                lng_val, lat_val = coords[0], coords[1]
            elif gtype == "LineString" and coords:
                mid = len(coords) // 2
                lng_val, lat_val = coords[mid][0], coords[mid][1]
            else:
                continue
            events = props.get("events") or [{}]
            result.append({
                "lat":         lat_val,
                "lng":         lng_val,
                "category":    props.get("iconCategory", 0),
                "delay":       props.get("magnitudeOfDelay", 0),
                "from":        props.get("from", ""),
                "to":          props.get("to", ""),
                "description": events[0].get("description", ""),
            })
        _TOMTOM_INC_CACHE = {"ts": now, "data": result}
        return jsonify(result)
    except Exception as e:
        logger.warning("TomTom incidents error: %s", e)
        return jsonify({"error": str(e)}), 502


# ======================================================
# 🎯 YOLO DETECT UPLOAD
# ======================================================
ALLOWED_DETECT_EXT = {'.jpg', '.jpeg', '.png', '.bmp', '.mp4', '.avi', '.mov', '.mkv', '.webm'}

@app.route("/api/detect-upload", methods=["POST"])
def detect_upload():
    if 'file' not in request.files:
        return jsonify({"error": "Field 'file' tidak ada"}), 400

    f = request.files['file']
    if not f.filename:
        return jsonify({"error": "Nama file kosong"}), 400

    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_DETECT_EXT:
        return jsonify({"error": f"Tipe file '{ext}' tidak didukung"}), 400

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        f.save(tmp.name)
        tmp_path = tmp.name

    try:
        logger.info("detect-upload: processing %s (%s)", f.filename, ext)
        result = detector.detect_file(tmp_path)
        if result is None:
            return jsonify({"error": "File tidak bisa dibaca atau tidak ada frame"}), 500
        return jsonify({
            "success": True,
            "vehicle_count": result["vehicle_count"],
            "class_counts": result["class_counts"],
            "annotated_image": result["annotated_image"],
            "processing_time_ms": result["processing_time_ms"],
        })
    except Exception as e:
        logger.exception("detect-upload error")
        return jsonify({"error": str(e)}), 500
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ======================================================
# 🎯 YOLO DETECT FROM BROWSER FRAME (base64 JPEG)
# ======================================================
@app.route("/api/detect-frame", methods=["POST"])
def detect_frame():
    """
    Menerima frame dari browser (canvas.toDataURL) sebagai base64 JPEG,
    jalankan YOLO, kembalikan annotated image + jumlah kendaraan.
    Body: { "image": "data:image/jpeg;base64,..." atau "<base64 murni>" }
    """
    import base64
    data = request.get_json(silent=True)
    if not data or "image" not in data:
        return jsonify({"error": "Field 'image' (base64) tidak ada"}), 400

    raw = data["image"]
    # Hapus header data URI jika ada
    if "," in raw:
        raw = raw.split(",", 1)[1]

    try:
        img_bytes = base64.b64decode(raw)
    except Exception:
        return jsonify({"error": "Base64 tidak valid"}), 400

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(img_bytes)
        tmp_path = tmp.name

    try:
        result = detector.detect_file(tmp_path)
        if result is None:
            return jsonify({"error": "Frame tidak bisa diproses"}), 500
        return jsonify({
            "success": True,
            "vehicle_count": result["vehicle_count"],
            "class_counts": result["class_counts"],
            "annotated_image": result["annotated_image"],
            "processing_time_ms": result["processing_time_ms"],
        })
    except Exception as e:
        logger.exception("detect-frame error")
        return jsonify({"error": str(e)}), 500
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ======================================================
# 🖥️  GPU SERVICE MANAGEMENT
# ======================================================

@app.route("/api/gpu-register", methods=["POST"])
def gpu_register():
    """GPU service memanggil endpoint ini saat startup untuk mendaftarkan URL-nya."""
    import core.detector as det
    data = request.json or {}
    url = (data.get("url") or "").rstrip("/")
    if not url or not url.startswith("http"):
        return jsonify({"error": "url tidak valid"}), 400

    _gpu_state["url"] = url
    _gpu_state["last_heartbeat"] = time.time()
    _gpu_state["gpu_info"] = data.get("info", {})

    det.set_gpu_url(url)
    logger.info("[GPU] Registered: %s  gpu=%s", url, data.get("info", {}).get("gpu"))
    return jsonify({"ok": True, "message": "GPU service registered"})


@app.route("/api/gpu-heartbeat", methods=["POST", "GET"])
def gpu_heartbeat():
    """Periodic heartbeat dari GPU service — update timestamp + URL jika berubah."""
    import core.detector as det
    _gpu_state["last_heartbeat"] = time.time()
    det.mark_gpu_heartbeat()
    # Jika GPU service kirim URL di payload, update agar backend selalu punya URL terbaru
    try:
        body = request.get_json(silent=True) or {}
        url  = body.get("url", "")
        if url and url != _gpu_state.get("url"):
            det.set_gpu_url(url)
            _gpu_state["url"] = url
            logger.info("[GPU] URL diperbarui via heartbeat: %s", url)
    except Exception:
        pass
    return jsonify({"ok": True, "server_time": time.time()})


@app.route("/api/gpu-status")
def gpu_status():
    """Status GPU service + scan stats — digunakan oleh admin panel."""
    import core.detector as det
    age = time.time() - _gpu_state["last_heartbeat"] if _gpu_state["last_heartbeat"] else None
    return jsonify({
        "url":          _gpu_state["url"],
        "healthy":      det.is_gpu_healthy(),
        "heartbeat_age_s": round(age, 1) if age is not None else None,
        "gpu_info":     _gpu_state["gpu_info"],
        "scan_stats":   _gpu_state["scan_stats"],
    })


@app.route("/api/gpu-scan-now", methods=["POST"])
def gpu_scan_now():
    """Trigger GPU scan manual (operator)."""
    import threading
    t = threading.Thread(target=gpu_scan_job, daemon=True)
    t.start()
    return jsonify({"ok": True, "message": "GPU scan triggered"})


def _gpu_proxy(path, method="GET", **kwargs):
    """Forward request ke GPU service."""
    url = _gpu_state.get("url", "").rstrip("/")
    if not url:
        return jsonify({"error": "GPU service tidak terdaftar"}), 503
    try:
        r = requests.request(method, f"{url}/{path}", timeout=15, **kwargs)
        return jsonify(r.json()), r.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 502

@app.route("/api/gpu/train/check")
def gpu_train_check():
    return _gpu_proxy("train/check")

@app.route("/api/gpu/train/status")
def gpu_train_status():
    return _gpu_proxy("train/status")

@app.route("/api/gpu/train/start", methods=["POST"])
def gpu_train_start():
    body = request.get_json(silent=True) or {}
    dataset = body.get("dataset", "/home/jovyan/jaktraffic/dataset_merged")
    return _gpu_proxy("train/start", method="POST", params={"dataset": dataset})

@app.route("/api/gpu/train/stop", methods=["POST"])
def gpu_train_stop():
    return _gpu_proxy("train/stop", method="POST")


YOLO_MODEL_DIR  = os.path.join(os.path.dirname(__file__), "models")
YOLO_MODEL_PATH = os.path.join(YOLO_MODEL_DIR, "jaktraffic_yolo.pt")
YOLO_META_PATH  = os.path.join(YOLO_MODEL_DIR, "jaktraffic_yolo_meta.json")
os.makedirs(YOLO_MODEL_DIR, exist_ok=True)

UPLOAD_TOKEN = os.getenv("MODEL_UPLOAD_TOKEN", "jaktraffic2026")

@app.route("/api/yolo-model/upload", methods=["POST"])
def yolo_model_upload():
    """Terima model YOLO fine-tuned dari Colab / sumber lain."""
    token = request.headers.get("X-Upload-Token") or request.form.get("token", "")
    if token != UPLOAD_TOKEN:
        return jsonify({"error": "Unauthorized"}), 401
    if "model" not in request.files:
        return jsonify({"error": "Field 'model' tidak ada"}), 400
    f = request.files["model"]
    if not f.filename.endswith(".pt"):
        return jsonify({"error": "Harus file .pt"}), 400
    f.save(YOLO_MODEL_PATH)
    size_mb = round(os.path.getsize(YOLO_MODEL_PATH) / 1e6, 2)
    meta = {
        "uploaded_at": datetime.now().isoformat(),
        "filename": f.filename,
        "size_mb": size_mb,
        "classes": request.form.get("classes", ""),
        "map50": request.form.get("map50", ""),
    }
    with open(YOLO_META_PATH, "w") as mf:
        json.dump(meta, mf)
    logger.info("[YOLO Upload] Model diterima: %s (%.1f MB)", f.filename, size_mb)
    return jsonify({"ok": True, "size_mb": size_mb, "path": YOLO_MODEL_PATH})

@app.route("/api/yolo-model/download")
def yolo_model_download():
    """GPU server download model terbaru (hasil training)."""
    if not os.path.exists(YOLO_MODEL_PATH):
        return jsonify({"error": "Model belum diupload"}), 404
    from flask import send_file
    return send_file(YOLO_MODEL_PATH, as_attachment=True,
                     download_name="jaktraffic_yolo.pt",
                     mimetype="application/octet-stream")

@app.route("/api/yolo-model/download/base")
def yolo_model_download_base():
    """Download model Indonesia asli (jaktraffic_yolo11x.pt, ~110MB) sebagai base training."""
    base_path = os.path.join(YOLO_MODEL_DIR, "jaktraffic_yolo11x.pt")
    if not os.path.exists(base_path):
        return jsonify({"error": "Base model tidak ditemukan"}), 404
    from flask import send_file
    return send_file(base_path, as_attachment=True,
                     download_name="jaktraffic_yolo11x.pt",
                     mimetype="application/octet-stream")

@app.route("/api/yolo-model/info")
def yolo_model_info():
    """Status model YOLO yang tersimpan di backend."""
    if not os.path.exists(YOLO_MODEL_PATH):
        return jsonify({"available": False})
    meta = {}
    if os.path.exists(YOLO_META_PATH):
        with open(YOLO_META_PATH) as mf:
            meta = json.load(mf)
    return jsonify({
        "available": True,
        "size_mb": round(os.path.getsize(YOLO_MODEL_PATH) / 1e6, 2),
        **meta,
        "download_url": "/api/yolo-model/download",
    })


@app.route("/api/gpu-service")
def gpu_service_script():
    """Serve gpu_service_v3.py ke GPU server agar bisa di-wget langsung."""
    script_path = os.path.join(os.path.dirname(__file__), "..", "training", "gpu_service_v3.py")
    script_path = os.path.normpath(script_path)
    if not os.path.exists(script_path):
        return jsonify({"error": "gpu_service_v3.py tidak ditemukan"}), 404
    from flask import send_file
    return send_file(script_path, as_attachment=False,
                     download_name="gpu_service_v3.py",
                     mimetype="text/x-python")


@app.route("/api/gpu-service/v4")
def gpu_service_v4_script():
    """Serve gpu_service_v4.py (ByteTrack + batch inference)."""
    script_path = os.path.join(os.path.dirname(__file__), "..", "training", "gpu_service_v4.py")
    script_path = os.path.normpath(script_path)
    if not os.path.exists(script_path):
        return jsonify({"error": "gpu_service_v4.py tidak ditemukan"}), 404
    from flask import send_file
    return send_file(script_path, as_attachment=False,
                     download_name="gpu_service_v4.py",
                     mimetype="text/x-python")


@app.route("/api/training/yolo11l")
def training_yolo11l_script():
    """Serve 02_train_yolo11l.py untuk dijalankan di GPU server."""
    script_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "training", "02_train_yolo11l.py"))
    if not os.path.exists(script_path):
        return jsonify({"error": "02_train_yolo11l.py tidak ditemukan"}), 404
    from flask import send_file
    return send_file(script_path, as_attachment=False,
                     download_name="02_train_yolo11l.py",
                     mimetype="text/x-python")

@app.route("/api/training/yolo11x")
def training_yolo11x_script():
    """Serve train_jaktraffic_v2.py untuk dijalankan di GPU pod."""
    script_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "training", "train_jaktraffic_v2.py"))
    if not os.path.exists(script_path):
        return jsonify({"error": "train_jaktraffic_v2.py tidak ditemukan"}), 404
    return send_file(script_path, as_attachment=False,
                     download_name="train_jaktraffic_v2.py",
                     mimetype="text/x-python")

@app.route("/api/gpu/model/backup", methods=["POST"])
def gpu_model_backup():
    """Minta GPU service push model-nya ke backend untuk backup permanen."""
    return _gpu_proxy("model/push", method="POST")

@app.route("/api/gpu/model/info")
def gpu_model_info():
    """Info model yang sedang berjalan di GPU service."""
    return _gpu_proxy("model/info")

@app.route("/api/dataset/stats")
def dataset_stats():
    """Status dataset yang sudah terkumpul."""
    return jsonify(_ds_get_stats())

@app.route("/api/dataset/collect-now", methods=["POST"])
def dataset_collect_now():
    """Trigger pengumpulan dataset sekarang (tidak tunggu jadwal 30 menit)."""
    def _run():
        run_collection_round(db_handler, detector.model)
    threading.Thread(target=_run, daemon=True).start()
    return jsonify({"ok": True, "message": "Pengumpulan dimulai di background"})

@app.route("/api/dataset/download")
def dataset_download():
    """Download seluruh dataset sebagai ZIP dengan prefix folder 'dataset/' (browser download)."""
    import zipfile, io as _io
    from core.dataset_collector import DATASET_DIR
    if not DATASET_DIR.exists():
        return jsonify({"error": "Dataset belum ada"}), 404
    buf = _io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(DATASET_DIR.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(DATASET_DIR.parent))
    buf.seek(0)
    ts = datetime.now().strftime("%Y%m%d_%H%M")
    return send_file(buf, as_attachment=True,
                     download_name=f"jaktraffic_dataset_{ts}.zip",
                     mimetype="application/zip")

@app.route("/api/dataset/zip")
def dataset_zip():
    """Download dataset sebagai ZIP tanpa prefix folder — untuk GPU pod /train/start."""
    import zipfile, io as _io
    from core.dataset_collector import DATASET_DIR
    if not DATASET_DIR.exists():
        return jsonify({"error": "Dataset belum ada"}), 404
    n_imgs = len(list(DATASET_DIR.rglob("*.jpg")))
    if n_imgs < 50:
        return jsonify({"error": f"Dataset terlalu kecil ({n_imgs} gambar)"}), 400
    buf = _io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(DATASET_DIR.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(DATASET_DIR))  # tanpa prefix 'dataset/'
    buf.seek(0)
    logger.info("[Dataset] ZIP disiapkan: %d gambar", n_imgs)
    return send_file(buf, as_attachment=False,
                     download_name="jaktraffic_dataset.zip",
                     mimetype="application/zip")

@app.route("/api/gpu-service/v4")
def serve_gpu_service_v4():
    """Serve gpu_service_v4.py agar GPU server bisa self-update."""
    script_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "training", "gpu_service_v4.py"))
    if not os.path.exists(script_path):
        return jsonify({"error": "gpu_service_v4.py tidak ditemukan"}), 404
    from flask import send_file
    return send_file(script_path, as_attachment=False,
                     download_name="gpu_service_v4.py",
                     mimetype="text/x-python")


@app.route("/api/camera-speed/<int:cam_id>")
def camera_speed(cam_id):
    """Estimasi kecepatan kendaraan on-demand untuk satu kamera via optical flow.
    Dipanggil saat user buka popup kamera — ambil 2 frame ~1 detik, hitung flow.
    """
    import core.detector as det

    # Ambil stream_url kamera + jumlah kendaraan saat ini
    try:
        conn = db_handler.get_db_connection()
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT stream_url, speed_kmh, last_gpu_scan, vehicles FROM current_traffic WHERE id=%s",
            (cam_id,)
        )
        row = cur.fetchone()
        conn.close()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    if not row:
        return jsonify({"error": "Kamera tidak ditemukan"}), 404

    # Jika ada data GPU segar (< 90 detik), kembalikan langsung dari DB
    last_scan = row.get("last_gpu_scan")
    cached_speed = row.get("speed_kmh")
    if last_scan and cached_speed is not None:
        age_s = (datetime.now() - last_scan).total_seconds()
        if age_s < 90:
            return jsonify({
                "speed_kmh": float(cached_speed),
                "source": "cache",
                "age_s": round(age_s, 1),
            })

    stream_url = row.get("stream_url")
    if not stream_url:
        return jsonify({"error": "Kamera tidak memiliki stream URL (bukan JTD)"}), 400

    # Jangan ukur kecepatan jika kendaraan < 2 (optical flow tidak valid saat jalan kosong)
    vehicles = row.get("vehicles") or 0
    if vehicles < 2:
        return jsonify({"error": "Kendaraan tidak cukup untuk estimasi kecepatan", "vehicles": vehicles}), 422

    # Hitung on-demand
    try:
        vdet = det.VideoDetector()
        speed = vdet.estimate_speed(_resolve_stream_url(stream_url), cam_id)
        if speed is None:
            return jsonify({"error": "Stream tidak bisa dibuka"}), 502

        # Simpan ke DB untuk cache berikutnya
        conn2 = db_handler.get_db_connection()
        cur2 = conn2.cursor()
        cur2.execute(
            "UPDATE current_traffic SET speed_kmh=%s, last_gpu_scan=NOW() WHERE id=%s",
            (speed, cam_id)
        )
        conn2.commit()
        conn2.close()

        return jsonify({"speed_kmh": float(speed), "source": "live"})
    except Exception as e:
        logger.exception("camera-speed error cam %s", cam_id)
        return jsonify({"error": str(e)}), 500


# ======================================================
# 🧠 MODEL INFO (ADMIN)
# ======================================================
@app.route("/api/model-info")
def model_info():
    import torch
    import os
    from core.predictor import MODEL_PATH, SEQ_LEN, D_MODEL, N_HEADS, N_LAYERS, D_FF, N_FEATURES

    info = {
        "model_loaded": predictor.model is not None,
        "model_file": os.path.basename(MODEL_PATH),
        "model_exists": os.path.exists(MODEL_PATH),
    }

    if os.path.exists(MODEL_PATH):
        file_size = os.path.getsize(MODEL_PATH)
        info["file_size_kb"] = round(file_size / 1024, 1)

        checkpoint = torch.load(MODEL_PATH, map_location="cpu", weights_only=False)
        info["architecture"] = {
            "type": "Transformer Encoder",
            "d_model": D_MODEL,
            "n_heads": N_HEADS,
            "n_layers": N_LAYERS,
            "d_feedforward": D_FF,
            "n_features": N_FEATURES,
            "seq_len": SEQ_LEN,
            "output": "2 (pred_15min, pred_30min)",
        }
        info["training"] = {
            "vehicle_max": checkpoint.get("vehicle_max", "N/A"),
            "n_locations": checkpoint.get("n_locations", "N/A"),
            "best_val_loss": round(checkpoint.get("best_val_loss", 0), 6),
            "best_epoch": checkpoint.get("epoch", "N/A"),
        }

        # Count parameters
        from core.predictor import TrafficTransformer
        model = TrafficTransformer(n_locations=checkpoint.get("n_locations", 8))
        total_params = sum(p.numel() for p in model.parameters())
        trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
        info["parameters"] = {
            "total": total_params,
            "trainable": trainable_params,
        }

        # Quick prediction test — gunakan last_update sebagai batas atas history
        # sehingga konteks model = 60 menit SEBELUM last_update (jam 18:00)
        # dan prediksi = 18:15 & 18:30
        cctv_list = db_handler.get_all_cctv_status()
        test_predictions = []
        for cctv in cctv_list:
            loc_id      = cctv["id"]
            last_update = cctv.get("last_update")
            conn = db_handler.get_db_connection()
            cur  = _dict_cur(conn)

            if last_update:
                cur.execute("""
                    SELECT vehicles, timestamp FROM traffic_logs
                    WHERE location_id = %s AND timestamp IS NOT NULL
                      AND timestamp <= %s
                    ORDER BY timestamp DESC LIMIT 60
                """, (loc_id, last_update))
            else:
                cur.execute("""
                    SELECT vehicles, timestamp FROM traffic_logs
                    WHERE location_id = %s AND timestamp IS NOT NULL
                    ORDER BY timestamp DESC LIMIT 60
                """, (loc_id,))

            rows = cur.fetchall()
            cur.close()
            conn.close()

            history = [(r["vehicles"], _ts_str(r["timestamp"])) for r in reversed(rows)]
            pred    = predictor.predict(loc_id, history)
            if pred:
                test_predictions.append({
                    "name":    cctv.get("name"),
                    "current": cctv.get("vehicles", 0),
                    "pred_15": pred["pred_15min"],
                    "pred_30": pred["pred_30min"],
                })
        info["test_predictions"] = test_predictions

    return jsonify(info)


# ======================================================
# ✍️ PREVIEW / APPLY PATCHES (EDIT MODE WORKFLOW)
# ======================================================
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def is_safe_relative_path(p):
    # Prevent absolute paths and path traversal
    if not p or os.path.isabs(p):
        return False
    norm = os.path.normpath(p).replace('\\', '/')
    if norm.startswith('..'):
        return False
    # final resolved path must be inside project root
    final = os.path.abspath(os.path.join(PROJECT_ROOT, norm))
    return final.startswith(PROJECT_ROOT)


@app.route('/api/preview-patch', methods=['POST'])
def preview_patch():
    data = request.json or {}
    # Accept either direct 'changes' or model reply string 'model_reply'
    changes = data.get('changes')
    if not changes and data.get('model_reply'):
        # model_reply may be a plain text assistant response. Try to parse JSON;
        # if parsing fails, attempt to reformat by asking the model to return only JSON.
        raw = data['model_reply']
        def extract_json(s):
            if not s or not isinstance(s, str):
                return None
            # Remove common markdown/code fences and surrounding backticks
            cleaned = s.strip()
            # remove ```json or ```
            if cleaned.startswith('```'):
                # drop leading fence
                parts = cleaned.split('```')
                # parts[0] is empty before first fence
                # join remainder and strip
                cleaned = '```'.join(parts[1:]).strip()
                # if there is a trailing fence, remove it
                if cleaned.endswith('```'):
                    cleaned = cleaned[:-3].strip()
            # also remove single backticks wrapping
            if cleaned.startswith('`') and cleaned.endswith('`'):
                cleaned = cleaned[1:-1].strip()

            try:
                return json.loads(cleaned)
            except Exception:
                # Try to parse Python-style dicts (single quotes) safely
                try:
                    parsed = ast.literal_eval(cleaned)
                    if isinstance(parsed, dict):
                        return parsed
                except Exception:
                    pass

            # find first { and last } in cleaned text
            a = cleaned.find('{')
            b = cleaned.rfind('}')
            if a != -1 and b != -1 and b > a:
                candidate = cleaned[a:b+1]
                try:
                    return json.loads(candidate)
                except Exception:
                    # try to fix common trailing commas
                    cand2 = candidate.replace(',\n}', '\n}')
                    try:
                        return json.loads(cand2)
                    except Exception:
                        # as a last resort, try ast.literal_eval on the candidate
                        try:
                            parsed = ast.literal_eval(candidate)
                            if isinstance(parsed, dict):
                                return parsed
                        except Exception:
                            return None
            return None

        j = extract_json(raw)
        # If not JSON, ask local LLM to reformat into JSON schema
        if j is None:
            reformatted = None
            attempts = 2
            for attempt in range(attempts):
                try:
                    reformat_prompt = (
                        "The assistant produced a non-JSON reply.\n"
                        "Please return ONLY a single JSON object (no markdown, no extra text) that matches this schema:\n"
                        "{\n  \"summary\": \"short summary\",\n  \"changes\": [{\"path\": \"relative/path\", \"content\": \"<full file content>\"}]\n}\n"
                        "Here is the assistant reply to reformat:\n\n" + raw + "\n\n"
                    )
                    logger.info("Attempting to reformat assistant reply to JSON (attempt %d)", attempt+1)
                    resp = requests.post(
                        SUMOPOD_URL,
                        headers=_sumopod_headers(),
                        json={"model": SUMOPOD_MODEL, "messages": [{"role": "user", "content": reformat_prompt}], "stream": False},
                        timeout=30,
                    )
                    if resp.ok:
                        try:
                            text = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content", "")
                        except Exception:
                            text = resp.text
                        reformatted = extract_json(text)
                        if reformatted is not None:
                            j = reformatted
                            break
                except Exception:
                    logger.exception("Reformat attempt failed")

        if j is None:
            return jsonify({'error': 'Invalid model_reply JSON and reformat attempts failed', 'raw': raw}), 400
        changes = j.get('changes', [])

    if not changes:
        return jsonify({'error': 'No changes provided'}), 400

    results = []
    for ch in changes:
        path = ch.get('path')
        if not path or not is_safe_relative_path(path):
            results.append({'path': path, 'ok': False, 'error': 'unsafe or missing path'})
            continue

        abs_path = os.path.abspath(os.path.join(PROJECT_ROOT, path))
        exists = os.path.exists(abs_path)
        original = ''
        if exists:
            try:
                with open(abs_path, 'r', encoding='utf-8') as f:
                    original = f.read()
            except Exception as e:
                results.append({'path': path, 'ok': False, 'error': f'read failed: {e}'})
                continue

        # prefer 'content' (full new file) for safe apply
        if 'content' in ch:
            newcontent = ch['content'] or ''
            # compute unified diff
            diff = '\n'.join(difflib.unified_diff(
                original.splitlines(), newcontent.splitlines(),
                fromfile=f'a/{path}', tofile=f'b/{path}', lineterm=''
            ))
            results.append({'path': path, 'ok': True, 'exists': exists, 'diff': diff})
            continue

        # if patch provided, check via git apply --check (requires git)
        if 'patch' in ch:
            patch_text = ch['patch'] or ''
            try:
                p = subprocess.run(['git', 'apply', '--check', '-'], input=patch_text.encode('utf-8'), cwd=PROJECT_ROOT, capture_output=True)
                if p.returncode == 0:
                    results.append({'path': path, 'ok': True, 'exists': exists, 'diff': patch_text})
                else:
                    results.append({'path': path, 'ok': False, 'error': p.stderr.decode('utf-8')})
            except Exception as e:
                results.append({'path': path, 'ok': False, 'error': f'git apply check failed: {e}'})
            continue

        results.append({'path': path, 'ok': False, 'error': 'no content or patch in change'})

    return jsonify({'results': results})


@app.route('/api/apply-patch', methods=['POST'])
def apply_patch_endpoint():
    data = request.json or {}
    changes = data.get('changes')
    message = data.get('message') or 'Apply patches via chat assistant'

    if not changes:
        return jsonify({'error': 'No changes provided'}), 400

    applied = []
    backups = []
    for ch in changes:
        path = ch.get('path')
        if not path or not is_safe_relative_path(path):
            return jsonify({'error': f'unsafe path: {path}'}), 400

        abs_path = os.path.abspath(os.path.join(PROJECT_ROOT, path))
        # ensure dir exists
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)

        # backup existing file
        if os.path.exists(abs_path):
            ts = int(time.time())
            bak = f"{abs_path}.bak.{ts}"
            shutil.copy2(abs_path, bak)
            backups.append(bak)

        # apply content or patch
        if 'content' in ch:
            try:
                with open(abs_path, 'w', encoding='utf-8') as f:
                    f.write(ch['content'] or '')
                applied.append(path)
            except Exception as e:
                return jsonify({'error': f'write failed for {path}: {e}'}), 500
        elif 'patch' in ch:
            try:
                p = subprocess.run(['git', 'apply', '-'], input=(ch['patch'] or '').encode('utf-8'), cwd=PROJECT_ROOT, capture_output=True)
                if p.returncode != 0:
                    return jsonify({'error': f'git apply failed: {p.stderr.decode() }'}), 500
                applied.append(path)
            except Exception as e:
                return jsonify({'error': f'git apply error: {e}'}), 500
        else:
            return jsonify({'error': f'no content or patch for {path}'}), 400

    # try to commit changes if git available
    git_info = {'git_committed': False}
    try:
        # git add
        subprocess.run(['git', 'add', '--'] + applied, cwd=PROJECT_ROOT)
        subprocess.run(['git', 'commit', '-m', message, '--'] + applied, cwd=PROJECT_ROOT)
        git_info['git_committed'] = True
    except Exception:
        git_info['git_committed'] = False

    return jsonify({'applied': applied, 'backups': backups, 'git': git_info})



# ======================================================
# 🤖 AI CHAT-EDIT: Ollama → auto-apply source files
# ======================================================
FRONTEND_SRC_DIR = os.path.join(PROJECT_ROOT, 'frontend', 'src')
MAX_CTX_CHARS = 14000   # chars per file sent as context


def collect_project_context():
    """Walk frontend/src and return list of (rel_path, content)."""
    results = []
    skip_dirs = {'node_modules', '.git', 'build', 'dist', '__pycache__'}
    for root, dirs, files in os.walk(FRONTEND_SRC_DIR):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for fname in sorted(files):
            if fname.endswith(('.js', '.jsx', '.ts', '.tsx', '.css')):
                fpath = os.path.join(root, fname)
                rel = os.path.relpath(fpath, PROJECT_ROOT).replace('\\', '/')
                try:
                    size = os.path.getsize(fpath)
                    with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                        content = f.read(MAX_CTX_CHARS)
                    if size > MAX_CTX_CHARS:
                        content += f'\n... [TRUNCATED – {size} bytes total]'
                    results.append((rel, content))
                except Exception:
                    pass
    return results


def _extract_json(s):
    """Parse JSON from raw LLM output, handling markdown fences."""
    if not s:
        return None
    s = s.strip()
    # strip ```json ... ``` fences
    if '```' in s:
        parts = s.split('```')
        for i in range(1, len(parts), 2):
            candidate = parts[i].strip()
            if candidate.startswith('json'):
                candidate = candidate[4:].strip()
            try:
                return json.loads(candidate)
            except Exception:
                pass
    try:
        return json.loads(s)
    except Exception:
        pass
    a, b = s.find('{'), s.rfind('}')
    if a != -1 and b > a:
        try:
            return json.loads(s[a:b + 1])
        except Exception:
            pass
    return None


@app.route('/api/chat-edit', methods=['POST'])
def chat_edit():
    import re as _re
    data = request.json or {}
    message = data.get('message', '').strip()
    if not message:
        return jsonify({'error': 'Message is required'}), 400

    logger.info("chat-edit request: %s", message[:200])

    # Collect frontend file contexts (used by both fast path and AI path)
    file_contexts = collect_project_context()

    # ── Kata kunci semantik yang HARUS pergi ke AI Path, bukan Fast Path ──
    # Perintah seperti "ubah warna X menjadi Y" adalah instruksi semantik,
    # bukan penggantian teks literal — fast path akan salah baca "warna X" sebagai old_text.
    SEMANTIC_KEYWORDS = _re.compile(
        r'\b(warna|color|colour|ukuran|size|font|background|bg|border|padding|margin|style|tema|theme'
        r'|posisi|position|radius|shadow|opacity|visibility|display|flex|grid|layout'
        r'|icon|gambar|image|logo|animasi|animation|hover|active|dark|light'
        r'|pin|marker|peta|map|titik|dot|circle|lingkaran'
        r'|merah|biru|hijau|kuning|putih|hitam|abu|orange|ungu|pink|cyan|teal'
        r'|red|blue|green|yellow|white|black|gray|grey|purple|violet|emerald|indigo|rose|amber|lime'
        r'|tombol|button|header|footer|sidebar|navbar|card|panel|modal|popup|label|text|teks)\b',
        _re.IGNORECASE
    )

    # ── FAST PATH: hanya untuk penggantian teks label/string literal ──
    def _try_extract_replace(msg):
        """Aktif HANYA jika perintah tidak mengandung kata semantik (warna, style, dll)."""
        # Jika ada kata semantik → tolak fast path, serahkan ke AI
        if SEMANTIC_KEYWORDS.search(msg):
            return None, None
        action_m = _re.search(r'\b(ubah|ganti|change|rename)\b', msg, _re.IGNORECASE)
        if not action_m:
            return None, None
        after_action = msg[action_m.end():].strip()
        after_action = _re.sub(r'^teks\s+', '', after_action, flags=_re.IGNORECASE)
        sep_m = _re.search(r'\s+(?:menjadi|dengan|ke|to)\s+', after_action, _re.IGNORECASE)
        if not sep_m:
            return None, None
        old = after_action[:sep_m.start()].strip().strip('"\'').rstrip('.')
        new = after_action[sep_m.end():].strip().strip('"\'').rstrip('.')
        # Hanya terima jika old_text pendek dan kemungkinan teks literal (< 60 karakter)
        if old and new and len(old) < 60:
            return old, new
        return None, None

    direct_old, direct_new = _try_extract_replace(message)
    if direct_old:
        logger.info("chat-edit FAST PATH: '%s' -> '%s'", direct_old, direct_new)

    if direct_old is not None:
        # No AI needed — teks literal langsung diganti
        parsed = {
            'summary': f'Ubah "{direct_old}" menjadi "{direct_new}"',
            'changes': [{'old_text': direct_old, 'new_text': direct_new}]
        }
    else:
        # ── AI PATH: kirim konteks file yang relevan ──────────────────────────
        # Domain mapping: kata kunci → file yang HARUS diprioritaskan
        DOMAIN_MAP = {
            # Peta / CCTV markers
            _re.compile(r'\b(pin|marker|peta|map|cctv|lokasi|location|circle|pulse|traffic.*color|getTrafficColor|pulseIcon)\b', _re.I):
                ['frontend/src/App.js'],
            # Chatbot popup
            _re.compile(r'\b(chat|chatbot|popup|ChatPopup|assistant|bubble|message)\b', _re.I):
                ['frontend/src/components/ChatPopup.jsx'],
            # Admin panel
            _re.compile(r'\b(admin|Admin)\b', _re.I):
                ['frontend/src/Admin.js'],
            # Rute / routing
            _re.compile(r'\b(rute|route|routing|TrafficRoute|polyline)\b', _re.I):
                ['frontend/src/components/TrafficRoute.jsx', 'frontend/src/App.js'],
        }

        # Cari file yang wajib dimasukkan berdasarkan domain
        forced_paths = set()
        for pattern, paths in DOMAIN_MAP.items():
            if pattern.search(message):
                for p in paths:
                    forced_paths.add(p)

        def _score_relevance(rel_path, content, query):
            """Hitung skor relevansi file berdasarkan kata kunci query."""
            score = 0
            query_words = _re.findall(r'\w+', query.lower())
            content_lower = content.lower()
            path_lower = rel_path.lower()
            for w in query_words:
                if len(w) < 3:   # skip kata terlalu pendek (ke, di, dll)
                    continue
                cnt = content_lower.count(w)
                if cnt:
                    score += min(cnt, 10)  # cap per-word agar satu file tidak dominasi
                if w in path_lower:
                    score += 30   # bonus untuk nama file yang cocok
            # Bonus besar untuk file yang dipaksa masuk via domain map
            if rel_path.replace('\\', '/') in forced_paths:
                score += 500
            return score

        # Skor semua file dan ambil top-4 yang paling relevan
        scored = sorted(
            [(rel, content, _score_relevance(rel, content, message)) for rel, content in file_contexts],
            key=lambda x: x[2],
            reverse=True
        )
        top_files = scored[:4]

        # Bangun konteks file (trim tiap file maks 4000 char agar tidak overflow)
        file_ctx_str = ""
        for rel, content, score in top_files:
            if score == 0:
                continue
            snippet = content[:4000]
            file_ctx_str += f"\n--- FILE: {rel} ---\n{snippet}\n"

        # Hint arsitektur project agar AI tidak salah pilih file
        arch_hint = (
            "PROJECT ARCHITECTURE (read carefully before answering):\n"
            "- frontend/src/App.js         → Main map + CCTV pins. Map pin colors: `getTrafficColor()` returns hex (#22c55e green, #f97316 orange, #ef4444 red). "
            "Pin HTML template is in `pulseIcon()` function.\n"
            "- frontend/src/components/ChatPopup.jsx → AI chatbot popup. Contains LlmStatusDot (small colored dot) and MarkdownMessage bullet (small dot). "
            "NOT related to map pins.\n"
            "- frontend/src/Admin.js       → Admin dashboard page.\n"
            "- frontend/src/components/TrafficRoute.jsx → Route display on map.\n\n"
            "IMPORTANT RULES:\n"
            "1. 'pin lokasi', 'marker', 'titik lokasi di peta' → refers to pulseIcon() in App.js, NOT ChatPopup.jsx\n"
            "2. 'warna hijau/green' on map → color #22c55e in getTrafficColor() or pulseIcon() in App.js\n"
            "3. old_text must be VERBATIM text copied from the file shown below\n"
            "4. Keep old_text as SHORT as possible\n"
        )

        prompt = (
            "You are a precise code modification assistant. Output ONLY valid JSON, no explanation.\n\n"
            f"{arch_hint}\n"
            f"The user wants to make this change: \"{message}\"\n\n"
            "Look at the source files below and find the EXACT code snippet that needs to change.\n"
            f"{file_ctx_str}\n"
            "Respond with ONLY this JSON:\n"
            "{\"summary\":\"brief description\","
            "\"changes\":[{\"path\":\"relative/file/path\",\"old_text\":\"exact code to replace\","
            "\"new_text\":\"replacement code\"}]}"
        )

        logger.info("chat-edit AI PATH — forced files: %s", list(forced_paths))

        # ── Helper: nama warna → hex ────────────────────────────────────────
        COLOR_HEX = {
            'merah': '#ef4444', 'red': '#ef4444',
            'biru': '#3b82f6', 'blue': '#3b82f6',
            'hijau': '#22c55e', 'green': '#22c55e',
            'kuning': '#eab308', 'yellow': '#eab308',
            'oranye': '#f97316', 'orange': '#f97316',
            'ungu': '#8b5cf6', 'purple': '#8b5cf6', 'violet': '#8b5cf6',
            'pink': '#ec4899',
            'cyan': '#06b6d4', 'teal': '#14b8a6',
            'putih': '#ffffff', 'white': '#ffffff',
            'hitam': '#000000', 'black': '#000000',
            'abu': '#6b7280', 'gray': '#6b7280', 'grey': '#6b7280',
            'indigo': '#6366f1', 'emerald': '#10b981', 'lime': '#84cc16',
        }

        # ── Deteksi perubahan warna marker/pin secara deterministik ─────────
        # Tangkap pola: (change|ubah) * (marker|pin|cctv|...) * (color|warna) * (from|dari) * <warna1> * (to|menjadi) * <warna2>
        # Atau yang lebih sederhana: (ubah|change) * <konteks> * <warna1> * (menjadi|to|ke) * <warna2>
        color_names_pat = '|'.join(COLOR_HEX.keys())
        _map_color_re = _re.compile(
            r'\b(?:change|ubah|ganti)\b.{0,60}'
            r'\b(' + color_names_pat + r')\b'
            r'.{0,30}\b(?:to|menjadi|ke|jadi|with|dengan)\b.{0,10}'
            r'\b(' + color_names_pat + r')\b',
            _re.IGNORECASE
        )
        _mc = _map_color_re.search(message)
        is_map_color_request = bool(forced_paths & {'frontend/src/App.js'}) and _mc

        if is_map_color_request:
            from_color_name = _mc.group(1).lower()
            to_color_name   = _mc.group(2).lower()
            from_hex = COLOR_HEX.get(from_color_name)
            to_hex   = COLOR_HEX.get(to_color_name)
            logger.info("chat-edit MAP COLOR: %s(%s) → %s(%s)", from_color_name, from_hex, to_color_name, to_hex)

            if from_hex and to_hex:
                # Baca App.js dan replace semua kemunculan warna lama dengan warna baru
                app_js_path = os.path.abspath(os.path.join(PROJECT_ROOT, 'frontend/src/App.js'))
                if os.path.exists(app_js_path):
                    with open(app_js_path, 'r', encoding='utf-8') as f:
                        app_content = f.read()

                    # from_hex bisa juga dalam format rgba — cari variasi
                    # Hitung berapa occurrences dari from_hex
                    count_before = app_content.count(from_hex)
                    if count_before > 0:
                        new_content = app_content.replace(from_hex, to_hex)

                        # Juga ganti rgba variant jika ada
                        # rgba dari from_hex: extract r,g,b
                        def _hex_to_rgba_pattern(h):
                            h = h.lstrip('#')
                            r, g, b = int(h[0:2],16), int(h[2:4],16), int(h[4:6],16)
                            return f'rgba({r},{g},{b},'

                        def _hex_to_rgba_target(h):
                            h = h.lstrip('#')
                            r, g, b = int(h[0:2],16), int(h[2:4],16), int(h[4:6],16)
                            return f'rgba({r},{g},{b},'

                        from_rgba = _hex_to_rgba_pattern(from_hex)
                        to_rgba   = _hex_to_rgba_target(to_hex)
                        new_content = new_content.replace(from_rgba, to_rgba)

                        bak = f"{app_js_path}.bak.{int(time.time())}"
                        shutil.copy2(app_js_path, bak)
                        with open(app_js_path, 'w', encoding='utf-8') as f:
                            f.write(new_content)
                        logger.info("chat-edit MAP COLOR applied: %s → %s (%d occurrences)", from_hex, to_hex, count_before)
                        parsed = {
                            'summary': f'Ubah warna marker dari {from_color_name} ({from_hex}) menjadi {to_color_name} ({to_hex})',
                            'changes': [{'path': 'frontend/src/App.js', 'old_text': from_hex, 'new_text': to_hex}]
                        }
                        # Langsung return — bypass AI
                        return jsonify({
                            'applied': ['frontend/src/App.js'],
                            'backups': [bak],
                            'summary': parsed['summary'],
                            'git': {'git_committed': False},
                        })
                    else:
                        logger.info("chat-edit MAP COLOR: from_hex %s not found in App.js, falling through to AI", from_hex)

        # ── Panggil AI ───────────────────────────────────────────────────────
        def _call_sumopod(p, timeout=90):
            resp = requests.post(
                SUMOPOD_URL,
                headers=_sumopod_headers(),
                json={"model": SUMOPOD_MODEL, "messages": [{"role": "user", "content": p}], "stream": False},
                timeout=timeout,
            )
            if not resp.ok:
                raise RuntimeError(f'SumoPod HTTP {resp.status_code}')
            return (resp.json().get("choices") or [{}])[0].get("message", {}).get("content", "")

        try:
            ai_text = _call_sumopod(prompt)
        except Exception as e:
            logger.exception("SumoPod call failed in chat-edit")
            return jsonify({'error': f'SumoPod unreachable: {e}'}), 500

        logger.info("chat-edit AI response (%d chars):\n%s", len(ai_text), ai_text[:800])
        parsed = _extract_json(ai_text)

        # ── Retry dengan prompt minimal jika parse gagal ─────────────────────
        if not parsed or 'changes' not in parsed:
            logger.warning("chat-edit: first AI response not parseable, retrying with minimal prompt")
            minimal_prompt = (
                f"Task: {message}\n\n"
                "Output ONLY valid JSON (no markdown, no explanation):\n"
                "{\"summary\":\"short description\","
                "\"changes\":[{\"path\":\"file path\",\"old_text\":\"exact text to replace\",\"new_text\":\"replacement\"}]}"
            )
            try:
                ai_text2 = _call_sumopod(minimal_prompt, timeout=60)
                parsed = _extract_json(ai_text2)
                if parsed and 'changes' in parsed:
                    logger.info("chat-edit: retry succeeded")
                else:
                    logger.warning("chat-edit: retry also failed:\n%s", ai_text2[:400])
            except Exception:
                pass

        if not parsed or 'changes' not in parsed:
            return jsonify({
                'error': (
                    'Permintaan tidak dapat diproses otomatis.\n\n'
                    '💡 Coba format: "ubah [teks lama] menjadi [teks baru]"\n'
                    'Contoh: "ubah Mode Waktu menjadi Pilih Waktu"\n\n'
                    'Untuk warna pin peta: "ubah warna pin dari biru menjadi hijau"'
                ),
                'raw': ai_text[:500]
            }), 422


    # Apply changes — support both old_text/new_text and full content
    applied, backups, errors = [], [], []
    project_root_abs = os.path.abspath(PROJECT_ROOT)

    def _backup_and_write(abs_path, new_content):
        """Backup file then write new content. Returns backup path or None."""
        bak = None
        if os.path.exists(abs_path):
            bak = f"{abs_path}.bak.{int(time.time())}"
            shutil.copy2(abs_path, bak)
        else:
            os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        with open(abs_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        return bak

    def _normalize_ws(s):
        """Normalisasi whitespace: collapse semua whitespace (spasi, tab, newline) jadi satu spasi."""
        import re as _r
        return _r.sub(r'\s+', ' ', s).strip()

    def _find_in_content(file_content, old_text):
        """
        Cari old_text di file_content. Coba exact match dulu, lalu whitespace-normalized fallback.
        Kembalikan (actual_old_text, found) dimana actual_old_text = teks asli di file yang cocok.
        """
        # 1. Exact match
        if old_text in file_content:
            return old_text, True

        # 2. Whitespace-normalized match
        # Normalisasi old_text, lalu cari di file dengan sliding window
        norm_old = _normalize_ws(old_text)
        if not norm_old:
            return old_text, False

        # Split file jadi tokens kata (preserve non-whitespace)
        import re as _r
        # Coba match per-baris dulu: cari baris yang paling cocok
        lines = file_content.split('\n')
        for i, line in enumerate(lines):
            if _normalize_ws(line) == norm_old:
                return line, True  # kembalikan teks asli di file

        # Sliding window multi-baris: coba gabungkan 2-8 baris berturut-turut
        for window in range(2, 9):
            for i in range(len(lines) - window + 1):
                chunk = '\n'.join(lines[i:i+window])
                if _normalize_ws(chunk) == norm_old:
                    return chunk, True

        # 3. Partial match: old_text mungkin hanya sebagian kecil dari baris
        # Coba cari semua substring yang jika di-normalize sama dengan norm_old
        # (Gunakan regex untuk handle whitespace fleksibel)
        try:
            # Buat pattern dari norm_old dengan whitespace fleksibel
            pattern_str = _r.sub(r'\\ ', r'\\s+', _r.escape(norm_old))
            pattern = _r.compile(pattern_str, _r.MULTILINE | _r.DOTALL)
            m = pattern.search(file_content)
            if m:
                return m.group(0), True
        except Exception:
            pass

        return old_text, False

    def _find_file_with_text(old_text):
        """Search all frontend files for old_text (exact or fuzzy), return (rel_path, abs_path, actual_old) or (None, None, None)."""
        for rel, _content in file_contexts:
            ap = os.path.abspath(os.path.join(PROJECT_ROOT, rel))
            try:
                with open(ap, 'r', encoding='utf-8', errors='replace') as f:
                    content = f.read()
                actual, found = _find_in_content(content, old_text)
                if found:
                    return rel, ap, actual
            except Exception:
                pass
        return None, None, None

    for ch in parsed.get('changes', []):
        path      = ch.get('path', '').strip().replace('\\', '/')
        old_text  = ch.get('old_text', '')
        new_text  = ch.get('new_text', '')
        content   = ch.get('content', '')   # full-file fallback

        # ── Strategy 1: old_text → new_text (preferred, small output) ──
        if old_text:
            abs_path = os.path.abspath(os.path.join(PROJECT_ROOT, path)) if path else None
            file_content = None
            actual_old = old_text   # teks asli di file yang akan diganti

            # Coba baca file yang disebutkan AI
            if abs_path and abs_path.startswith(project_root_abs) and os.path.exists(abs_path):
                with open(abs_path, 'r', encoding='utf-8', errors='replace') as f:
                    file_content = f.read()
                actual_old_candidate, found = _find_in_content(file_content, old_text)
                if found:
                    actual_old = actual_old_candidate
                else:
                    file_content = None   # tidak ketemu, cari di file lain

            if file_content is None:
                # Auto-search semua file frontend (exact + fuzzy)
                found_rel, found_abs, actual_old_candidate = _find_file_with_text(old_text)
                if not found_rel:
                    errors.append({'path': path or '(auto)', 'error': f'old_text not found in any file: "{old_text[:80]}"'})
                    continue
                path, abs_path = found_rel, found_abs
                actual_old = actual_old_candidate
                with open(abs_path, 'r', encoding='utf-8', errors='replace') as f:
                    file_content = f.read()

            # Apply replacement (pakai actual_old yang sudah diverifikasi ada di file)
            new_file_content = file_content.replace(actual_old, new_text, 1)
            try:
                bak = _backup_and_write(abs_path, new_file_content)
                if bak:
                    backups.append(bak)
                applied.append(path)
                logger.info("chat-edit (replace) applied: %s | '%s' → '%s'", path, actual_old[:60], new_text[:60])
            except Exception as e:
                errors.append({'path': path, 'error': str(e)})
            continue


        # ── Strategy 2: full content (fallback) ──
        if content and path:
            abs_path = os.path.abspath(os.path.join(PROJECT_ROOT, path))
            if not abs_path.startswith(project_root_abs):
                errors.append({'path': path, 'error': 'Path outside project root'})
                continue
            try:
                bak = _backup_and_write(abs_path, content)
                if bak:
                    backups.append(bak)
                applied.append(path)
                logger.info("chat-edit (full) applied: %s", path)
            except Exception as e:
                errors.append({'path': path, 'error': str(e)})
            continue

        errors.append({'path': path or '?', 'error': 'No old_text or content provided by AI'})

    return jsonify({
        'success': len(applied) > 0,
        'summary': parsed.get('summary', 'Perubahan diterapkan'),
        'applied': applied,
        'backups': backups,
        'errors': errors,
    })


@app.route('/api/undo-edit', methods=['POST'])
def undo_edit():
    """Restore files from .bak.TIMESTAMP backups created by chat-edit."""
    data = request.json or {}
    backups = data.get('backups', [])
    if not backups:
        return jsonify({'error': 'No backups specified'}), 400

    project_root_abs = os.path.abspath(PROJECT_ROOT)
    restored, errors = [], []

    for bak_path in backups:
        abs_bak = os.path.abspath(bak_path)
        if not abs_bak.startswith(project_root_abs):
            errors.append({'backup': bak_path, 'error': 'Outside project root'})
            continue
        if not os.path.exists(abs_bak):
            errors.append({'backup': bak_path, 'error': 'Backup not found'})
            continue
        idx = abs_bak.rfind('.bak.')
        if idx == -1:
            errors.append({'backup': bak_path, 'error': 'Invalid backup filename'})
            continue
        original = abs_bak[:idx]
        try:
            shutil.copy2(abs_bak, original)
            os.remove(abs_bak)
            restored.append(os.path.relpath(original, PROJECT_ROOT).replace('\\', '/'))
            logger.info("undo-edit: restored %s", original)
        except Exception as e:
            errors.append({'backup': bak_path, 'error': str(e)})

    return jsonify({'success': len(restored) > 0, 'restored': restored, 'errors': errors})


# ======================================================
# 📊 LAPORAN PERIODIK
# ======================================================
@app.route("/api/reports/periodic")
def periodic_report():
    """
    Generate laporan periodik lalu lintas.
    ?range=7d|30d|today
    Returns aggregated stats: total scans, peak hours, busiest corridors, trends.
    """
    range_param = request.args.get("range", "7d")
    delta_map   = {"today": timedelta(days=1), "7d": timedelta(days=7), "30d": timedelta(days=30)}
    delta       = delta_map.get(range_param, timedelta(days=7))

    try:
        conn = db_handler.get_db_connection()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        # ── 1. Total records & rentang waktu ─────────────────────────────
        cur.execute("""
            SELECT COUNT(*) AS total_records,
                   MIN(timestamp) AS from_ts,
                   MAX(timestamp) AS to_ts,
                   AVG(vehicles)  AS global_avg,
                   MAX(vehicles)  AS global_max
            FROM traffic_logs
            WHERE timestamp >= NOW() - %s::interval
        """, (str(delta),))
        summary = dict(cur.fetchone() or {})

        # ── 2. Jam tersibuk (per jam dalam rentang) ───────────────────────
        cur.execute("""
            SELECT EXTRACT(HOUR FROM timestamp)::int AS hour,
                   AVG(vehicles) AS avg_v,
                   MAX(vehicles) AS max_v,
                   COUNT(*)      AS samples
            FROM traffic_logs
            WHERE timestamp >= NOW() - %s::interval
            GROUP BY hour ORDER BY avg_v DESC LIMIT 6
        """, (str(delta),))
        peak_hours = [dict(r) for r in cur.fetchall()]

        # ── 3. Hari tersibuk ─────────────────────────────────────────────
        cur.execute("""
            SELECT TO_CHAR(timestamp, 'Day') AS day_name,
                   EXTRACT(DOW FROM timestamp)::int AS dow,
                   AVG(vehicles) AS avg_v
            FROM traffic_logs
            WHERE timestamp >= NOW() - %s::interval
            GROUP BY day_name, dow ORDER BY avg_v DESC
        """, (str(delta),))
        peak_days = [dict(r) for r in cur.fetchall()]

        # ── 4. Top 10 koridor terpadat ────────────────────────────────────
        cur.execute("""
            SELECT tl.location_id AS id,
                   COALESCE(cl.name, ct.name) AS name,
                   AVG(tl.vehicles)  AS avg_v,
                   MAX(tl.vehicles)  AS peak_v,
                   COUNT(*)          AS samples
            FROM traffic_logs tl
            LEFT JOIN cctv_locations cl ON tl.location_id = cl.id
            LEFT JOIN current_traffic ct ON tl.location_id = ct.id
            WHERE tl.timestamp >= NOW() - %s::interval
            GROUP BY tl.location_id, cl.name, ct.name
            ORDER BY avg_v DESC LIMIT 10
        """, (str(delta),))
        top_corridors = [dict(r) for r in cur.fetchall()]

        # ── 5. Tren harian (rata-rata per hari) ──────────────────────────
        cur.execute("""
            SELECT DATE(timestamp) AS day,
                   AVG(vehicles)   AS avg_v,
                   MAX(vehicles)   AS peak_v,
                   COUNT(DISTINCT location_id) AS cameras
            FROM traffic_logs
            WHERE timestamp >= NOW() - %s::interval
            GROUP BY day ORDER BY day
        """, (str(delta),))
        daily_trend = [dict(r) for r in cur.fetchall()]
        for d in daily_trend:
            d["day"] = str(d["day"])

        # ── 6. Laporan masyarakat dalam periode ───────────────────────────
        cur.execute("""
            SELECT report_type, COUNT(*) AS cnt, status
            FROM crowd_reports
            WHERE created_at >= NOW() - %s::interval
            GROUP BY report_type, status ORDER BY cnt DESC
        """, (str(delta),))
        crowd_summary = [dict(r) for r in cur.fetchall()]

        conn.close()

        for k in ("from_ts","to_ts"):
            if summary.get(k):
                summary[k] = str(summary[k])
        for row in summary, *peak_hours, *peak_days, *top_corridors:
            for key in list(row.keys()):
                if hasattr(row[key], '__float__'):
                    row[key] = round(float(row[key]), 2)

        return jsonify({
            "range":        range_param,
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "summary":      summary,
            "peak_hours":   peak_hours,
            "peak_days":    peak_days,
            "top_corridors":top_corridors,
            "daily_trend":  daily_trend,
            "crowd_summary":crowd_summary,
        })
    except Exception as e:
        logger.error("[periodic_report] %s", e)
        return jsonify({"error": str(e)}), 500


# ======================================================
# 🔮 PREDIKSI LALU LINTAS (Lightweight ML)
# ======================================================
@app.route("/api/predict/corridor/<int:location_id>")
def predict_corridor(location_id):
    """
    Prediksi kepadatan 1–3 jam ke depan untuk satu koridor.
    Metode: weighted moving average historis per jam (7 hari terakhir)
    dikombinasikan dengan tren saat ini.
    """
    horizon = min(int(request.args.get("horizon", 3)), 6)
    try:
        conn = db_handler.get_db_connection()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        now_hour = _jak_hour()

        # Rata-rata historis per jam (7 hari) untuk jam ini + beberapa jam ke depan
        hours_needed = [(now_hour + h) % 24 for h in range(horizon + 1)]
        cur.execute("""
            SELECT EXTRACT(HOUR FROM timestamp)::int AS hour,
                   AVG(vehicles) AS avg_v,
                   STDDEV(vehicles) AS std_v,
                   COUNT(*) AS samples
            FROM traffic_logs
            WHERE location_id = %s
              AND timestamp >= NOW() - INTERVAL '14 days'
            GROUP BY hour ORDER BY hour
        """, (location_id,))
        hist = {int(r["hour"]): r for r in cur.fetchall()}

        # Nilai saat ini
        cur.execute("""
            SELECT vehicles FROM traffic_logs
            WHERE location_id = %s
            ORDER BY timestamp DESC LIMIT 5
        """, (location_id,))
        recent = [r["vehicles"] for r in cur.fetchall() if r["vehicles"] is not None]
        current_v = sum(recent) / len(recent) if recent else 0

        # Prediksi: interpolasi antara nilai saat ini dan historis per jam
        predictions = []
        for h in range(1, horizon + 1):
            target_hour = (now_hour + h) % 24
            hist_row    = hist.get(target_hour, {})
            hist_avg    = float(hist_row.get("avg_v") or current_v)
            hist_std    = float(hist_row.get("std_v") or 5.0)
            samples     = int(hist_row.get("samples") or 0)

            # Blend: semakin jauh ke depan, semakin bergantung pada historis
            blend   = min(h / horizon, 1.0)
            pred_v  = round((1 - blend) * current_v + blend * hist_avg, 1)
            status  = "padat" if pred_v > 40 else "ramai" if pred_v > 20 else "lancar"
            color   = "#f43f5e" if pred_v > 40 else "#f59e0b" if pred_v > 20 else "#22c55e"
            conf    = min(int(samples / 5 * 100), 95) if samples else 30

            predictions.append({
                "hour":       target_hour,
                "label":      f"{target_hour:02d}:00",
                "vehicles":   pred_v,
                "hist_avg":   round(hist_avg, 1),
                "hist_std":   round(hist_std, 1),
                "status":     status,
                "color":      color,
                "confidence": conf,
            })

        cam_name = None
        cur.execute("SELECT COALESCE(name,'') FROM current_traffic WHERE id=%s", (location_id,))
        row = cur.fetchone()
        if row: cam_name = list(row.values())[0]
        conn.close()

        return jsonify({
            "location_id": location_id,
            "name":        cam_name,
            "current":     round(current_v, 1),
            "current_hour": now_hour,
            "predictions": predictions,
            "method":      "weighted-historical-blend",
        })
    except Exception as e:
        logger.error("[predict_corridor] %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/predict/overview")
def predict_overview():
    """
    Prediksi global Jakarta 1 jam ke depan — semua koridor sekaligus.
    Returns: daftar location_id → predicted_vehicles untuk 1h ke depan.
    """
    try:
        conn = db_handler.get_db_connection()
        cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        now_h  = _jak_hour()
        next_h = (now_h + 1) % 24

        cur.execute("""
            SELECT tl.location_id AS id,
                   AVG(tl.vehicles) AS hist_avg,
                   ct.vehicles AS current_v,
                   COALESCE(cl.name, ct.name) AS name
            FROM traffic_logs tl
            LEFT JOIN current_traffic ct ON tl.location_id = ct.id
            LEFT JOIN cctv_locations  cl ON tl.location_id = cl.id
            WHERE tl.timestamp >= NOW() - INTERVAL '14 days'
              AND EXTRACT(HOUR FROM tl.timestamp)::int = %s
            GROUP BY tl.location_id, ct.vehicles, cl.name, ct.name
        """, (next_h,))
        rows = cur.fetchall()
        conn.close()

        result = []
        for r in rows:
            cur_v  = float(r["current_v"] or 0)
            hist_v = float(r["hist_avg"] or cur_v)
            pred_v = round(0.45 * cur_v + 0.55 * hist_v, 1)
            result.append({
                "id":       r["id"],
                "name":     r["name"],
                "pred":     pred_v,
                "current":  round(cur_v, 1),
                "status":   "padat" if pred_v > 40 else "ramai" if pred_v > 20 else "lancar",
            })

        return jsonify({"hour": next_h, "predictions": result, "count": len(result)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ======================================================
# 🚨 INCIDENT DETECTION
# ======================================================
@app.route("/api/incidents")
def get_incidents():
    """Return active incidents terdeteksi oleh GPU scanner."""
    return jsonify({
        "incidents": list(_active_incidents.values()),
        "total": len(_active_incidents),
        "ts": time.time(),
    })

# 📡 CAMERA HEALTH MONITORING
# ======================================================
@app.route("/api/cameras/health")
def cameras_health():
    """
    Return per-camera health: last_seen, error_count, status, calibration.
    Gabungan in-memory scan results + DB camera_config.
    """
    try:
        cctv = db_handler.get_all_cctv_status()
        configs = db_handler.get_camera_configs()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    now = datetime.now()
    result = []
    for cam in cctv:
        cam_id = cam["id"]
        h      = _cam_health.get(cam_id, {})
        cfg    = configs.get(cam_id, {})

        last_seen = h.get("last_seen")
        if last_seen:
            try:
                ls_dt  = datetime.strptime(last_seen, "%Y-%m-%d %H:%M:%S")
                age_s  = int((now - ls_dt).total_seconds())
            except Exception:
                age_s = None
        else:
            last_seen = _ts_str(cam.get("last_gpu_scan"))
            age_s = None
            if last_seen:
                try:
                    ls_dt = datetime.strptime(last_seen, "%Y-%m-%d %H:%M:%S")
                    age_s = int((now - ls_dt).total_seconds())
                except Exception:
                    pass

        consec = h.get("consecutive_errors", 0)
        has_stream = bool(cam.get("stream_url") or cam.get("preview_url"))

        if cfg.get("maintenance"):
            cam_status = "maintenance"
        elif not has_stream:
            cam_status = "no_stream"
        elif age_s is None:
            cam_status = "unknown"
        elif consec >= 3:
            cam_status = "offline"
        elif age_s > 300:
            cam_status = "stale"
        else:
            cam_status = "online"

        result.append({
            "id":                 cam_id,
            "name":               cam.get("name"),
            "lat":                cam.get("lat"),
            "lng":                cam.get("lng"),
            "road_type":          cam.get("road_type", "city"),
            "has_stream":         has_stream,
            "last_seen":          last_seen,
            "last_seen_age_s":    age_s,
            "last_count":         h.get("last_count"),
            "speed_kmh":          h.get("speed_kmh"),
            "success_count":      h.get("success_count", 0),
            "error_count":        h.get("error_count", 0),
            "consecutive_errors": consec,
            "status":             cam_status,
            "maintenance":        bool(cfg.get("maintenance", False)),
            "maintenance_note":   cfg.get("maintenance_note", ""),
            "pix_per_meter":      float(cfg.get("pix_per_meter", 8.0)),
        })

    online   = sum(1 for r in result if r["status"] == "online")
    offline  = sum(1 for r in result if r["status"] in ("offline", "stale"))
    maint    = sum(1 for r in result if r["status"] == "maintenance")
    no_stream = sum(1 for r in result if r["status"] == "no_stream")

    return jsonify({
        "cameras": result,
        "summary": {
            "total": len(result),
            "online": online,
            "offline": offline,
            "maintenance": maint,
            "no_stream": no_stream,
        }
    })


@app.route("/api/cameras/<int:cam_id>/config", methods=["PUT"])
def update_camera_config(cam_id):
    """Update konfigurasi kamera: maintenance status dan kalibrasi pix_per_meter."""
    data = request.json or {}
    try:
        db_handler.upsert_camera_config(
            cam_id       = cam_id,
            maintenance  = data.get("maintenance"),
            maintenance_note = data.get("maintenance_note"),
            pix_per_meter    = data.get("pix_per_meter"),
        )
        if cam_id in _cam_health:
            _cam_health[cam_id]["maintenance"] = data.get("maintenance", False)
        return jsonify({"status": "ok", "cam_id": cam_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ======================================================
# 📋 CROWD REPORTS (Laporan Masyarakat)
# ======================================================
import hashlib as _hashlib

@app.route("/api/reports", methods=["GET"])
def get_reports():
    """Ambil laporan aktif (pending + verified) dalam 24 jam terakhir."""
    include_resolved = request.args.get("all") == "1"
    try:
        reports = db_handler.get_crowd_reports(include_resolved=include_resolved)
        return jsonify({"reports": reports, "count": len(reports)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/reports", methods=["POST"])
def add_report():
    """User submit laporan kondisi jalan."""
    data = request.json or {}
    report_type  = data.get("type", "")
    lat          = data.get("lat")
    lng          = data.get("lng")
    description  = data.get("description", "")

    VALID_TYPES = {"macet", "banjir", "kecelakaan", "tutup", "galian", "longsor"}
    if report_type not in VALID_TYPES:
        return jsonify({"error": "Tipe laporan tidak valid"}), 400
    if lat is None or lng is None:
        return jsonify({"error": "Koordinat wajib diisi"}), 400
    try:
        lat, lng = float(lat), float(lng)
    except Exception:
        return jsonify({"error": "Koordinat tidak valid"}), 400
    if not (-7.5 < lat < -5.5 and 106.0 < lng < 107.5):
        return jsonify({"error": "Koordinat di luar wilayah Jakarta"}), 400

    ip_raw  = request.headers.get("X-Forwarded-For", request.remote_addr) or ""
    ip_hash = _hashlib.sha256(ip_raw.encode()).hexdigest()[:16]

    try:
        report_id = db_handler.add_crowd_report(report_type, lat, lng, description, ip_hash)
        if report_id:
            # Broadcast ke operator via WebSocket
            socketio.emit("new_report", {
                "id": report_id, "type": report_type,
                "lat": lat, "lng": lng, "description": description,
                "status": "pending", "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            })
            return jsonify({"status": "ok", "id": report_id}), 201
        return jsonify({"error": "Gagal menyimpan laporan"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/reports/<int:report_id>", methods=["PUT"])
def update_report(report_id):
    """Operator: ubah status laporan (verified / dismissed / resolved)."""
    data   = request.json or {}
    status = data.get("status", "")
    VALID  = {"verified", "dismissed", "resolved", "pending"}
    if status not in VALID:
        return jsonify({"error": "Status tidak valid"}), 400
    try:
        db_handler.update_crowd_report(report_id, status, data.get("operator_note"))
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/reports/<int:report_id>", methods=["DELETE"])
def delete_report(report_id):
    """Operator: hapus laporan."""
    try:
        conn = db_handler.get_db_connection()
        cur  = conn.cursor()
        cur.execute("DELETE FROM crowd_reports WHERE id = %s", (report_id,))
        conn.commit(); conn.close()
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ======================================================
# 🚀 MAIN
# ======================================================
if __name__ == "__main__":
    # mining_job()  # DISABLED: Mining off

    socketio.run(
        app,
        host="0.0.0.0",
        port=5000,
        debug=False,
        use_reloader=False,
        allow_unsafe_werkzeug=True,
    )
