#!/usr/bin/env python3
"""
Train Multi-Signal Digital Twins for All Plants

Uses the new NormalDataFilter for unified training data selection.
Trains temperature, DC current, and DC voltage twins per inverter.

Usage:
    # Train all plants
    python scripts/train_multi_signal_twins.py

    # Train specific plant
    python scripts/train_multi_signal_twins.py --plant alpha

    # Train subset of inverters (for testing)
    python scripts/train_multi_signal_twins.py --plant alpha --max-inverters 5

    # Verbose output
    python scripts/train_multi_signal_twins.py --plant alpha --verbose
"""

import argparse
import json
import logging
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Any, Optional

import yaml
import polars as pl

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.digitaltwin.multi_signal_twin import (
    MultiSignalTwinFactory,
    DCCurrentTwin,
    DCVoltageTwin,
    FilterConfig,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def load_plant_config(config_path: Path) -> Dict[str, Any]:
    """Load plant configuration from YAML file."""
    with open(config_path) as f:
        return yaml.safe_load(f)


def get_inverter_list(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract flat list of inverters from config."""
    inverters = []
    if "components" in config and "groups" in config["components"]:
        for group in config["components"]["groups"]:
            for inv in group.get("inverters", []):
                inverters.append({
                    "inverter_id": inv["inverter_id"],
                    "nominal_kw": inv.get("nominal_kw", 60),
                    "group_id": group["group_id"],
                })
    return inverters


def detect_inverters_from_data(df: pl.DataFrame, pattern: str) -> List[str]:
    """Detect inverters from column names using pattern."""
    inverters = set()
    for col in df.columns:
        match = re.search(pattern, col)
        if match:
            inverters.add(match.group(1))
    return sorted(list(inverters))


def find_column_by_pattern(df: pl.DataFrame, pattern: str) -> Optional[str]:
    """Find a column matching a pattern (handles unit variations)."""
    import re
    # Escape regex special chars except those we use as placeholders
    pattern_regex = re.escape(pattern).replace(r"\{", "{").replace(r"\}", "}")
    pattern_regex = pattern_regex.replace("{inv}", r"[^/]+")
    pattern_regex = pattern_regex.replace("{ch:02d}", r"\d+")
    pattern_regex = pattern_regex.replace("{ch}", r"\d+")

    for col in df.columns:
        if re.search(pattern_regex, col):
            return col
    return None


def build_column_names(
    config: Dict[str, Any],
    inverter_id: str,
    df: Optional[pl.DataFrame] = None,
) -> Dict[str, Any]:
    """Build column names for an inverter based on config patterns."""
    patterns = config.get("data", {}).get("patterns", {})
    plant_name = config.get("plant_name", "")

    # Power column - search in df for exact match
    power_col = None
    power_pattern = patterns.get("inverter_power", "")
    if power_pattern and df is not None:
        base_pattern = power_pattern.replace("\\(", "(").replace("\\)", ")").replace("{inv}", inverter_id)
        # Search for columns containing this pattern
        for col in df.columns:
            if base_pattern in col or (inverter_id in col and "Power Normalized" in col):
                power_col = col
                break

    # Temperature column - search with flexible encoding
    temp_col = None
    temp_pattern = patterns.get("inverter_temp", "")
    if temp_pattern and df is not None:
        for col in df.columns:
            if inverter_id in col and "Temperature" in col:
                temp_col = col
                break

    # DC Current columns - search by pattern
    dc_channels = config.get("data", {}).get("dc_channels", 12)
    mppt_channels = config.get("data", {}).get("mppt_channels", 0)

    current_cols = []
    if df is not None:
        # Search for Input_current_XX pattern
        for ch in range(1, dc_channels + 1):
            for col in df.columns:
                if inverter_id in col and f"Input_current_{ch:02d}" in col:
                    current_cols.append(col)
                    break
        # Also check I_MPPT pattern
        if not current_cols and mppt_channels > 0:
            for ch in range(1, mppt_channels + 1):
                for col in df.columns:
                    if inverter_id in col and f"I_MPPT_{ch}" in col:
                        current_cols.append(col)
                        break

    # DC Voltage columns - search by pattern
    voltage_cols = []
    if df is not None:
        n_voltage = mppt_channels if mppt_channels > 0 else dc_channels
        for ch in range(1, n_voltage + 1):
            for col in df.columns:
                if inverter_id in col and (f"U_DC_{ch} " in col or f"U_DC_{ch}(" in col or f"U_MPPT_{ch}" in col):
                    voltage_cols.append(col)
                    break

    return {
        "power": power_col,
        "temperature": temp_col,
        "current_cols": current_cols,
        "voltage_cols": voltage_cols,
    }


def train_plant_twins(
    config_path: Path,
    output_dir: Path,
    max_inverters: Optional[int] = None,
    verbose: bool = True,
) -> Dict[str, Any]:
    """
    Train multi-signal twins for all inverters in a plant.

    Args:
        config_path: Path to plant YAML config
        output_dir: Output directory for models
        max_inverters: Limit number of inverters (for testing)
        verbose: Print progress

    Returns:
        Training results summary
    """
    # Load config
    config = load_plant_config(config_path)
    plant_id = config.get("plant_id", config_path.stem)
    plant_name = config.get("plant_name", plant_id)

    logger.info(f"Training multi-signal twins for {plant_name}")

    # Load data
    data_path = Path(config["data"]["source_path"])
    if not data_path.exists():
        logger.error(f"Data file not found: {data_path}")
        return {"error": f"Data file not found: {data_path}"}

    logger.info(f"Loading data from {data_path}")
    df = pl.read_parquet(data_path)
    logger.info(f"Loaded {len(df):,} rows, {len(df.columns):,} columns")

    # Parse timestamp and sort for monotonic index (required by NormalDataFilter)
    ts_col = config["data"].get("timestamp_column", "timestamp")
    ts_format = config["data"].get("timestamp_format", "%Y.%m.%d %H:%M")

    if ts_col in df.columns:
        if df[ts_col].dtype == pl.Utf8:
            df = df.with_columns(
                pl.col(ts_col).str.strptime(pl.Datetime, ts_format).alias("timestamp")
            )
        elif df[ts_col].dtype != pl.Datetime:
            df = df.with_columns(pl.col(ts_col).cast(pl.Datetime).alias("timestamp"))

    # Sort by timestamp for monotonic index (required by rolling operations)
    if "timestamp" in df.columns:
        df = df.sort("timestamp")
        logger.info("Sorted data by timestamp")

    # Get environmental columns
    columns = config["data"].get("columns", {})
    irradiance_col = columns.get("irradiance", "irradiance")
    ambient_temp_col = columns.get("ambient_temp", "ambient_temp")
    module_temp_col = columns.get("module_temp")

    # Helper to find column by partial match (handles encoding variations)
    def find_column(df, col_name):
        if not col_name:
            return None
        if col_name in df.columns:
            return col_name
        # Try matching without unit suffix (handle encoding issues)
        base_name = col_name.split("(")[0].strip() if "(" in col_name else col_name
        for c in df.columns:
            if base_name in c:
                return c
        return None

    # Find actual column names (handles encoding variations like °C vs ())
    actual_irradiance = find_column(df, irradiance_col)
    actual_ambient = find_column(df, ambient_temp_col)
    actual_module = find_column(df, module_temp_col)

    # Rename columns if needed
    rename_map = {}
    if actual_irradiance and actual_irradiance != "irradiance":
        rename_map[actual_irradiance] = "irradiance"
    if actual_ambient and actual_ambient != "ambient_temp":
        rename_map[actual_ambient] = "ambient_temp"
    if actual_module and actual_module != "module_temp":
        rename_map[actual_module] = "module_temp"

    if rename_map:
        df = df.rename(rename_map)
        logger.info(f"Renamed columns: {rename_map}")

    # If no ambient_temp found, try to use module_temp as fallback
    if "ambient_temp" not in df.columns and "module_temp" in df.columns:
        df = df.with_columns(pl.col("module_temp").alias("ambient_temp"))
        logger.info("Using module_temp as ambient_temp fallback")

    # Verify irradiance data after renaming
    if "irradiance" in df.columns:
        irr = df["irradiance"]
        daytime_count = df.filter(pl.col("irradiance") > 50).height
        logger.info(f"Irradiance column stats: min={irr.min()}, max={irr.max()}, daytime_rows={daytime_count:,}")

    # Get inverter list
    inverters = get_inverter_list(config)
    if not inverters:
        # Try to detect from data
        inv_pattern = config["data"].get("inverter_pattern", "")
        if inv_pattern:
            inv_ids = detect_inverters_from_data(df, inv_pattern)
            inverters = [{"inverter_id": inv_id, "nominal_kw": 60, "group_id": ""} for inv_id in inv_ids]

    if not inverters:
        logger.error("No inverters found in config or data")
        return {"error": "No inverters found"}

    logger.info(f"Found {len(inverters)} inverters")

    if max_inverters:
        inverters = inverters[:max_inverters]
        logger.info(f"Limited to {len(inverters)} inverters for testing")

    # Create output directory
    plant_output_dir = output_dir / plant_id
    plant_output_dir.mkdir(parents=True, exist_ok=True)

    # Training results
    results = {
        "plant_id": plant_id,
        "plant_name": plant_name,
        "n_inverters": len(inverters),
        "training_start": datetime.now().isoformat(),
        "inverter_results": {},
        "summary": {
            "successful": 0,
            "failed": 0,
            "avg_retention_ratio": 0.0,
            "avg_temp_r2": 0.0,
            "avg_current_r2": 0.0,
            "avg_voltage_r2": 0.0,
        }
    }

    retention_ratios = []
    temp_r2s = []
    current_r2s = []
    voltage_r2s = []

    # Train each inverter
    for i, inv_info in enumerate(inverters):
        inverter_id = inv_info["inverter_id"]
        nominal_kw = inv_info["nominal_kw"]

        if verbose:
            print(f"\n{'='*60}")
            print(f"[{i+1}/{len(inverters)}] Training {inverter_id} ({nominal_kw} kW)")
            print(f"{'='*60}")

        try:
            # Build column names (pass df for pattern matching)
            cols = build_column_names(config, inverter_id, df=df)

            # Check which columns exist
            power_col = cols["power"] if cols["power"] in df.columns else None
            temp_col = cols["temperature"] if cols["temperature"] and cols["temperature"] in df.columns else None
            current_cols = [c for c in cols["current_cols"] if c in df.columns]
            voltage_cols = [c for c in cols["voltage_cols"] if c in df.columns]

            # Auto-detect if pattern-based columns not found
            if not current_cols:
                current_cols = DCCurrentTwin.detect_current_columns(df, inverter_id)
            if not voltage_cols:
                voltage_cols = DCVoltageTwin.detect_voltage_columns(df, inverter_id)

            # Detect if power is normalized (kW/kWp)
            power_is_normalized = power_col and ("Normalized" in power_col or "kWp" in power_col)

            if verbose:
                print(f"  Power col: {power_col is not None} (normalized: {power_is_normalized})")
                print(f"  Temp col: {temp_col is not None}")
                print(f"  Current cols: {len(current_cols)}")
                print(f"  Voltage cols: {len(voltage_cols)}")

            if not power_col and not current_cols:
                logger.warning(f"No data columns found for {inverter_id}, skipping")
                results["inverter_results"][inverter_id] = {"error": "No data columns found"}
                results["summary"]["failed"] += 1
                continue

            # For normalized power (kW/kWp), use p_rated=1.0 for correct PR calculation
            # For absolute power (kW), use actual p_rated
            filter_p_rated = 1.0 if power_is_normalized else nominal_kw

            # Create factory with NormalDataFilter
            factory = MultiSignalTwinFactory(
                inverter_id=inverter_id,
                n_dc_channels=len(current_cols) if current_cols else 12,
                p_rated=filter_p_rated,
                filter_config=FilterConfig(
                    min_irradiance=50.0,
                    pr_min=0.5,
                    pr_max=1.15,
                ),
                use_normal_filter=True,
            )

            # Train
            start_time = time.time()
            metrics = factory.train(
                df,
                temp_col=temp_col or "inverter_temp",
                current_cols=current_cols if current_cols else None,
                voltage_cols=voltage_cols if voltage_cols else None,
                power_col=power_col,
                irradiance_col="irradiance",
                ambient_temp_col="ambient_temp",
                apply_variability_filter=True,
                apply_clustering_filter=False,
                verbose=verbose,
            )
            train_time = time.time() - start_time

            # Save model
            factory.save(plant_output_dir)

            # Collect results
            inv_result = {
                "training_time_s": train_time,
                "filter": metrics.get("filter", {}),
            }

            if metrics.get("filter"):
                retention_ratios.append(metrics["filter"]["retention_ratio"])

            if "temperature" in metrics:
                inv_result["temperature"] = {
                    "mae": metrics["temperature"].mae,
                    "r2": metrics["temperature"].r2,
                }
                temp_r2s.append(metrics["temperature"].r2)

            if "current" in metrics:
                inv_result["current"] = {
                    "mae": metrics["current"].mae,
                    "r2": metrics["current"].r2,
                }
                current_r2s.append(metrics["current"].r2)

            if "voltage" in metrics:
                inv_result["voltage"] = {
                    "mae": metrics["voltage"].mae,
                    "r2": metrics["voltage"].r2,
                }
                voltage_r2s.append(metrics["voltage"].r2)

            results["inverter_results"][inverter_id] = inv_result
            results["summary"]["successful"] += 1

            if verbose:
                print(f"\n  ✓ Training complete in {train_time:.1f}s")
                if factory.filter_result:
                    print(f"  ✓ Data retention: {factory.filter_result.retention_ratio:.1%}")

        except Exception as e:
            logger.error(f"Failed to train {inverter_id}: {e}")
            results["inverter_results"][inverter_id] = {"error": str(e)}
            results["summary"]["failed"] += 1

    # Calculate summary statistics
    results["training_end"] = datetime.now().isoformat()
    if retention_ratios:
        results["summary"]["avg_retention_ratio"] = sum(retention_ratios) / len(retention_ratios)
    if temp_r2s:
        results["summary"]["avg_temp_r2"] = sum(temp_r2s) / len(temp_r2s)
    if current_r2s:
        results["summary"]["avg_current_r2"] = sum(current_r2s) / len(current_r2s)
    if voltage_r2s:
        results["summary"]["avg_voltage_r2"] = sum(voltage_r2s) / len(voltage_r2s)

    # Save results
    results_path = plant_output_dir / "training_results.json"
    with open(results_path, "w") as f:
        json.dump(results, f, indent=2, default=str)

    logger.info(f"Results saved to {results_path}")

    # Print summary
    print(f"\n{'='*60}")
    print(f"Training Summary for {plant_name}")
    print(f"{'='*60}")
    print(f"  Inverters: {results['summary']['successful']} successful, {results['summary']['failed']} failed")
    print(f"  Avg data retention: {results['summary']['avg_retention_ratio']:.1%}")
    if temp_r2s:
        print(f"  Avg temp R²: {results['summary']['avg_temp_r2']:.3f}")
    if current_r2s:
        print(f"  Avg current R²: {results['summary']['avg_current_r2']:.3f}")
    if voltage_r2s:
        print(f"  Avg voltage R²: {results['summary']['avg_voltage_r2']:.3f}")
    print(f"  Models saved to: {plant_output_dir}")

    return results


def main():
    parser = argparse.ArgumentParser(description="Train multi-signal digital twins")
    parser.add_argument(
        "--plant",
        type=str,
        default=None,
        help="Plant ID to train (default: all plants)",
    )
    parser.add_argument(
        "--max-inverters",
        type=int,
        default=None,
        help="Maximum inverters per plant (for testing)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="public/data/digitaltwin",
        help="Output directory for models",
    )
    parser.add_argument(
        "--config-dir",
        type=str,
        default="backenddata/configs/plants",
        help="Directory containing plant YAML configs",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Verbose output",
    )
    args = parser.parse_args()

    config_dir = Path(args.config_dir)
    output_dir = Path(args.output_dir)

    # Find plant configs
    if args.plant:
        config_path = config_dir / f"{args.plant}.yaml"
        if not config_path.exists():
            logger.error(f"Config not found: {config_path}")
            sys.exit(1)
        config_paths = [config_path]
    else:
        config_paths = sorted(config_dir.glob("*.yaml"))
        # Skip template
        config_paths = [p for p in config_paths if not p.name.startswith("_")]

    logger.info(f"Found {len(config_paths)} plant configs")

    # Train each plant
    all_results = {}
    for config_path in config_paths:
        plant_id = config_path.stem
        logger.info(f"\n{'#'*60}")
        logger.info(f"# Training {plant_id}")
        logger.info(f"{'#'*60}")

        try:
            results = train_plant_twins(
                config_path=config_path,
                output_dir=output_dir,
                max_inverters=args.max_inverters,
                verbose=args.verbose,
            )
            all_results[plant_id] = results
        except Exception as e:
            logger.error(f"Failed to train {plant_id}: {e}")
            all_results[plant_id] = {"error": str(e)}

    # Save overall results
    overall_results_path = output_dir / "all_plants_training_results.json"
    with open(overall_results_path, "w") as f:
        json.dump(all_results, f, indent=2, default=str)

    logger.info(f"\nOverall results saved to {overall_results_path}")


if __name__ == "__main__":
    main()
