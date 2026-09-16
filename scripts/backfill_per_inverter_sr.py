#!/usr/bin/env python3
"""
Backfill Per-Inverter Soiling Ratio Estimates

Generate historical SR estimates for all inverters using a trained model.

Usage:
    # Backfill using pseudo-label model
    python scripts/backfill_per_inverter_sr.py --plant alpha1 --variant pseudo

    # Backfill specific date range
    python scripts/backfill_per_inverter_sr.py --plant alpha1 --start 2022-01-01 --end 2024-12-15

    # Output to specific directory
    python scripts/backfill_per_inverter_sr.py --plant alpha1 --output-dir ./output

Author: NuraVolt Team
"""

import argparse
import sys
import json
import logging
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional

import pandas as pd
import numpy as np

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.soiling.sr_ml_model import PerInverterSRModel
from nuravolt.soiling.sr_ml_features import SoilingRatioFeatureEngineer, PlantLocation
from nuravolt.soiling.sr_per_inverter_features import PerInverterFeatureEngineer


def _load_plant_location(plant_id: str) -> PlantLocation:
    """Plant location for feature engineering — same resolution the trainer
    uses: plant_configs/{plant}.yaml when present, else the Mediterranean
    default (correct for the Spanish flagship plants)."""
    config_path = Path('plant_configs') / f'{plant_id}.yaml'
    if config_path.exists():
        import yaml

        with open(config_path) as f:
            loc = (yaml.safe_load(f) or {}).get('location', {})
        return PlantLocation(
            latitude=loc.get('latitude', 40.0),
            longitude=loc.get('longitude', -4.0),
            elevation_m=loc.get('elevation', 0.0),
            climate_zone=loc.get('climate_zone', 'mediterranean'),
            distance_to_coast_km=loc.get('distance_to_coast_km', 50.0),
        )
    return PlantLocation(
        latitude=40.0, longitude=-4.0, elevation_m=0.0,
        climate_zone='mediterranean', distance_to_coast_km=50.0,
    )

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class PerInverterBackfiller:
    """Generate historical SR estimates for all inverters."""

    def __init__(
        self,
        plant_id: str,
        model_path: Path,
        data_dir: Path,
        output_dir: Path,
        history_days: int = 0
    ):
        """
        Initialize backfiller.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        model_path : Path
            Path to trained model file
        data_dir : Path
            Directory containing plant data
        output_dir : Path
            Output directory for results
        history_days : int
            Cap the per-inverter history emitted into the served JSON to the
            trailing N days (0 = model default). Keeps the committed artifact
            small; the full-range CSVs are unaffected.
        """
        self.plant_id = plant_id
        self.model_path = Path(model_path)
        self.data_dir = Path(data_dir)
        self.output_dir = Path(output_dir)
        self.history_days = history_days

        # Load model
        logger.info(f"Loading model from {model_path}")
        self.model = PerInverterSRModel.load(model_path)

        # Initialize feature engineers
        self.feature_engineer = SoilingRatioFeatureEngineer(_load_plant_location(plant_id))
        self.per_inverter_fe = PerInverterFeatureEngineer()

        # Ensure output directory exists
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def backfill(
        self,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        verbose: bool = True
    ) -> pd.DataFrame:
        """
        Generate historical SR estimates.

        Parameters
        ----------
        start_date : str, optional
            Start date (YYYY-MM-DD). Defaults to earliest available data.
        end_date : str, optional
            End date (YYYY-MM-DD). Defaults to today.
        verbose : bool
            Print progress

        Returns
        -------
        pd.DataFrame
            Per-inverter SR estimates
        """
        if verbose:
            print(f"\n{'='*60}")
            print(f"Per-Inverter SR Backfill")
            print(f"Plant: {self.plant_id}")
            print(f"Model: {self.model_path.name}")
            print(f"{'='*60}\n")

        # Step 1: Load data
        if verbose:
            print("Step 1: Loading data...")

        df_rain, df_aod, df_inverter_pr = self._load_data()

        # Step 2: Determine date range
        if verbose:
            print("Step 2: Determining date range...")

        if start_date:
            start = pd.to_datetime(start_date)
        else:
            start = df_rain['date'].min()

        if end_date:
            end = pd.to_datetime(end_date)
        else:
            # Also cap at PR coverage: beyond it every inverter degrades to
            # identical default features and the fleet spread collapses to 0.
            end = min(df_rain['date'].max(), df_inverter_pr['date'].max(), pd.to_datetime('today'))

        if verbose:
            print(f"  Range: {start.date()} to {end.date()}")
            print(f"  Days: {(end - start).days + 1}")

        # Step 3: Load inverter metadata
        if verbose:
            print("Step 3: Loading inverter metadata...")

        # load_inverter_metadata populates the engineer in place (returns None)
        # and keys entries by the underscored id form (INV 01.032 -> INV_01_032).
        inverter_json = self.data_dir / self.plant_id / 'per_inverter' / 'all_inverters.json'
        self.per_inverter_fe.load_inverter_metadata(all_inverters_path=str(inverter_json))
        inverter_metadata = self.per_inverter_fe.inverter_metadata

        if verbose:
            print(f"  Inverters: {len(inverter_metadata)}")

        # Step 4: Generate features
        if verbose:
            print("Step 4: Generating features...")

        # Filter data to date range
        df_rain_filtered = df_rain[
            (df_rain['date'] >= start) & (df_rain['date'] <= end)
        ].copy()

        df_aod_filtered = None
        if df_aod is not None:
            df_aod_filtered = df_aod[
                (df_aod['date'] >= start) & (df_aod['date'] <= end)
            ].copy()

        df_pr_filtered = df_inverter_pr[
            (df_inverter_pr['date'] >= start) & (df_inverter_pr['date'] <= end)
        ].copy()

        # Normalize PR ids to the metadata's underscored key form so the
        # per-inverter PR lookup actually matches (pr_daily carries the raw
        # external ids, e.g. 'INV 01.032'); keep the reverse map so served
        # output uses the external ids the frontend knows.
        display_ids = {}
        if 'inverterId' in df_pr_filtered.columns:
            df_pr_filtered['inverter_id'] = (
                df_pr_filtered['inverterId']
                .str.replace(' ', '_', regex=False)
                .str.replace('.', '_', regex=False)
            )
            display_ids = dict(zip(df_pr_filtered['inverter_id'], df_pr_filtered['inverterId']))

        # Create plant-level features
        df_plant_features = self._create_plant_features(df_rain_filtered, df_aod_filtered)

        # Expand to per-inverter (expects date-indexed plant features; returns
        # a (date, inverter_id) MultiIndex frame)
        df_expanded = self.per_inverter_fe.expand_to_per_inverter(
            df_plant_features=df_plant_features.set_index('date'),
            df_inverter_pr=df_pr_filtered,
            inverter_ids=list(inverter_metadata.keys()) or None
        ).reset_index()

        if verbose:
            print(f"  Feature rows: {len(df_expanded)}")

        # Step 5: Generate predictions
        if verbose:
            print("Step 5: Generating predictions...")

        # Prepare features for prediction
        target_cols = ['date', 'inverter_id']
        feature_cols = [c for c in df_expanded.columns if c not in target_cols]

        X = df_expanded[feature_cols]
        inverter_ids = df_expanded['inverter_id']
        dates = df_expanded['date']

        # Predict
        predictions = self.model.predict_per_inverter(X, inverter_ids, dates)

        # Serve external ids (INV 01.032), not the internal underscored form.
        if display_ids:
            predictions['inverter_id'] = predictions['inverter_id'].map(
                lambda i: display_ids.get(i, i)
            )

        if verbose:
            print(f"  Predictions: {len(predictions)}")

        # Step 6: Validate predictions
        if verbose:
            print("Step 6: Validating predictions...")

        rain_for_validation = df_rain_filtered.rename(columns={
            'precipitation_sum': 'precipitation_mm'
        }) if 'precipitation_sum' in df_rain_filtered.columns else df_rain_filtered

        validation = self.model.validate_predictions(predictions, rain_for_validation)

        if verbose:
            print(f"  Valid: {validation['is_valid']}")
            if validation['issues']:
                for issue in validation['issues']:
                    print(f"    - {issue}")

        # Step 7: Save outputs
        if verbose:
            print("Step 7: Saving outputs...")

        self._save_outputs(predictions, validation)

        if verbose:
            print(f"\nBackfill complete!")
            print(f"  Output directory: {self.output_dir}")

        return predictions

    def _load_data(self):
        """Load required data files."""
        plant_dir = self.data_dir / self.plant_id

        # Load rain data
        rain_path = plant_dir / 'rain_history.csv'
        if not rain_path.exists():
            rain_path = plant_dir / f'{self.plant_id}_rain_history.csv'

        df_rain = pd.read_csv(rain_path)
        df_rain['date'] = pd.to_datetime(df_rain['date'])

        # Load AOD data (optional)
        df_aod = None
        aod_path = plant_dir / 'aod_history.csv'
        if not aod_path.exists():
            aod_path = plant_dir / f'{self.plant_id}_aod_history.csv'
        if aod_path.exists():
            df_aod = pd.read_csv(aod_path)
            df_aod['date'] = pd.to_datetime(df_aod['date'])

        # Load per-inverter PR
        pr_path = plant_dir / 'pr_daily.parquet'
        if not pr_path.exists():
            pr_path = plant_dir / f'{self.plant_id}_pr_daily.parquet'

        df_pr = pd.read_parquet(pr_path)
        df_pr['date'] = pd.to_datetime(df_pr['date'])

        return df_rain, df_aod, df_pr

    def _create_plant_features(self, df_rain, df_aod):
        """Create plant-level features."""
        # Prepare rain features (reset the index so the dict-of-arrays the
        # engineer returns aligns positionally with the date column)
        rain_col = 'precipitation_sum' if 'precipitation_sum' in df_rain.columns else 'precipitation_mm'
        df_rain_prep = (
            df_rain[['date', rain_col]]
            .rename(columns={rain_col: 'precipitation_mm'})
            .reset_index(drop=True)
        )

        # Generate rain features — returns Dict[str, array-like]
        feature_arrays = self.feature_engineer._create_rainfall_features(df_rain_prep)
        df_features = pd.DataFrame(feature_arrays)
        df_features['date'] = df_rain_prep['date']

        # Merge AOD if available
        if df_aod is not None:
            df_features = df_features.merge(df_aod, on='date', how='left')

            for col in ['aod_550', 'dust_aod']:
                if col in df_features.columns:
                    for window in [7, 14, 30]:
                        df_features[f'{col}_mean_{window}d'] = (
                            df_features[col].rolling(window, min_periods=1).mean()
                        )

        # Add temporal features
        df_features['day_of_year'] = df_features['date'].dt.dayofyear
        df_features['month'] = df_features['date'].dt.month
        df_features['day_of_year_sin'] = np.sin(2 * np.pi * df_features['day_of_year'] / 365)
        df_features['day_of_year_cos'] = np.cos(2 * np.pi * df_features['day_of_year'] / 365)
        df_features['month_sin'] = np.sin(2 * np.pi * df_features['month'] / 12)
        df_features['month_cos'] = np.cos(2 * np.pi * df_features['month'] / 12)
        df_features['is_dry_season'] = df_features['month'].isin([5, 6, 7, 8, 9]).astype(int)

        return df_features

    def _save_outputs(self, predictions: pd.DataFrame, validation: dict):
        """Save prediction outputs in multiple formats."""
        # Save full CSV
        csv_path = self.output_dir / f'{self.plant_id}_per_inverter_sr.csv'
        predictions.to_csv(csv_path, index=False)
        logger.info(f"Saved CSV: {csv_path}")

        # Save JSON for web consumption (history capped for serving budget)
        if self.history_days > 0:
            self.model.per_inverter_config.output_history_days = self.history_days
        json_output = self.model.to_json_output(predictions, self.plant_id)
        json_output['validation'] = validation

        # Provenance + model metrics so the serving layer can label honestly.
        model_meta_path = self.model_path.with_suffix('.json')
        if model_meta_path.exists():
            try:
                with open(model_meta_path) as f:
                    model_meta = json.load(f)
                json_output['metadata']['metrics'] = model_meta.get('metrics', model_meta)
            except (json.JSONDecodeError, OSError):
                pass
        json_output['metadata']['provenance'] = {
            'source': 'measured_per_inverter',
            'method': f"lightgbm_{json_output['metadata'].get('model_variant', 'unknown')}",
            'data_start': str(predictions['date'].min())[:10],
            'data_end': str(predictions['date'].max())[:10],
            'generated_at': datetime.now().isoformat(),
        }

        json_path = self.output_dir / f'{self.plant_id}_per_inverter_sr.json'
        with open(json_path, 'w') as f:
            json.dump(json_output, f, indent=2, default=str)
        logger.info(f"Saved JSON: {json_path}")

        # Save daily summary
        daily_summary = predictions.groupby('date').agg({
            'sr_predicted': ['mean', 'std', 'min', 'max'],
            'confidence': 'mean',
            'is_anomaly': 'sum'
        }).reset_index()
        daily_summary.columns = [
            'date', 'sr_mean', 'sr_std', 'sr_min', 'sr_max',
            'confidence_mean', 'anomaly_count'
        ]

        summary_path = self.output_dir / f'{self.plant_id}_sr_daily_summary.csv'
        daily_summary.to_csv(summary_path, index=False)
        logger.info(f"Saved summary: {summary_path}")

        # Save per-inverter statistics
        inverter_stats = predictions.groupby('inverter_id').agg({
            'sr_predicted': ['mean', 'std', 'min', 'max'],
            'is_anomaly': 'mean'
        }).reset_index()
        inverter_stats.columns = [
            'inverter_id', 'sr_mean', 'sr_std', 'sr_min', 'sr_max', 'anomaly_rate'
        ]

        stats_path = self.output_dir / f'{self.plant_id}_inverter_sr_stats.csv'
        inverter_stats.to_csv(stats_path, index=False)
        logger.info(f"Saved inverter stats: {stats_path}")


