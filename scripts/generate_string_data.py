"""
generate_string_data.py
=======================
Processes real SCADA parquet data to generate string/MPPT level monitoring JSON
files for the NuraVolt platform.

Outputs per plant:
  public/data/digitaltwin/{plantId}/mppt_string_data.json
  public/data/digitaltwin/{plantId}/string_anomalies.json

Usage:
  python scripts/generate_string_data.py
"""

import json
import logging
import math
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import polars as pl

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Plant configuration
# ---------------------------------------------------------------------------
PLANTS = {
    "alpha": {
        "prefix": "Alpha (ES)",
        "inverter_model": "Generic 60kW",
        "nominal_power_kw": 60.0,
        "strings_per_inverter": 12,
        "mppt_count": 6,
        "strings_per_mppt": 2,
        "modules_per_string": 20,  # typical utility-scale
    },
    "ribera": {
        "prefix": "Ribera (ES)",
        "inverter_model": "Generic 50kW",
        "nominal_power_kw": 50.0,
        "strings_per_inverter": 12,
        "mppt_count": 6,
        "strings_per_mppt": 2,
        "modules_per_string": 20,
    },
}

SCADA_ROOT = Path("backenddata/scada")
OUTPUT_ROOT = Path("public/data/digitaltwin")

# Anomaly thresholds
OPEN_CIRCUIT_THRESHOLD_A = 0.1       # mean current below this → open circuit
MISMATCH_WARNING_PCT = 15.0          # % below MPPT peer mean → warning
MISMATCH_CRITICAL_PCT = 25.0         # % below MPPT peer mean → critical
DEGRADATION_INFO_PCT_PER_MONTH = 0.5 # slope threshold (info)
DEGRADATION_WARN_PCT_PER_MONTH = 1.0 # slope threshold (warning)
IRRADIANCE_MIN_WM2 = 200.0           # filter out night/low-light
ANALYSIS_DAYS = 30


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def safe_float(val, default: float = 0.0) -> float:
    """Convert a value to float, returning default on None/NaN."""
    if val is None:
        return default
    try:
        f = float(val)
        return default if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return default


def parse_timestamp(ts_str: str) -> datetime:
    """Parse '2024.07.01 22:00' format."""
    return datetime.strptime(ts_str, "%Y.%m.%d %H:%M")


def detect_inverter_ids(columns: list[str], prefix: str) -> list[str]:
    """Extract sorted unique inverter IDs from column list."""
    pattern = re.compile(rf"^{re.escape(prefix)}: INV (\d{{2}}\.\d{{3}}) /")
    ids = sorted(set(m.group(1) for c in columns if (m := pattern.match(c))))
    return ids


def build_col_name(prefix: str, inv_id: str, signal: str) -> str:
    return f"{prefix}: INV {inv_id} / {signal}"


def irradiance_col(prefix: str) -> str:
    return f"{prefix}: Plant / Irradiation_average (W/m²)"


# ---------------------------------------------------------------------------
# Core processing
# ---------------------------------------------------------------------------

def load_and_filter_recent(parquet_path: Path, irr_col: str) -> tuple[pl.DataFrame, str]:
    """
    Load parquet, filter to last 30 days of data where irradiance > threshold.
    Returns (filtered_df, last_timestamp_str).
    """
    log.info("Loading %s ...", parquet_path.name)
    df_full = pl.read_parquet(parquet_path)
    log.info("  Loaded %d rows x %d cols", df_full.height, df_full.width)

    # Parse timestamps to find the latest date in the data
    ts_series = df_full["timestamp"]
    latest_str = ts_series.drop_nulls().max()  # lexicographic max works for this format
    latest_dt = parse_timestamp(latest_str)
    cutoff_dt = latest_dt - timedelta(days=ANALYSIS_DAYS)
    cutoff_str = cutoff_dt.strftime("%Y.%m.%d %H:%M")

    log.info("  Data latest: %s  |  30-day cutoff: %s", latest_str, cutoff_str)

    # Filter to recent window
    df_recent = df_full.filter(pl.col("timestamp") >= cutoff_str)
    log.info("  Rows in 30-day window: %d", df_recent.height)

    # Filter to daylight (irradiance > threshold)
    if irr_col in df_recent.columns:
        df_day = df_recent.filter(pl.col(irr_col) > IRRADIANCE_MIN_WM2)
    else:
        log.warning("  Irradiance column not found: %s — skipping irradiance filter", irr_col)
        df_day = df_recent

    log.info("  Daytime rows (irr > %g W/m²): %d", IRRADIANCE_MIN_WM2, df_day.height)

    return df_day, latest_str


