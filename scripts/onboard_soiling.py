#!/usr/bin/env python3
"""
Soiling domain onboarding script.

Handles all soiling-related data collection, analysis, and model training for a solar plant.

Usage:
    # With SCADA date range (called by orchestrator)
    python scripts/onboard_soiling.py --plant-id eta --start-date 2020-01-01 --end-date 2024-12-31

    # Standalone (auto-detects SCADA range)
    python scripts/onboard_soiling.py --plant-id eta
"""

import argparse
import sys
import yaml
from pathlib import Path
from typing import Optional

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.utils.onboarding import BaseOnboarder
from nuravolt.utils.data_inspector import get_scada_date_range


class SoilingOnboarder(BaseOnboarder):
    """Soiling domain onboarding orchestrator."""

    def __init__(self, plant_id: str, start_date: Optional[str] = None, end_date: Optional[str] = None):
        super().__init__(plant_id, Path(__file__).parent.parent)
        self.start_date = start_date
        self.end_date = end_date
        self.output_dir = self.project_root / 'public' / 'data' / 'soiling' / plant_id
        self.models_dir = self.project_root / 'models' / 'soiling'

        # Auto-detect SCADA range if not provided
        if not self.start_date or not self.end_date:
            self._detect_scada_range()

    def _detect_scada_range(self):
        """Auto-detect SCADA date range from plant config."""
        config_path = self.project_root / 'plant_configs' / f'{self.plant_id}.yaml'
        with open(config_path) as f:
            config = yaml.safe_load(f)

        parquet_path = Path(config['data']['source_path'])
        timestamp_col = config['data'].get('timestamp_column', 'timestamp')

        self.start_date, self.end_date = get_scada_date_range(parquet_path, timestamp_col)
        self.logger.info(f"🔍 Auto-detected SCADA range: {self.start_date} to {self.end_date}")

    def run(self) -> bool:
        """Execute soiling onboarding pipeline."""
        self.logger.info("\n" + "="*70)
        self.logger.info("SOILING DOMAIN ONBOARDING")
        self.logger.info("="*70)
        self.logger.info(f"Plant: {self.plant_id}")
        self.logger.info(f"SCADA data range: {self.start_date} to {self.end_date}")
        self.logger.info("="*70)

        steps = [
            ('external_data', self.download_external_data),
            ('sensor_data', self.extract_sensor_data),
            ('daily_metrics', self.calculate_daily_metrics),
            ('rdtools', self.run_rdtools_analysis),
            ('seasonal_forecast', self.generate_seasonal_forecast),
            ('foundation_soiling', self.train_foundation_soiling_model),
            ('per_inverter_soiling', self.train_per_inverter_soiling),
            ('nodustiq', self.train_nodustiq_model),
            ('forecasts', self.generate_forecasts),
        ]

        for step_name, step_func in steps:
            if not step_func():
                self.failed_steps.append(step_name)
                self.logger.error(f"❌ Step '{step_name}' failed")
                return False
            self.completed_steps.add(step_name)

        self.logger.info("\n" + "="*70)
        self.logger.info("✅ SOILING ONBOARDING COMPLETED SUCCESSFULLY")
        self.logger.info("="*70)
        return True

    def download_external_data(self) -> bool:
        """Download rain, dust, AOD for SCADA date range."""
        self.logger.info("\n" + "="*60)
        self.logger.info("SOILING STEP 1/9: DOWNLOAD EXTERNAL DATA")
        self.logger.info("="*60)
        self.logger.info(f"📅 Date range: {self.start_date} to {self.end_date}")

        # Fetch rain history for SCADA date range
        rain_cmd = [
            self.python_path, 'scripts/fetch_rain_history.py',
            '--plant-id', self.plant_id,
            '--start-date', self.start_date,
            '--end-date', self.end_date
        ]
        if not self._run_command(rain_cmd, 'Rain history download'):
            return False

        # Fetch recent dust history (still 92 days - API limitation)
        dust_cmd = [self.python_path, 'scripts/fetch_dust_history.py', '--plant-id', self.plant_id]
        if not self._run_command(dust_cmd, 'Recent dust history download'):
            return False

        # Fetch CAMS AOD for SCADA date range
        self.logger.info(f"\n📡 Fetching historical AOD data from CAMS EAC4...")
        self.logger.info("⏳ This may take several minutes to download NetCDF data...")

        cams_cmd = [
            self.python_path, 'scripts/fetch_cams_historical_aod.py',
            '--plant-id', self.plant_id,
            '--start-date', self.start_date,
            '--end-date', self.end_date
        ]
        if not self._run_command(cams_cmd, 'CAMS historical AOD download', timeout=900):
            self.logger.warning("⚠️  CAMS AOD download failed - check credentials")
            return False

        # Fallback weather (irradiance/temp/wind) — required for plants without
        # on-site sensors, useful as QC reference for the rest. Warn-only:
        # sensor-equipped plants can proceed without it.
        weather_cmd = [
            self.python_path, 'scripts/fetch_weather_fallback.py',
            '--plant-id', self.plant_id,
            '--start-date', self.start_date,
            '--end-date', self.end_date
        ]
        if not self._run_command(weather_cmd, 'Fallback weather download'):
            self.logger.warning("⚠️  Fallback weather download failed — plants "
                                "without on-site irradiance will degrade to clearsky")

        return True

    def extract_sensor_data(self) -> bool:
        """Extract DustIQ from parquet if available."""
        self.logger.info("\n" + "="*60)
        self.logger.info("SOILING STEP 2/9: EXTRACT SENSOR DATA")
        self.logger.info("="*60)

        output_file = self.output_dir / 'dustiq_history.json'

        # Extract DustIQ
        cmd = [self.python_path, 'scripts/extract_dustiq_history.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'DustIQ extraction')

        return success

    def calculate_daily_metrics(self) -> bool:
        """Calculate daily PR and basic metrics."""
        self.logger.info("\n" + "="*60)
        self.logger.info("SOILING STEP 3/9: CALCULATE DAILY METRICS")
        self.logger.info("="*60)

        # Calculate daily PR
        cmd = [self.python_path, 'scripts/calculateDailyPR.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'Daily PR calculation')

        return success

    def run_rdtools_analysis(self) -> bool:
        """Run rdtools SRR analysis."""
        self.logger.info("\n" + "="*60)
        self.logger.info("SOILING STEP 4/9: RUN RDTOOLS ANALYSIS")
        self.logger.info("="*60)

        # Run RdTools SRR
        cmd = [self.python_path, 'scripts/calculateSoilingRatio_rdtools.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'RdTools SRR analysis')

        if not success:
            return False

        # Generate fleet analysis from rdtools output
        cmd_fleet = [self.python_path, 'scripts/generate_fleet_analysis_from_rdtools.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd_fleet, 'Fleet analysis generation')

        return success

    def generate_seasonal_forecast(self) -> bool:
        """Generate seasonal soiling forecast."""
        self.logger.info("\n" + "="*60)
        self.logger.info("SOILING STEP 5/9: GENERATE SEASONAL FORECAST")
        self.logger.info("="*60)

        # Generate forecast
        cmd = [self.python_path, 'scripts/generateSeasonalForecast.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'Seasonal forecast generation')

        return success

    def train_foundation_soiling_model(self) -> bool:
        """Train foundation SR model (requires DustIQ)."""
        self.logger.info("\n" + "="*60)
        self.logger.info("SOILING STEP 6/9: TRAIN FOUNDATION SOILING MODEL")
        self.logger.info("="*60)

        # Check if DustIQ data exists
        dustiq_file = self.output_dir / 'dustiq_history.json'
        if not dustiq_file.exists():
            self.logger.warning("⚠️  No DustIQ data available, skipping foundation model training")
            return True

        # Train foundation model
        cmd = [self.python_path, 'scripts/train_sr_foundation_model.py', '--plant', self.plant_id]
        success = self._run_command(cmd, 'Foundation soiling model training')

        return success

    def train_per_inverter_soiling(self) -> bool:
        """Train per-inverter SR models (dustiq + pseudo variants)."""
        self.logger.info("\n" + "="*60)
        self.logger.info("SOILING STEP 7/9: TRAIN PER-INVERTER SOILING")
        self.logger.info("="*60)

        # Train DustIQ variant if available
        dustiq_file = self.output_dir / 'dustiq_history.json'
        if dustiq_file.exists():
            cmd_dustiq = [self.python_path, 'scripts/train_per_inverter_sr.py',
                         '--plant', self.plant_id, '--variant', 'dustiq']
            if not self._run_command(cmd_dustiq, 'Per-inverter soiling (DustIQ variant)'):
                return False

        # Train pseudo-label variant
        cmd_pseudo = [self.python_path, 'scripts/train_per_inverter_sr.py',
                     '--plant', self.plant_id, '--variant', 'pseudo']
        success = self._run_command(cmd_pseudo, 'Per-inverter soiling (pseudo-label variant)')

        return success

    def train_nodustiq_model(self) -> bool:
        """Train NoDustIQ ML soiling model."""
        self.logger.info("\n" + "="*60)
        self.logger.info("SOILING STEP 8/9: TRAIN NODUSTIQ MODEL")
        self.logger.info("="*60)

        # Train NoDustIQ model
        cmd = [self.python_path, 'scripts/train_nodustiq_model.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'NoDustIQ model training')

        return success

    def generate_forecasts(self) -> bool:
        """Generate SR forecasts (365d + annual)."""
        self.logger.info("\n" + "="*60)
        self.logger.info("SOILING STEP 9/9: GENERATE FORECASTS")
        self.logger.info("="*60)

        # Generate forecasts
        cmd = [self.python_path, 'scripts/generate_sr_forecast.py',
               '--plant', self.plant_id, '--both']
        success = self._run_command(cmd, 'Forecast generation')

        return success


def main():
    parser = argparse.ArgumentParser(
        description='Soiling domain onboarding for solar plants',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # With SCADA date range (called by orchestrator)
    python scripts/onboard_soiling.py --plant-id eta --start-date 2020-01-01 --end-date 2024-12-31

    # Standalone (auto-detects SCADA range)
    python scripts/onboard_soiling.py --plant-id eta
        """
    )
    parser.add_argument('--plant-id', required=True, help='Plant ID (e.g., eta, ribera, alpha1)')
    parser.add_argument('--start-date', help='Start date (YYYY-MM-DD) for external data download')
    parser.add_argument('--end-date', help='End date (YYYY-MM-DD) for external data download')
    args = parser.parse_args()

    onboarder = SoilingOnboarder(
        plant_id=args.plant_id,
        start_date=args.start_date,
        end_date=args.end_date
    )

    success = onboarder.run()
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
