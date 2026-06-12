import psycopg2
import psycopg2.extras
from datetime import datetime
import logging
import os
from dotenv import load_dotenv

load_dotenv()

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
            SELECT ct.*, cl.stream_url, cl.road_type
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
        return row["avg_usual"] if row and row["avg_usual"] else 0

    except Exception as e:
        logger.error(f"[DB] get_usual_traffic error: {e}")
        return 0

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
        return row["avg_val"] or 0

    except Exception as e:
        logger.error(f"[DB] get_hourly_usual_traffic error: {e}")
        return 0

    finally:
        cur.close()
        conn.close()
