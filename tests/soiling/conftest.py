"""Shared fixtures for the soiling test suite.

All fixtures are synthetic and in-memory (or written to tmp_path) — the real
parquet/lake inputs are gitignored, so nothing here may touch
public/data/soiling source data, S3, or the lake. Schemas mirror the real
on-disk contracts:

- pr_daily.parquet  : long format ``date`` (datetime64), ``inverterId``
  ('INV 01.001' style), ``pr`` (float)
- rain_history.csv  : ``date,precipitation_mm,is_cleaning_event,is_heavy_rain``
- dustiq_history.json : ``{metadata: {...}, daily_data: [{date, sr_dustiq}]}``
- per_inverter/all_inverters.json : ``{metadata, inverters: [{inverterId,
  groupId, soilingRatio:{median}, anomalyDetection:{anomalyRate_pct},
  fleetComparison:{rank, zScore}}]}``
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

N_INVERTERS = 10
N_DAYS = 200
START = pd.Timestamp("2024-01-01")
# Heavy-rain (cleaning) days, as day offsets from START
RAIN_RESET_DAYS = [60, 140]
DIRTY_INVERTER = "INV 01.010"  # engineered systematically dirtier


def _inverter_ids(n: int = N_INVERTERS):
    return [f"INV 01.{i + 1:03d}" for i in range(n)]


def _sr_sawtooth(n_days: int = N_DAYS, start_sr: float = 0.995,
                 decay_per_day: float = 0.0012) -> np.ndarray:
    """Physics-plausible SR: linear dry-day decay, full reset after heavy rain."""
    sr = np.empty(n_days)
    current = start_sr
    for d in range(n_days):
        if d in RAIN_RESET_DAYS:
            current = start_sr
        sr[d] = current
        current -= decay_per_day
    return sr


@pytest.fixture(scope="session")
def sr_series() -> pd.Series:
    """Plant-level SR series (date-indexed) with rain resets — the ground truth."""
    dates = pd.date_range(START, periods=N_DAYS, freq="D")
    return pd.Series(_sr_sawtooth(), index=dates, name="sr")


@pytest.fixture(scope="session")
def rain_df() -> pd.DataFrame:
    """Rain history matching the rain_history.csv schema (date as a column)."""
    dates = pd.date_range(START, periods=N_DAYS, freq="D")
    rng = np.random.default_rng(7)
    precip = np.where(rng.random(N_DAYS) < 0.08, rng.uniform(0.5, 4.0, N_DAYS), 0.0)
    for d in RAIN_RESET_DAYS:
        precip[d] = 22.0  # heavy rain -> natural cleaning
    return pd.DataFrame({
        "date": dates,
        "precipitation_mm": np.round(precip, 1),
        "is_cleaning_event": [d in RAIN_RESET_DAYS for d in range(N_DAYS)],
        "is_heavy_rain": precip >= 10.0,
    })


@pytest.fixture(scope="session")
def pr_daily_df(sr_series) -> pd.DataFrame:
    """Long-format per-inverter daily PR (pr_daily.parquet schema).

    PR tracks the plant SR sawtooth scaled to a realistic PR band, with a
    stable per-inverter offset so cross-inverter variance is real, plus one
    engineered dirty inverter (DIRTY_INVERTER, −0.06 PR).
    """
    rng = np.random.default_rng(11)
    ids = _inverter_ids()
    offsets = dict(zip(ids, rng.normal(0.0, 0.008, len(ids))))
    offsets[DIRTY_INVERTER] = -0.06
    rows = []
    for date, sr in sr_series.items():
        for inv in ids:
            pr = 0.82 * sr + offsets[inv] + rng.normal(0, 0.002)
            rows.append({"date": date, "inverterId": inv, "pr": round(float(pr), 4)})
    return pd.DataFrame(rows)


@pytest.fixture()
def plant_dir(tmp_path, pr_daily_df, rain_df, sr_series):
    """Factory: lay out a ``public/data/soiling/{plant}``-shaped dir in tmp_path.

    Returns (plant_root: Path, plant_id: str). Contains pr_daily.parquet,
    rain_history.csv, dustiq_history.json and per_inverter/all_inverters.json
    with the minimal real schemas.
    """

    def _make(plant_id: str = "testplant") -> Path:
        root = tmp_path / plant_id
        (root / "per_inverter").mkdir(parents=True)
        pr_daily_df.to_parquet(root / "pr_daily.parquet", index=False)
        rain_out = rain_df.copy()
        rain_out["date"] = rain_out["date"].dt.strftime("%Y-%m-%d")
        rain_out.to_csv(root / "rain_history.csv", index=False)

        dustiq = {
            "metadata": {
                "plant_id": plant_id,
                "source": "DustIQ Direct Sensor",
                "sensors": ["DustIQ.01 Sensor 1"],
                "period": {
                    "start": str(sr_series.index[0].date()),
                    "end": str(sr_series.index[-1].date()),
                },
            },
            "daily_data": [
                {"date": str(d.date()), "sr_dustiq": round(float(v), 6)}
                for d, v in sr_series.items()
            ],
        }
        (root / "dustiq_history.json").write_text(json.dumps(dustiq))

        inv_stats = pr_daily_df.groupby("inverterId")["pr"].agg(["median", "mean", "std"])
        fleet_mean = inv_stats["mean"].mean()
        fleet_std = inv_stats["mean"].std() or 1.0
        ranks = inv_stats["mean"].rank(ascending=False).astype(int)
        all_inverters = {
            "metadata": {"plant_id": plant_id, "total_inverters": len(inv_stats)},
            "inverters": [
                {
                    "inverterId": inv,
                    "groupId": inv.split(".")[0],
                    "soilingRatio": {"median": round(float(row["median"]) / 0.82, 4)},
                    "anomalyDetection": {"anomalyRate_pct": 0.0},
                    "fleetComparison": {
                        "rank": int(ranks[inv]),
                        "zScore": round(float((row["mean"] - fleet_mean) / fleet_std), 3),
                    },
                }
                for inv, row in inv_stats.iterrows()
            ],
        }
        (root / "per_inverter" / "all_inverters.json").write_text(json.dumps(all_inverters))
        return root

    return _make
