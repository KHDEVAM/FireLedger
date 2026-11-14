"""Pipeline tests: gridding, SP/NRT dedupe, filters, calibration, no-data handling."""
import importlib

import numpy as np
import pandas as pd
import pytest

import lib

grid_step = importlib.import_module("03_grid")


def detections(rows):
    cols = ["latitude", "longitude", "acq_date", "acq_time", "family", "sat", "proc", "confidence", "type"]
    df = pd.DataFrame(rows, columns=cols)
    df["acq_date"] = pd.to_datetime(df["acq_date"])
    return df


# ---------------------------------------------------------------- grid snapping

def test_grid_snapping_is_deterministic():
    rng = np.random.default_rng(1)
    lat, lon = rng.uniform(-60, 60, 5000), rng.uniform(-180, 180, 5000)
    a = lib.fine_cell(lat, lon)
    b = lib.fine_cell(lat[::-1], lon[::-1])[::-1]
    assert (a == b).all()
    assert (a == lib.fine_cell(lat.astype("float32").astype("float64").round(5), lon.round(5))).mean() > 0.95


def test_cell_contains_its_point_and_edges_are_stable():
    lat, lon = np.array([35.17123, 34.59999, 34.6, -0.004]), np.array([-5.27456, -2.35, -2.35001, 0.0])
    cell = lib.fine_cell(lat, lon)
    clon, clat = lib.cell_center(cell, 100)
    assert np.all(np.abs(clat - lat) <= 0.005 + 1e-9)
    assert np.all(np.abs(clon - lon) <= 0.005 + 1e-9)
    # 34.59999 and 34.6 are in different rows, exactly at the cell edge
    assert cell[1] != cell[2]


def test_coarsen_groups_25_by_25_fine_cells():
    base = lib.fine_cell([35.0], [-5.0])[0]
    same = lib.fine_cell([35.24], [-4.76])[0]
    other = lib.fine_cell([35.25], [-5.0])[0]
    assert lib.coarsen([base], 100, 25)[0] == lib.coarsen([same], 100, 25)[0]
    assert lib.coarsen([base], 100, 25)[0] != lib.coarsen([other], 100, 25)[0]


# ---------------------------------------------------------------- SP / NRT

def test_sp_and_nrt_are_never_double_counted():
    df = detections([
        (35.0, -5.0, "2025-06-01", 1200, "VIIRS", "N20", "SP", "n", 0),
        (35.0, -5.0, "2025-06-01", 1200, "VIIRS", "N20", "NRT", "n", 0),   # same day as SP -> dropped
        (35.1, -5.1, "2025-06-02", 1200, "VIIRS", "N20", "NRT", "n", 0),   # after the SP end -> kept
        (35.0, -5.0, "2025-06-01", 1210, "VIIRS", "N21", "NRT", "n", 0),   # satellite without SP -> kept
        (35.1, -5.1, "2025-06-02", 1200, "VIIRS", "N20", "NRT", "n", 0),   # exact duplicate -> dropped
    ])
    out = lib.dedupe_sp_nrt(df)
    assert len(out) == 3
    per_day = out[out["sat"] == "N20"].groupby("acq_date")["proc"].nunique()
    assert (per_day == 1).all()


def test_confidence_filter():
    df = detections([
        (0, 0, "2020-01-01", 0, "MODIS", "Terra", "SP", "29", 0),
        (0, 0, "2020-01-01", 0, "MODIS", "Aqua", "SP", "30", 0),
        (0, 0, "2020-01-01", 0, "VIIRS", "N", "SP", "l", 0),
        (0, 0, "2020-01-01", 0, "VIIRS", "N", "SP", "n", 0),
        (0, 0, "2020-01-01", 0, "VIIRS", "N20", "SP", "h", 0),
    ])
    assert list(lib.confidence_ok(df)) == [False, True, False, True, True]


def test_unify_schema_maps_viirs_and_modis_columns():
    viirs = pd.DataFrame({"latitude": [1.0], "longitude": [2.0], "bright_ti4": [330.0], "acq_date": ["2023-01-01"],
                          "acq_time": [1256], "satellite": ["N"], "confidence": ["n"], "version": ["2"],
                          "bright_ti5": [295.0], "frp": [2.3], "daynight": ["D"], "type": [0]})
    modis = pd.DataFrame({"latitude": [1.0], "longitude": [2.0], "brightness": [310.0], "acq_date": ["2023-01-01"],
                          "acq_time": [1023], "satellite": ["T"], "confidence": [53], "version": ["6.1NRT"],
                          "bright_t31": [280.0], "frp": [10.9], "daynight": ["D"]})
    v = lib.unify_schema(viirs, "VIIRS", "N", None)
    m = lib.unify_schema(modis, "MODIS", None, None)
    assert list(v.columns) == list(m.columns) == lib.CLEAN_COLUMNS
    assert v["brightness"][0] == pytest.approx(330.0) and m["bright_31"][0] == pytest.approx(280.0)
    assert m["sat"][0] == "Terra" and m["proc"][0] == "NRT" and v["proc"][0] == "SP"
    assert m["type"][0] == 0  # NRT has no type column: presumed vegetation


# ---------------------------------------------------------------- fire-cell-days

