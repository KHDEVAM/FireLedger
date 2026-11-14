"""GET /api/weather?lat=..&lon=..

Wind, gusts, humidity and temperature for the advisory, from Open-Meteo
(CC BY 4.0, see SOURCES.md). Cached for 30 minutes per 0.1 degree.
"""
import json

from common import UpstreamError, cache_get, cache_put, guarded, http_get, parse_float, query, response

OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
TTL = 30 * 60


def fetch(lat: float, lon: float) -> dict:
    url = (f"{OPEN_METEO}?latitude={lat:.2f}&longitude={lon:.2f}"
           "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m"
           "&hourly=wind_speed_10m,relative_humidity_2m&forecast_days=3&wind_speed_unit=kmh&timezone=UTC")
    try:
        data = json.loads(http_get(url))
        cur, hourly = data["current"], data["hourly"]
        return {
            "time": cur["time"],
            "temp_c": cur["temperature_2m"],
            "rh_pct": cur["relative_humidity_2m"],
            "wind_kmh": cur["wind_speed_10m"],
            "wind_dir_from": cur["wind_direction_10m"],
            "gust_kmh": cur["wind_gusts_10m"],
            "max_wind_72h": max(v for v in hourly["wind_speed_10m"] if v is not None),
            "min_rh_72h": min(v for v in hourly["relative_humidity_2m"] if v is not None),
            "source": "Open-Meteo (CC BY 4.0)",
        }
    except (KeyError, ValueError, TypeError):
        raise UpstreamError("weather service returned an unexpected answer") from None


@guarded
def handler(event, context=None):
    q = query(event)
    lat = round(parse_float(q.get("lat"), -90, 90, "lat"), 1)
    lon = round(parse_float(q.get("lon"), -180, 180, "lon"), 1)
    key = f"weather/{lat:g}_{lon:g}.json"
    data = cache_get(key, TTL)
    if data is None:
        data = fetch(lat, lon)
        cache_put(key, data)
    return response(200, data, cache_seconds=TTL)
