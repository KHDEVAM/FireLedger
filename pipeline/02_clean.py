"""Step 2 - unify schemas, apply confidence filters, remove SP/NRT double counting.

Output: data/interim/clean.parquet (all `type` values kept; later steps select
vegetation fires) and data/interim/raw_counts.csv (unfiltered detections per
year and sensor family, used for the "before harmonization" figure).
"""
from __future__ import annotations

import pandas as pd

from lib import BOUNDARY_FILE, INTERIM, RAW, boundary_rings, confidence_ok, dedupe_sp_nrt, inside_rings, load_config, unify_schema


def main() -> None:
    cfg = load_config()
    rings = boundary_rings() if BOUNDARY_FILE.exists() else []
    frames = []
    for sensor, meta in cfg["sources"]["archive_sensors"].items():
        for path in sorted((RAW / sensor).glob("*.csv")):
            frames.append(unify_schema(pd.read_csv(path, low_memory=False), meta["family"], meta["sat"], None))
    for source, meta in cfg["sources"]["tail_sources"].items():
        path = RAW / "tail" / f"{source}.csv"
        if path.exists():
            tail = unify_schema(pd.read_csv(path, low_memory=False), meta["family"], meta["sat"], meta["proc"])
            # the area API returns a rectangle; keep only the country, like the yearly country files
            keep = inside_rings(tail["longitude"], tail["latitude"], rings, cfg["region"].get("clip_buffer_deg", 0.0))
            print(f"tail {source}: {len(tail):,} rows in the bounding box, {int(keep.sum()):,} inside the region")
            frames.append(tail[keep])
    if not frames:
        raise SystemExit("No raw files found. Run pipeline/01_download.py first.")
    df = pd.concat(frames, ignore_index=True)
    n_raw = len(df)

    df = dedupe_sp_nrt(df)
    n_dedupe = len(df)

    raw_counts = (df.assign(year=df["acq_date"].dt.year)
                    .groupby(["year", "family", "sat"]).size().rename("detections").reset_index())
    INTERIM.mkdir(parents=True, exist_ok=True)
    raw_counts.to_csv(INTERIM / "raw_counts.csv", index=False)

    f = cfg["filters"]
    df = df[confidence_ok(df, f["modis_min_confidence"], f["viirs_confidence"])]
    df = df.sort_values(["acq_date", "acq_time"]).reset_index(drop=True)
    for col in ["family", "sat", "proc", "confidence", "daynight"]:
        df[col] = df[col].astype("category")
    df.to_parquet(INTERIM / "clean.parquet", index=False)

    print(f"raw rows {n_raw:,} -> after SP/NRT dedupe {n_dedupe:,} -> after confidence filter {len(df):,}")
    print(df.groupby(["family", "sat", "proc"], observed=True)["acq_date"].agg(["min", "max", "size"]))
    print("type counts:", df["type"].value_counts().to_dict())


if __name__ == "__main__":
    main()
