#!/usr/bin/env python3
"""Backfill JSON demo data into TimescaleDB.

Reads existing JSON files from public/data/ and inserts them into
the measurements and analysis_results hypertables in long format.

Idempotent: uses ON CONFLICT / upsert via the TimeseriesWriter.

Usage:
    python scripts/backfill_json_to_db.py
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, ".")
from nuravolt.db.writer import TimeseriesWriter, get_plant_id

DATA_DIR = Path("public/data")
PLANTS = [
    "alpha",
    "ribera",
    "gamma",
    "delta",
    "epsilon",
    "zeta",
    "eta",
    "theta",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def load_json(path: Path) -> Optional[Any]:
    """Load JSON file, return None if missing."""
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def parse_ts(raw: str) -> datetime:
    """Parse a date or datetime string from JSON into a datetime object.

    Handles formats:
      - "2024-01-01"
      - "2024-01-01T12:00:00"
      - "2024-01-01T12:00:00.123456"
      - "2025.11.19 00:00"
    """
    if "." in raw and " " in raw and "T" not in raw:
        # "2025.11.19 00:00" format used by fault timestamps
        return datetime.strptime(raw, "%Y.%m.%d %H:%M")
    return datetime.fromisoformat(raw)


# ---------------------------------------------------------------------------
# Backfill functions
# ---------------------------------------------------------------------------


def backfill_soiling_forecasts(
    writer: TimeseriesWriter, plant_slug: str, plant_uuid: str
) -> int:
    """Backfill soiling 365-day forecast predictions into analysis_results.

    Source: public/data/soiling/{plant}/forecast_365d.json
    Keys per row: date, sr_predicted, sr_lower_bound, sr_upper_bound,
                  soiling_loss_pct
    """
    path = DATA_DIR / "soiling" / plant_slug / "forecast_365d.json"
    data = load_json(path)
    if data is None:
        print(f"  Soiling forecast: [SKIP] {path} not found")
        return 0

    forecasts = data.get("forecasts", [])
    if not forecasts:
        print(f"  Soiling forecast: [SKIP] no forecasts array")
        return 0

    model_version = data.get("metadata", {}).get("model_type", "physics")
    records: List[Dict[str, Any]] = []

    for row in forecasts:
        ts = parse_ts(row["date"])
        base = {"time": ts, "device_id": None}

        if row.get("sr_predicted") is not None:
            records.append(
                {**base, "metric": "soiling_ratio", "value": row["sr_predicted"]}
            )
        if row.get("sr_lower_bound") is not None:
            records.append(
                {
                    **base,
                    "metric": "soiling_ratio_lower",
                    "value": row["sr_lower_bound"],
                }
            )
        if row.get("sr_upper_bound") is not None:
            records.append(
                {
                    **base,
                    "metric": "soiling_ratio_upper",
                    "value": row["sr_upper_bound"],
                }
            )
        if row.get("soiling_loss_pct") is not None:
            records.append(
                {
                    **base,
                    "metric": "soiling_loss_pct",
                    "value": row["soiling_loss_pct"],
                }
            )

    n = writer.write_analysis_results(
        plant_id=plant_uuid,
        domain="soiling",
        records=records,
        model_version=model_version,
    )
    print(f"  Soiling forecast: {n} rows")
    return n


def backfill_soiling_history(
    writer: TimeseriesWriter, plant_slug: str, plant_uuid: str
) -> int:
    """Backfill historical soiling ratio observations into analysis_results.

    Source: public/data/soiling/{plant}/soiling_ratio_srr.json
    Keys per row: date, soiling_ratio
    """
    path = DATA_DIR / "soiling" / plant_slug / "soiling_ratio_srr.json"
    data = load_json(path)
    if data is None:
        print(f"  Soiling history:  [SKIP] {path} not found")
        return 0

    daily_data = data.get("daily_data", [])
    if not daily_data:
        print(f"  Soiling history:  [SKIP] no daily_data array")
        return 0

    method = data.get("metadata", {}).get("method", "srr")
    records: List[Dict[str, Any]] = []

    for row in daily_data:
        ts = parse_ts(row["date"])
        sr = row.get("soiling_ratio")
        if sr is not None:
            records.append(
                {
                    "time": ts,
                    "device_id": None,
                    "metric": "soiling_ratio_observed",
                    "value": sr,
                }
            )

    n = writer.write_analysis_results(
        plant_id=plant_uuid,
        domain="soiling",
        records=records,
        model_version=method,
    )
    print(f"  Soiling history:  {n} rows")
    return n


def backfill_rain_history(
    writer: TimeseriesWriter, plant_slug: str, plant_uuid: str
) -> int:
    """Backfill rainfall measurements.

    Source: public/data/soiling/{plant}/rain_history.json
    Keys per row: date, precipitation_mm, is_cleaning_event, is_heavy_rain
    """
    path = DATA_DIR / "soiling" / plant_slug / "rain_history.json"
    data = load_json(path)
    if data is None:
        print(f"  Rain history:     [SKIP] {path} not found")
        return 0

    daily_data = data.get("daily_data", [])
    if not daily_data:
        print(f"  Rain history:     [SKIP] no daily_data array")
        return 0

    records: List[Dict[str, Any]] = []

    for row in daily_data:
        ts = parse_ts(row["date"])
        precip = row.get("precipitation_mm")
        if precip is not None:
            records.append(
                {
                    "time": ts,
                    "device_id": plant_slug,  # plant-level measurement
                    "metric": "precipitation",
                    "value": precip,
                    "unit": "mm",
                }
            )

    n = writer.write_measurements(
        plant_id=plant_uuid,
        records=records,
    )
    print(f"  Rain history:     {n} rows")
    return n


def backfill_digitaltwin_summary(
    writer: TimeseriesWriter, plant_slug: str, plant_uuid: str
) -> int:
    """Backfill digital twin model performance metrics into analysis_results.

    Source: public/data/digitaltwin/{plant}/digital_twins_summary.json
    Contains per-inverter metrics: r2, mae_kW, rmse_kW, nSamples, nominalPower_kW
    Also contains plant-level statistics: avgR2, avgMAE_kW, plantModelR2
    """
    path = DATA_DIR / "digitaltwin" / plant_slug / "digital_twins_summary.json"
    data = load_json(path)
    if data is None:
        print(f"  DT summary:       [SKIP] {path} not found")
        return 0

    generated_at = data.get("generatedAt")
    if not generated_at:
        print(f"  DT summary:       [SKIP] no generatedAt timestamp")
        return 0

    ts = parse_ts(generated_at)
    model_type = data.get("modelType", "unknown")
    records: List[Dict[str, Any]] = []

    # Plant-level statistics
    stats = data.get("statistics", {})
    for metric_key, metric_name in [
        ("avgR2", "model_r2"),
        ("avgMAE_kW", "model_mae_kw"),
        ("plantModelR2", "plant_model_r2"),
        ("physicsOnlyR2", "physics_only_r2"),
        ("totalInverters", "total_inverters"),
        ("successful", "successful_inverters"),
    ]:
        val = stats.get(metric_key)
        if val is not None:
            records.append(
                {
                    "time": ts,
                    "device_id": None,
                    "metric": metric_name,
                    "value": float(val),
                }
            )

    # Per-inverter metrics
    inverters = data.get("inverters", {})
    for inv_id, inv_data in inverters.items():
        if not inv_data.get("success"):
            continue
        metrics = inv_data.get("metrics", {})
        for metric_key, metric_name in [
            ("r2", "model_r2"),
            ("mae_kW", "model_mae_kw"),
            ("rmse_kW", "model_rmse_kw"),
        ]:
            val = metrics.get(metric_key)
            if val is not None:
                records.append(
                    {
                        "time": ts,
                        "device_id": inv_id,
                        "metric": metric_name,
                        "value": float(val),
                    }
                )

    n = writer.write_analysis_results(
        plant_id=plant_uuid,
        domain="digitaltwin",
        records=records,
        model_version=model_type,
    )
    print(f"  DT summary:       {n} rows")
    return n


def backfill_digitaltwin_predictions(
    writer: TimeseriesWriter, plant_slug: str, plant_uuid: str
) -> int:
    """Backfill digital twin per-inverter predictions into analysis_results.

    Source: public/data/digitaltwin/{plant}/predictions.json
    Contains per-inverter: expected_power_kW, actual_power_kW,
                           power_loss_pct, timestamp
    """
    path = DATA_DIR / "digitaltwin" / plant_slug / "predictions.json"
    data = load_json(path)
    if data is None:
        print(f"  DT predictions:   [SKIP] {path} not found")
        return 0

    predictions = data.get("predictions", {})
    if not predictions:
        print(f"  DT predictions:   [SKIP] no predictions object")
        return 0

    records: List[Dict[str, Any]] = []

    for inv_id, pred in predictions.items():
        ts_raw = pred.get("timestamp")
        if not ts_raw:
            continue
        ts = parse_ts(ts_raw)

        for json_key, metric_name in [
            ("expected_power_kW", "power_predicted"),
            ("actual_power_kW", "power_actual"),
            ("power_loss_pct", "power_loss_pct"),
        ]:
            val = pred.get(json_key)
            if val is not None:
                records.append(
                    {
                        "time": ts,
                        "device_id": inv_id,
                        "metric": metric_name,
                        "value": float(val),
                    }
                )

        # Compute residual = actual - expected
        actual = pred.get("actual_power_kW")
        expected = pred.get("expected_power_kW")
        if actual is not None and expected is not None:
            records.append(
                {
                    "time": ts,
                    "device_id": inv_id,
                    "metric": "residual",
                    "value": float(actual) - float(expected),
                }
            )

    n = writer.write_analysis_results(
        plant_id=plant_uuid,
        domain="digitaltwin",
        records=records,
    )
    print(f"  DT predictions:   {n} rows")
    return n


def backfill_faults(
    writer: TimeseriesWriter, plant_slug: str, plant_uuid: str
) -> int:
    """Backfill fault detection results into analysis_results.

    Source: public/data/faults/{plant}/fault_detection_results.json
    Contains reactive_faults[] and predictive_faults[] arrays.

    For reactive faults:
      - severity, power_loss_kw, energy_loss_kwh, duration_minutes
    For predictive faults:
      - confidence, projected_power_loss_kw, projected_energy_loss_kwh,
        days_to_fault
    """
    path = DATA_DIR / "faults" / plant_slug / "fault_detection_results.json"
    data = load_json(path)
    if data is None:
        print(f"  Faults:           [SKIP] {path} not found")
        return 0

    records: List[Dict[str, Any]] = []

    # --- Reactive faults ---
    severity_map = {"critical": 1.0, "high": 0.8, "warning": 0.6, "info": 0.3}

    for fault in data.get("reactive_faults", []):
        ts_raw = fault.get("timestamp_start")
        if not ts_raw:
            continue
        ts = parse_ts(ts_raw)
        equip = fault.get("equipment_id", "unknown")
        fault_type = fault.get("fault_type", "unknown")

        # Severity as a numeric value
        sev_str = fault.get("severity", "info")
        sev_val = severity_map.get(sev_str, 0.3)

        metadata = {
            "fault_id": fault.get("id"),
            "fault_type": fault_type,
            "severity_label": sev_str,
            "message": fault.get("message", ""),
            "is_chronic": fault.get("is_chronic", False),
        }

        records.append(
            {
                "time": ts,
                "device_id": equip,
                "metric": "fault_severity",
                "value": sev_val,
                "confidence": fault.get("classification", {}).get("confidence"),
                "metadata": metadata,
            }
        )

        for json_key, metric_name in [
            ("power_loss_kw", "fault_power_loss_kw"),
            ("energy_loss_kwh", "fault_energy_loss_kwh"),
            ("duration_minutes", "fault_duration_min"),
        ]:
            val = fault.get(json_key)
            if val is not None:
                records.append(
                    {
                        "time": ts,
                        "device_id": equip,
                        "metric": metric_name,
                        "value": float(val),
                    }
                )

    # --- Predictive faults ---
    for fault in data.get("predictive_faults", []):
        ts_raw = fault.get("estimated_date")
        if not ts_raw:
            continue
        ts = parse_ts(ts_raw)
        equip = fault.get("equipment_id", "unknown")
        fault_type = fault.get("fault_type", "unknown")

        metadata = {
            "fault_id": fault.get("id"),
            "fault_type": fault_type,
            "display_name": fault.get("display_name", ""),
            "urgency": fault.get("urgency", ""),
            "recommended_action": fault.get("recommended_action", ""),
            "days_to_fault": fault.get("days_to_fault"),
        }

        confidence = fault.get("confidence")

        records.append(
            {
                "time": ts,
                "device_id": equip,
                "metric": "predicted_fault_severity",
                "value": confidence if confidence is not None else 0.5,
                "confidence": confidence,
                "metadata": metadata,
            }
        )

        for json_key, metric_name in [
            ("projected_power_loss_kw", "predicted_power_loss_kw"),
            ("projected_energy_loss_kwh", "predicted_energy_loss_kwh"),
            ("days_to_fault", "predicted_days_to_fault"),
        ]:
            val = fault.get(json_key)
            if val is not None:
                records.append(
                    {
                        "time": ts,
                        "device_id": equip,
                        "metric": metric_name,
                        "value": float(val),
                    }
                )

    n = writer.write_analysis_results(
        plant_id=plant_uuid,
        domain="fault",
        records=records,
    )
    print(f"  Faults:           {n} rows")
    return n


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    writer = TimeseriesWriter()
    total = 0

    for slug in PLANTS:
        plant_uuid = get_plant_id(slug)
        if not plant_uuid:
            print(f"  [SKIP] Plant '{slug}' not found in DB")
            continue

        print(f"\n=== Backfilling {slug} (UUID: {plant_uuid}) ===")

        total += backfill_soiling_forecasts(writer, slug, plant_uuid)
        total += backfill_soiling_history(writer, slug, plant_uuid)
        total += backfill_rain_history(writer, slug, plant_uuid)
        total += backfill_digitaltwin_summary(writer, slug, plant_uuid)
        total += backfill_digitaltwin_predictions(writer, slug, plant_uuid)
        total += backfill_faults(writer, slug, plant_uuid)

    writer.close()
    print(f"\n=== Backfill complete: {total} total rows inserted ===")


if __name__ == "__main__":
    main()
