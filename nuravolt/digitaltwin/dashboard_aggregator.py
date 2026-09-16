#!/usr/bin/env python3
"""
Dashboard Data Aggregator for Digital Twin

Aggregates residuals CSV data into JSON files for frontend dashboard visualization.
Fixes:
- Week boundary normalization (consistent Monday starts)
- Nighttime vs offline detection (uses expected power, not loss_pct)

This module is called automatically after training to regenerate dashboard data.
"""

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional, Union

import polars as pl

logger = logging.getLogger(__name__)


class DashboardAggregator:
    """Aggregates residuals data for dashboard heatmaps."""

    def __init__(self, data_dir: Path, output_dir: Optional[Path] = None):
        """
        Initialize aggregator.

        Args:
            data_dir: Directory containing residuals_INV_*.parquet files
            output_dir: Output directory for JSON files (defaults to data_dir)
        """
        self.data_dir = Path(data_dir)
        self.output_dir = Path(output_dir) if output_dir else self.data_dir

    def aggregate_all(self) -> dict:
        """
        Aggregate all dashboard data files.

        Returns:
            dict with paths to generated files and statistics
        """
        results = {
            "timeline_heatmap": None,
            "pr_heatmap": None,
            "errors": [],
        }

        # Generate timeline heatmap (loss_pct)
        try:
            timeline_path = self.aggregate_timeline_heatmap()
            results["timeline_heatmap"] = str(timeline_path)
            logger.info(f"Generated timeline heatmap: {timeline_path}")
        except Exception as e:
            logger.error(f"Failed to generate timeline heatmap: {e}")
            results["errors"].append(f"timeline_heatmap: {e}")

        # Generate PR heatmap from residuals (if pr column exists)
        try:
            pr_path = self.aggregate_pr_timeline_heatmap()
            if pr_path:
                results["pr_heatmap"] = str(pr_path)
                logger.info(f"Generated PR heatmap: {pr_path}")
        except Exception as e:
            logger.error(f"Failed to generate PR heatmap: {e}")
            results["errors"].append(f"pr_heatmap: {e}")

        return results

    def aggregate_timeline_heatmap(self) -> Path:
        """
        Aggregate residuals Parquet files into timeline heatmap JSON.

        Fixes:
        - Week boundaries normalized to Monday
        - Uses expected power > 0.05 kW/kWp instead of loss_pct < 100
          to properly distinguish nighttime from offline periods
        """
        output_file = self.output_dir / "timeline_heatmap_data.json"

        # Find residuals files (prefer Parquet, fall back to CSV)
        csv_files = sorted(self.data_dir.glob("residuals_INV_*.parquet"))
        if csv_files:
            logger.info(f"Found {len(csv_files)} residuals Parquet files")
        else:
            csv_files = sorted(self.data_dir.glob("residuals_INV_*.csv"))
            logger.info(f"Found {len(csv_files)} residuals CSV files")

        if len(csv_files) == 0:
            raise FileNotFoundError(f"No residuals files found in {self.data_dir} (expected residuals_INV_*.parquet or .csv)")

        # Aggregate daily and weekly
        daily_data = self._aggregate_loss_pct(csv_files, "daily")
        weekly_data = self._aggregate_loss_pct(csv_files, "weekly")

        if daily_data is None or weekly_data is None:
            raise RuntimeError("Aggregation failed")

        # Combine into single output
        output = {
            "daily": daily_data,
            "weekly": weekly_data,
        }

        # Write JSON
        self.output_dir.mkdir(parents=True, exist_ok=True)
        with open(output_file, "w") as f:
            json.dump(output, f, indent=2)

        file_size_mb = output_file.stat().st_size / (1024 * 1024)
        logger.info(
            f"Timeline heatmap: {daily_data['metadata']['total_dates']} days, "
            f"{weekly_data['metadata']['total_dates']} weeks, {file_size_mb:.2f} MB"
        )

        return output_file

    def aggregate_pr_timeline_heatmap(self) -> Optional[Path]:
        """
        Aggregate PR data from residuals Parquet files into PR timeline heatmap JSON.

        Only generates if 'pr' column exists in residuals Parquet files.
        """
        output_file = self.output_dir / "pr_timeline_heatmap.json"

        # Find residuals files (prefer Parquet, fall back to CSV)
        csv_files = sorted(self.data_dir.glob("residuals_INV_*.parquet"))
        if not csv_files:
            csv_files = sorted(self.data_dir.glob("residuals_INV_*.csv"))

        if len(csv_files) == 0:
            return None

        # PR can be either present as a column or derived from actual/expected.
        first_df = pl.read_parquet(csv_files[0]) if csv_files[0].suffix == ".parquet" else pl.read_csv(csv_files[0])
        has_pr = "pr" in first_df.columns
        has_actual_expected = ("actual" in first_df.columns) and ("expected" in first_df.columns)
        if not has_pr and not has_actual_expected:
            logger.info("No PR (or actual/expected) columns in residuals - skipping PR heatmap")
            return None

        # Aggregate daily and weekly
        daily_data = self._aggregate_pr(csv_files, "daily")
        weekly_data = self._aggregate_pr(csv_files, "weekly")

        if daily_data is None or weekly_data is None:
            return None

        # Combine into single output
        output = {
            "daily": daily_data,
            "weekly": weekly_data,
        }

        # Write JSON
        with open(output_file, "w") as f:
            json.dump(output, f, indent=2)

        file_size_mb = output_file.stat().st_size / (1024 * 1024)
        logger.info(
            f"PR heatmap: {daily_data['metadata']['total_dates']} days, "
            f"{weekly_data['metadata']['total_dates']} weeks, {file_size_mb:.2f} MB"
        )

        return output_file

    def _aggregate_loss_pct(
        self, csv_files: list[Path], aggregation: str
    ) -> Optional[dict]:
        """Aggregate loss_pct from all inverter CSVs."""
        logger.info(f"Aggregating {aggregation} loss_pct data...")

        all_dates = set()
        inverter_data = {}

        for i, csv_path in enumerate(csv_files, 1):
            # Extract inverter ID: residuals_INV_01_001.parquet -> INV 01.001
            parts = csv_path.stem.replace("residuals_INV_", "").split("_")
            if len(parts) == 2:
                inv_id = f"INV {parts[0]}.{parts[1]}"
            else:
                logger.warning(f"Could not parse inverter ID from {csv_path.name}")
                continue

            # Load and aggregate
            agg_df = self._load_and_aggregate_loss(csv_path, aggregation)

            if agg_df is None or len(agg_df) == 0:
                logger.warning(f"No data for {inv_id}")
                continue

            # Convert to dict (handle null values from mean)
            inv_dict = {}
            for row in agg_df.iter_rows(named=True):
                date_str = str(row["date"])
                avg_val = row["avg_loss_pct"]
                if avg_val is not None:
                    all_dates.add(date_str)
                    inv_dict[date_str] = round(avg_val, 2)

            inverter_data[inv_id] = inv_dict

            if i % 25 == 0:
                logger.info(f"Processed {i}/{len(csv_files)} inverters...")

        return self._build_matrix_output(
            all_dates, inverter_data, aggregation, "loss_pct"
        )

    def _aggregate_pr(self, csv_files: list[Path], aggregation: str) -> Optional[dict]:
        """Aggregate PR from all inverter CSVs."""
        logger.info(f"Aggregating {aggregation} PR data...")

        all_dates = set()
        inverter_data = {}

        for i, csv_path in enumerate(csv_files, 1):
            # Extract inverter ID
            parts = csv_path.stem.replace("residuals_INV_", "").split("_")
            if len(parts) == 2:
                inv_id = f"INV {parts[0]}.{parts[1]}"
            else:
                continue

            # Load and aggregate PR
            agg_df = self._load_and_aggregate_pr(csv_path, aggregation)

            if agg_df is None or len(agg_df) == 0:
                continue

            # Convert to dict (PR as percentage, handle null values)
            inv_dict = {}
            for row in agg_df.iter_rows(named=True):
                date_str = str(row["date"])
                avg_val = row["avg_pr"]
                if avg_val is not None:
                    all_dates.add(date_str)
                    inv_dict[date_str] = round(avg_val * 100, 2)

            inverter_data[inv_id] = inv_dict

            if i % 25 == 0:
                logger.info(f"Processed {i}/{len(csv_files)} inverters...")

        return self._build_matrix_output(
            all_dates, inverter_data, aggregation, "performance_ratio"
        )

    def _load_and_aggregate_loss(
        self, csv_path: Path, aggregation: str
    ) -> Optional[pl.DataFrame]:
        """
        Load single inverter Parquet and aggregate loss_pct.

        PREDICTION-SIDE FILTER: Only filter by irradiance > 0 (daylight hours).
        This is the minimal filter needed to exclude nighttime data.
        Training-side filters (in normal_data_filter.py) are more restrictive.
        """
        try:
            df = pl.read_parquet(csv_path) if csv_path.suffix == ".parquet" else pl.read_csv(csv_path, try_parse_dates=True)

            # Parse timestamp (support both string and datetime typed columns)
            if df.schema.get("timestamp") == pl.Datetime:
                df = df.with_columns(pl.col("timestamp").alias("datetime"))
            else:
                df = df.with_columns(
                    pl.col("timestamp")
                    .cast(pl.Utf8)
                    .str.to_datetime("%Y-%m-%d %H:%M:%S", strict=False)
                    .alias("datetime")
                )

            # PREDICTION-SIDE: Minimal filter - only exclude nighttime (irradiance = 0)
            # This keeps ALL daytime data including:
            # - Offline/fault periods (loss_pct = 100%)
            # - Low performance periods
            # - Sensor issues (for visibility in dashboard)
            if "irradiance" in df.columns:
                df = df.filter(pl.col("irradiance") > 0)
            elif "expected" in df.columns:
                # Fallback: use expected > 0 if no irradiance column
                df = df.filter(pl.col("expected") > 0)
            else:
                # Last resort: use loss_pct < 100 (excludes nighttime)
                df = df.filter(pl.col("loss_pct") < 100.0)

            if len(df) == 0:
                return None

            # Build aggregation
            return self._apply_aggregation(df, "loss_pct", "avg_loss_pct", aggregation)

        except Exception as e:
            logger.error(f"Error processing {csv_path.name}: {e}")
            return None

    def _load_and_aggregate_pr(
        self, csv_path: Path, aggregation: str
    ) -> Optional[pl.DataFrame]:
        """
        Load single inverter Parquet and aggregate PR.

        PREDICTION-SIDE FILTER: Only filter by irradiance > 0 (daylight hours).
        PR bounds (0-1.5) are kept as sanity checks for unrealistic values.
        """
        try:
            df = pl.read_parquet(csv_path) if csv_path.suffix == ".parquet" else pl.read_csv(csv_path, try_parse_dates=True)

            # Derive PR if needed (PR = actual/expected when expected > 0)
            if "pr" not in df.columns:
                if "actual" not in df.columns or "expected" not in df.columns:
                    return None
                df = df.with_columns(
                    pl.when(pl.col("expected") > 0)
                    .then(pl.col("actual") / pl.col("expected"))
                    .otherwise(None)
                    .alias("pr")
                )

            # Parse timestamp (support both string and datetime typed columns)
            if df.schema.get("timestamp") == pl.Datetime:
                df = df.with_columns(pl.col("timestamp").alias("datetime"))
            else:
                df = df.with_columns(
                    pl.col("timestamp")
                    .cast(pl.Utf8)
                    .str.to_datetime("%Y-%m-%d %H:%M:%S", strict=False)
                    .alias("datetime")
                )

            # PREDICTION-SIDE: Minimal filter - only exclude nighttime (irradiance = 0)
            # Keep basic PR sanity bounds (0-1.5) to filter out calculation errors
            if "irradiance" in df.columns:
                df = df.filter(
                    (pl.col("irradiance") > 0)
                    & (pl.col("pr").is_not_null())
                    & (pl.col("pr") >= 0)
                    & (pl.col("pr") < 1.5)  # Sanity check for unrealistic PR > 150%
                )
            elif "expected" in df.columns:
                # Fallback: use expected > 0 if no irradiance column
                df = df.filter(
                    (pl.col("expected") > 0)
                    & (pl.col("pr").is_not_null())
                    & (pl.col("pr") >= 0)
                    & (pl.col("pr") < 1.5)
                )
            else:
                df = df.filter(
                    (pl.col("pr").is_not_null())
                    & (pl.col("pr") >= 0)
                    & (pl.col("pr") < 1.5)
                )

            if len(df) == 0:
                return None

            return self._apply_aggregation(df, "pr", "avg_pr", aggregation)

        except Exception as e:
            logger.error(f"Error processing PR from {csv_path.name}: {e}")
            return None

    def _apply_aggregation(
        self, df: pl.DataFrame, source_col: str, agg_col: str, aggregation: str
    ) -> pl.DataFrame:
        """
        Apply daily or weekly aggregation.

        FIX: Weekly aggregation uses truncate("1w") for consistent Monday boundaries.
        """
        agg_exprs = [
            pl.col(source_col).mean().alias(agg_col),
            pl.col(source_col).count().alias("data_points"),
        ]

        if aggregation == "daily":
            agg_df = df.group_by(pl.col("datetime").dt.date().alias("date")).agg(
                agg_exprs
            )
        elif aggregation == "weekly":
            # FIX: Use truncate("1w") for consistent Monday week boundaries
            # This ensures all inverters use the same week_start date
            agg_df = df.with_columns(
                pl.col("datetime").dt.truncate("1w").alias("week_start")
            ).group_by("week_start").agg(agg_exprs)

            # Rename week_start to date
            agg_df = agg_df.with_columns(
                pl.col("week_start").dt.date().alias("date")
            ).drop("week_start")
        else:
            raise ValueError(f"Invalid aggregation: {aggregation}")

        return agg_df.sort("date")

    def _build_matrix_output(
        self,
        all_dates: set,
        inverter_data: dict,
        aggregation: str,
        metric: str,
    ) -> Optional[dict]:
        """Build matrix output structure for frontend."""
        if not all_dates or not inverter_data:
            return None

        sorted_dates = sorted(list(all_dates))
        inverters = sorted(inverter_data.keys())

        # Build data matrix [date][inverter_idx] = value
        data_matrix = []
        for date in sorted_dates:
            row = []
            for inv_id in inverters:
                value = inverter_data[inv_id].get(date, None)
                row.append(value)
            data_matrix.append(row)

        # Count null cells
        total_cells = len(sorted_dates) * len(inverters)
        null_cells = sum(1 for row in data_matrix for v in row if v is None)
        null_pct = (null_cells / total_cells * 100) if total_cells > 0 else 0

        result = {
            "dates": sorted_dates,
            "inverters": inverters,
            "data": data_matrix,
            "metadata": {
                "aggregation": aggregation,
                "metric": metric,
                "total_inverters": len(inverters),
                "total_dates": len(sorted_dates),
                "total_cells": total_cells,
                "null_cells": null_cells,
                "null_percentage": round(null_pct, 2),
                "date_range": {
                    "start": sorted_dates[0] if sorted_dates else None,
                    "end": sorted_dates[-1] if sorted_dates else None,
                },
                "generated_at": datetime.now().isoformat(),
            },
        }

        logger.info(
            f"{aggregation.capitalize()} {metric}: "
            f"{len(sorted_dates)} periods, {len(inverters)} inverters, "
            f"{null_pct:.1f}% null cells"
        )

        return result


def aggregate_dashboard_data(data_dir: Union[str, Path], output_dir: Union[str, Path, None] = None) -> dict:
    """
    Convenience function to aggregate all dashboard data.

    Args:
        data_dir: Directory containing residuals_INV_*.parquet files
        output_dir: Output directory for JSON files (defaults to data_dir)

    Returns:
        dict with paths to generated files and statistics
    """
    aggregator = DashboardAggregator(Path(data_dir), Path(output_dir) if output_dir else None)
    return aggregator.aggregate_all()


if __name__ == "__main__":
    import sys

    # Default paths
    project_root = Path(__file__).parent.parent.parent
    default_data_dir = project_root / "public" / "data" / "digitaltwin" / "alpha1"

    data_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else default_data_dir

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
    )

    print(f"Aggregating dashboard data from: {data_dir}")
    results = aggregate_dashboard_data(data_dir)

    print("\nResults:")
    for key, value in results.items():
        print(f"  {key}: {value}")
