"""GET /api/nrt?bbox=W,S,E,N&days=7

Live hotspots from the NASA FIRMS area API (MODIS, VIIRS NOAA-20, VIIRS NOAA-21).
The MAP_KEY stays on the server; responses are cached for 15 minutes.
"""
from common import guarded, parse_bbox, parse_int, query, response
from common.firms import NRT_TTL, recent_hotspots


@guarded
def handler(event, context=None):
    q = query(event)
    bbox = parse_bbox(q.get("bbox"))
    days = parse_int(q.get("days"), default=2, lo=1, hi=10, name="days")
    return response(200, recent_hotspots(bbox, days), cache_seconds=NRT_TTL)
