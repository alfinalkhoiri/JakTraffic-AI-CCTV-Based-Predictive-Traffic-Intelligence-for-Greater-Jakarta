import psycopg2
import psycopg2.extras
from datetime import datetime
import logging
import os
from dotenv import load_dotenv

load_dotenv()

# Stream URL yang di-proxied melalui Nginx reverse proxy kita
# Kamera yang bisa diakses dari server SG → route lewat proxy domain kita
_STREAM_PROXY_MAP = {
    "https://camera.jtd.co.id/": "/stream-proxy/jtd/",
    "https://cctv.kkdm.co.id/":  "/stream-proxy/kkdm/",
}

def _proxy_stream_url(url: str | None) -> str | None:
    """Ganti upstream stream URL dengan path proxy Nginx jika tersedia."""
    if not url:
        return url
    for upstream, proxy_path in _STREAM_PROXY_MAP.items():
        if url.startswith(upstream):
            return proxy_path + url[len(upstream):]
    return url

# ===============================
# CONFIG
# ===============================

DB_CONFIG = {
    "host":     os.getenv("DB_HOST", "localhost"),
    "port":     int(os.getenv("DB_PORT", 5432)),
    "dbname":   os.getenv("DB_NAME", "traffic_system"),
    "user":     os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", ""),
}

logger = logging.getLogger(__name__)

