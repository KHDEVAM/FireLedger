"""Shared, importable building blocks of the FireLedger pipeline.

The numbered scripts stay thin; everything that needs a unit test lives here.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
INTERIM = ROOT / "data" / "interim"
PROCESSED = ROOT / "data" / "processed"
WEB_DATA = ROOT / "web" / "public" / "data"
FIGURES = ROOT / "docs" / "figures"


def load_config(path: Path | None = None) -> dict:
    with open(path or Path(__file__).with_name("config.yaml"), encoding="utf-8") as fh:
        return yaml.safe_load(fh)


# --------------------------------------------------------------------------- grid

def fine_cell(lat, lon, per_degree: int = 100) -> np.ndarray:
    """Snap coordinates to the common grid. Deterministic integer id.

    id = row * (360 * per_degree) + col, rows counted from 90 S, cols from 180 W.
    Coordinates are rounded to 1e-5 degree first (the precision FIRMS publishes),
    so the same detection always lands in the same cell.
    """
    lat = np.round(np.asarray(lat, dtype="float64"), 5)
    lon = np.round(np.asarray(lon, dtype="float64"), 5)
    row = np.floor((lat + 90.0) * per_degree + 1e-7).astype("int64")
    col = np.floor((lon + 180.0) * per_degree + 1e-7).astype("int64")
    row = np.clip(row, 0, 180 * per_degree - 1)
    col = np.clip(col, 0, 360 * per_degree - 1)
    return row * (360 * per_degree) + col


def coarsen(cell, per_degree: int, factor: int) -> np.ndarray:
    """Id of the coarser cell (factor x factor fine cells) containing `cell`."""
    cell = np.asarray(cell, dtype="int64")
    ncol = 360 * per_degree
    row, col = cell // ncol, cell % ncol
    return (row // factor) * (ncol // factor) + (col // factor)


def cell_center(cell, per_degree: float) -> tuple[np.ndarray, np.ndarray]:
    """(lon, lat) of the cell centre for a grid with `per_degree` cells per degree."""
    cell = np.asarray(cell, dtype="int64")
    ncol = int(round(360 * per_degree))
    row, col = cell // ncol, cell % ncol
    return (col + 0.5) / per_degree - 180.0, (row + 0.5) / per_degree - 90.0


# ----------------------------------------------------------------------- boundary

BOUNDARY_FILE = RAW / "boundary" / "adm1.geojson"


def boundary_rings(path: Path | None = None) -> list[np.ndarray]:
    """Outer rings (lon, lat) of every polygon of the region boundary file."""
    import json

    geo = json.loads((path or BOUNDARY_FILE).read_text(encoding="utf-8"))
    rings = []
    for feature in geo["features"]:
        g = feature["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        rings += [np.asarray(poly[0], dtype="float64") for poly in polys]
    return rings


def inside_rings(lon, lat, rings, buffer_deg: float = 0.0) -> np.ndarray:
    """True for points inside any ring. `buffer_deg` grows the rings a little
    (the area API tail is clipped to the country like the yearly country files)."""
    from matplotlib.path import Path as MplPath

    pts = np.column_stack([np.asarray(lon, dtype="float64"), np.asarray(lat, dtype="float64")])
    inside = np.zeros(len(pts), dtype=bool)
    for ring in rings:
        lo, hi = ring.min(axis=0) - buffer_deg, ring.max(axis=0) + buffer_deg
        cand = ~inside & (pts[:, 0] >= lo[0]) & (pts[:, 0] <= hi[0]) & (pts[:, 1] >= lo[1]) & (pts[:, 1] <= hi[1])
        if cand.any():
            # positive radius grows a counter-clockwise ring, negative a clockwise one: test both
            path = MplPath(ring)
            hit = path.contains_points(pts[cand], radius=buffer_deg) | path.contains_points(pts[cand], radius=-buffer_deg)
            inside[np.flatnonzero(cand)[hit]] = True
    return inside


# ----------------------------------------------------------------------- cleaning

CLEAN_COLUMNS = [
    "latitude", "longitude", "acq_date", "acq_time", "family", "sat", "proc",
    "confidence", "frp", "daynight", "type", "brightness", "bright_31",
]


def unify_schema(df: pd.DataFrame, family: str, sat: str | None, proc: str | None) -> pd.DataFrame:
    """Bring a raw FIRMS CSV (MODIS or VIIRS, archive or NRT) to one schema."""
    out = pd.DataFrame(index=df.index)
    out["latitude"] = df["latitude"].astype("float64")
    out["longitude"] = df["longitude"].astype("float64")
    out["acq_date"] = pd.to_datetime(df["acq_date"])
    out["acq_time"] = pd.to_numeric(df["acq_time"], errors="coerce").fillna(0).astype("int16")
    out["family"] = family
    if sat is None:  # MODIS: Terra / Aqua (also seen as T / A)
        s = df["satellite"].astype(str).str.strip()
        out["sat"] = s.map({"T": "Terra", "A": "Aqua"}).fillna(s)
    else:
        out["sat"] = sat
    version = df["version"].astype(str) if "version" in df else pd.Series("", index=df.index)
    if proc is None:
        out["proc"] = np.where(version.str.contains("NRT|RT|URT", case=False), "NRT", "SP")
    else:
        out["proc"] = proc
    out["confidence"] = df["confidence"].astype(str).str.strip().str.lower()
    out["frp"] = pd.to_numeric(df.get("frp"), errors="coerce").astype("float32")
    out["daynight"] = df["daynight"].astype(str).str.strip().str.upper() if "daynight" in df else "U"
    # `type` only exists in standard-processing files; NRT rows are presumed vegetation (0)
    if "type" in df:
        out["type"] = pd.to_numeric(df["type"], errors="coerce").fillna(0).astype("int8")
    else:
        out["type"] = np.int8(0)
    bright = "bright_ti4" if "bright_ti4" in df else "brightness"
    b31 = "bright_ti5" if "bright_ti5" in df else "bright_t31"
    out["brightness"] = pd.to_numeric(df.get(bright), errors="coerce").astype("float32")
    out["bright_31"] = pd.to_numeric(df.get(b31), errors="coerce").astype("float32")
    return out[CLEAN_COLUMNS]


def confidence_ok(df: pd.DataFrame, modis_min: int = 30, viirs_keep=("n", "h")) -> pd.Series:
    """True for detections that pass the per-family confidence filter."""
    is_modis = df["family"] == "MODIS"
    num = pd.to_numeric(df["confidence"], errors="coerce")
    # MODIS confidence is 0-100; some files use l/n/h letters for it as well
    modis_ok = (num >= modis_min) | df["confidence"].isin(["n", "h", "nominal", "high"])
    keep = {k.lower() for k in viirs_keep} | {{"n": "nominal", "h": "high", "l": "low"}[k] for k in viirs_keep}
    viirs_ok = df["confidence"].isin(keep)
    return np.where(is_modis, modis_ok, viirs_ok)


def dedupe_sp_nrt(df: pd.DataFrame) -> pd.DataFrame:
    """Never count standard-processing (SP) and NRT for the same date.

    Per satellite, NRT rows are kept only for dates after the last SP date.
    Exact duplicate detections (overlapping downloads) are dropped too.
    """
    sp_end = df.loc[df["proc"] == "SP"].groupby("sat")["acq_date"].max()
    cutoff = df["sat"].map(sp_end)
    keep = (df["proc"] == "SP") | cutoff.isna() | (df["acq_date"] > cutoff)
    out = df.loc[keep]
    return out.drop_duplicates(subset=["latitude", "longitude", "acq_date", "acq_time", "sat"])


# -------------------------------------------------------------------- calibration

def fit_models(M, V, month) -> dict:
    """Fit the candidate MODIS->VIIRS models on monthly totals of one region.

    ratio   : V = k * M                          (k = sum V / sum M)
    loglog  : log(V+1) = a + b * log(M+1)        (ordinary least squares)
    seasonal: V = s[calendar month] + ks * M     (month fixed effects, s >= 0, ks >= 0)

    The seasonal model keeps a background of small fires that VIIRS sees and
    MODIS misses (s), and scales what MODIS does see (ks).
    """
    M = np.asarray(M, dtype="float64")
    V = np.asarray(V, dtype="float64")
    month = np.asarray(month, dtype="int64")
    sm = M.sum()
    k = float(V.sum() / sm) if sm > 0 else float("nan")
    x, y = np.log1p(M), np.log1p(V)
    use = (M > 0) | (V > 0)
    if use.sum() >= 3 and np.ptp(x[use]) > 0:
        b, a = np.polyfit(x[use], y[use], 1)
    else:
        a, b = float("nan"), float("nan")
    # month fixed effects: slope from within-month deviations, intercepts from month means
    m_mean, v_mean = np.zeros(13), np.zeros(13)
    for mo in range(1, 13):
        sel = month == mo
        if sel.any():
            m_mean[mo], v_mean[mo] = M[sel].mean(), V[sel].mean()
    dm, dv = M - m_mean[month], V - v_mean[month]
    ks = float(max((dm * dv).sum() / (dm ** 2).sum(), 0.0)) if (dm ** 2).sum() > 0 else 0.0
    s = np.maximum(v_mean - ks * m_mean, 0.0)
    return {"k": k, "a": float(a), "b": float(b), "ks": ks, "s": [float(v) for v in s[1:]],
            "n": int(use.sum()), "sum_m": float(sm)}


def predict_parts(model: dict, kind: str, M, month) -> tuple[np.ndarray, np.ndarray]:
    """(part proportional to MODIS, background part) of the VIIRS-equivalent estimate."""
    M = np.asarray(M, dtype="float64")
    month = np.asarray(month, dtype="int64")
    zero = np.zeros_like(M)
    if kind == "ratio":
        out = model["k"] * M
    elif kind == "loglog":
        out = np.expm1(model["a"] + model["b"] * np.log1p(M))
    else:
        return model["ks"] * M, np.asarray(model["s"])[month - 1]
    out = np.nan_to_num(np.where(M > 0, np.maximum(out, 0.0), 0.0))
    return out, zero


def predict(model: dict, kind: str, M, month) -> np.ndarray:
    """VIIRS-equivalent fire-cell-days for MODIS monthly totals M."""
    prop, background = predict_parts(model, kind, M, month)
    return prop + background


def regression_metrics(obs, pred) -> dict:
    obs = np.asarray(obs, dtype="float64")
    pred = np.asarray(pred, dtype="float64")
    ss_res = float(((obs - pred) ** 2).sum())
    ss_tot = float(((obs - obs.mean()) ** 2).sum())
    return {
        "n": int(obs.size),
        "r2": 1 - ss_res / ss_tot if ss_tot > 0 else float("nan"),
        "mae": float(np.abs(obs - pred).mean()),
        "bias_pct": float((pred.sum() - obs.sum()) / obs.sum() * 100) if obs.sum() > 0 else float("nan"),
        "spearman": spearman(obs, pred),
    }


def spearman(a, b) -> float:
    a = pd.Series(np.asarray(a, dtype="float64")).rank()
    b = pd.Series(np.asarray(b, dtype="float64")).rank()
    if a.std() == 0 or b.std() == 0:
        return float("nan")
    return float(np.corrcoef(a, b)[0, 1])


# ------------------------------------------------------------- anomaly statistics

def robust_stats(values) -> dict:
    """Median and MAD of the finite values."""
    v = np.asarray(values, dtype="float64")
    v = v[np.isfinite(v)]
    if v.size == 0:
        return {"median": float("nan"), "mad": float("nan"), "n": 0}
    med = float(np.median(v))
    return {"median": med, "mad": float(np.median(np.abs(v - med))), "n": int(v.size)}


def anomaly(count: float, median: float, mad: float, eps: float = 1.0) -> dict:
    if not (np.isfinite(count) and np.isfinite(median)):
        return {"anomaly_pct": float("nan"), "robust_z": float("nan")}
    z = (count - median) / (1.4826 * mad) if mad and mad > 0 else float("nan")
    return {"anomaly_pct": (count - median) / max(median, eps) * 100, "robust_z": z}


def percentile_rank(value: float, sample) -> float:
    """Share (0-100) of finite sample values that are <= value."""
    s = np.asarray(sample, dtype="float64")
    s = s[np.isfinite(s)]
    if s.size == 0 or not np.isfinite(value):
        return float("nan")
    return float((s <= value).mean() * 100)


def theil_sen(x, y) -> float:
    x = np.asarray(x, dtype="float64")
    y = np.asarray(y, dtype="float64")
    ok = np.isfinite(x) & np.isfinite(y)
    x, y = x[ok], y[ok]
    if x.size < 3:
        return float("nan")
    i, j = np.triu_indices(x.size, 1)
    dx = x[j] - x[i]
    return float(np.median((y[j] - y[i])[dx != 0] / dx[dx != 0]))


def mann_kendall_p(y) -> float:
    """Two-sided Mann-Kendall p-value (normal approximation with tie correction)."""
    y = np.asarray(y, dtype="float64")
    y = y[np.isfinite(y)]
    n = y.size
    if n < 4:
        return float("nan")
    i, j = np.triu_indices(n, 1)
    s = float(np.sign(y[j] - y[i]).sum())
    _, counts = np.unique(y, return_counts=True)
    var = (n * (n - 1) * (2 * n + 5) - (counts * (counts - 1) * (2 * counts + 5)).sum()) / 18.0
    if var <= 0:
        return 1.0
    z = (s - np.sign(s)) / math.sqrt(var)
    return float(math.erfc(abs(z) / math.sqrt(2)))


def season_length(monthly_profile, share: float = 0.10) -> int:
    """Months that hold more than `share` of the annual total."""
    p = np.nan_to_num(np.asarray(monthly_profile, dtype="float64"))
    total = p.sum()
    return int((p > share * total).sum()) if total > 0 else 0


# --------------------------------------------------------------------- coverage

def month_coverage(years, data_start: pd.Timestamp, data_end: pd.Timestamp, gaps=()) -> pd.DataFrame:
    """Coverage status of every (year, month): ok / partial / nodata."""
    rows = []
    for y in years:
        for m in range(1, 13):
            first = pd.Timestamp(year=y, month=m, day=1)
            last = first + pd.offsets.MonthEnd(0)
            if last < data_start or first > data_end:
                status, note = "nodata", "outside the data record"
            elif first < data_start or last > data_end:
                status, note = "partial", "month only partly covered by the record"
            else:
                status, note = "ok", ""
            for g in gaps:
                g0, g1 = pd.Timestamp(g["from"]), pd.Timestamp(g["to"])
                if status != "nodata" and g0 <= last and g1 >= first:
                    status = "partial"
                    note = f'{g["sensor"]} {g.get("note", "outage")} {g["from"]} to {g["to"]}'
            rows.append({"year": y, "month": m, "status": status, "note": note})
    return pd.DataFrame(rows)


def calendar_matrix(monthly: pd.DataFrame, years, coverage: pd.DataFrame, value: str = "h") -> np.ndarray:
    """years x 12 matrix of summed `value`. Months without data are NaN, never 0."""
    years = list(years)
    mat = np.zeros((len(years), 12))
    agg = monthly.groupby(["year", "month"])[value].sum()
    for (y, m), v in agg.items():
        if y in years:
            mat[years.index(y), m - 1] = v
    for r in coverage.itertuples():
        if r.status == "nodata" and r.year in years:
            mat[years.index(r.year), r.month - 1] = np.nan
    return mat
