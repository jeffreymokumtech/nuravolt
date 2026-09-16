#!/usr/bin/env python3
"""
CLI for Zone Analysis API.

This script is called by Next.js API routes to run zone analysis.
Communication is via stdin (JSON input) and stdout (JSON output).

Commands:
- detect_zones: Auto-detect zones for a plant
- get_zones: Get zone configuration for a plant
- analyze_zones: Run zone-level soiling analysis
- get_zone_performance: Get zone performance metrics
"""

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from dataclasses import asdict

import pandas as pd

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.soiling.quality.zone_detection import (
    ZoneDetector,
    ZoneAnalyzer,
    SoilingZone,
    detect_and_analyze_zones,
    DEFAULT_ZONE_PATTERNS,
)


# Data directory
DATA_DIR = project_root / "public" / "data" / "soiling"


def load_plant_sr_data(plant_id: str) -> pd.DataFrame:
    """Load soiling ratio data for a plant."""
    # Try per-inverter SR file
    sr_file = DATA_DIR / plant_id / "per_inverter_sr.json"
    if sr_file.exists():
        with open(sr_file) as f:
            data = json.load(f)
        return pd.DataFrame(data.get('daily_sr', []))

    # Try DustIQ history
    dustiq_file = DATA_DIR / plant_id / "dustiq_history.json"
    if dustiq_file.exists():
        with open(dustiq_file) as f:
            data = json.load(f)
        return pd.DataFrame(data.get('data', []))

    return pd.DataFrame()


def get_inverter_columns(plant_id: str) -> list:
    """Get list of inverter columns for a plant."""
    # Try per-inverter data
    inv_file = DATA_DIR / plant_id / "per_inverter_analysis.json"
    if inv_file.exists():
        with open(inv_file) as f:
            data = json.load(f)
        inverters = data.get('inverter_metrics', [])
        return [inv.get('inverterId', '') for inv in inverters]

    # Fall back to generating from known patterns
    if plant_id in DEFAULT_ZONE_PATTERNS:
        patterns = DEFAULT_ZONE_PATTERNS[plant_id]
        # Generate sample names
        inverters = []
        for i, pat in enumerate(patterns):
            for j in range(1, 10):
                inverters.append(f"INV {i+1:02d}.{j:03d}")
        return inverters

    return []


def handle_detect_zones(plant_id: str, custom_patterns: list = None) -> dict:
    """Auto-detect zones for a plant."""
    try:
        # Get inverter columns
        inverters = get_inverter_columns(plant_id)
        if not inverters:
            return {
                "success": False,
                "error": f"No inverter data found for plant {plant_id}",
            }

        # Detect zones
        detector = ZoneDetector(plant_id, custom_patterns)
        zones = detector.detect_zones(inverters)

        return {
            "success": True,
            "plant_id": plant_id,
            "zones": [asdict(z) for z in zones],
            "detected_at": datetime.now().isoformat(),
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def handle_get_zones(plant_id: str) -> dict:
    """Get zone configuration for a plant."""
    # Check for saved zone config
    config_file = DATA_DIR / plant_id / "zone_config.json"
    if config_file.exists():
        with open(config_file) as f:
            return json.load(f)

    # Otherwise detect zones
    return handle_detect_zones(plant_id)


def handle_analyze_zones(
    plant_id: str,
    start_date: str = None,
    end_date: str = None,
) -> dict:
    """Run zone-level soiling analysis."""
    try:
        # Load SR data
        sr_data = load_plant_sr_data(plant_id)
        if sr_data.empty:
            return {
                "success": False,
                "error": f"No soiling data found for plant {plant_id}",
            }

        # Filter by date range
        if 'date' in sr_data.columns:
            sr_data['date'] = pd.to_datetime(sr_data['date'])
            if start_date:
                sr_data = sr_data[sr_data['date'] >= start_date]
            if end_date:
                sr_data = sr_data[sr_data['date'] <= end_date]

        # Get inverter columns (exclude date columns)
        inv_cols = [c for c in sr_data.columns
                   if c not in ['date', 'timestamp', 'Date', 'Timestamp']]

        if not inv_cols:
            return {
                "success": False,
                "error": "No inverter columns found in data",
            }

        # Run zone analysis
        result = detect_and_analyze_zones(plant_id, sr_data, inv_cols)

        return {
            "success": True,
            "plant_id": plant_id,
            "zones": [asdict(z) for z in result.zones],
            "performance": [asdict(p) for p in result.performance],
            "zone_comparison": result.zone_comparison,
            "cleaning_recommendations": result.cleaning_recommendations,
            "analyzed_at": result.analyzed_at,
            "data_period": result.data_period,
        }

    except Exception as e:
        return {"success": False, "error": str(e)}


def handle_get_zone_performance(plant_id: str) -> dict:
    """Get latest zone performance metrics."""
    # Check for cached analysis
    perf_file = DATA_DIR / plant_id / "zone_performance.json"
    if perf_file.exists():
        with open(perf_file) as f:
            cached = json.load(f)
        # Return if recent (within 24h)
        cached_at = cached.get('analyzed_at', '')
        if cached_at:
            cached_time = datetime.fromisoformat(cached_at.replace('Z', '+00:00'))
            if datetime.now() - cached_time.replace(tzinfo=None) < timedelta(hours=24):
                return cached

    # Otherwise run fresh analysis
    return handle_analyze_zones(plant_id)


def handle_save_zone_config(plant_id: str, zones: list) -> dict:
    """Save custom zone configuration."""
    try:
        config_dir = DATA_DIR / plant_id
        config_dir.mkdir(parents=True, exist_ok=True)

        config = {
            "plant_id": plant_id,
            "zones": zones,
            "saved_at": datetime.now().isoformat(),
        }

        config_file = config_dir / "zone_config.json"
        with open(config_file, 'w') as f:
            json.dump(config, f, indent=2)

        return {"success": True, "saved": True, "file": str(config_file)}

    except Exception as e:
        return {"success": False, "error": str(e)}


def main():
    """Main entry point - reads JSON from stdin, writes JSON to stdout."""
    try:
        # Read input from stdin
        input_data = json.loads(sys.stdin.read())

        command = input_data.get("command")
        plant_id = input_data.get("plant_id")

        # Route to handler
        if command == "detect_zones":
            result = handle_detect_zones(
                plant_id,
                custom_patterns=input_data.get("custom_patterns"),
            )

        elif command == "get_zones":
            result = handle_get_zones(plant_id)

        elif command == "analyze_zones":
            result = handle_analyze_zones(
                plant_id,
                start_date=input_data.get("start_date"),
                end_date=input_data.get("end_date"),
            )

        elif command == "get_zone_performance":
            result = handle_get_zone_performance(plant_id)

        elif command == "save_zone_config":
            result = handle_save_zone_config(
                plant_id,
                zones=input_data.get("zones", []),
            )

        else:
            result = {"error": f"Unknown command: {command}"}

        # Write output to stdout
        print(json.dumps(result, default=str))

    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {str(e)}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"Internal error: {str(e)}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