BACKUP_COORDS = {
    1:  {"lat": -6.2095, "lng": 106.8190, "name": "Bendungan Hilir",       "road_type": "city"},
    2:  {"lat": -6.2168, "lng": 106.8003, "name": "Gelora",                "road_type": "city"},
    3:  {"lat": -6.1800, "lng": 106.7737, "name": "Tanjung Duren",         "road_type": "city"},
    4:  {"lat": -6.1753, "lng": 106.7972, "name": "Tomang",                "road_type": "city"},
    5:  {"lat": -6.1848, "lng": 106.8032, "name": "Jati Pulo",             "road_type": "city"},
    6:  {"lat": -6.1897, "lng": 106.7870, "name": "Kemanggisan",           "road_type": "city"},
    7:  {"lat": -6.1965, "lng": 106.8310, "name": "Menteng",               "road_type": "city"},
    8:  {"lat": -6.2218, "lng": 106.8411, "name": "Pasar Manggis",         "road_type": "city"},
    9:  {"lat": -6.2272, "lng": 106.8014, "name": "Senayan",               "road_type": "city"},
    10: {"lat": -6.2336, "lng": 106.8238, "name": "Kuningan Barat",        "road_type": "city"},
    11: {"lat": -6.2442, "lng": 106.8513, "name": "Cikoko",                "road_type": "city"},
    12: {"lat": -6.1260, "lng": 106.7235, "name": "Cengkareng Barat",      "road_type": "city"},
    14: {"lat": -6.1793, "lng": 106.8229, "name": "Gambir",                "road_type": "city"},
    15: {"lat": -6.1762, "lng": 106.8676, "name": "Cempaka Putih",         "road_type": "city"},
    16: {"lat": -6.1887, "lng": 106.8704, "name": "Rawa Sari",             "road_type": "city"},
    17: {"lat": -6.1473, "lng": 106.7180, "name": "Kalideres",             "road_type": "city"},
    18: {"lat": -6.1284, "lng": 106.8050, "name": "Penjaringan",           "road_type": "city"},
    19: {"lat": -6.2095, "lng": 106.7381, "name": "Meruya Selatan",        "road_type": "city"},
    20: {"lat": -6.3076, "lng": 106.8274, "name": "Ragunan",               "road_type": "city"},
    21: {"lat": -6.3123, "lng": 106.7814, "name": "Lebak Bulus",           "road_type": "city"},
    22: {"lat": -6.2175, "lng": 106.7818, "name": "Grogol Utara",          "road_type": "city"},
    23: {"lat": -6.1963, "lng": 106.9052, "name": "Jatinegara",            "road_type": "city"},
    24: {"lat": -6.2368, "lng": 106.8709, "name": "Kampung Melayu",        "road_type": "city"},
    25: {"lat": -6.1771, "lng": 106.9485, "name": "Cakung Timur",          "road_type": "city"},
    26: {"lat": -6.1519, "lng": 106.8976, "name": "Kelapa Gading",         "road_type": "city"},
    27: {"lat": -6.1508, "lng": 106.8794, "name": "Sunter Jaya",           "road_type": "city"},
    28: {"lat": -6.1272, "lng": 106.8550, "name": "Sunter Agung",          "road_type": "city"},
    29: {"lat": -6.1754, "lng": 106.9181, "name": "Tol KG-PG - Kayu Putih",   "road_type": "toll"},
    30: {"lat": -6.1781, "lng": 106.9182, "name": "Tol KG-PG - Pulo Gadung",  "road_type": "toll"},
    31: {"lat": -6.1828, "lng": 106.9378, "name": "Tol KG-PG - Rawa Terate",  "road_type": "toll"},
    32: {"lat": -6.1849, "lng": 106.9465, "name": "Tol KG-PG - Cakung 1",     "road_type": "toll"},
    33: {"lat": -6.1857, "lng": 106.9507, "name": "Tol KG-PG - Cakung 2",     "road_type": "toll"},
    34: {"lat": -6.1648, "lng": 106.9125, "name": "Tol KG-PG - Kelapa Gading","road_type": "toll"},
    35: {"lat": -6.2427, "lng": 106.8972, "name": "Tol BCKM - Cawang",        "road_type": "toll"},
    36: {"lat": -6.2492, "lng": 106.9370, "name": "Tol BCKM - Duren Sawit",   "road_type": "toll"},
    37: {"lat": -6.2476, "lng": 106.9772, "name": "Tol BCKM - Bekasi Barat",  "road_type": "toll"},
    # Bekasi
    38: {"lat": -6.2392, "lng": 106.9936, "name": "Simpang Lima Bekasi",           "road_type": "city"},
    39: {"lat": -6.2363, "lng": 107.0057, "name": "Jl. Ahmad Yani - Kayuringin",   "road_type": "city"},
    40: {"lat": -6.2271, "lng": 106.9991, "name": "Jl. Cut Meutia - KH Noer Ali",  "road_type": "city"},
    41: {"lat": -6.2213, "lng": 106.9974, "name": "Jl. Sudirman Bekasi",           "road_type": "city"},
    42: {"lat": -6.2146, "lng": 107.0131, "name": "Jl. Raya Bekasi - Sumber Arta", "road_type": "city"},
    43: {"lat": -6.2604, "lng": 107.0278, "name": "Tol Bekasi Timur",              "road_type": "toll"},
    44: {"lat": -6.2549, "lng": 106.9855, "name": "Jl. Raya Jatiwaringin",         "road_type": "city"},
    45: {"lat": -6.2099, "lng": 107.0001, "name": "Harapan Indah Bekasi",          "road_type": "city"},
    46: {"lat": -6.2804, "lng": 106.9739, "name": "Pondok Gede",                   "road_type": "city"},
    47: {"lat": -6.1874, "lng": 107.0323, "name": "Jl. Raya Babelan",              "road_type": "city"},
    48: {"lat": -6.2888, "lng": 106.9901, "name": "Jl. Lingkar Selatan Bekasi",    "road_type": "city"},
    49: {"lat": -6.2172, "lng": 107.0003, "name": "Kranji - Bekasi Barat",         "road_type": "city"},
    50: {"lat": -6.2303, "lng": 106.9872, "name": "Jl. Ir. H. Juanda Bekasi",      "road_type": "city"},
}

# ===============================
# CONNECTION
# ===============================

def get_db_connection():
    conn = psycopg2.connect(**DB_CONFIG)
    return conn

# ===============================
# READ OPERATIONS
# ===============================

