"""Step 7 - validation figures and metrics for the report and the Methods page.

docs/figures/before_after.png      raw detections per sensor vs harmonized series
docs/figures/validation.png        leave-one-year-out: predicted vs observed + monthly series
docs/figures/validation.json       metrics
"""
from __future__ import annotations

import json
import shutil

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from lib import FIGURES, INTERIM, PROCESSED, WEB_DATA, load_config

NAVY, ORANGE, RED, BLUE, SLATE = "#00112C", "#FD8500", "#C60006", "#006BC6", "#3D5575"


def main() -> None:
    cfg = load_config()
    FIGURES.mkdir(parents=True, exist_ok=True)
    harm = json.loads((PROCESSED / "harmonization.json").read_text(encoding="utf-8"))
    best = harm["validation"]["model"]
    grid = pd.read_parquet(PROCESSED / "monthly_grid.parquet")
    veg = grid[grid["variant"] == "veg"]
    raw = pd.read_csv(INTERIM / "raw_counts.csv")
    raw = raw[raw["year"] >= cfg["years"]["start"]]
    obs_year = int(harm["viirs_observed_from"][:4])

    # ---- before / after
    fig, ax = plt.subplots(1, 2, figsize=(12, 4.2), sharex=True)
    fam = raw.groupby(["year", "family"])["detections"].sum().unstack(fill_value=0)
    ax[0].plot(fam.index, fam.get("MODIS", 0), color=SLATE, marker="o", ms=3, label="MODIS detections (1 km)")
    ax[0].plot(fam.index[fam["VIIRS"] > 0], fam["VIIRS"][fam["VIIRS"] > 0], color=RED, marker="o", ms=3,
               label="VIIRS detections (375 m, all satellites)")
    ax[0].set_title("Before: raw hotspot counts", color=NAVY, fontweight="bold")
    ax[0].set_ylabel("detections per year")
    ax[0].legend(frameon=False)
    annual = veg.groupby("year")[["h", "lo", "hi", "modis"]].sum()
    ax[1].fill_between(annual.index, annual["lo"], annual["hi"], color=ORANGE, alpha=0.25, lw=0,
                       label="90 % band (MODIS-based estimate)")
    ax[1].plot(annual.index, annual["h"], color=ORANGE, marker="o", ms=3, lw=2, label="Harmonized series")
    ax[1].plot(annual.index, annual["modis"], color=SLATE, ls=":", label="MODIS-only fire-cell-days")
    ax[1].axvline(obs_year - 0.5 + 1 / 12, color=BLUE, ls="--", lw=1)
    ax[1].text(obs_year - 0.3, ax[1].get_ylim()[1] * 0.95, "VIIRS observed", color=BLUE, va="top", fontsize=8)
    ax[1].set_title("After: VIIRS-equivalent fire-cell-days", color=NAVY, fontweight="bold")
    ax[1].set_ylabel("fire-cell-days per year")
    ax[1].legend(frameon=False, fontsize=8)
    for a in ax:
        a.spines[["top", "right"]].set_visible(False)
        a.set_xlabel("year")
    fig.suptitle(f'{cfg["region"]["name"]}: MODIS and VIIRS before and after harmonization', color=NAVY)
    fig.tight_layout()
    fig.savefig(FIGURES / "before_after.png", dpi=150)
    plt.close(fig)

    # ---- validation
    cv = pd.read_csv(PROCESSED / "validation.csv")
    v = harm["validation"]
    fig, ax = plt.subplots(1, 2, figsize=(12, 4.2), gridspec_kw={"width_ratios": [1, 1.7]})
    pos = cv[(cv["ref"] > 0) | (cv[best] > 0)]
    ax[0].scatter(pos["ref"] + 1, pos[best] + 1, s=8, color=ORANGE, alpha=0.5, edgecolor="none")
    lim = [1, max(pos["ref"].max(), pos[best].max()) * 1.3 + 1]
    ax[0].plot(lim, lim, color=NAVY, lw=1)
    ax[0].set(xscale="log", yscale="log", xlim=lim, ylim=lim,
              xlabel="observed VIIRS fire-cell-days + 1", ylabel="predicted from MODIS + 1")
    ax[0].set_title(f"Held-out region-months  (R² {v['unit_month']['r2']:.2f}, "
                    f"Spearman {v['unit_month']['spearman']:.2f})", color=NAVY, fontsize=10)
    dom = cv.groupby("ym")[["MODIS", "ref", best]].sum().reset_index()
    x = pd.to_datetime(dom["ym"].astype(str), format="%Y%m")
    ax[1].plot(x, dom["ref"], color=RED, lw=1.6, label="VIIRS observed")
    ax[1].plot(x, dom[best], color=ORANGE, lw=1.6, ls="--", label="Predicted from MODIS (year held out)")
    ax[1].plot(x, dom["MODIS"], color=SLATE, lw=1, ls=":", label="Raw MODIS fire-cell-days")
    ax[1].set_ylabel("fire-cell-days per month")
    ax[1].set_title(f"Whole region, monthly  (R² {v['domain_month']['r2']:.2f}, "
                    f"bias {v['domain_month']['bias_pct']:+.1f} %, MAE {v['domain_month']['mae']:.0f})",
                    color=NAVY, fontsize=10)
    ax[1].legend(frameon=False, fontsize=8)
    for a in ax:
        a.spines[["top", "right"]].set_visible(False)
    fig.suptitle("Leave-one-year-out validation of the MODIS to VIIRS calibration", color=NAVY)
    fig.tight_layout()
    fig.savefig(FIGURES / "validation.png", dpi=150)
    plt.close(fig)

    (FIGURES / "validation.json").write_text(json.dumps(v, indent=2), encoding="utf-8")
    web = WEB_DATA / cfg["region"]["code"]
    web.mkdir(parents=True, exist_ok=True)
    for name in ["validation.png", "before_after.png"]:
        shutil.copy(FIGURES / name, web / name)

    # ---- golden check helper: peak month of each of the five busiest years
    m = veg.groupby(["year", "month"])["h"].sum().unstack(fill_value=0)
    top_years = m.sum(axis=1).sort_values(ascending=False).head(5).index
    print("busiest years and their peak month:")
    for y in top_years:
        print(f"  {y}: total {m.loc[y].sum():.0f}, peak month {int(m.loc[y].idxmax())} ({m.loc[y].max():.0f})")
    print(json.dumps(v, indent=2))


if __name__ == "__main__":
    main()
