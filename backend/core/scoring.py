def calculate_decision(vehicle_count, weather_status):
    score = 0

    # 1. Skor Kendaraan
    if vehicle_count > 40:
        score += 80   # MERAH murni tanpa cuaca buruk
    elif vehicle_count > 25:
        score += 50   # KUNING (padat)
    elif vehicle_count >= 15:
        score += 20   # Ramai tapi masih lancar

    # 2. Skor Cuaca
    w = (weather_status or "").lower()
    if "badai" in w or "thunder" in w or "lebat" in w:
        score += 40
    elif "hujan" in w or "rain" in w or "gerimis" in w:
        score += 20

    # 3. Klasifikasi
    if score >= 80:
        return "MERAH", "Bahaya: Kemacetan Padat"
    elif score >= 40:
        return "KUNING", "Waspada: Mulai Padat"
    else:
        return "HIJAU", "Aman: Lancar"

def evaluate_now_vs_usual(now: float, usual: float, hour: int) -> dict:
    """
    Evaluasi kondisi lalu lintas dengan konteks waktu
    """
    delta = round(now - usual, 2)
    delta_percent = round((delta / usual) * 100, 1) if usual > 0 else 0

    context = get_time_context(hour)

    # Threshold berbasis konteks
    if context == "off_peak":
        if delta <= 5:
            status = "NORMAL"
            label = "Normal untuk jam ini"
            severity = "INFO"
            confidence = 90
        elif delta <= 10:
            status = "FLUCTUATION"
            label = "Mulai terjadi fluktuasi lalu lintas"
            severity = "WARNING"
            confidence = 75
        else:
            status = "ANOMALY"
            label = "Anomali lalu lintas terdeteksi"
            severity = "ALERT"
            confidence = 85

    elif context in ["morning_peak", "evening_peak"]:
        if delta <= 3:
            status = "NORMAL"
            label = "Kondisi sesuai jam sibuk"
            severity = "INFO"
            confidence = 88
        elif delta <= 7:
            status = "DENSE"
            label = "Kepadatan meningkat"
            severity = "WARNING"
            confidence = 80
        else:
            status = "SEVERE"
            label = "Kemacetan berat terdeteksi"
            severity = "ALERT"
            confidence = 92

    else:  # night
        if delta <= 2:
            status = "NORMAL"
            label = "Lalu lintas malam normal"
            severity = "INFO"
            confidence = 95
        else:
            status = "UNUSUAL"
            label = "Aktivitas lalu lintas tidak biasa"
            severity = "WARNING"
            confidence = 85

    return {
        "now": now,
        "usual": usual,
        "delta": delta,
        "delta_percent": delta_percent,
        "hour": f"{hour:02d}:00",
        "time_context": context,
        "status": status,
        "severity": severity,
        "label": label,
        "confidence": confidence,
    }


def get_time_context(hour: int) -> str:
    """
    Mengklasifikasikan jam ke konteks lalu lintas
    """
    if 5 <= hour < 9:
        return "morning_peak"
    elif 9 <= hour < 16:
        return "off_peak"
    elif 16 <= hour < 19:
        return "evening_peak"
    else:
        return "night"
