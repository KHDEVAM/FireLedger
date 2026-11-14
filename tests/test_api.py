"""API tests: input validation, FIRMS proxy behaviour, and that the MAP_KEY never leaks."""
import datetime as dt
import json

import pytest

import common
from common import firms
from export.app import handler as export_handler
from nrt.app import handler as nrt_handler
from weather.app import handler as weather_handler

SECRET = "SECRETMAPKEY0123456789abcdef"

CSV = """latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
35.10000,-5.20000,330.1,0.4,0.4,2026-11-13,1310,N20,VIIRS,n,2.0NRT,290.1,12.34,D
35.10000,-5.20000,330.1,0.4,0.4,2026-11-13,1310,N20,VIIRS,n,2.0NRT,290.1,12.34,D
35.30000,-5.40000,300.1,0.4,0.4,2026-11-13,0210,N20,VIIRS,l,2.0NRT,280.1,1.00,N
"""


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("FIRMS_MAP_KEY", SECRET)
    monkeypatch.delenv("CACHE_BUCKET", raising=False)
    monkeypatch.setattr(common, "LOCAL_CACHE", tmp_path)
    monkeypatch.setattr(common, "_key", None)


def call(handler, **params):
    res = handler({"queryStringParameters": params})
    return res["statusCode"], res


@pytest.mark.parametrize("bbox", [None, "1,2,3", "a,b,c,d", "5,0,1,10", "-190,0,10,10", "-60,0,60,60", "0,0,nan,1"])
def test_bad_bbox_is_a_clear_400(bbox):
    status, res = call(nrt_handler, **({"bbox": bbox} if bbox else {}))
    assert status == 400
    assert "bbox" in json.loads(res["body"])["error"]


def test_days_must_be_in_range():
    assert call(nrt_handler, bbox="-6,34,-4,36", days="0")[0] == 400
    assert call(nrt_handler, bbox="-6,34,-4,36", days="x")[0] == 400


def test_snap_bbox_grows_outward():
    assert common.snap_bbox((-5.27, 35.01, -4.9, 35.49)) == (-5.5, 35.0, -4.5, 35.5)


def test_nrt_filters_dedupes_caches_and_hides_the_key(monkeypatch):
    urls = []

    def fake_get(url, timeout=25):
        urls.append(url)
        return CSV

    monkeypatch.setattr(firms, "http_get", fake_get)
    status, res = call(nrt_handler, bbox="-6,34,-4,36", days="7")
    body = json.loads(res["body"])
    assert status == 200
    # one duplicate and one low-confidence row removed, for each of the 3 sources x 2 calls -> still 1 unique
    assert body["count"] == 1 and body["hotspots"][0]["frp"] == 12.3
    assert body["sources"] == ["MODIS_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]
    # 7 days = one 5-day call plus one dated 2-day call per source; never the ended S-NPP NRT feed
    assert len(urls) == 6
    assert not any("VIIRS_SNPP_NRT" in u for u in urls)
    assert sum(u.rstrip("/").split("/")[-1].count("-") == 2 for u in urls) == 3
    assert SECRET not in res["body"] and SECRET not in json.dumps(res["headers"])

    # second request is served from the cache
    status2, res2 = call(nrt_handler, bbox="-5.9,34.1,-4.1,35.9", days="7")
    assert status2 == 200 and json.loads(res2["body"])["cached"] is True
    assert len(urls) == 6


def test_firms_error_text_is_not_echoed(monkeypatch):
    monkeypatch.setattr(firms, "http_get", lambda url, timeout=25: f"Invalid MAP_KEY {SECRET}.")
    status, res = call(nrt_handler, bbox="-6,34,-4,36")
    assert status == 502
    assert SECRET not in res["body"]


def test_weather_validation_and_shape(monkeypatch):
    assert call(weather_handler, lat="95", lon="0")[0] == 400
    assert call(weather_handler, lon="0")[0] == 400
    payload = {"current": {"time": "2026-11-14T12:00", "temperature_2m": 20, "relative_humidity_2m": 30,
                           "wind_speed_10m": 35, "wind_direction_10m": 270, "wind_gusts_10m": 60},
               "hourly": {"wind_speed_10m": [10, 40, None], "relative_humidity_2m": [50, 20, None]}}
    import weather.app as weather

    monkeypatch.setattr(weather, "http_get", lambda url, timeout=25: json.dumps(payload))
    status, res = call(weather_handler, lat="35.17", lon="-5.27")
    body = json.loads(res["body"])
    assert status == 200
    assert body["wind_kmh"] == 35 and body["wind_dir_from"] == 270 and body["max_wind_72h"] == 40 and body["min_rh_72h"] == 20


def test_export_limits(monkeypatch):
    ok = dict(bbox="-6,34,-4,36", source="VIIRS_NOAA20_NRT")
    today = dt.datetime.now(dt.timezone.utc).date()
    assert call(export_handler, **ok, **{"from": "2026-01-01", "to": "2026-03-01"})[0] == 400      # too long
    assert call(export_handler, **ok, **{"from": "2026-02-01", "to": "2026-01-01"})[0] == 400      # reversed
    assert call(export_handler, bbox="-6,34,-4,36", source="VIIRS_SNPP_NRT", **{"from": "2026-01-01", "to": "2026-01-02"})[0] == 400
    assert call(export_handler, **ok, **{"from": str(today), "to": str(today + dt.timedelta(days=2))})[0] == 400

    monkeypatch.setattr(firms, "http_get", lambda url, timeout=25: CSV)
    status, res = call(export_handler, **ok, **{"from": "2026-11-01", "to": "2026-11-07"})
    assert status == 200 and res["headers"]["Content-Type"].startswith("text/csv")
    lines = res["body"].strip().split("\n")
    assert lines[0].startswith("latitude,longitude,acq_date") and len(lines) == 1 + 2 * 3   # 2 windows x 3 rows
    assert SECRET not in res["body"]
