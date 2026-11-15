"""Step 4 - cross-sensor harmonization into VIIRS-equivalent fire-cell-days.

A. Single-satellite VIIRS reference: S-NPP until NOAA-20 has a full year, then
   NOAA-20 scaled to S-NPP with the ratio measured on their overlap.
B. Terra-only months (before Aqua, mid-2002) are scaled to a Terra+Aqua equivalent.
C. MODIS -> VIIRS reference: per calibration region (1 degree, falling back to
   5 degree, then the whole domain) fit three candidate models on the monthly
   totals of the overlap period (ratio, log-log, seasonal background + slope),
   keep the one with the best leave-one-year-out score, and backcast the
   MODIS-only years.
D. Uncertainty: 90 % band from the leave-one-year-out log residuals.

Outputs: data/processed/monthly_grid.parquet, daily_grid.parquet,
harmonization.json, validation.csv
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from lib import (INTERIM, PROCESSED, coarsen, fit_models, load_config, predict, predict_parts, regression_metrics,
                 spearman)

KINDS = ["ratio", "loglog", "seasonal"]


def build_reference(m: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Add `ref`: the single-satellite VIIRS reference series."""
    veg = m[m["variant"] == "veg"]
    by_year = veg.groupby("year")[["SNPP", "N20"]].sum()
    n20_years = by_year.index[by_year["N20"] > 0]
    info = {"switch_year": None, "k_n20_to_snpp": None, "overlap_years": []}
    m = m.copy()
    m["ref"] = m["SNPP"].astype("float64")
    if len(n20_years):
        first = int(n20_years.min())
        first_month = int(veg.loc[(veg["year"] == first) & (veg["N20"] > 0), "month"].min())
        switch = first if first_month == 1 else first + 1
        snpp_last = int(by_year.index[by_year["SNPP"] > 0].max())
        overlap = [int(y) for y in n20_years if switch <= y <= snpp_last]
        if overlap:
            # only months in which both satellites delivered data (S-NPP ends before NOAA-20)
            by_month = veg.groupby(["year", "month"])[["SNPP", "N20"]].sum()
            both = by_month[(by_month["SNPP"] > 0) & (by_month["N20"] > 0)].index
            o = veg[veg["year"].isin(overlap) & pd.MultiIndex.from_frame(veg[["year", "month"]]).isin(both)]
            k = float(o["SNPP"].sum() / o["N20"].sum())
            use_n20 = m["year"] >= switch  # NOAA-20 carries the record from the switch year on
            m.loc[use_n20, "ref"] = m.loc[use_n20, "N20"] * k
            info = {"switch_year": switch, "k_n20_to_snpp": k, "overlap_years": overlap}
            n21 = veg[veg["N21"] > 0]
            if len(n21):
                both = veg[veg["year"].isin(n21["year"].unique())]
                info["k_n21_to_n20"] = float(both["N20"].sum() / both["N21"].sum())
    return m, info