def compute_mppt_snapshot(
    df_day: pl.DataFrame,
    prefix: str,
    inv_id: str,
    cfg: dict,
) -> tuple[list[dict], dict]:
    """
    Compute the latest snapshot values for all MPPTs in one inverter.

    Returns (mppts_list, summary_dict) with values averaged over recent
    daytime data (a stable snapshot rather than a single noisy reading).
    """
    n_mppts = cfg["mppt_count"]
    n_str_per_mppt = cfg["strings_per_mppt"]
    n_strings = cfg["strings_per_inverter"]

    # Collect mean values for each string current and DC voltage
    string_means: dict[int, float] = {}    # 1-indexed string number
    voltage_means: dict[int, float] = {}   # 1-indexed

    for s in range(1, n_strings + 1):
        cur_col = build_col_name(prefix, inv_id, f"Input_current_{s:02d} (A)")
        if cur_col in df_day.columns:
            vals = df_day[cur_col].drop_nulls()
            string_means[s] = float(vals.mean()) if vals.len() > 0 else 0.0
        else:
            string_means[s] = 0.0

        # Voltage column numbering is not zero-padded
        vol_col = build_col_name(prefix, inv_id, f"U_DC_{s} (V)")
        if vol_col in df_day.columns:
            vals = df_day[vol_col].drop_nulls()
            voltage_means[s] = float(vals.mean()) if vals.len() > 0 else 0.0
        else:
            voltage_means[s] = 0.0

    mppts = []
    total_power = 0.0
    all_voltages = []
    healthy_strings = 0
    total_strings_count = 0

    for m in range(n_mppts):
        mppt_idx = m + 1
        # Strings assigned to this MPPT: [2m+1, 2m+2] (1-indexed)
        str_indices = [m * n_str_per_mppt + k + 1 for k in range(n_str_per_mppt)]

        mppt_voltage = sum(voltage_means.get(s, 0.0) for s in str_indices) / n_str_per_mppt
        mppt_current = sum(string_means.get(s, 0.0) for s in str_indices)
        mppt_power = mppt_voltage * mppt_current / 1000.0  # W → kW

        strings_data = []
        mppt_status = "normal"

        for s in str_indices:
            cur_A = safe_float(string_means.get(s, 0.0))
            vol_V = safe_float(voltage_means.get(s, 0.0))
            pwr_kW = vol_V * cur_A / 1000.0

            # Determine string status
            if cur_A < OPEN_CIRCUIT_THRESHOLD_A:
                status = "open_circuit"
                degradation_pct = 100.0
            elif cur_A < (mppt_current / n_str_per_mppt) * (1 - MISMATCH_CRITICAL_PCT / 100):
                status = "degraded"
                peer_avg = mppt_current / n_str_per_mppt
                degradation_pct = (1 - cur_A / peer_avg) * 100 if peer_avg > 0 else 0.0
            else:
                status = "normal"
                degradation_pct = 0.0

            if status == "normal":
                healthy_strings += 1
            elif status in ("degraded", "open_circuit"):
                mppt_status = "warning" if mppt_status == "normal" else mppt_status

            total_strings_count += 1

            strings_data.append({
                "stringId": f"STR-{s}",
                "moduleCount": cfg["modules_per_string"],
                "voltage_V": round(vol_V, 2),
                "current_A": round(cur_A, 3),
                "power_kW": round(pwr_kW, 4),
                "status": status,
                "degradation_pct": round(degradation_pct, 1),
            })

        mppts.append({
            "mpptId": f"MPPT-{mppt_idx}",
            "voltage_V": round(mppt_voltage, 2),
            "current_A": round(mppt_current, 3),
            "power_kW": round(mppt_power, 4),
            "status": mppt_status,
            "strings": strings_data,
        })

        total_power += mppt_power
        all_voltages.extend([voltage_means.get(s, 0.0) for s in str_indices])

    avg_voltage = sum(all_voltages) / len(all_voltages) if all_voltages else 0.0
    fault_ratio = 1.0 - (healthy_strings / total_strings_count) if total_strings_count > 0 else 0.0
    overall_status = (
        "faulted" if fault_ratio > 0.3
        else "degraded" if fault_ratio > 0.1
        else "healthy"
    )

    summary = {
        "totalPower_kW": round(total_power, 4),
        "avgVoltage_V": round(avg_voltage, 2),
        "healthyStrings": healthy_strings,
        "totalStrings": total_strings_count,
        "overallStatus": overall_status,
    }

    return mppts, summary


