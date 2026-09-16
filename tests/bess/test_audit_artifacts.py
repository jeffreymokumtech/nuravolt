"""Unit tests for the dispatch-schedule → telemetry reconstruction used by
scripts/generate_bess_audit_artifacts.py (the live BESS audit job)."""

from datetime import date

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from scripts.generate_bess_audit_artifacts import dispatch_rows_to_telemetry, jsonable


def make_row(day, charge, discharge, soc, price):
    return {
        "schedule_date": day,
        "charge_schedule_kw": charge,
        "discharge_schedule_kw": discharge,
        "soc_schedule": soc,
        "price_forecast": price,
    }


def test_sign_convention_positive_is_discharge():
    df = dispatch_rows_to_telemetry(
        [make_row(date(2026, 7, 1), [500, 0], [0, 800], [0.4, 0.7], [30.0, 90.0])]
    )
    assert list(df["power_kw"]) == [-500.0, 800.0]
    assert list(df["soc"]) == [0.4, 0.7]
    assert list(df["price_eur_mwh"]) == [30.0, 90.0]


def test_negative_charge_storage_is_normalized():
    # Some writers store charge as negative power already.
    df = dispatch_rows_to_telemetry(
        [make_row(date(2026, 7, 1), [-500, 0], [0, 800], [0.4, 0.7], [30.0, 90.0])]
    )
    assert list(df["power_kw"]) == [-500.0, 800.0]


def test_hourly_timestamps_and_multiday_ordering():
    df = dispatch_rows_to_telemetry(
        [
            make_row(date(2026, 7, 1), [0] * 24, [100] * 24, [0.5] * 24, [50.0] * 24),
            make_row(date(2026, 7, 2), [0] * 24, [100] * 24, [0.5] * 24, [50.0] * 24),
        ]
    )
    assert len(df) == 48
    assert df["timestamp"].iloc[0].hour == 0
    assert df["timestamp"].iloc[23].hour == 23
    assert df["timestamp"].is_monotonic_increasing


def test_short_or_missing_arrays_do_not_crash():
    df = dispatch_rows_to_telemetry(
        [make_row(date(2026, 7, 1), [0, 100], [50, 0], [0.5], [])]
    )
    assert len(df) == 2
    assert df["soc"].iloc[1] is None or df["soc"].isna().iloc[1]
    assert df["price_eur_mwh"].isna().all()


def test_jsonable_scrubs_nan_for_postgres():
    out = jsonable({"a": float("nan"), "b": float("inf"), "c": 1.5})
    assert out["a"] is None
    assert out["b"] is None
    assert out["c"] == 1.5