def assign_units(cells: pd.DataFrame, overlap: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """Finest calibration region with enough overlap data, per display cell."""
    h = cfg["harmonize"]

    def eligible(level: str) -> set:
        t = overlap.groupby([level, "ym"])["MODIS"].sum().reset_index()
        g = t.groupby(level)["MODIS"].agg(months=lambda s: (s > 0).sum(), total="sum")
        return set(g.index[(g["months"] >= h["min_months_with_fire"]) & (g["total"] >= h["min_modis_cell_days"])])

    ok1, ok5 = eligible("r1"), eligible("r5")
    cells = cells.copy()
    cells["level"] = np.where(cells["r1"].isin(ok1), "r1", np.where(cells["r5"].isin(ok5), "r5", "dom"))
    cells["region"] = np.where(cells["level"] == "r1", cells["r1"], np.where(cells["level"] == "r5", cells["r5"], 0))
    cells["unit"] = cells["level"] + ":" + cells["region"].astype(str)
    return cells


def unit_table(df: pd.DataFrame, units: list[str], yms: list[int]) -> pd.DataFrame:
    """Complete unit x month table of MODIS and reference totals (no fire = 0)."""
    idx = pd.MultiIndex.from_product([units, yms], names=["unit", "ym"])
    t = df.groupby(["unit", "ym"])[["MODIS", "ref"]].sum().reindex(idx, fill_value=0).reset_index()
    t["year"], t["month"] = t["ym"] // 100, t["ym"] % 100
    return t


def fit_all(table: pd.DataFrame) -> dict:
    return {u: fit_models(g["MODIS"], g["ref"], g["month"]) for u, g in table.groupby("unit", sort=False)}


def predict_table(table: pd.DataFrame, models: dict, kind: str) -> np.ndarray:
    out = np.zeros(len(table))
    for u, idx in table.groupby("unit", sort=False).indices.items():
        g = table.iloc[idx]
        out[idx] = predict(models[u], kind, g["MODIS"], g["month"])
    return np.nan_to_num(out)


def main() -> None:
    cfg = load_config()
    g, h = cfg["grid"], cfg["harmonize"]
    m = pd.read_parquet(INTERIM / "monthly_series.parquet")
    m, ref_info = build_reference(m)
    m["ym"] = m["year"] * 100 + m["month"]

    # Terra flew alone until Aqua joined (first Aqua fire data: July 2002). Scale those
    # months to a two-satellite equivalent with the union/Terra ratio of the later record.
    aqua_from = int(h["aqua_from"].replace("-", ""))
    later = m[(m["variant"] == "veg") & (m["ym"] > aqua_from)]
    k_terra = float(later["MODIS"].sum() / later["TERRA"].sum())
    m["modis_raw"] = m["MODIS"]
    m["MODIS"] = np.where(m["ym"] < aqua_from, m["MODIS"] * k_terra, m["MODIS"]).astype("float64")
    ref_info["k_terra_only_to_terra_aqua"] = k_terra
    ref_info["terra_only_before"] = h["aqua_from"]

    per_deg = g["fine_per_degree"] // g["display_factor"]
    m["r1"] = coarsen(m["dcell"], per_deg, g["calib_factor_1deg"])
    m["r5"] = coarsen(m["dcell"], per_deg, g["calib_factor_5deg"])

    obs_from = int(h["viirs_observed_from"].replace("-", ""))
    veg = m[m["variant"] == "veg"]
    tot = veg.groupby("year")[["MODIS", "ref"]].sum()
    overlap_years = [int(y) for y in tot.index if tot.loc[y, "MODIS"] > 0 and tot.loc[y, "ref"] > 0]
    overlap = veg[veg["year"].isin(overlap_years) & (veg["ym"] >= obs_from)]

    cells = assign_units(m[["dcell", "r1", "r5"]].drop_duplicates(), overlap, cfg)
    unit_of = cells.set_index("dcell")["unit"]
    units = sorted(cells["unit"].unique())
    m["unit"] = m["dcell"].map(unit_of)
    overlap = overlap.assign(unit=overlap["dcell"].map(unit_of))
    yms = sorted({y * 100 + mo for y in overlap_years for mo in range(1, 13) if y * 100 + mo >= obs_from})
    ut = unit_table(overlap, units, yms)

    # ---- leave-one-year-out cross-validation of the three candidate models
    cv = []
    for year in overlap_years:
        models = fit_all(ut[ut["year"] != year])
        test = ut[ut["year"] == year].copy()
        for kind in KINDS:
            test[kind] = predict_table(test, models, kind)
        cv.append(test)
    cv = pd.concat(cv, ignore_index=True)
    dom = cv.groupby("ym")[["MODIS", "ref"] + KINDS].sum().reset_index()
    dom["year"] = dom["ym"] // 100

    def calendar_rank(col: str) -> list[float]:
        return [spearman(d["ref"], d[col]) for _, d in dom.groupby("year") if len(d) == 12]

    by_model = {k: {"unit_month": regression_metrics(cv["ref"], cv[k]),
                    "domain_month": regression_metrics(dom["ref"], dom[k]),
                    "calendar_rank_spearman_mean": float(np.nanmean(calendar_rank(k)))} for k in KINDS}
    best = min(KINDS, key=lambda k: by_model[k]["unit_month"]["mae"])
    metrics = {
        "model": best,
        "candidates": by_model,
        "unit_month": by_model[best]["unit_month"],
        "domain_month": by_model[best]["domain_month"],
        "domain_month_raw_modis": regression_metrics(dom["ref"], dom["MODIS"]),
        "calendar_rank_spearman_mean": by_model[best]["calendar_rank_spearman_mean"],
        "calendar_rank_spearman_min": float(np.nanmin(calendar_rank(best))),
    }

    # ---- uncertainty band from the CV log residuals (per unit, domain fallback)
    resid = np.log1p(cv["ref"]) - np.log1p(cv[best])
    informative = (cv["ref"] > 0) | (cv[best] > 0)
    sigma_dom = float(resid[informative].std())
    by_unit = resid[informative].groupby(cv.loc[informative, "unit"]).agg(["std", "size"])
    sigma_unit = {u: (float(r["std"]) if r["size"] >= 24 and np.isfinite(r["std"]) else sigma_dom)
                  for u, r in by_unit.iterrows()}
    z = h["band_z"]

    # ---- final models on the whole overlap
    models = fit_all(ut)
    # share of each cell in its unit's VIIRS climatology per calendar month (spreads the background)
    clim = overlap.groupby(["unit", "dcell", "month"])["ref"].sum().rename("v").reset_index()
    clim["w"] = clim["v"] / clim.groupby(["unit", "month"])["v"].transform("sum")
    clim = clim[clim["w"] > 0][["unit", "dcell", "month", "w"]]

    # ---- backcast table: every unit x backcast month
    first_ym = cfg["years"]["start"] * 100 + 1
    back_yms = [y * 100 + mo for y in range(cfg["years"]["start"], obs_from // 100 + 1) for mo in range(1, 13)
                if first_ym <= y * 100 + mo < obs_from]
    bveg = veg[veg["ym"].isin(back_yms)].assign(unit=lambda d: d["dcell"].map(unit_of))
    bu = unit_table(bveg, units, back_yms)
    prop = np.zeros(len(bu))
    bg = np.zeros(len(bu))
    for u, idx in bu.groupby("unit", sort=False).indices.items():
        gdf = bu.iloc[idx]
        prop[idx], bg[idx] = predict_parts(models[u], best, gdf["MODIS"], gdf["month"])
    bu["prop"], bu["bg"] = np.nan_to_num(prop), np.nan_to_num(bg)
    bu["V"] = bu["prop"] + bu["bg"]
    bu["slope"] = np.where(bu["MODIS"] > 0, bu["prop"] / bu["MODIS"].where(bu["MODIS"] > 0, 1), 0.0)
    sig = bu["unit"].map(sigma_unit).fillna(sigma_dom)
    bu["f_lo"] = np.where(bu["V"] > 0, np.maximum((bu["V"] + 1) * np.exp(-z * sig) - 1, 0) / bu["V"].where(bu["V"] > 0, 1), 0)
    bu["f_hi"] = np.where(bu["V"] > 0, ((bu["V"] + 1) * np.exp(z * sig) - 1) / bu["V"].where(bu["V"] > 0, 1), 0)
    factors = bu[["unit", "ym", "month", "slope", "bg", "f_lo", "f_hi"]]

    def backcast(variant: str) -> pd.DataFrame:
        """Cell-level estimate = slope x MODIS in the cell + background x cell share."""
        mv = m[(m["variant"] == variant) & m["ym"].isin(back_yms)][["dcell", "unit", "ym", "MODIS", "modis_raw"]]
        bgc = factors[factors["bg"] > 0].merge(clim, on=["unit", "month"])[["dcell", "unit", "ym"]]
        rows = pd.concat([mv, bgc]).groupby(["dcell", "unit", "ym"], as_index=False)[["MODIS", "modis_raw"]].sum()
        rows = rows.merge(factors, on=["unit", "ym"], how="left")
        rows = rows.merge(clim, on=["unit", "dcell", "month"], how="left").fillna({"w": 0.0})
        rows["h"] = rows["MODIS"] * rows["slope"] + rows["bg"] * rows["w"]
        rows["lo"], rows["hi"] = rows["h"] * rows["f_lo"], rows["h"] * rows["f_hi"]
        rows["variant"], rows["src"] = variant, "modis_est"
        rows["year"], rows["month"] = rows["ym"] // 100, rows["ym"] % 100
        rows["viirs_ref"], rows["viirs_union"] = 0.0, 0.0
        return rows.rename(columns={"modis_raw": "modis"})

    cols = ["dcell", "year", "month", "variant", "h", "lo", "hi", "src", "modis", "viirs_ref", "viirs_union", "unit"]
    obs = m[m["ym"] >= obs_from].assign(h=lambda d: d["ref"], lo=lambda d: d["ref"], hi=lambda d: d["ref"],
                                        src="viirs_obs")
    obs = obs.rename(columns={"modis_raw": "modis", "ref": "viirs_ref", "VIIRS": "viirs_union"})
    out = pd.concat([backcast("veg")[cols], backcast("all")[cols], obs[cols]], ignore_index=True)
    out = out[(out["h"] > 0) | (out["modis"] > 0) | (out["viirs_union"] > 0)]
    out = out.sort_values(["variant", "year", "month", "dcell"]).reset_index(drop=True)
    PROCESSED.mkdir(parents=True, exist_ok=True)
    out.to_parquet(PROCESSED / "monthly_grid.parquet", index=False)

    # ---- daily table. Only the MODIS-proportional part can be dated before the VIIRS era;
    #      the seasonal background has no day, so daily sums are below the monthly table there.
    d = pd.read_parquet(INTERIM / "daily_series.parquet")
    d["ym"] = d["date"].dt.year * 100 + d["date"].dt.month
    d["unit"] = d["dcell"].map(unit_of)
    d = d.merge(factors[["unit", "ym", "slope"]], on=["unit", "ym"], how="left")
    switch, k = ref_info["switch_year"], ref_info["k_n20_to_snpp"]
    ref_d = np.where(d["date"].dt.year >= (switch or 9999), d["N20"] * (k or 1.0), d["SNPP"])
    modis_d = np.where(d["ym"] < aqua_from, d["MODIS"] * k_terra, d["MODIS"])
    d["h"] = np.where(d["ym"] >= obs_from, ref_d, modis_d * d["slope"].fillna(0.0))
    d["src"] = np.where(d["ym"] >= obs_from, "viirs_obs", "modis_est")
    d = d[(d["h"] > 0) & (d["date"].dt.year >= cfg["years"]["start"])]
    d[["dcell", "date", "variant", "h", "src"]].to_parquet(PROCESSED / "daily_grid.parquet", index=False)

    info = {
        "target_unit": "VIIRS-equivalent fire-cell-days (0.01 degree cells, single-satellite reference)",
        "viirs_reference": ref_info,
        "viirs_observed_from": h["viirs_observed_from"],
        "overlap_years": overlap_years,
        "calibration_units": {k_: int(v) for k_, v in cells["level"].value_counts().items()},
        "models": {u: models[u] for u in units},
        "sigma_log": {"domain": sigma_dom, "units": sigma_unit},
        "band": f"{z} sigma of leave-one-year-out log residuals (about 90 %)",
        "validation": metrics,
    }
    (PROCESSED / "harmonization.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    cv.to_csv(PROCESSED / "validation.csv", index=False)

    print("VIIRS reference:", json.dumps(ref_info))
    print("calibration units:", info["calibration_units"], "| overlap", overlap_years[0], "-", overlap_years[-1])
    for kind in KINDS:
        u, dm = by_model[kind]["unit_month"], by_model[kind]["domain_month"]
        print(f"  {kind:8s} unit-month MAE {u['mae']:.2f} R2 {u['r2']:.2f} | domain-month R2 {dm['r2']:.2f} "
              f"MAE {dm['mae']:.1f} bias {dm['bias_pct']:+.1f}% spearman {dm['spearman']:.2f} | "
              f"calendar rank {by_model[kind]['calendar_rank_spearman_mean']:.2f}")
    r = metrics["domain_month_raw_modis"]
    print(f"  raw MODIS               | domain-month R2 {r['r2']:.2f} MAE {r['mae']:.1f} bias {r['bias_pct']:+.1f}% "
          f"spearman {r['spearman']:.2f}")
    print("selected model:", best)
    ann = out[out["variant"] == "veg"].groupby("year")[["h", "lo", "hi", "modis"]].sum().round(0)
    print(ann.to_string())


if __name__ == "__main__":
    main()
