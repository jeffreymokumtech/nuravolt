"""
String Twin Factory for Batch Training

Orchestrates creation of string-level digital twins for all strings:
- Automatic string column detection
- Batch parallel processing
- Model validation and quality assurance
- CSV export for fault detection integration
- JSON export for dashboard consumption

Usage:
    from nuravolt.digitaltwin import StringTwinFactory, StringFactoryConfig

    factory = StringTwinFactory(
        config=StringFactoryConfig(
            num_modules=20,
            module_imp=8.5,
        ),
        output_dir="public/data/digitaltwin/alpha1/strings"
    )

    results = factory.create_all_twins(df, inverter_ids=["INV_01.001"])
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple
from pathlib import Path
from datetime import datetime
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
import multiprocessing

import numpy as np
import polars as pl

from .string_twin import (
    StringPerformanceTwin,
    StringTwinThresholds,
    StringTwinMetrics,
)

logger = logging.getLogger(__name__)


@dataclass
class StringFactoryConfig:
    """Configuration for string twin factory."""

    # String hardware parameters
    num_modules: Optional[int] = None  # Modules per string
    module_imp: Optional[float] = None  # Module current at MPP (A) at STC
    module_temp_coeff: float = -0.004  # Temperature coefficient (%/°C)

    # Training parameters
    max_years: float = 3.0  # Training period (first N years)
    min_training_samples: int = 500  # Minimum samples per string
    validation_split: float = 0.2  # Validation fraction
    use_physics_baseline: bool = True  # Use physics baseline + ML residual

    # Processing
    max_workers: int = field(default_factory=lambda: min(4, multiprocessing.cpu_count()))
    batch_size: int = 30  # Strings per batch

    # Quality thresholds (tuned for string-level noise - Phase 1.7)
    min_r2: float = 0.40  # Minimum R² for valid model (optimized for string data)
    max_mae_a: float = 1.2  # Maximum MAE (A) for valid model
    min_data_completeness: float = 0.70  # Minimum valid data fraction
    min_high_irradiance_samples: int = 500  # Min samples at >700 W/m² for calibration

    # Anomaly detection
    thresholds: Optional[StringTwinThresholds] = None

    # Output
    save_models: bool = True  # Save model pickle files
    save_residuals: bool = True  # Export residuals Parquet for fault detection
    save_json: bool = True  # Export JSON for dashboard
    verbose: bool = True

    # Weather fallback (used only when no on-site irradiance column exists;
    # requires latitude/longitude — see nuravolt/weather/fallback.py)
    enable_weather_fallback: bool = True
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    tilt: Optional[float] = None  # array tilt (deg); heuristic if None
    azimuth: Optional[float] = None  # pvlib convention, 180 = south
    timezone: str = "auto"  # IANA tz of the SCADA timestamps


@dataclass
class StringResult:
    """Result for single string model creation."""
    string_id: str
    inverter_id: str
    success: bool = False
    metrics: Optional[StringTwinMetrics] = None
    model: Optional[StringPerformanceTwin] = None
    training_samples: int = 0
    training_period: Optional[Tuple[str, str]] = None
    error_message: Optional[str] = None
    processing_time_s: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        """Convert to JSON-serializable dict."""
        return {
            "stringId": self.string_id,
            "inverterId": self.inverter_id,
            "success": self.success,
            "metrics": {
                "mae": round(self.metrics.mae, 3),
                "rmse": round(self.metrics.rmse, 3),
                "r2": round(self.metrics.r2, 3),
                "mape": round(self.metrics.mape * 100, 2),
                "improvementOverPhysicsPct": round(self.metrics.improvement_over_physics_pct, 1),
                "trainingSamples": self.metrics.n_samples,
            } if self.metrics else None,
            "trainingSamples": self.training_samples,
            "trainingPeriod": {
                "start": self.training_period[0] if self.training_period else None,
                "end": self.training_period[1] if self.training_period else None,
            },
            "errorMessage": self.error_message,
            "processingTime_s": round(self.processing_time_s, 2),
        }


class StringTwinFactory:
    """
    Factory for creating string-level digital twins for all strings in a plant.

    Features:
    - Automatic string column detection (Input_current_01, Input_current_02, ...)
    - Training data selection (first 3 years, quality filtering)
    - Parallel batch processing
    - Model validation and quality control
    - CSV export for fault detection integration
    - JSON export for dashboard visualization
    """

    def __init__(
        self,
        config: Optional[StringFactoryConfig] = None,
        output_dir: str = "public/data/digitaltwin/strings",
    ):
        """
        Initialize factory.

        Parameters:
        -----------
        config : StringFactoryConfig
            Factory configuration
        output_dir : str
            Output directory for models and residuals
        """
        self.config = config or StringFactoryConfig()
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Results storage
        self.results: Dict[str, StringResult] = {}

        # Statistics
        self.stats = {
            "start_time": None,
            "end_time": None,
            "total_strings": 0,
            "successful": 0,
            "failed": 0,
            "skipped": 0,
        }

    def create_all_twins(
        self,
        df: pl.DataFrame,
        inverter_ids: Optional[List[str]] = None,
        string_limit: Optional[int] = None,
    ) -> Dict[str, StringResult]:
        """
        Create string twins for all strings.

        Parameters:
        -----------
        df : pl.DataFrame
            Full dataset with all string columns
        inverter_ids : List[str]
            Specific inverter IDs to process (e.g., ["INV_01.001"])
        string_limit : int
            Maximum number of strings to process (for testing)

        Returns:
        --------
        Dict[str, StringResult]
            Results keyed by string ID
        """
        self.stats["start_time"] = datetime.now()
        logger.info("Starting string twin factory...")

        # Identify string columns and group by inverter
        string_cols_by_inv = self._identify_string_columns(df, inverter_ids)

        total_strings = sum(len(strings) for strings in string_cols_by_inv.values())
        logger.info(f"Found {total_strings} strings across {len(string_cols_by_inv)} inverters")

        if total_strings == 0:
            raise ValueError("No string columns found in DataFrame")

        # Apply limit if specified
        if string_limit:
            limited_cols = {}
            count = 0
            for inv_id, strings in string_cols_by_inv.items():
                if count >= string_limit:
                    break
                take = min(len(strings), string_limit - count)
                limited_cols[inv_id] = strings[:take]
                count += take
            string_cols_by_inv = limited_cols

        self.stats["total_strings"] = sum(len(s) for s in string_cols_by_inv.values())
        logger.info(f"Processing {self.stats['total_strings']} strings")

        # Find required columns
        irradiance_col = self._find_irradiance_column(df)
        irradiance_source = "onsite"
        if not irradiance_col:
            reference_cols = [c for cols in string_cols_by_inv.values() for c in cols]
            df, fallback_meta = self._apply_weather_fallback(df, reference_cols)
            if fallback_meta is None:
                raise ValueError(
                    "No irradiance column found in DataFrame and weather fallback "
                    "unavailable — set StringFactoryConfig.latitude/longitude to "
                    "enable satellite-derived irradiance (nuravolt/weather)"
                )
            irradiance_col = self._find_irradiance_column(df)
            irradiance_source = fallback_meta["source"]
        self.stats["irradiance_source"] = irradiance_source

        ambient_col = self._find_ambient_temp_column(df)
        module_col = self._find_module_temp_column(df)

        logger.info(f"Using columns: irradiance={irradiance_col}, "
                   f"ambient={ambient_col}, module={module_col}")

        # Ensure datetime index
        if "timestamp" in df.columns and df["timestamp"].dtype != pl.Datetime:
            df = df.with_columns([
                pl.col("timestamp").str.strptime(pl.Datetime, format="%Y.%m.%d %H:%M")
            ])

        # Process all strings
        all_string_cols = []
        for inv_id, string_cols in string_cols_by_inv.items():
            all_string_cols.extend([(inv_id, col) for col in string_cols])

        # Process in batches
        batches = [
            all_string_cols[i:i + self.config.batch_size]
            for i in range(0, len(all_string_cols), self.config.batch_size)
        ]

        for batch_idx, batch in enumerate(batches):
            logger.info(f"Processing batch {batch_idx + 1}/{len(batches)} ({len(batch)} strings)")

            if self.config.max_workers > 1:
                batch_results = self._process_batch_parallel(
                    df, batch, irradiance_col, ambient_col, module_col
                )
            else:
                batch_results = self._process_batch_sequential(
                    df, batch, irradiance_col, ambient_col, module_col
                )

            self.results.update(batch_results)

            # Progress logging
            successful = sum(1 for r in batch_results.values() if r.success)
            logger.info(f"Batch {batch_idx + 1}: {successful}/{len(batch)} successful")

        # Calculate final stats
        self._calculate_stats()

        # Export results
        if self.config.save_residuals:
            self._export_residuals(df)

        if self.config.save_json:
            self._export_json()

        logger.info(f"Factory complete: {self.stats['successful']} successful, "
                   f"{self.stats['failed']} failed, {self.stats['skipped']} skipped")

        return self.results

    def _process_batch_parallel(
        self,
        df: pl.DataFrame,
        batch: List[Tuple[str, str]],  # (inverter_id, string_col)
        irradiance_col: str,
        ambient_col: Optional[str],
        module_col: Optional[str],
    ) -> Dict[str, StringResult]:
        """Process batch of strings in parallel."""
        results = {}

        with ThreadPoolExecutor(max_workers=self.config.max_workers) as executor:
            futures = {
                executor.submit(
                    self._create_single_twin,
                    df, inv_id, string_col, irradiance_col, ambient_col, module_col
                ): (inv_id, string_col)
                for inv_id, string_col in batch
            }

            for future in as_completed(futures):
                inv_id, string_col = futures[future]
                try:
                    result = future.result(timeout=300)
                    results[result.string_id] = result
                except Exception as e:
                    string_id = self._extract_string_id(inv_id, string_col)
                    logger.error(f"Error processing {string_id}: {e}")
                    results[string_id] = StringResult(
                        string_id=string_id,
                        inverter_id=inv_id,
                        success=False,
                        error_message=str(e),
                    )

        return results

    def _process_batch_sequential(
        self,
        df: pl.DataFrame,
        batch: List[Tuple[str, str]],
        irradiance_col: str,
        ambient_col: Optional[str],
        module_col: Optional[str],
    ) -> Dict[str, StringResult]:
        """Process batch of strings sequentially."""
        results = {}

        for inv_id, string_col in batch:
            try:
                result = self._create_single_twin(
                    df, inv_id, string_col, irradiance_col, ambient_col, module_col
                )
                results[result.string_id] = result
            except Exception as e:
                string_id = self._extract_string_id(inv_id, string_col)
                logger.error(f"Error processing {string_id}: {e}")
                results[string_id] = StringResult(
                    string_id=string_id,
                    inverter_id=inv_id,
                    success=False,
                    error_message=str(e),
                )

        return results

    def _create_single_twin(
        self,
        df: pl.DataFrame,
        inverter_id: str,
        string_col: str,
        irradiance_col: str,
        ambient_col: Optional[str],
        module_col: Optional[str],
    ) -> StringResult:
        """Create digital twin for single string."""
        import time
        start_time = time.time()

        string_id = self._extract_string_id(inverter_id, string_col)
        result = StringResult(string_id=string_id, inverter_id=inverter_id)

        try:
            # Prepare training data
            train_df = self._prepare_training_data(
                df, string_col, irradiance_col, ambient_col, module_col
            )

            if len(train_df) < self.config.min_training_samples:
                result.error_message = f"Insufficient data: {len(train_df)} samples"
                result.training_samples = len(train_df)
                return result

            result.training_samples = len(train_df)

            # Get training period
            if "timestamp" in train_df.columns:
                start_date = str(train_df["timestamp"].min())[:10]
                end_date = str(train_df["timestamp"].max())[:10]
                result.training_period = (start_date, end_date)

            # Create and train model
            model = StringPerformanceTwin(
                string_id=string_id,
                inverter_id=inverter_id,
                num_modules=self.config.num_modules,
                module_imp=self.config.module_imp,
                module_temp_coeff=self.config.module_temp_coeff,
                thresholds=self.config.thresholds,
            )

            metrics = model.train(
                df=train_df,
                target_col="string_current",
                validation_split=self.config.validation_split,
                use_physics_baseline=self.config.use_physics_baseline,
                verbose=False,
            )

            result.metrics = metrics
            result.model = model

            # Validate model quality
            if metrics.r2 < self.config.min_r2:
                result.error_message = f"R² too low: {metrics.r2:.3f} < {self.config.min_r2}"
                result.success = False
            elif metrics.mae > self.config.max_mae_a:
                result.error_message = f"MAE too high: {metrics.mae:.2f} > {self.config.max_mae_a}"
                result.success = False
            else:
                result.success = True

                # Save model if successful
                if self.config.save_models:
                    model_path = self.output_dir / "models" / f"{string_id.replace(' ', '_')}.pkl"
                    model_path.parent.mkdir(exist_ok=True)
                    model.save(str(model_path))

        except Exception as e:
            result.error_message = str(e)
            logger.error(f"Failed to create twin for {string_id}: {e}", exc_info=True)

        result.processing_time_s = time.time() - start_time
        return result

    def _prepare_training_data(
        self,
        df: pl.DataFrame,
        string_col: str,
        irradiance_col: str,
        ambient_col: Optional[str],
        module_col: Optional[str],
    ) -> pl.DataFrame:
        """Prepare training data for single string."""

        # Select required columns
        select_cols = ["timestamp", string_col, irradiance_col]

        if ambient_col:
            select_cols.append(ambient_col)
        if module_col:
            select_cols.append(module_col)

        train_df = df.select([c for c in select_cols if c in df.columns])

        # Rename columns to standard names
        rename_map = {
            string_col: "string_current",
            irradiance_col: "irradiance",
        }

        if ambient_col:
            rename_map[ambient_col] = "ambient_temp"
        if module_col:
            rename_map[module_col] = "module_temp"

        train_df = train_df.rename(rename_map)

        # Filter to first N years (if max_years specified)
        if self.config.max_years and self.config.max_years > 0 and "timestamp" in train_df.columns:
            min_date = train_df["timestamp"].min()
            max_date = train_df["timestamp"].max()

            if min_date and max_date:
                from datetime import timedelta
                cutoff_date = min_date + timedelta(days=self.config.max_years * 365)

                if max_date > cutoff_date:
                    train_df = train_df.filter(pl.col("timestamp") <= cutoff_date)

        # === Data Quality Filtering (Phase 1.7 tuning) ===

        # 1. Basic validity: positive irradiance, non-null values
        train_df = train_df.filter(
            pl.col("irradiance") > 0
        ).filter(
            pl.col("string_current").is_not_null()
        ).filter(
            pl.col("string_current") >= 0
        )

        # Store original count for completeness check
        original_count = len(train_df)

        # 2. Filter offline strings during daylight (likely faulty/disconnected)
        # Remove periods where string current is near zero despite high irradiance
        train_df = train_df.with_columns([
            # Mark as offline if current < 0.1A and irradiance > 300 W/m²
            ((pl.col("string_current") < 0.1) & (pl.col("irradiance") > 300.0))
            .alias("_is_offline")
        ])

        # Keep rows that are not offline
        train_df = train_df.filter(~pl.col("_is_offline"))

        # 3. Filter communication errors (consecutive zeros)
        # Identify sequences of 5+ consecutive zero current readings (likely comm failure)
        train_df = train_df.with_columns([
            # Create group ID that changes when current goes from 0 to non-zero or vice versa
            (pl.col("string_current") > 0.0).cast(pl.Int32).alias("_nonzero")
        ])

        # Count consecutive zeros using cumsum trick
        train_df = train_df.with_columns([
            pl.col("_nonzero").cum_sum().alias("_group_id")
        ])

        # For each zero group, count the sequence length
        train_df = train_df.with_columns([
            pl.when(pl.col("string_current") == 0.0)
            .then(
                pl.col("_group_id").count().over("_group_id")
            )
            .otherwise(0)
            .alias("_zero_sequence_len")
        ])

        # Remove sequences of 5+ consecutive zeros (communication errors)
        train_df = train_df.filter(pl.col("_zero_sequence_len") < 5)

        # 4. Filter extreme curtailment (sudden drops to zero at high irradiance)
        # This is different from offline - it's active power limiting
        train_df = train_df.with_columns([
            # Rolling average of current (3 samples)
            pl.col("string_current").rolling_mean(window_size=3, min_periods=1).alias("_current_ma3")
        ])

        # Flag sudden drops: current drops to <0.5A while average was >5A and irradiance >500
        train_df = train_df.with_columns([
            (
                (pl.col("string_current") < 0.5) &
                (pl.col("_current_ma3") > 5.0) &
                (pl.col("irradiance") > 500.0)
            ).alias("_is_curtailed")
        ])

        train_df = train_df.filter(~pl.col("_is_curtailed"))

        # Clean up temporary columns
        train_df = train_df.drop([
            "_is_offline", "_nonzero", "_group_id", "_zero_sequence_len",
            "_current_ma3", "_is_curtailed"
        ])

        # 5. Check data completeness after filtering
        final_count = len(train_df)
        completeness = final_count / original_count if original_count > 0 else 0.0

        if completeness < self.config.min_data_completeness:
            logger.warning(
                f"Low data completeness: {completeness:.1%} < {self.config.min_data_completeness:.1%} "
                f"(original: {original_count:,}, filtered: {final_count:,})"
            )

        # 6. Check high-irradiance samples (needed for calibration)
        high_irrad_samples = train_df.filter(pl.col("irradiance") > 700.0)
        high_irrad_count = len(high_irrad_samples)

        if high_irrad_count < self.config.min_high_irradiance_samples:
            logger.warning(
                f"Low high-irradiance samples: {high_irrad_count:,} < "
                f"{self.config.min_high_irradiance_samples:,}"
            )

        return train_df

    def _identify_string_columns(
        self,
        df: pl.DataFrame,
        inverter_ids: Optional[List[str]] = None,
    ) -> Dict[str, List[str]]:
        """
        Identify string current columns and group by inverter.

        Returns dict: {inverter_id: [string_col1, string_col2, ...]}
        """
        # Normalize inverter IDs to underscore format (INV_XX.XXX)
        normalized_inverter_ids = None
        if inverter_ids:
            normalized_inverter_ids = [
                inv_id.replace(" ", "_") if " " in inv_id else inv_id
                for inv_id in inverter_ids
            ]

        # Pattern: "Plant (ES): INV XX.XXX / Input_current_NN (A)"
        pattern = re.compile(r'INV\s+([\d.]+)\s*/\s*Input_current_(\d+)\s*\(A\)')

        result = {}

        for col in df.columns:
            match = pattern.search(col)
            if match:
                inv_id = f"INV_{match.group(1)}"
                string_num = int(match.group(2))

                # Filter by inverter IDs if specified
                if normalized_inverter_ids and inv_id not in normalized_inverter_ids:
                    continue

                if inv_id not in result:
                    result[inv_id] = []
                result[inv_id].append(col)

        # Sort string columns by number for each inverter
        for inv_id in result:
            result[inv_id] = sorted(result[inv_id], key=lambda c: int(pattern.search(c).group(2)))

        return result

    def _extract_string_id(self, inverter_id: str, string_col: str) -> str:
        """Extract string ID from column name."""
        pattern = re.compile(r'Input_current_(\d+)')
        match = pattern.search(string_col)
        if match:
            string_num = match.group(1)
            return f"{inverter_id}_string_{string_num}"
        return f"{inverter_id}_string_unknown"

    def _apply_weather_fallback(self, df: pl.DataFrame, reference_cols: Optional[List[str]] = None):
        """Inject satellite/model irradiance when no on-site sensor column exists.

        Returns (df, provenance) — provenance is None when the fallback is
        disabled, unconfigured (no lat/lon), or failed. `reference_cols`
        (string currents) let the fallback auto-detect logger clock offsets.
        """
        cfg = self.config
        if not cfg.enable_weather_fallback or cfg.latitude is None or cfg.longitude is None:
            return df, None
        if "timestamp" not in df.columns:
            return df, None
        try:
            from nuravolt.weather import fallback_columns_for_index

            if df["timestamp"].dtype != pl.Datetime:
                df = df.with_columns([
                    pl.col("timestamp").str.strptime(pl.Datetime, format="%Y.%m.%d %H:%M")
                ])
            index = df["timestamp"].to_pandas()
            reference = None
            if reference_cols:
                reference = df.select(
                    pl.mean_horizontal([pl.col(c) for c in reference_cols]).alias("ref")
                )["ref"].to_pandas()
            cols, provenance = fallback_columns_for_index(
                index, cfg.latitude, cfg.longitude,
                tilt=cfg.tilt, azimuth=cfg.azimuth, timezone=cfg.timezone,
                align_reference=reference,
            )
            if cols is None:
                return df, None
            # cols is positionally aligned to df's timestamp order
            df = df.with_columns([
                pl.Series(name, cols[name].to_numpy()) for name in cols.columns
            ])
        except Exception as exc:
            logger.warning(f"Weather fallback failed: {exc}")
            return df, None
        logger.warning(
            "No on-site irradiance column — using %s fallback irradiance "
            "(plane=%s, confidence=%.2f, coverage=%.0f%%)",
            provenance["source"], provenance["irradiance_plane"],
            provenance["confidence"], 100 * provenance["coverage"],
        )
        return df, provenance

    def _find_irradiance_column(self, df: pl.DataFrame) -> Optional[str]:
        """Find irradiance column."""
        patterns = ["irradiation", "irradiance", "poa", "ghi"]
        return self._find_column(df, patterns)

    def _find_ambient_temp_column(self, df: pl.DataFrame) -> Optional[str]:
        """Find ambient temperature column."""
        patterns = ["ambient", "t_amb", "temp_ambient"]
        return self._find_column(df, patterns)

    def _find_module_temp_column(self, df: pl.DataFrame) -> Optional[str]:
        """Find module temperature column."""
        patterns = ["module", "t_mod", "temp_module", "t_cell"]
        return self._find_column(df, patterns)

    def _find_column(self, df: pl.DataFrame, patterns: List[str]) -> Optional[str]:
        """Find first column matching any pattern (case-insensitive)."""
        df_cols_lower = {c.lower(): c for c in df.columns}

        for pattern in patterns:
            for col_lower, col_original in df_cols_lower.items():
                if pattern in col_lower:
                    return col_original

        return None

    def _calculate_stats(self) -> None:
        """Calculate final processing statistics."""
        self.stats["end_time"] = datetime.now()

        for result in self.results.values():
            if result.success:
                self.stats["successful"] += 1
            elif result.training_samples < self.config.min_training_samples:
                self.stats["skipped"] += 1
            else:
                self.stats["failed"] += 1

        duration = (self.stats["end_time"] - self.stats["start_time"]).total_seconds()
        self.stats["total_time_s"] = duration

        # Average metrics for successful models
        successful_results = [r for r in self.results.values() if r.success and r.metrics]
        if successful_results:
            self.stats["avg_r2"] = np.mean([r.metrics.r2 for r in successful_results])
            self.stats["avg_mae"] = np.mean([r.metrics.mae for r in successful_results])

    def _export_residuals(self, df: pl.DataFrame) -> None:
        """Export residuals Parquet files for fault detection integration."""
        logger.info("Exporting residuals Parquet files...")

        residuals_dir = self.output_dir / "residuals"
        residuals_dir.mkdir(exist_ok=True)

        count = 0

        for string_id, result in self.results.items():
            if not result.success or not result.model:
                continue

            try:
                # Get string column
                string_cols = [c for c in df.columns if f"Input_current_{string_id.split('_')[-1]}" in c]

                if not string_cols:
                    continue

                string_col = string_cols[0]

                # Prepare data
                irrad_col = self._find_irradiance_column(df)
                amb_col = self._find_ambient_temp_column(df)
                mod_col = self._find_module_temp_column(df)

                pred_df = self._prepare_training_data(df, string_col, irrad_col, amb_col, mod_col)

                # Predict residuals
                pred_df = result.model.predict(pred_df)

                # Export Parquet
                if "string_residual" in pred_df.columns:
                    export_df = pred_df.select([
                        "timestamp",
                        "I_string_expected",
                        "string_current",
                        "string_residual",
                        "string_residual_pct",
                    ])

                    parquet_path = residuals_dir / f"residuals_{string_id}.parquet"
                    export_df.write_parquet(parquet_path, compression="snappy")
                    count += 1

            except Exception as e:
                logger.warning(f"Failed to export residuals for {string_id}: {e}")

        logger.info(f"Exported {count} residual Parquet files to {residuals_dir}")

    def _export_json(self) -> None:
        """Export results to JSON for dashboard consumption."""
        # Main summary
        summary = {
            "generatedAt": datetime.now().isoformat(),
            "config": {
                "maxYears": self.config.max_years,
                "numModules": self.config.num_modules,
                "moduleImp": self.config.module_imp,
                "usePhysicsBaseline": self.config.use_physics_baseline,
                "minR2": self.config.min_r2,
            },
            "statistics": {
                "totalStrings": self.stats["total_strings"],
                "successful": self.stats["successful"],
                "failed": self.stats["failed"],
                "skipped": self.stats["skipped"],
                "totalTime_s": self.stats.get("total_time_s", 0),
                "avgR2": round(self.stats.get("avg_r2", 0), 4),
                "avgMAE_A": round(self.stats.get("avg_mae", 0), 3),
            },
        }

        # Per-string results
        string_results = {}
        for string_id, result in self.results.items():
            string_results[string_id] = result.to_dict()

        # Export files
        summary_path = self.output_dir / "string_twins_summary.json"
        with open(summary_path, "w") as f:
            json.dump(summary, f, indent=2)

        results_path = self.output_dir / "string_twins_results.json"
        with open(results_path, "w") as f:
            json.dump(string_results, f, indent=2)

        # Export combined for dashboard
        dashboard_data = {
            **summary,
            "strings": string_results,
        }
        dashboard_path = self.output_dir / "string_twins.json"
        with open(dashboard_path, "w") as f:
            json.dump(dashboard_data, f, indent=2)

        logger.info(f"Exported JSON to {self.output_dir}")

    def get_successful_models(self) -> Dict[str, StringPerformanceTwin]:
        """Get all successfully trained models."""
        return {
            string_id: result.model
            for string_id, result in self.results.items()
            if result.success and result.model
        }


def create_string_factory(
    output_dir: str = "public/data/digitaltwin/strings",
    num_modules: Optional[int] = None,
    module_imp: Optional[float] = None,
    max_years: float = 3.0,
) -> StringTwinFactory:
    """
    Create a string twin factory with sensible defaults.

    Parameters:
    -----------
    output_dir : str
        Output directory for models and residuals
    num_modules : int
        Number of modules per string
    module_imp : float
        Module current at MPP (A) at STC
    max_years : float
        Training data period

    Returns:
    --------
    StringTwinFactory
        Configured factory
    """
    config = StringFactoryConfig(
        num_modules=num_modules,
        module_imp=module_imp,
        max_years=max_years,
    )

    return StringTwinFactory(config=config, output_dir=output_dir)