def main():
    parser = argparse.ArgumentParser(
        description='Backfill Per-Inverter Soiling Ratio Estimates',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Backfill all available history
    python scripts/backfill_per_inverter_sr.py --plant alpha1 --variant pseudo

    # Backfill specific date range
    python scripts/backfill_per_inverter_sr.py --plant alpha1 --start 2023-01-01 --end 2024-12-15

    # Custom model path
    python scripts/backfill_per_inverter_sr.py --plant alpha1 --model ./models/custom_model.pkl
        """
    )

    parser.add_argument(
        '--plant',
        type=str,
        required=True,
        help='Plant identifier (e.g., alpha1)'
    )

    parser.add_argument(
        '--variant',
        type=str,
        choices=['dustiq', 'pseudo'],
        default='pseudo',
        help='Model variant to use (default: pseudo)'
    )

    parser.add_argument(
        '--model',
        type=str,
        default=None,
        help='Custom model path (overrides variant)'
    )

    parser.add_argument(
        '--data-dir',
        type=str,
        default='public/data/soiling',
        help='Data directory (default: public/data/soiling)'
    )

    parser.add_argument(
        '--output-dir',
        type=str,
        default=None,
        help='Output directory (default: <data-dir>/<plant>/per_inverter)'
    )

    parser.add_argument(
        '--start',
        type=str,
        default=None,
        help='Start date (YYYY-MM-DD)'
    )

    parser.add_argument(
        '--end',
        type=str,
        default=None,
        help='End date (YYYY-MM-DD)'
    )

    parser.add_argument(
        '--history-days',
        type=int,
        default=0,
        help='Cap per-inverter history in the served JSON to the trailing N days (0 = model default)'
    )

    args = parser.parse_args()

    # Setup paths
    data_dir = Path(args.data_dir)

    # Model path
    if args.model:
        model_path = Path(args.model)
    else:
        model_path = data_dir / args.plant / 'models' / f'sr_model_{args.variant}_{args.plant}.pkl'

    # Output directory
    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        output_dir = data_dir / args.plant / 'per_inverter'

    # Validate model exists
    if not model_path.exists():
        logger.error(f"Model not found: {model_path}")
        logger.error(f"Train a model first using: python scripts/train_per_inverter_sr.py --plant {args.plant} --variant {args.variant}")
        sys.exit(1)

    # Run backfill
    backfiller = PerInverterBackfiller(
        plant_id=args.plant,
        model_path=model_path,
        data_dir=data_dir,
        output_dir=output_dir,
        history_days=args.history_days
    )
    # Legacy pickles (saved before PerInverterSRModel round-tripped its own
    # config) lose the variant; the filename convention still knows it.
    if not args.model:
        backfiller.model.per_inverter_config.variant = args.variant

    predictions = backfiller.backfill(
        start_date=args.start,
        end_date=args.end,
        verbose=True
    )

    print(f"\nOutput files saved to: {output_dir}")


if __name__ == '__main__':
    main()