def test_pixel_clusters_collapse_and_satellites_are_a_union():
    df = detections([
        # three VIIRS pixels of one fire in the same 0.01 degree cell, same day, same satellite
        (35.1001, -5.1001, "2023-07-01", 1200, "VIIRS", "N", "SP", "n", 0),
        (35.1030, -5.1040, "2023-07-01", 1200, "VIIRS", "N", "SP", "n", 0),
        (35.1060, -5.1070, "2023-07-01", 1200, "VIIRS", "N", "SP", "n", 0),
        # the same cell seen by a second satellite
        (35.1050, -5.1050, "2023-07-01", 1300, "VIIRS", "N20", "SP", "n", 0),
        # a static source in another cell
        (35.5000, -5.5000, "2023-07-01", 1300, "VIIRS", "N20", "SP", "n", 2),
    ])
    everything, long = grid_step.cell_days(df, 100)
    counts = everything.groupby("series").size()
    assert counts["SNPP"] == 1          # 3 pixels -> 1 fire-cell-day
    assert counts["N20"] == 2
    assert counts["VIIRS"] == 2         # union of satellites, not 1 + 2
    veg = long[long["type"] == 0][["acq_date", "series", "cell"]].drop_duplicates()
    assert veg.groupby("series").size()["VIIRS"] == 1


# ---------------------------------------------------------------- no data is NaN

def test_missing_months_are_nan_not_zero():
    monthly = pd.DataFrame({"year": [2001, 2001], "month": [3, 5], "h": [10.0, 4.0]})
    cov = lib.month_coverage([2000, 2001], pd.Timestamp("2000-12-10"), pd.Timestamp("2001-06-20"),
                             [{"from": "2001-03-05", "to": "2001-03-09", "sensor": "X", "note": "outage"}])
    mat = lib.calendar_matrix(monthly, [2000, 2001], cov)
    assert np.isnan(mat[0, :11]).all()            # before the record: no data
    assert mat[0, 11] == 0                        # December 2000 partly covered: a real zero
    assert mat[1, 2] == 10 and mat[1, 3] == 0     # observed month without fire stays 0
    assert np.isnan(mat[1, 6:]).all()             # after the record: no data
    status = cov.set_index(["year", "month"])["status"]
    assert status[(2001, 3)] == "partial" and status[(2001, 4)] == "ok" and status[(2001, 6)] == "partial"
    assert status[(2001, 7)] == "nodata"


# ---------------------------------------------------------------- calibration

def test_seasonal_model_recovers_background_and_slope():
    rng = np.random.default_rng(3)
    month = np.tile(np.arange(1, 13), 12)
    background = 5 + 20 * np.exp(-((month - 8) ** 2) / 4)
    M = rng.poisson(3 + background / 4).astype(float)
    V = background + 2.5 * M
    model = lib.fit_models(M, V, month)
    assert model["ks"] == pytest.approx(2.5, rel=1e-6)
    assert np.allclose(model["s"], background[:12], atol=1e-6)
    assert np.allclose(lib.predict(model, "seasonal", M, month), V)


def test_ratio_and_loglog_keep_zero_modis_at_zero():
    month = np.tile(np.arange(1, 13), 3)
    M = np.array([0, 2, 5, 0, 9, 3] * 6, dtype=float)
    V = 4 * M + 1
    model = lib.fit_models(M, V, month)
    for kind in ("ratio", "loglog"):
        pred = lib.predict(model, kind, M, month)
        assert (pred[M == 0] == 0).all() and (pred[M > 0] > 0).all()
    assert model["k"] == pytest.approx(V.sum() / M.sum())


def test_trend_statistics():
    x = np.arange(2001, 2021)
    assert lib.theil_sen(x, 3.0 * x + 5) == pytest.approx(3.0)
    assert lib.mann_kendall_p(np.arange(20.0)) < 0.001
    assert lib.mann_kendall_p(np.array([1, 2, 1, 2, 1, 2, 1, 2.0])) > 0.3
    assert lib.season_length([0, 0, 0, 0, 0, 5, 30, 40, 20, 5, 0, 0]) == 3
    assert lib.percentile_rank(5, [1, 2, 5, 9]) == 75
    a = lib.anomaly(30, 10, 5)
    assert a["anomaly_pct"] == pytest.approx(200) and a["robust_z"] == pytest.approx(20 / (1.4826 * 5))


# ---------------------------------------------------------------- processed outputs (when the pipeline has run)

@pytest.fixture
def processed():
    if not (lib.PROCESSED / "validation.csv").exists():
        pytest.skip("pipeline outputs not present (run the pipeline first)")
    return lib.PROCESSED


def test_harmonized_overlap_totals_stay_within_validation_band(processed):
    import json

    harm = json.loads((processed / "harmonization.json").read_text(encoding="utf-8"))
    best = harm["validation"]["model"]
    cv = pd.read_csv(processed / "validation.csv")
    yearly = cv.groupby("year")[["ref", best]].sum()
    ratio = yearly[best] / yearly["ref"]
    # every held-out year is predicted within +-35 %, and the whole overlap within +-5 %
    assert ratio.between(0.65, 1.35).all(), ratio.to_dict()
    assert abs(yearly[best].sum() / yearly["ref"].sum() - 1) < 0.05
    # harmonizing must beat raw MODIS as an estimate of VIIRS
    assert harm["validation"]["domain_month"]["mae"] < harm["validation"]["domain_month_raw_modis"]["mae"]


def test_processed_grid_is_consistent(processed):
    grid = pd.read_parquet(processed / "monthly_grid.parquet")
    veg = grid[grid["variant"] == "veg"]
    assert (veg["lo"] <= veg["h"] + 1e-9).all() and (veg["h"] <= veg["hi"] + 1e-9).all()
    assert (veg["h"] >= 0).all()
    observed = veg[veg["src"] == "viirs_obs"]
    assert np.allclose(observed["h"], observed["viirs_ref"])
    everything = grid[grid["variant"] == "all"].groupby("year")["h"].sum()
    assert (everything >= veg.groupby("year")["h"].sum() - 1e-6).all()