def get_all_cctv_status():
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        cur.execute("""
            SELECT ct.id, ct.vehicles, ct.weather, ct.status, ct.risk_score, ct.last_update,
                   ct.last_gpu_scan, ct.speed_kmh,
                   COALESCE(cl.name, ct.name) AS name,
                   COALESCE(cl.lat,  ct.lat)  AS lat,
                   COALESCE(cl.lng,  ct.lng)  AS lng,
                   COALESCE(cl.stream_url,  ct.stream_url)  AS stream_url,
                   COALESCE(cl.preview_url, ct.preview_url) AS preview_url,
                   cl.road_type
            FROM current_traffic ct
            LEFT JOIN cctv_locations cl ON ct.id = cl.id
            ORDER BY ct.id
        """)
        rows = cur.fetchall()

        results = []
        for row in rows:
            data = dict(row)
            cctv_id = data.get("id")

            if data.get("lat") is None or data.get("lng") is None:
                if cctv_id in BACKUP_COORDS:
                    data["lat"] = BACKUP_COORDS[cctv_id]["lat"]
                    data["lng"] = BACKUP_COORDS[cctv_id]["lng"]
                    data["name"] = BACKUP_COORDS[cctv_id]["name"]
            if data.get("road_type") is None:
                data["road_type"] = BACKUP_COORDS.get(cctv_id, {}).get("road_type", "city")

            # Jalan tol tidak memiliki lampu merah — rekomendasi sinyal tidak berlaku
            data["has_signal"] = data.get("road_type") != "toll"

            # Transform stream URLs ke Nginx proxy path jika tersedia
            data["stream_url"]  = _proxy_stream_url(data.get("stream_url"))
            data["preview_url"] = _proxy_stream_url(data.get("preview_url"))

            results.append(data)

        return results

    except Exception as e:
        logger.error(f"[DB] get_all_cctv_status error: {e}")
        return []

    finally:
        cur.close()
        conn.close()


def get_traffic_stats(limit=30):
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        cur.execute("""
            SELECT timestamp, SUM(vehicles) AS total_vehicles
            FROM traffic_logs
            GROUP BY timestamp
            ORDER BY timestamp DESC
            LIMIT %s
        """, (limit,))

        rows = cur.fetchall()

        return [
            {"timestamp": r["timestamp"], "count": r["total_vehicles"]}
            for r in reversed(rows)
        ]

    except Exception as e:
        logger.error(f"[DB] get_traffic_stats error: {e}")
        return []

    finally:
        cur.close()
        conn.close()

# ===============================
# WRITE OPERATIONS
# ===============================

def insert_log(location_id, vehicles, timestamp=None):
    if timestamp is None:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute("""
            INSERT INTO traffic_logs (location_id, vehicles, timestamp)
            VALUES (%s, %s, %s)
        """, (location_id, vehicles, timestamp))
        conn.commit()

    except Exception as e:
        logger.error(f"[DB] insert_log error: {e}")
        conn.rollback()

    finally:
        cur.close()
        conn.close()


def update_traffic_data(location_id, vehicles, weather=None, status=None, risk_score=None):
    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute("""
            UPDATE current_traffic
            SET vehicles = %s,
                weather = COALESCE(%s, weather),
                status = COALESCE(%s, status),
                risk_score = COALESCE(%s, risk_score),
                last_update = CURRENT_TIMESTAMP
            WHERE id = %s
        """, (vehicles, weather, status, risk_score, location_id))

        cur.execute("""
            INSERT INTO traffic_logs (location_id, vehicles, timestamp)
            VALUES (%s, %s, CURRENT_TIMESTAMP)
        """, (location_id, vehicles))

        conn.commit()

    except Exception as e:
        logger.error(f"[DB] update_traffic_data error (loc {location_id}): {e}")
        conn.rollback()

    finally:
        cur.close()
        conn.close()


