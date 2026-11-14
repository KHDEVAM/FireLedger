"""Step 6 - export compact static files for the web app.

web/public/data/index.json                 list of regions
web/public/data/<REGION>/meta.json         record, baseline, coverage, harmonization summary
web/public/data/<REGION>/monthly.json      harmonized cell x month table (columnar)
web/public/data/<REGION>/hotspots/<year>.csv   filtered raw hotspots for CSV export
"""
from __future__ import annotations

import datetime as dt
import json

import numpy as np
import pandas as pd

from lib import INTERIM, PROCESSED, WEB_DATA, cell_center, fine_cell, load_config


def main() -> None:
    cfg = load_config()
    g = cfg["grid"]
    code = cfg["region"]["code"]
    out = WEB_DATA / code
    (out / "hotspots").mkdir(parents=True, exist_ok=True)

    grid = pd.read_parquet(PROCESSED / "monthly_grid.parquet")
    veg = grid[grid["variant"] == "veg"].set_index(["dcell", "year", "month"])
    allv = grid[grid["variant"] == "all"].set_index(["dcell", "year", "month"])["h"].rename("a")
    t = veg[["h", "lo", "hi", "modis"]].join(allv, how="outer").fillna(0).reset_index()
    t = t[(t["h"] > 0) | (t["a"] > 0) | (t["modis"] > 0)].sort_values(["year", "month", "dcell"])

    display_per_degree = g["fine_per_degree"] / g["display_factor"]
    size = 1 / display_per_degree
    cells = np.sort(t["dcell"].unique())
    lon, lat = cell_center(cells, display_per_degree)
    index = {int(c): i for i, c in enumerate(cells)}

    def r1(s):
        return [round(float(v), 1) for v in s]

    monthly = {
        "cell_size_deg": size,
        "cells": [[round(float(x - size / 2), 4), round(float(y - size / 2), 4)] for x, y in zip(lon, lat)],
        "columns": {
            "c": "index into cells", "ym": "year*100+month",
            "h": "harmonized VIIRS-equivalent fire-cell-days (vegetation fires)",
            "lo": "lower band", "hi": "upper band",
            "a": "harmonized, static/industrial sources included",
            "m": "MODIS-only fire-cell-days (not harmonized)",
        },
        "c": [index[int(c)] for c in t["dcell"]],
        "ym": [int(y * 100 + m) for y, m in zip(t["year"], t["month"])],
        "h": r1(t["h"]), "lo": r1(t["lo"]), "hi": r1(t["hi"]), "a": r1(t["a"]), "m": r1(t["modis"]),
    }
    (out / "monthly.json").write_text(json.dumps(monthly, separators=(",", ":")), encoding="utf-8")

    # raw hotspots (already confidence-filtered) per year
    df = pd.read_parquet(INTERIM / "clean.parquet")
    df = df[df["acq_date"].dt.year >= cfg["years"]["start"]]
    sat = df["sat"].astype(str)
    sensor = np.where(df["family"] == "MODIS", "MODIS " + sat,
                      "VIIRS " + sat.map({"N": "S-NPP", "N20": "NOAA-20", "N21": "NOAA-21"}).fillna(sat))
    hs = pd.DataFrame({
        "latitude": df["latitude"].round(5), "longitude": df["longitude"].round(5),
        "acq_date": df["acq_date"].dt.strftime("%Y-%m-%d"),
        "acq_time": df["acq_time"].astype(int).map("{:04d}".format),
        "sensor": sensor, "confidence": df["confidence"].astype(str),
        "frp": df["frp"].round(1), "daynight": df["daynight"].astype(str), "type": df["type"],
        "cell_id": fine_cell(df["latitude"], df["longitude"], g["fine_per_degree"]),
    })
    files = {}
    for year, part in hs.groupby(df["acq_date"].dt.year.values):
        part.to_csv(out / "hotspots" / f"{year}.csv", index=False, lineterminator="\n")
        files[int(year)] = len(part)

    cov = pd.read_csv(PROCESSED / "coverage.csv").fillna("")
    summary = json.loads((PROCESSED / "region_summary.json").read_text(encoding="utf-8"))
    harm = json.loads((PROCESSED / "harmonization.json").read_text(encoding="utf-8"))
    meta = {
        "code": code,
        "name": cfg["region"]["name"],
        "bbox": [float(min(c[0] for c in monthly["cells"])), float(min(c[1] for c in monthly["cells"])),
                 float(max(c[0] for c in monthly["cells"]) + size), float(max(c[1] for c in monthly["cells"]) + size)],
        "years": summary["years"],
        "data_start": summary["data_start"],
        "data_end": summary["data_end"],
        "baseline": summary["baseline"],
        "coverage": [{"ym": int(r.year * 100 + r.month), "status": r.status, "note": r.note}
                     for r in cov.itertuples() if r.status != "ok"],
        "harmonization": {
            "target_unit": harm["target_unit"],
            "viirs_observed_from": harm["viirs_observed_from"],
            "viirs_reference": harm["viirs_reference"],
            "overlap_years": harm["overlap_years"],
            "calibration_units": harm["calibration_units"],
            "band": harm["band"],
            "validation": harm["validation"],
        },
        "filters": cfg["filters"],
        "hotspot_rows": files,
        "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    (WEB_DATA / "index.json").write_text(json.dumps(
        {"regions": [{"code": code, "name": cfg["region"]["name"], "bbox": meta["bbox"]}]}, indent=1), encoding="utf-8")

    mb = sum(p.stat().st_size for p in out.rglob("*") if p.is_file()) / 1e6
    print(f"{len(cells)} cells, {len(t):,} cell-months, {sum(files.values()):,} hotspots -> {out} ({mb:.1f} MB)")


if __name__ == "__main__":
    main()
