"""Step 3 - detections -> fire-cell-days on the common 0.01 degree grid.

For every sensor series and day we keep the unique 0.01 degree cells with at
least one detection. This collapses clusters of 375 m VIIRS pixels toward a
MODIS-like footprint and makes extra satellites a union, not a sum.

Series:
  MODIS  Terra + Aqua (union)
  TERRA  MODIS Terra alone          (to correct the Terra-only months before Aqua, mid-2002)
  SNPP   VIIRS Suomi NPP alone      (single-satellite reference until NOAA-20)
  N20    VIIRS NOAA-20 alone        (single-satellite reference afterwards)
  N21    VIIRS NOAA-21 alone        (backup / gap filler)
  VIIRS  all VIIRS satellites (union)

Variants: `veg` (FIRMS type 0 only) and `all` (static / industrial sources too).

Outputs (data/interim): cell_days.parquet, monthly_series.parquet,
daily_series.parquet, constellation.parquet
"""
from __future__ import annotations

import pandas as pd

from lib import INTERIM, coarsen, fine_cell, load_config

SERIES = ["MODIS", "TERRA", "SNPP", "N20", "N21", "VIIRS"]


def assign_series(df: pd.DataFrame) -> pd.DataFrame:
    """One row per (detection, series it belongs to)."""
    sat_series = {"N": "SNPP", "N20": "N20", "N21": "N21"}
    parts = [df.loc[df["family"] == "MODIS"].assign(series="MODIS"),
             df.loc[df["family"] == "VIIRS"].assign(series="VIIRS"),
             df.loc[df["sat"].astype(str) == "Terra"].assign(series="TERRA")]
    viirs = df.loc[df["family"] == "VIIRS"]
    single = viirs.assign(series=viirs["sat"].astype(str).map(sat_series)).dropna(subset=["series"])
    return pd.concat(parts + [single], ignore_index=True)


def cell_days(df: pd.DataFrame, per_degree: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Unique (date, series, cell) for all sources, plus the long table to filter by type."""
    df = df.assign(cell=fine_cell(df["latitude"], df["longitude"], per_degree))
    long = assign_series(df[["acq_date", "family", "sat", "type", "cell"]])
    keys = ["acq_date", "series", "cell"]
    everything = long[keys].drop_duplicates().assign(variant="all")
    return everything, long


def main() -> None:
    cfg = load_config()
    g = cfg["grid"]
    df = pd.read_parquet(INTERIM / "clean.parquet")

    everything, long = cell_days(df, g["fine_per_degree"])
    veg = (long.loc[long["type"].isin(cfg["filters"]["vegetation_types"]), ["acq_date", "series", "cell"]]
               .drop_duplicates().assign(variant="veg"))
    cd = pd.concat([veg, everything], ignore_index=True).rename(columns={"acq_date": "date"})
    cd["dcell"] = coarsen(cd["cell"], g["fine_per_degree"], g["display_factor"])
    cd.to_parquet(INTERIM / "cell_days.parquet", index=False)

    daily = (cd.groupby(["dcell", "date", "variant", "series"]).size().unstack("series", fill_value=0)
               .reindex(columns=SERIES, fill_value=0).reset_index())
    daily.to_parquet(INTERIM / "daily_series.parquet", index=False)

    monthly = daily.assign(year=daily["date"].dt.year, month=daily["date"].dt.month)
    monthly = monthly.groupby(["dcell", "year", "month", "variant"], as_index=False)[SERIES].sum()
    monthly.to_parquet(INTERIM / "monthly_series.parquet", index=False)

    # constellation size: satellites with at least one detection that month (covariate)
    const = (df.assign(year=df["acq_date"].dt.year, month=df["acq_date"].dt.month)
               .groupby(["year", "month", "family"], observed=True)["sat"].nunique()
               .unstack("family", fill_value=0).reset_index())
    const.to_parquet(INTERIM / "constellation.parquet", index=False)

    print(f"fire-cell-days: {len(cd):,} rows; display cells with fire: {monthly['dcell'].nunique():,}")
    print(monthly[monthly["variant"] == "veg"].groupby("year")[SERIES].sum().to_string())


if __name__ == "__main__":
    main()