def get_usual_traffic(location_id, days=7):
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        cur.execute("""
            SELECT AVG(vehicles) AS avg_usual
            FROM traffic_logs
            WHERE location_id = %s
              AND TO_CHAR(timestamp, 'HH24') = TO_CHAR(NOW(), 'HH24')
              AND timestamp::date < CURRENT_DATE
              AND timestamp >= NOW() - INTERVAL '%s days'
        """ % ('%s', days), (location_id,))

        row = cur.fetchone()
        return float(row["avg_usual"]) if row and row["avg_usual"] else 0.0

    except Exception as e:
        logger.error(f"[DB] get_usual_traffic error: {e}")
        return 0.0

    finally:
        cur.close()
        conn.close()

# ===============================
# CAMERA CRUD (ADMIN)
# ===============================

def add_camera(name, stream_url, lat, lng):
    conn = get_db_connection()
    cur = conn.cursor()

    try:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        cur.execute("""
            INSERT INTO cctv_locations (name, stream_url, lat, lng)
            VALUES (%s, %s, %s, %s)
            RETURNING id
        """, (name, stream_url, lat, lng))

        cam_id = cur.fetchone()[0]

        cur.execute("""
            INSERT INTO current_traffic (id, vehicles, lat, lng, last_update)
            VALUES (%s, 0, %s, %s, %s)
        """, (cam_id, lat, lng, timestamp))

        conn.commit()
        return cam_id

    except Exception as e:
        logger.error(f"[DB] add_camera error: {e}")
        conn.rollback()
        raise

    finally:
        cur.close()
        conn.close()


def update_camera(cam_id, name, stream_url, lat, lng):
    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute("""
            UPDATE cctv_locations
            SET name = %s, stream_url = %s, lat = %s, lng = %s
            WHERE id = %s
        """, (name, stream_url, lat, lng, cam_id))

        cur.execute("""
            UPDATE current_traffic
            SET lat = %s, lng = %s
            WHERE id = %s
        """, (lat, lng, cam_id))

        conn.commit()

    except Exception as e:
        logger.error(f"[DB] update_camera error: {e}")
        conn.rollback()
        raise

    finally:
        cur.close()
        conn.close()


def delete_camera(cam_id):
    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute("DELETE FROM traffic_logs WHERE location_id = %s", (cam_id,))
        cur.execute("DELETE FROM current_traffic WHERE id = %s", (cam_id,))
        cur.execute("DELETE FROM cctv_locations WHERE id = %s", (cam_id,))
        conn.commit()

    except Exception as e:
        logger.error(f"[DB] delete_camera error: {e}")
        conn.rollback()
        raise

    finally:
        cur.close()
        conn.close()


