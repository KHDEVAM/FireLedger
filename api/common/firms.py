"""FIRMS area API access shared by the nrt, export and refresh functions."""
from __future__ import annotations

import csv
import datetime as dt
import io

from . import FIRMS_API, UpstreamError, cache_get, cache_put, http_get, map_key, snap_bbox

# Suomi NPP data delivery ended on 2 Nov 2026: VIIRS_SNPP_NRT is deliberately absent.
NRT_SOURCES = ["MODIS_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]
EXPORT_SOURCES = NRT_SOURCES + ["MODIS_SP", "VIIRS_NOAA20_SP", "VIIRS_SNPP_SP"]
NRT_TTL = 15 * 60
MAX_HOTSPOTS = 8000


def area_csv(source: str, bbox, day_range: int, date: dt.date | None = None) -> list[dict]:
    """One FIRMS area request (DAY_RANGE 1-5) parsed into rows."""
    box = ",".join(f"{v:g}" for v in bbox)
    url = f"{FIRMS_API}/area/csv/{map_key()}/{source}/{box}/{day_range}"
    if date:
        url += f"/{date.isoformat()}"
    text = http_get(url)
    if not text.lstrip().startswith("latitude"):
        # FIRMS reports problems (invalid key, rate limit) as plain text; do not echo it
        raise UpstreamError("FIRMS did not return data (check the MAP_KEY and the transaction limit)")
    return list(csv.DictReader(io.StringIO(text)))


def confident(row: dict) -> bool:
    """Same confidence filter as the pipeline: MODIS >= 30, VIIRS nominal or high."""
    conf = (row.get("confidence") or "").strip().lower()
    if conf.isdigit():
        return int(conf) >= 30
    return conf in ("n", "h", "nominal", "high")


def to_hotspot(row: dict) -> dict:
    def num(name):
        try:
            return float(row.get(name) or "nan")
        except ValueError:
            return float("nan")

    frp = num("frp")
    return {
        "lat": round(num("latitude"), 5),
        "lon": round(num("longitude"), 5),
        "date": row.get("acq_date", ""),
        "time": str(row.get("acq_time", "0")).zfill(4),
        "sat": row.get("satellite", ""),
        "frp": round(frp, 1) if frp == frp else 0.0,
        "conf": (row.get("confidence") or "").strip().lower(),
        "dn": row.get("daynight", ""),
    }


def recent_hotspots(bbox, days: int, now: dt.datetime | None = None) -> dict:
    """Confidence-filtered NRT hotspots of the last `days` days (1-10), cached 15 minutes."""
    now = now or dt.datetime.now(dt.timezone.utc)
    box = snap_bbox(bbox)
    key = "nrt/" + "_".join(f"{v:g}" for v in box) + f"_{days}d.json"
    hit = cache_get(key, NRT_TTL)
    if hit is not None:
        return {**hit, "cached": True}

    hotspots: list[dict] = []
    for source in NRT_SOURCES:
        rows = area_csv(source, box, min(days, 5))
        if days > 5:
            # the API serves at most 5 days per call: fetch the older days with a start date
            rows += area_csv(source, box, days - 5, (now - dt.timedelta(days=days - 1)).date())
        hotspots += [to_hotspot(r) for r in rows if confident(r)]
    seen, unique = set(), []
    for h in sorted(hotspots, key=lambda h: (h["date"], h["time"]), reverse=True):
        ident = (h["lat"], h["lon"], h["date"], h["time"], h["sat"])
        if ident not in seen:
            seen.add(ident)
            unique.append(h)
    result = {
        "fetched_utc": now.isoformat(timespec="seconds"),
        "sources": NRT_SOURCES,
        "bbox": list(box),
        "days": days,
        "count": len(unique),
        "truncated": len(unique) > MAX_HOTSPOTS,
        "hotspots": unique[:MAX_HOTSPOTS],
    }
    cache_put(key, result)
    return {**result, "cached": False}
