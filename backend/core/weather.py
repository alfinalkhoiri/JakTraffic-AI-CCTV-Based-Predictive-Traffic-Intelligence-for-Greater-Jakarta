import requests

def get_weather_data(lat, lng):
    """
    Ambil data cuaca realtime dari Open-Meteo
    Return dict: { text, code }
    """
    try:
        url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lng}&current_weather=true"
        )
        response = requests.get(url, timeout=2)
        if response.status_code == 200:
            data = response.json()
            code = data["current_weather"]["weathercode"]

            if code <= 3:
                return {"text": "Cerah/Berawan", "code": code}
            elif code <= 55:
                return {"text": "Gerimis", "code": code}
            elif code <= 65:
                return {"text": "Hujan", "code": code}
            elif code <= 82:
                return {"text": "Hujan Lebat", "code": code}
            elif code >= 95:
                return {"text": "Badai", "code": code}
    except Exception:
        pass

    # fallback jika API gagal
    return {"text": "Cerah", "code": 0}