def init_extensions():
    """Buat tabel crowd_reports dan camera_config jika belum ada."""
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS crowd_reports (
                id           SERIAL PRIMARY KEY,
                report_type  VARCHAR(30) NOT NULL,
                lat          DOUBLE PRECISION NOT NULL,
                lng          DOUBLE PRECISION NOT NULL,
                description  TEXT,
                status       VARCHAR(20) DEFAULT 'pending',
                ip_hash      VARCHAR(64),
                operator_note TEXT,
                created_at   TIMESTAMP DEFAULT NOW(),
                updated_at   TIMESTAMP DEFAULT NOW()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS camera_config (
                cam_id          INTEGER PRIMARY KEY,
                maintenance     BOOLEAN DEFAULT FALSE,
                maintenance_note TEXT,
                pix_per_meter   FLOAT DEFAULT 8.0,
                updated_at      TIMESTAMP DEFAULT NOW()
            )
        """)
        conn.commit()
        logger.info("[DB] Tabel crowd_reports & camera_config siap")
    except Exception as e:
        logger.error(f"[DB] init_extensions error: {e}")
        conn.rollback()
    finally:
        cur.close()
        conn.close()


def get_camera_configs():
    """Ambil semua konfigurasi kamera (maintenance, pix_per_meter)."""
    conn = get_db_connection()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cur.execute("SELECT * FROM camera_config")
        return {row["cam_id"]: dict(row) for row in cur.fetchall()}
    except Exception as e:
        logger.error(f"[DB] get_camera_configs error: {e}")
        return {}
    finally:
        cur.close()
        conn.close()


def upsert_camera_config(cam_id: int, maintenance: bool = None, maintenance_note: str = None,
                         pix_per_meter: float = None):
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        cur.execute("""
            INSERT INTO camera_config (cam_id, maintenance, maintenance_note, pix_per_meter, updated_at)
            VALUES (%s, %s, %s, %s, NOW())
            ON CONFLICT (cam_id) DO UPDATE
            SET maintenance      = COALESCE(%s, camera_config.maintenance),
                maintenance_note = COALESCE(%s, camera_config.maintenance_note),
                pix_per_meter    = COALESCE(%s, camera_config.pix_per_meter),
                updated_at       = NOW()
        """, (
            cam_id,
            maintenance if maintenance is not None else False,
            maintenance_note, pix_per_meter,
            maintenance, maintenance_note, pix_per_meter,
        ))
        conn.commit()
    except Exception as e:
        logger.error(f"[DB] upsert_camera_config error: {e}")
        conn.rollback()
    finally:
        cur.close()
        conn.close()


def add_crowd_report(report_type: str, lat: float, lng: float,
                     description: str = "", ip_hash: str = ""):
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        cur.execute("""
            INSERT INTO crowd_reports (report_type, lat, lng, description, ip_hash)
            VALUES (%s, %s, %s, %s, %s) RETURNING id
        """, (report_type, lat, lng, description[:500] if description else "", ip_hash))
        report_id = cur.fetchone()[0]
        conn.commit()
        return report_id
    except Exception as e:
        logger.error(f"[DB] add_crowd_report error: {e}")
        conn.rollback()
        return None
    finally:
        cur.close()
        conn.close()


def get_crowd_reports(include_resolved: bool = False):
    conn = get_db_connection()
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        if include_resolved:
            cur.execute("""
                SELECT * FROM crowd_reports
                ORDER BY created_at DESC LIMIT 200
            """)
        else:
            cur.execute("""
                SELECT * FROM crowd_reports
                WHERE status IN ('pending','verified')
                  AND created_at >= NOW() - INTERVAL '24 hours'
                ORDER BY created_at DESC LIMIT 100
            """)
        rows = cur.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["created_at"] = d["created_at"].strftime("%Y-%m-%d %H:%M:%S") if d.get("created_at") else None
            d["updated_at"] = d["updated_at"].strftime("%Y-%m-%d %H:%M:%S") if d.get("updated_at") else None
            result.append(d)
        return result
    except Exception as e:
        logger.error(f"[DB] get_crowd_reports error: {e}")
        return []
    finally:
        cur.close()
        conn.close()


def update_crowd_report(report_id: int, status: str, operator_note: str = None):
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        cur.execute("""
            UPDATE crowd_reports
            SET status = %s, operator_note = COALESCE(%s, operator_note), updated_at = NOW()
            WHERE id = %s
        """, (status, operator_note, report_id))
        conn.commit()
    except Exception as e:
        logger.error(f"[DB] update_crowd_report error: {e}")
        conn.rollback()
    finally:
        cur.close()
        conn.close()


def get_hourly_usual_traffic(location_id, hour, days=7):
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        cur.execute("""
            SELECT AVG(vehicles) as avg_val
            FROM traffic_logs
            WHERE location_id = %s
              AND TO_CHAR(timestamp, 'HH24') = %s
              AND timestamp::date < CURRENT_DATE
              AND timestamp >= NOW() - INTERVAL '%s days'
        """ % ('%s', '%s', days), (location_id, f"{hour:02d}"))

        row = cur.fetchone()
        return float(row["avg_val"]) if row and row["avg_val"] else 0.0

    except Exception as e:
        logger.error(f"[DB] get_hourly_usual_traffic error: {e}")
        return 0.0

    finally:
        cur.close()
        conn.close()
