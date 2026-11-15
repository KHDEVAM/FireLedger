"""Step 1 - download raw FIRMS hotspots.

History comes from the FIRMS yearly country files (no key needed, no API loop).
The recent tail that the yearly files do not cover yet is fetched from the FIRMS
area API in 5-day windows, only when FIRMS_MAP_KEY is set (.env or environment).

    python pipeline/01_download.py --region MAR --years 2001-2026
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import time

import pandas as pd
import requests

from lib import BOUNDARY_FILE, RAW, ROOT, load_config

UA = {"User-Agent": "fireledger-pipeline/0.1"}


def read_env_key() -> str | None:
    key = os.environ.get("FIRMS_MAP_KEY")
    env = ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("FIRMS_MAP_KEY="):
                key = line.split("=", 1)[1].strip().strip('"')
    return key or None


def download_archive(cfg: dict, y0: int, y1: int) -> dict:
    """Yearly country CSVs. Returns {sensor: last year found}."""
    country = cfg["region"]["name"].replace(" ", "_")
    last = {}
    for sensor in cfg["sources"]["archive_sensors"]:
        out_dir = RAW / sensor
        out_dir.mkdir(parents=True, exist_ok=True)
        for year in range(y0, y1 + 1):
            name = f"{sensor}_{year}_{country}.csv"
            dest = out_dir / name
            if dest.exists() and dest.stat().st_size > 0:
                last[sensor] = year
                continue
            url = f'{cfg["sources"]["country_base"]}/{sensor}/{year}/{name}'
            r = requests.get(url, headers=UA, timeout=120)
            if r.status_code == 200 and r.text.startswith("latitude"):
                dest.write_bytes(r.content)
                last[sensor] = year
                print(f"  ok   {name}  {len(r.content) / 1e6:.2f} MB")
            else:
                print(f"  --   {name}  (HTTP {r.status_code}, not published)")
            time.sleep(0.3)
    return last


def download_tail(cfg: dict, key: str, last_archive: dict) -> None:
    """Area API, 5-day windows, from the first year without a country file."""
    api = cfg["sources"]["api_base"]
    bbox = ",".join(str(v) for v in cfg["region"]["bbox"])
    avail = pd.read_csv(io.StringIO(
        requests.get(f"{api}/data_availability/csv/{key}/ALL", headers=UA, timeout=60).text))
    avail = avail.set_index("data_id")
    out_dir = RAW / "tail"
    out_dir.mkdir(parents=True, exist_ok=True)
    # the tail starts with the first year that has no yearly country file
    tail_from = dt.date(max(last_archive.values(), default=cfg["years"]["download_from"] - 1) + 1, 1, 1)
    sources = cfg["sources"]["tail_sources"]
    # last standard-processing day per satellite: NRT is only fetched after it
    sp_end = {}
    for source, meta in sources.items():
        if meta["proc"] == "SP" and source in avail.index:
            sp_end[meta["sat"] or "MODIS"] = dt.date.fromisoformat(avail.loc[source, "max_date"])
    for source, meta in sources.items():
        if source not in avail.index:
            print(f"  --   {source}: not listed by data_availability")
            continue
        start = max(tail_from, dt.date.fromisoformat(avail.loc[source, "min_date"]))
        if meta["proc"] == "NRT" and (meta["sat"] or "MODIS") in sp_end:
            start = max(start, sp_end[meta["sat"] or "MODIS"] + dt.timedelta(days=1))
        end = dt.date.fromisoformat(avail.loc[source, "max_date"])
        if start > end:
            print(f"  --   {source}: nothing after the yearly files")
            continue
        frames, day = [], start
        while day <= end:
            n = min(5, (end - day).days + 1)
            url = f"{api}/area/csv/{key}/{source}/{bbox}/{n}/{day.isoformat()}"
            r = requests.get(url, headers=UA, timeout=120)
            if r.status_code == 200 and r.text.startswith("latitude"):
                frames.append(pd.read_csv(io.StringIO(r.text)))
            else:
                print(f"  !!   {source} {day}: HTTP {r.status_code} {r.text[:80]!r}")
            day += dt.timedelta(days=n)
            time.sleep(0.25)  # far below the 5000 transactions / 10 min limit
        if frames:
            df = pd.concat(frames, ignore_index=True)
            df.to_csv(out_dir / f"{source}.csv", index=False)
            print(f"  ok   tail {source}: {len(df)} rows, {start} -> {end}")


def download_boundary(cfg: dict) -> None:
    """Region outline (geoBoundaries ADM1, see SOURCES.md) used to clip the area-API tail."""
    if BOUNDARY_FILE.exists():
        return
    meta = requests.get(f'https://www.geoboundaries.org/api/current/gbOpen/{cfg["region"]["code"]}/ADM1/', timeout=60).json()
    BOUNDARY_FILE.parent.mkdir(parents=True, exist_ok=True)
    BOUNDARY_FILE.write_bytes(requests.get(meta["simplifiedGeometryGeoJSON"], timeout=120).content)
    print(f"  ok   boundary {BOUNDARY_FILE.name}")


def main() -> None:
    cfg = load_config()
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default=cfg["region"]["code"])
    ap.add_argument("--years", default=f'{cfg["years"]["download_from"]}-{cfg["years"]["download_to"]}')
    ap.add_argument("--no-tail", action="store_true")
    args = ap.parse_args()
    if args.region != cfg["region"]["code"]:
        raise SystemExit(f"Region {args.region} is not configured in pipeline/config.yaml")
    y0, y1 = (int(v) for v in args.years.split("-"))

    print("FIRMS yearly country files")
    last = download_archive(cfg, y0, y1)

    key = read_env_key()
    if args.no_tail:
        pass
    elif key:
        print("FIRMS area API (recent tail)")
        download_boundary(cfg)
        download_tail(cfg, key, last)
    else:
        print("FIRMS_MAP_KEY not set: skipping the recent tail (the record ends with the last yearly file).")

    manifest = {
        "accessed_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "region": cfg["region"],
        "last_archive_year": last,
        "tail_fetched": bool(key) and not args.no_tail,
    }
    (RAW / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