def detect_anomalies(
    df_day: pl.DataFrame,
    prefix: str,
    inv_id: str,
    cfg: dict,
) -> list[dict]:
    """
    Run anomaly detection for one inverter against the recent daytime dataset.
    Returns list of anomaly dicts.
    """
    n_mppts = cfg["mppt_count"]
    n_str_per_mppt = cfg["strings_per_mppt"]
    n_strings = cfg["strings_per_inverter"]
    anomalies = []

    # Pre-compute mean current for each string
    string_means: dict[int, float] = {}
    string_series: dict[int, pl.Series] = {}

    for s in range(1, n_strings + 1):
        col = build_col_name(prefix, inv_id, f"Input_current_{s:02d} (A)")
        if col in df_day.columns:
            vals = df_day[col].drop_nulls()
            string_means[s] = float(vals.mean()) if vals.len() > 0 else 0.0
            string_series[s] = vals
        else:
            string_means[s] = 0.0
            string_series[s] = pl.Series([], dtype=pl.Float64)

    # Detect per MPPT
    for m in range(n_mppts):
        mppt_idx = m + 1
        mppt_id = f"MPPT-{mppt_idx}"
        str_indices = [m * n_str_per_mppt + k + 1 for k in range(n_str_per_mppt)]

        mppt_peer_avg = sum(string_means.get(s, 0.0) for s in str_indices) / n_str_per_mppt

        for s in str_indices:
            mean_cur = string_means.get(s, 0.0)
            str_id = f"STR-{s}"

            # --- OPEN_CIRCUIT detection ---
            if mean_cur < OPEN_CIRCUIT_THRESHOLD_A:
                anomalies.append({
                    "inverterId": f"INV {inv_id}",
                    "mpptId": mppt_id,
                    "stringId": str_id,
                    "type": "OPEN_CIRCUIT",
                    "severity": "critical",
                    "currentDrop_pct": 100.0,
                    "detectedAt": datetime.now().strftime("%Y-%m-%d"),
                    "description": (
                        f"String mean current {mean_cur:.3f}A is below "
                        f"open-circuit threshold ({OPEN_CIRCUIT_THRESHOLD_A}A)"
                    ),
                })
                continue  # no need for further checks on this string

            # --- MISMATCH detection ---
            if mppt_peer_avg > 0:
                drop_pct = (1.0 - mean_cur / mppt_peer_avg) * 100.0
                if drop_pct > MISMATCH_CRITICAL_PCT:
                    anomalies.append({
                        "inverterId": f"INV {inv_id}",
                        "mpptId": mppt_id,
                        "stringId": str_id,
                        "type": "MISMATCH",
                        "severity": "critical",
                        "currentDrop_pct": round(drop_pct, 1),
                        "detectedAt": datetime.now().strftime("%Y-%m-%d"),
                        "description": (
                            f"String current {drop_pct:.1f}% below MPPT peer average "
                            f"({mean_cur:.2f}A vs {mppt_peer_avg:.2f}A) — critical mismatch"
                        ),
                    })
                elif drop_pct > MISMATCH_WARNING_PCT:
                    anomalies.append({
                        "inverterId": f"INV {inv_id}",
                        "mpptId": mppt_id,
                        "stringId": str_id,
                        "type": "MISMATCH",
                        "severity": "warning",
                        "currentDrop_pct": round(drop_pct, 1),
                        "detectedAt": datetime.now().strftime("%Y-%m-%d"),
                        "description": (
                            f"String current {drop_pct:.1f}% below MPPT peer average "
                            f"({mean_cur:.2f}A vs {mppt_peer_avg:.2f}A)"
                        ),
                    })

            # --- DEGRADATION (trend) detection ---
            # We need a timestamp column for the trend; use the df_day "timestamp" string
            vals = string_series.get(s)
            if vals is None or vals.len() < 10:
                continue

            # Build a simple daily mean time-series using date from df_day
            if "timestamp" not in df_day.columns:
                continue

            col = build_col_name(prefix, inv_id, f"Input_current_{s:02d} (A)")
            irr_col_name = irradiance_col(prefix)

            # Build a lightweight sub-df for trend: date, normalised current
            sub_cols = ["timestamp", col]
            if irr_col_name in df_day.columns:
                sub_cols.append(irr_col_name)

            sub = df_day.select([c for c in sub_cols if c in df_day.columns])

            # Irradiance-normalise current (A per W/m²) to remove seasonal effect
            if irr_col_name in sub.columns:
                sub = sub.with_columns(
                    (pl.col(col) / pl.col(irr_col_name).clip(lower_bound=1e-3)).alias("norm_cur")
                )
                cur_col_trend = "norm_cur"
            else:
                cur_col_trend = col

            # Parse date from timestamp string (YYYY.MM.DD)
            sub = sub.with_columns(
                pl.col("timestamp").str.slice(0, 10).str.replace_all(r"\.", "-").alias("date")
            )

            daily = (
                sub.group_by("date")
                .agg(pl.col(cur_col_trend).drop_nulls().mean().alias("mean_norm"))
                .sort("date")
            )

            if daily.height < 5:
                continue

            means = daily["mean_norm"].to_list()
            n = len(means)
            if n < 2:
                continue

            # Simple linear regression (OLS) in index space
            x_mean = (n - 1) / 2.0
            y_mean = sum(means) / n
            ss_xx = sum((i - x_mean) ** 2 for i in range(n))
            ss_xy = sum((i - x_mean) * (means[i] - y_mean) for i in range(n))
            slope_per_day = ss_xy / ss_xx if ss_xx != 0 else 0.0

            # Convert to % per month (30 days) relative to mean
            if y_mean > 1e-6:
                slope_pct_per_month = (slope_per_day * 30.0 / y_mean) * 100.0
            else:
                continue

            # Negative slope = degradation
            if slope_pct_per_month < -DEGRADATION_WARN_PCT_PER_MONTH:
                anomalies.append({
                    "inverterId": f"INV {inv_id}",
                    "mpptId": mppt_id,
                    "stringId": str_id,
                    "type": "DEGRADATION",
                    "severity": "warning",
                    "currentDrop_pct": round(abs(slope_pct_per_month), 2),
                    "detectedAt": datetime.now().strftime("%Y-%m-%d"),
                    "description": (
                        f"Irradiance-normalised string current declining at "
                        f"{abs(slope_pct_per_month):.2f}%/month over {n} days"
                    ),
                })
            elif slope_pct_per_month < -DEGRADATION_INFO_PCT_PER_MONTH:
                anomalies.append({
                    "inverterId": f"INV {inv_id}",
                    "mpptId": mppt_id,
                    "stringId": str_id,
                    "type": "DEGRADATION",
                    "severity": "info",
                    "currentDrop_pct": round(abs(slope_pct_per_month), 2),
                    "detectedAt": datetime.now().strftime("%Y-%m-%d"),
                    "description": (
                        f"Mild irradiance-normalised current decline: "
                        f"{abs(slope_pct_per_month):.2f}%/month over {n} days"
                    ),
                })

    return anomalies


