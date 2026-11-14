"""Step 8 (optional) - admin-1 regions for the "Country / region" list.

Source: geoBoundaries gbOpen (see SOURCES.md). Each region is reduced to the
outer ring of its largest polygon, thinned to a few hundred points, which is
plenty for selecting 0.25 degree cells.

Output: web/public/data/<REGION>/adm1.json  [{name, ring: [[lon, lat], ...]}]
"""
from __future__ import annotations

import json

import requests

from lib import WEB_DATA, load_config

API = "https://www.geoboundaries.org/api/current/gbOpen/{iso}/ADM1/"
MAX_POINTS = 300


def ring_area(ring) -> float:
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:]))) / 2


def largest_ring(geometry: dict) -> list:
    polys = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return max((p[0] for p in polys), key=ring_area)


def main() -> None:
    cfg = load_config()
    iso = cfg["region"]["code"]
    meta = requests.get(API.format(iso=iso), timeout=60).json()
    geo = requests.get(meta["simplifiedGeometryGeoJSON"], timeout=120).json()
    out = []
    for feature in geo["features"]:
        ring = largest_ring(feature["geometry"])
        step = max(1, len(ring) // MAX_POINTS)
        thin = [[round(x, 3), round(y, 3)] for x, y in ring[::step]]
        out.append({"name": feature["properties"].get("shapeName", "?"), "ring": thin})
    out.sort(key=lambda r: r["name"])
    dest = WEB_DATA / iso / "adm1.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(out)} regions -> {dest} ({dest.stat().st_size / 1e3:.0f} kB)")
    print("license:", meta.get("boundaryLicense"), "| source:", meta.get("boundarySource"),
          "| year:", meta.get("boundaryYearRepresented"))
    print([r["name"] for r in out])


if __name__ == "__main__":
    main()
