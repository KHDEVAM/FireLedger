"""Scheduled every 3 hours (EventBridge Scheduler).

1. Pre-fetches the live hotspots of the configured regions so the first visitor
   gets a cache hit, and stores latest/<name>.json in the cache bucket.
2. Checks the watch zones (watch/zones.json in the cache bucket, optional):
   [{"name": "...", "bbox": [W,S,E,N], "email": "...", "min_hotspots": 1}]
   and e-mails an alert through Amazon SES when SES_SENDER is configured.
   Without SES the alert is only written to the log (demo mode).
"""
import json
import os

from common import cache_get, cache_put, guarded, response
from common.firms import recent_hotspots

# name:W,S,E,N;name:W,S,E,N
DEFAULT_REGIONS = "MAR-north:-10,30,-1,36;MAR-south:-17.5,20.5,-8,30"


def regions() -> dict:
    out = {}
    for part in os.environ.get("REFRESH_REGIONS", DEFAULT_REGIONS).split(";"):
        name, box = part.split(":")
        out[name] = tuple(float(v) for v in box.split(","))
    return out


def inside(h: dict, bbox) -> bool:
    return bbox[0] <= h["lon"] <= bbox[2] and bbox[1] <= h["lat"] <= bbox[3]


def alert(zone: dict, count: int) -> str:
    text = (f"FireLedger watch zone '{zone['name']}': {count} hotspot(s) detected by satellite in the last 48 h. "
            "Satellite data, about 3 h delay. Decision support only; follow your local civil protection "
            "and fire authorities. https://fireledger.earth")
    sender = os.environ.get("SES_SENDER")
    if sender and zone.get("email"):
        import boto3

        boto3.client("ses").send_email(
            Source=sender,
            Destination={"ToAddresses": [zone["email"]]},
            Message={"Subject": {"Data": f"FireLedger alert: {zone['name']}"}, "Body": {"Text": {"Data": text}}},
        )
        return "emailed"
    print("ALERT (not e-mailed):", text)
    return "logged"


@guarded
def handler(event, context=None):
    summary = {"regions": {}, "alerts": []}
    latest = []
    for name, bbox in regions().items():
        data = recent_hotspots(bbox, 7)
        cache_put(f"latest/{name}.json", data)
        summary["regions"][name] = data["count"]
        latest += data["hotspots"]

    zones = cache_get("watch/zones.json", None) or []
    for zone in zones:
        recent = [h for h in latest if inside(h, zone["bbox"])]
        if len(recent) >= int(zone.get("min_hotspots", 1)):
            summary["alerts"].append({"zone": zone["name"], "hotspots": len(recent), "delivery": alert(zone, len(recent))})
    print(json.dumps(summary))
    return response(200, summary)