# ---------------------------------------------------------------------------
# Plant processor
# ---------------------------------------------------------------------------

def process_plant(plant_id: str, cfg: dict) -> None:
    log.info("=" * 60)
    log.info("Processing plant: %s", plant_id)
    log.info("=" * 60)

    parquet_path = SCADA_ROOT / plant_id / f"{plant_id}_cleaned.parquet"
    if not parquet_path.exists():
        log.error("Parquet not found: %s", parquet_path)
        return

    prefix = cfg["prefix"]
    irr_col = irradiance_col(prefix)

    # --- Load and filter data ---
    df_day, latest_ts_str = load_and_filter_recent(parquet_path, irr_col)

    # Determine last timestamp for snapshot field
    last_timestamp_iso = parse_timestamp(latest_ts_str).strftime("%Y-%m-%dT%H:%M:00Z")
    generated_at = datetime.now().strftime("%Y-%m-%dT%H:%M:00Z")

    # --- Discover inverter IDs ---
    inv_ids = detect_inverter_ids(df_day.columns, prefix)
    if not inv_ids:
        # Try from the full file
        df_meta = pl.read_parquet(parquet_path, n_rows=1)
        inv_ids = detect_inverter_ids(df_meta.columns, prefix)

    log.info("Found %d inverters", len(inv_ids))

    # --- Output directories ---
    out_dir = OUTPUT_ROOT / plant_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # -----------------------------------------------------------------------
    # Build mppt_string_data.json
    # -----------------------------------------------------------------------
    log.info("Building MPPT snapshot data ...")
    inverters_snapshot: dict[str, dict] = {}

    for idx, inv_id in enumerate(inv_ids):
        if idx % 30 == 0:
            log.info("  Inverter %d / %d ...", idx + 1, len(inv_ids))

        group_id = f"PV-{inv_id.split('.')[0]}"
        mppts, summary = compute_mppt_snapshot(df_day, prefix, inv_id, cfg)

        inverters_snapshot[f"INV {inv_id}"] = {
            "inverterId": f"INV {inv_id}",
            "groupId": group_id,
            "model": cfg["inverter_model"],
            "nominalPower_kW": cfg["nominal_power_kw"],
            "timestamp": last_timestamp_iso,
            "mppts": mppts,
            "summary": summary,
        }

    mppt_data = {
        "plantId": plant_id,
        "generatedAt": generated_at,
        "inverterModel": cfg["inverter_model"],
        "mpptCount": cfg["mppt_count"],
        "stringsPerMppt": cfg["strings_per_mppt"],
        "inverters": inverters_snapshot,
    }

    mppt_out = out_dir / "mppt_string_data.json"
    with open(mppt_out, "w") as f:
        json.dump(mppt_data, f, indent=2)

    log.info("Wrote %s", mppt_out)

    # -----------------------------------------------------------------------
    # Build string_anomalies.json
    # -----------------------------------------------------------------------
    log.info("Running anomaly detection ...")
    all_anomalies: list[dict] = []

    for idx, inv_id in enumerate(inv_ids):
        if idx % 30 == 0:
            log.info("  Inverter %d / %d ...", idx + 1, len(inv_ids))

        anomalies = detect_anomalies(df_day, prefix, inv_id, cfg)
        all_anomalies.extend(anomalies)

    # Build summary counts
    # Count unique affected strings (a string may have multiple anomaly types)
    total_strings = len(inv_ids) * cfg["strings_per_inverter"]
    affected_string_keys = set(
        (a["inverterId"], a["mpptId"], a["stringId"]) for a in all_anomalies
    )
    unique_anomaly_strings = len(affected_string_keys)
    normal_count = max(0, total_strings - unique_anomaly_strings)

    # anomalyCount reflects unique strings with at least one anomaly
    anomaly_count = unique_anomaly_strings

    by_type: dict[str, int] = {}
    for a in all_anomalies:
        by_type[a["type"]] = by_type.get(a["type"], 0) + 1

    anomalies_data = {
        "plantId": plant_id,
        "generatedAt": generated_at,
        "anomalies": all_anomalies,
        "summary": {
            "totalStrings": total_strings,
            "normalCount": max(0, normal_count),
            "anomalyCount": anomaly_count,
            "byType": by_type,
        },
    }

    anomalies_out = out_dir / "string_anomalies.json"
    with open(anomalies_out, "w") as f:
        json.dump(anomalies_data, f, indent=2)

    log.info("Wrote %s", anomalies_out)

    # -----------------------------------------------------------------------
    # Print summary stats
    # -----------------------------------------------------------------------
    inv_summaries = inverters_snapshot.values()
    healthy_inv = sum(1 for i in inv_summaries if i["summary"]["overallStatus"] == "healthy")
    degraded_inv = sum(1 for i in inv_summaries if i["summary"]["overallStatus"] == "degraded")
    faulted_inv = sum(1 for i in inv_summaries if i["summary"]["overallStatus"] == "faulted")
    total_plant_power = sum(i["summary"]["totalPower_kW"] for i in inv_summaries)

    log.info("-" * 50)
    log.info("SUMMARY: %s", plant_id.upper())
    log.info("  Inverters: %d total | %d healthy | %d degraded | %d faulted",
             len(inv_ids), healthy_inv, degraded_inv, faulted_inv)
    log.info("  Total plant power (30-day avg daytime): %.1f kW", total_plant_power)
    log.info("  Total strings: %d | Strings with anomalies: %d | Total anomaly events: %d",
             total_strings, anomaly_count, len(all_anomalies))
    log.info("  Anomaly breakdown: %s", by_type)
    log.info("  Output: %s", out_dir.resolve())


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    start = datetime.now()

    for plant_id, cfg in PLANTS.items():
        try:
            process_plant(plant_id, cfg)
        except Exception as exc:
            log.exception("Failed to process plant %s: %s", plant_id, exc)

    elapsed = (datetime.now() - start).total_seconds()
    log.info("Done. Total elapsed: %.1f s", elapsed)


if __name__ == "__main__":
    main()
