#!/usr/bin/env python3
"""
Generate a lightweight transfer-learning SR time series for the frontend Data Explorer.

Reads a per-inverter predictions CSV (e.g. from two-stage transfer learning) and
aggregates it to a plant-level daily SR series.

Example:
  python scripts/generate_transfer_sr_predictions.py \\
    --target-plant alpha1 \\
    --source-plant ribera \\
    --predictions-csv outputs_two_stage_forecast/stage2_test_predictions.csv
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate transfer SR predictions JSON for the frontend.")
    parser.add_argument("--target-plant", required=True, help="Target plant id (e.g. alpha1, eta)")
    parser.add_argument("--source-plant", required=True, help="Source plant id (e.g. ribera)")
    parser.add_argument(
        "--predictions-csv",
        required=True,
        type=Path,
        help="CSV with columns including date and y_pred (or sr_pred).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output JSON path (default: public/data/soiling/<target>/transfer_sr_predictions.json)",
    )
    parser.add_argument(
        "--method",
        default="two_stage_transfer",
        help="Method label to store in JSON metadata.",
    )
    args = parser.parse_args()

    if not args.predictions_csv.exists():
        raise FileNotFoundError(f"Predictions CSV not found: {args.predictions_csv}")

    out_path = args.out or Path("public") / "data" / "soiling" / args.target_plant / "transfer_sr_predictions.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    by_date: dict[str, list[float]] = defaultdict(list)
    n_rows = 0

    with args.predictions_csv.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            n_rows += 1
            date = (row.get("date") or "").strip()
            if not date:
                continue

            y = row.get("y_pred")
            if y is None:
                y = row.get("sr_pred")
            if y is None:
                continue
            y = y.strip()
            if not y:
                continue
            try:
                by_date[date].append(float(y))
            except ValueError:
                continue

    dates = sorted(by_date.keys())
    daily_data = []
    for d in dates:
        vals = by_date[d]
        sr = sum(vals) / len(vals) if vals else None
        daily_data.append({"date": d, "sr_transfer": sr})

    payload = {
        "plant_id": args.target_plant,
        "source_plant_id": args.source_plant,
        "method": args.method,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_predictions": sum(len(v) for v in by_date.values()),
        "n_rows_read": n_rows,
        "date_range": {"start": dates[0] if dates else None, "end": dates[-1] if dates else None},
        "daily_data": daily_data,
    }

    out_path.write_text(json.dumps(payload, indent=2))
    print(f"✅ Wrote {out_path} ({len(daily_data)} days)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

