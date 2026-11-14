"""Step 5 - calendar matrix, baselines, anomalies and trends for the whole region.

The web app recomputes the same metrics in the browser for any drawn area; this
step produces the region-level reference (used by tests, the report and the
default view) plus the month coverage table (ok / partial / nodata).

Outputs: data/processed/coverage.csv, cell_baseline.parquet, region_summary.json
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from lib import (INTERIM, PROCESSED, anomaly, calendar_matrix, load_config, mann_kendall_p, month_coverage,
                 percentile_rank, robust_stats, season_length, theil_sen)


def clean(v):
    return None if v is None or (isinstance(v, float) and not np.isfinite(v)) else v


def main() -> None:
    cfg = load_config()
    b0, b1 = cfg["baseline"]["start"], cfg["baseline"]["end"]
    grid = pd.read_parquet(PROCESSED / "monthly_grid.parquet")
    veg = grid[grid["variant"] == "veg"]
    raw = pd.read_parquet(INTERIM / "clean.parquet", columns=["acq_date"])
    data_start, data_end = raw["acq_date"].min(), raw["acq_date"].max()

    years = list(range(cfg["years"]["start"], data_end.year + 1))
    cov = month_coverage(years, data_start, data_end, cfg.get("known_gaps", []))
    cov.to_csv(PROCESSED / "coverage.csv", index=False)

    mat = calendar_matrix(veg, years, cov, "h")
    base_rows = [i for i, y in enumerate(years) if b0 <= y <= b1]

    months = []
    for mi in range(12):
        col = mat[:, mi]
        stats = robust_stats(col[base_rows])
        months.append({
            "month": mi + 1,
            "median": clean(stats["median"]),
            "mad": clean(stats["mad"]),
            "trend_per_year": clean(theil_sen(years, col)),
            "trend_p": clean(mann_kendall_p(col)),
        })

    cells = []
    for yi, y in enumerate(years):
        for mi in range(12):
            v = mat[yi, mi]
            # exclude the target year from its own baseline
            ref = [mat[i, mi] for i in base_rows if years[i] != y]
            st = robust_stats(ref)
            a = anomaly(v, st["median"], st["mad"])
            cells.append({"year": y, "month": mi + 1, "h": clean(float(v)),
                          "median": clean(st["median"]),
                          "anomaly_pct": clean(a["anomaly_pct"]), "robust_z": clean(a["robust_z"]),
                          "percentile": clean(percentile_rank(v, mat[:, mi]))})

    annual = np.nansum(mat, axis=1)
    complete = ~np.isnan(mat).any(axis=1)
    profile = np.array([m["median"] or 0 for m in months])
    summary = {
        "region": cfg["region"],
        "baseline": [b0, b1],
        "data_start": str(data_start.date()),
        "data_end": str(data_end.date()),
        "years": years,
        "annual_total": [clean(float(v)) for v in annual],
        "annual_rank": [int(r) for r in (-annual).argsort().argsort() + 1],
        "annual_trend_per_year": clean(theil_sen(np.array(years)[complete], annual[complete])),
        "annual_trend_p": clean(mann_kendall_p(annual[complete])),
        "peak_month": int(profile.argmax() + 1),
        "fire_season_length": season_length(profile),
        "months": months,
        "calendar": cells,
    }
    (PROCESSED / "region_summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")

    # per display cell baseline (median per calendar month over the reference period)
    full = (veg[veg["year"].between(b0, b1)].pivot_table(index="dcell", columns=["year", "month"], values="h",
                                                         aggfunc="sum", fill_value=0)
            .reindex(columns=pd.MultiIndex.from_product([range(b0, b1 + 1), range(1, 13)]), fill_value=0))
    base = full.T.groupby(level=1).median().T
    base.columns = [f"m{c:02d}" for c in base.columns]
    base.reset_index().to_parquet(PROCESSED / "cell_baseline.parquet", index=False)

    print(f"record {summary['data_start']} -> {summary['data_end']}; peak month {summary['peak_month']}; "
          f"season length {summary['fire_season_length']} months")
    top = sorted((c for c in cells if c["h"] is not None), key=lambda c: -c["h"])[:5]
    print("busiest months:", [(c["year"], c["month"], round(c["h"])) for c in top])


if __name__ == "__main__":
    main()
