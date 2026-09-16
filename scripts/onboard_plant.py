#!/usr/bin/env python3
"""
Complete onboarding script for a new solar plant.

Runs all necessary steps to generate:
- Digital twin models
- Fault detection models
- All soiling models (SRR, DustIQ, NoDustIQ)
- Data quality assessments
- Weather data downloads (CAMS, OpenMeteo)
- All required JSON outputs

Usage:
    python scripts/onboard_plant.py --plant-id eta
    python scripts/onboard_plant.py --plant-id ribera --dry-run
    python scripts/onboard_plant.py --plant-id alpha1 --steps soiling,digital-twin
    python scripts/onboard_plant.py --plant-id eta --force
    python scripts/onboard_plant.py --plant-id ribera --resume
"""

import argparse
import json
import logging
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Set

import yaml

# Import domain-specific onboarders
sys.path.insert(0, str(Path(__file__).parent))
from onboard_soiling import SoilingOnboarder
from onboard_dt import DigitalTwinOnboarder
from onboard_faults import FaultOnboarder

# Import utilities
sys.path.insert(0, str(Path(__file__).parent.parent))
from nuravolt.utils.data_inspector import get_scada_date_range


class PlantOnboarder:
    """Comprehensive onboarding orchestrator for solar plants."""

    # Domain definitions (new modular architecture)
    ALL_DOMAINS = ['soiling', 'digital_twin', 'faults']

    # Legacy support: map old step names to new domains
    LEGACY_STEP_TO_DOMAIN = {
        'external_data': 'soiling',
        'sensor_data': 'soiling',
        'daily_metrics': 'soiling',
        'rdtools': 'soiling',
        'seasonal_forecast': 'soiling',
        'foundation_soiling': 'soiling',
        'per_inverter_soiling': 'soiling',
        'nodustiq': 'soiling',
        'forecasts': 'soiling',
        'digital_twin': 'digital_twin',
        'fault_detection': 'faults',
    }

    # Step groups for --steps flag (using new domain names)
    STEP_GROUPS = {
        'all': ALL_DOMAINS
    }

    def __init__(self, plant_id: str, dry_run: bool = False, force: bool = False,
                 resume: bool = False, steps: Optional[List[str]] = None):
        """Initialize the onboarder.

        Args:
            plant_id: Plant identifier (e.g., 'eta', 'ribera', 'alpha1')
            dry_run: If True, only show what would be executed
            force: If True, regenerate existing outputs
            resume: If True, skip steps with existing outputs
            steps: Optional list of specific steps to run
        """
        self.plant_id = plant_id
        self.dry_run = dry_run
        self.force = force
        self.resume = resume
        self.steps_to_run = self._resolve_steps(steps)

        # Setup paths
        self.project_root = Path(__file__).parent.parent
        self.config_path = self.project_root / 'plant_configs' / f'{plant_id}.yaml'
        self.output_dir = self.project_root / 'public' / 'data' / 'soiling' / plant_id
        self.models_dir = self.project_root / 'models' / 'soiling'
        self.faults_dir = self.project_root / 'public' / 'data' / 'faults' / plant_id

        # Use the same Python interpreter that's running this script
        self.python_path = sys.executable

        # Setup logging
        self.logger = self._setup_logger()

        # Track completed domains and steps
        self.completed_steps: Set[str] = set()
        self.failed_steps: List[str] = []

        # SCADA date range (determined in validate_prerequisites)
        self.scada_start_date: Optional[str] = None
        self.scada_end_date: Optional[str] = None

        # Load config
        self.config: Optional[Dict] = None

    def _resolve_steps(self, steps: Optional[List[str]]) -> List[str]:
        """Resolve domain names and groups to actual domain list."""
        if steps is None:
            return self.ALL_DOMAINS

        resolved = []
        for step in steps:
            if step in self.STEP_GROUPS:
                resolved.extend(self.STEP_GROUPS[step])
            elif step in self.ALL_DOMAINS:
                resolved.append(step)
            else:
                print(f"⚠️  Warning: Unknown domain '{step}', skipping")

        # Remove duplicates while preserving order
        seen = set()
        return [s for s in resolved if not (s in seen or seen.add(s))]

    def _setup_logger(self) -> logging.Logger:
        """Setup comprehensive logging to file and console."""
        logger = logging.getLogger(f'onboard_{self.plant_id}')
        logger.setLevel(logging.INFO)

        # Clear existing handlers
        logger.handlers = []

        # Console handler
        console = logging.StreamHandler()
        console.setLevel(logging.INFO)
        console_fmt = logging.Formatter('%(message)s')
        console.setFormatter(console_fmt)
        logger.addHandler(console)

        # File handler
        log_dir = self.project_root / 'logs'
        log_dir.mkdir(exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        log_file = log_dir / f'onboard_{self.plant_id}_{timestamp}.log'

        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(logging.DEBUG)
        file_fmt = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
        file_handler.setFormatter(file_fmt)
        logger.addHandler(file_handler)

        logger.info(f"Log file: {log_file}")

        return logger

    def _run_command(self, cmd: List[str], step_name: str, check_output: bool = True) -> bool:
        """Run a shell command with logging.

        Args:
            cmd: Command as list of strings
            step_name: Name of the step for logging
            check_output: If True, check for output files

        Returns:
            True if successful, False otherwise
        """
        cmd_str = ' '.join(cmd)

        if self.dry_run:
            self.logger.info(f"[DRY RUN] Would execute: {cmd_str}")
            return True

        self.logger.info(f"▶️  Executing: {cmd_str}")

        try:
            result = subprocess.run(
                cmd,
                cwd=self.project_root,
                capture_output=True,
                text=True,
                check=False
            )

            if result.returncode == 0:
                self.logger.info(f"✅ {step_name} completed successfully")
                if result.stdout:
                    self.logger.debug(f"Output: {result.stdout}")
                return True
            else:
                self.logger.error(f"❌ {step_name} failed with code {result.returncode}")
                if result.stderr:
                    self.logger.error(f"Error: {result.stderr}")
                return False

        except Exception as e:
            self.logger.error(f"❌ {step_name} failed with exception: {e}")
            return False

    def _check_output_exists(self, path: Path) -> bool:
        """Check if output file exists."""
        return path.exists() and path.stat().st_size > 0

    def _skip_if_exists(self, output_files: List[Path], step_name: str) -> bool:
        """Check if step should be skipped based on existing outputs.

        Returns:
            True if step should be skipped, False if it should run
        """
        if self.force:
            return False

        if not self.resume:
            return False

        all_exist = all(self._check_output_exists(f) for f in output_files)

        if all_exist:
            self.logger.info(f"⏭️  Skipping {step_name} (outputs exist, use --force to regenerate)")
            return True

        return False

    # ========== STEP 1: VALIDATE PREREQUISITES ==========

    def validate_prerequisites(self) -> bool:
        """Check plant config, data files, and determine SCADA date range."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 1: VALIDATE PREREQUISITES")
        self.logger.info("="*60)

        # Check plant config exists
        if not self.config_path.exists():
            self.logger.error(f"❌ Plant config not found: {self.config_path}")
            return False

        self.logger.info(f"✅ Plant config found: {self.config_path}")

        # Load config
        try:
            with open(self.config_path) as f:
                self.config = yaml.safe_load(f)
            self.logger.info(f"✅ Config loaded successfully")
        except Exception as e:
            self.logger.error(f"❌ Failed to load config: {e}")
            return False

        # Check data file exists
        data_path = Path(self.config['data']['source_path'])
        if not data_path.exists():
            self.logger.error(f"❌ Data file not found: {data_path}")
            return False

        self.logger.info(f"✅ Data file found: {data_path} ({data_path.stat().st_size / 1024 / 1024:.1f} MB)")

        # Check required columns (if specified)
        if 'columns' in self.config.get('data', {}):
            required_cols = self.config['data']['columns']
            self.logger.info(f"✅ Required columns defined: {list(required_cols.keys())}")

        # NEW: Extract SCADA date range
        self.logger.info("\n🔍 Determining SCADA data time range...")
        timestamp_col = self.config['data'].get('timestamp_column', 'timestamp')

        try:
            self.scada_start_date, self.scada_end_date = get_scada_date_range(
                data_path, timestamp_col
            )

            self.logger.info(f"✅ SCADA data range: {self.scada_start_date} to {self.scada_end_date}")

            # Calculate coverage
            from datetime import datetime
            start = datetime.fromisoformat(self.scada_start_date)
            end = datetime.fromisoformat(self.scada_end_date)
            days = (end - start).days
            years = days / 365.25

            self.logger.info(f"   Coverage: {days} days ({years:.2f} years)")

        except Exception as e:
            self.logger.error(f"❌ Failed to determine SCADA date range: {e}")
            return False

        self.completed_steps.add('prerequisites')
        return True

    # ========== STEP 2: DOWNLOAD EXTERNAL DATA ==========

    def download_external_data(self) -> bool:
        """Fetch rain, dust, AOD from Open-Meteo/CAMS."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 2/15: DOWNLOAD EXTERNAL DATA")
        self.logger.info("="*60)

        if 'external_data' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_files = [
            self.output_dir / 'rain_history.json',
            self.output_dir / 'dust_history.json',
            self.output_dir / 'cams_aod_history.json'
        ]

        if self._skip_if_exists(output_files, 'external data download'):
            self.completed_steps.add('external_data')
            return True

        # Fetch rain history (multi-year from Open-Meteo Archive)
        rain_cmd = [self.python_path, 'scripts/fetch_rain_history.py', '--plant-id', self.plant_id]
        if not self._run_command(rain_cmd, 'Rain history download'):
            return False

        # Fetch recent dust history (92 days from Open-Meteo Air Quality API)
        dust_cmd = [self.python_path, 'scripts/fetch_dust_history.py', '--plant-id', self.plant_id]
        if not self._run_command(dust_cmd, 'Recent dust history download'):
            return False

        # Fetch historical CAMS AOD data (multi-year from CAMS EAC4 reanalysis)
        # Calculate start year: 3 years ago from today
        from datetime import datetime
        start_year = datetime.now().year - 3

        self.logger.info(f"\n📡 Fetching historical AOD data from CAMS EAC4 ({start_year}-present)...")
        self.logger.info("⏳ This may take several minutes to download NetCDF data...")

        cams_cmd = [
            self.python_path, 'scripts/fetch_cams_historical_aod.py',
            '--plant-id', self.plant_id,
            '--start-year', str(start_year)
        ]
        if not self._run_command(cams_cmd, 'CAMS historical AOD download'):
            self.logger.warning("⚠️  CAMS AOD download failed - soiling models may not train properly")
            self.logger.warning("    Check that you have:")
            self.logger.warning("    1. Registered at https://ads.atmosphere.copernicus.eu/user/register")
            self.logger.warning("    2. Configured ~/.cdsapirc with your API credentials")
            self.logger.warning("    3. Installed: pip install cdsapi xarray netCDF4")
            return False

        # Create placeholder for rain_history_onsite.json if no on-site sensor
        onsite_path = self.output_dir / 'rain_history_onsite.json'
        if not onsite_path.exists():
            placeholder = {
                "metadata": {
                    "plant_id": self.plant_id,
                    "source": "No on-site rain sensor available",
                    "note": "Using Open-Meteo data instead"
                },
                "daily_data": []
            }
            if not self.dry_run:
                with open(onsite_path, 'w') as f:
                    json.dump(placeholder, f, indent=2)
                self.logger.info(f"✅ Created placeholder rain_history_onsite.json")

        self.completed_steps.add('external_data')
        return True

    # ========== STEP 3: EXTRACT SENSOR DATA ==========

    def extract_sensor_data(self) -> bool:
        """Extract DustIQ from parquet if available."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 3/15: EXTRACT SENSOR DATA")
        self.logger.info("="*60)

        if 'sensor_data' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_file = self.output_dir / 'dustiq_history.json'

        if self._skip_if_exists([output_file], 'sensor data extraction'):
            self.completed_steps.add('sensor_data')
            return True

        # Extract DustIQ
        cmd = [self.python_path, 'scripts/extract_dustiq_history.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'DustIQ extraction')

        if success:
            self.completed_steps.add('sensor_data')

        return success

    # ========== STEP 4: CALCULATE DAILY METRICS ==========

    def calculate_daily_metrics(self) -> bool:
        """Calculate daily PR and basic metrics."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 4/15: CALCULATE DAILY METRICS")
        self.logger.info("="*60)

        if 'daily_metrics' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_file = self.output_dir / 'time_series' / 'daily_pr.json'

        if self._skip_if_exists([output_file], 'daily metrics calculation'):
            self.completed_steps.add('daily_metrics')
            return True

        # Calculate daily PR
        cmd = [self.python_path, 'scripts/calculateDailyPR.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'Daily PR calculation')

        if success:
            self.completed_steps.add('daily_metrics')

        return success

    # ========== STEP 5: RUN RDTOOLS ANALYSIS ==========

    def run_rdtools_analysis(self) -> bool:
        """Run rdtools SRR analysis."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 5/15: RUN RDTOOLS ANALYSIS")
        self.logger.info("="*60)

        if 'rdtools' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_files = [
            self.output_dir / 'soiling_ratio_srr.json',
            self.output_dir / 'per_inverter' / 'all_inverters.json',
            self.output_dir / 'fleet_summary.json'
        ]

        if self._skip_if_exists(output_files, 'rdtools analysis'):
            self.completed_steps.add('rdtools')
            return True

        # Run RdTools SRR
        cmd = [self.python_path, 'scripts/calculateSoilingRatio_rdtools.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'RdTools SRR analysis')

        if not success:
            return False

        # Generate fleet analysis from rdtools output
        cmd_fleet = [self.python_path, 'scripts/generate_fleet_analysis_from_rdtools.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd_fleet, 'Fleet analysis generation')

        if success:
            self.completed_steps.add('rdtools')

        return success

    # ========== STEP 6: GENERATE SEASONAL FORECAST ==========

    def generate_seasonal_forecast(self) -> bool:
        """Generate seasonal soiling forecast."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 6/15: GENERATE SEASONAL FORECAST")
        self.logger.info("="*60)

        if 'seasonal_forecast' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_file = self.output_dir / 'seasonal_forecast_365d.json'

        if self._skip_if_exists([output_file], 'seasonal forecast generation'):
            self.completed_steps.add('seasonal_forecast')
            return True

        # Generate forecast
        cmd = [self.python_path, 'scripts/generateSeasonalForecast.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'Seasonal forecast generation')

        if success:
            self.completed_steps.add('seasonal_forecast')

        return success

    # ========== STEP 7: TRAIN DIGITAL TWIN ==========

    def train_digital_twin(self) -> bool:
        """Train hybrid physics+ML model."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 7/15: TRAIN DIGITAL TWIN")
        self.logger.info("="*60)

        if 'digital_twin' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_files = [
            self.output_dir.parent.parent / 'digitaltwin' / self.plant_id / 'timeline_heatmap_data.json',
            self.output_dir.parent.parent / 'digitaltwin' / self.plant_id / 'digital_twins_summary.json'
        ]

        if self._skip_if_exists(output_files, 'digital twin training'):
            self.completed_steps.add('digital_twin')
            return True

        # Train digital twin
        cmd = [self.python_path, 'scripts/train_plant_model.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'Digital twin training')

        if success:
            self.completed_steps.add('digital_twin')

        return success

    # ========== STEP 8: TRAIN FOUNDATION SOILING MODEL ==========

    def train_foundation_soiling_model(self) -> bool:
        """Train foundation SR model (requires DustIQ)."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 8/15: TRAIN FOUNDATION SOILING MODEL")
        self.logger.info("="*60)

        if 'foundation_soiling' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        # Check if DustIQ data exists
        dustiq_file = self.output_dir / 'dustiq_history.json'
        if not dustiq_file.exists():
            self.logger.warning("⚠️  No DustIQ data available, skipping foundation model training")
            return True

        output_file = self.models_dir / f'sr_foundation_{self.plant_id}.pkl'

        if self._skip_if_exists([output_file], 'foundation soiling model training'):
            self.completed_steps.add('foundation_soiling')
            return True

        # Train foundation model
        cmd = [self.python_path, 'scripts/train_sr_foundation_model.py', '--plant', self.plant_id]
        success = self._run_command(cmd, 'Foundation soiling model training')

        if success:
            self.completed_steps.add('foundation_soiling')

        return success

    # ========== STEP 9: TRAIN PER-INVERTER SOILING ==========

    def train_per_inverter_soiling(self) -> bool:
        """Train per-inverter SR models (dustiq + pseudo variants)."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 9/15: TRAIN PER-INVERTER SOILING")
        self.logger.info("="*60)

        if 'per_inverter_soiling' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_file = self.output_dir / 'per_inverter' / f'{self.plant_id}_per_inverter_sr.json'

        if self._skip_if_exists([output_file], 'per-inverter soiling training'):
            self.completed_steps.add('per_inverter_soiling')
            return True

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

        if success:
            self.completed_steps.add('per_inverter_soiling')

        return success

    # ========== STEP 10: TRAIN NODUSTIQ MODEL ==========

    def train_nodustiq_model(self) -> bool:
        """Train NoDustIQ ML soiling model."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 10/15: TRAIN NODUSTIQ MODEL")
        self.logger.info("="*60)

        if 'nodustiq' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_file = self.output_dir / 'ml_sr_predictions.json'

        if self._skip_if_exists([output_file], 'NoDustIQ model training'):
            self.completed_steps.add('nodustiq')
            return True

        # Train NoDustIQ model
        cmd = [self.python_path, 'scripts/train_nodustiq_model.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'NoDustIQ model training')

        if success:
            self.completed_steps.add('nodustiq')

        return success

    # ========== STEP 11: GENERATE FORECASTS ==========

    def generate_forecasts(self) -> bool:
        """Generate SR forecasts (365d + annual)."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 11/15: GENERATE FORECASTS")
        self.logger.info("="*60)

        if 'forecasts' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_files = [
            self.output_dir / 'forecast_365d.json',
            self.output_dir / 'annual_soiling_forecast.json'
        ]

        if self._skip_if_exists(output_files, 'forecast generation'):
            self.completed_steps.add('forecasts')
            return True

        # Generate forecasts
        cmd = [self.python_path, 'scripts/generate_sr_forecast.py',
               '--plant', self.plant_id, '--both']
        success = self._run_command(cmd, 'Forecast generation')

        if success:
            self.completed_steps.add('forecasts')

        return success

    # ========== STEP 12: RUN FAULT DETECTION ==========

    def run_fault_detection(self) -> bool:
        """Run fault detection and anomaly analysis."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 12/15: RUN FAULT DETECTION")
        self.logger.info("="*60)

        if 'fault_detection' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_file = self.faults_dir / 'fault_detection_results.json'

        if self._skip_if_exists([output_file], 'fault detection'):
            self.completed_steps.add('fault_detection')
            return True

        # Run fault detection
        cmd = [self.python_path, 'scripts/run_fault_detection.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'Fault detection')

        if success:
            self.completed_steps.add('fault_detection')

        return success

    # ========== STEP 13: GENERATE ANALYSIS SUMMARIES ==========

    def generate_analysis_summaries(self) -> bool:
        """Generate monthly summary and model comparison."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 13/15: GENERATE ANALYSIS SUMMARIES")
        self.logger.info("="*60)

        if 'analysis_summaries' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_files = [
            self.output_dir / 'monthly_summary.json',
            self.output_dir / 'model_comparison.json'
        ]

        if self._skip_if_exists(output_files, 'analysis summaries generation'):
            self.completed_steps.add('analysis_summaries')
            return True

        # Generate analysis summaries
        if self.dry_run:
            self.logger.info("[DRY RUN] Would generate analysis summaries")
            return True

        # TODO: Implement summary generation
        # For now, create placeholder files
        self.logger.warning("⚠️  Analysis summary generation not yet implemented, creating placeholders")

        monthly_summary = {
            "metadata": {
                "plant_id": self.plant_id,
                "generated_at": datetime.now().isoformat()
            },
            "monthly_data": []
        }

        model_comparison = {
            "metadata": {
                "plant_id": self.plant_id,
                "generated_at": datetime.now().isoformat()
            },
            "models": ["RdTools SRR", "DustIQ", "ML NoDustIQ"],
            "comparison": {}
        }

        with open(output_files[0], 'w') as f:
            json.dump(monthly_summary, f, indent=2)

        with open(output_files[1], 'w') as f:
            json.dump(model_comparison, f, indent=2)

        self.logger.info("✅ Created placeholder analysis summaries")
        self.completed_steps.add('analysis_summaries')
        return True

    # ========== STEP 14: GENERATE ECONOMIC ANALYSIS ==========

    def generate_economic_analysis(self) -> bool:
        """Generate operator proposal with placeholder costs."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 14/15: GENERATE ECONOMIC ANALYSIS")
        self.logger.info("="*60)

        if 'economic_analysis' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        output_file = self.output_dir / 'operator_proposal.json'

        if self._skip_if_exists([output_file], 'economic analysis generation'):
            self.completed_steps.add('economic_analysis')
            return True

        if self.dry_run:
            self.logger.info("[DRY RUN] Would generate economic analysis")
            return True

        # Generate economic analysis with placeholder costs
        self.logger.warning("⚠️  Using placeholder cost estimates")

        operator_proposal = {
            "metadata": {
                "plant_id": self.plant_id,
                "generated_at": datetime.now().isoformat(),
                "note": "Using estimated costs - update with actual values"
            },
            "cleaning_costs": {
                "cost_per_cleaning_eur": 500,
                "crew_size": 4,
                "cleaning_duration_hours": 4,
                "water_cost_eur": 50
            },
            "recommendations": {
                "optimal_frequency_days": 60,
                "estimated_annual_cleanings": 6,
                "estimated_annual_cost_eur": 3000
            }
        }

        with open(output_file, 'w') as f:
            json.dump(operator_proposal, f, indent=2)

        self.logger.info("✅ Created operator proposal with placeholder costs")
        self.completed_steps.add('economic_analysis')
        return True

    # ========== STEP 15: VALIDATE ALL OUTPUTS ==========

    def validate_all_outputs(self) -> bool:
        """Verify output quality and completeness."""
        self.logger.info("\n" + "="*60)
        self.logger.info("STEP 15/15: VALIDATE ALL OUTPUTS")
        self.logger.info("="*60)

        if 'validation' not in self.steps_to_run:
            self.logger.info("⏭️  Skipping (not in selected steps)")
            return True

        if self.dry_run:
            self.logger.info("[DRY RUN] Would validate all outputs")
            return True

        # Expected files
        expected_files = [
            # External data
            self.output_dir / 'rain_history.json',
            self.output_dir / 'rain_history.csv',
            self.output_dir / 'dust_history.json',
            self.output_dir / 'cams_aod_history.json',
            self.output_dir / 'dustiq_history.json',

            # Metrics (Parquet format for performance)
            self.output_dir / 'pr_daily.parquet',

            # Soiling analysis
            self.output_dir / 'soiling_ratio_srr.json',
            self.output_dir / 'per_inverter' / 'all_inverters.json',
            self.output_dir / 'fleet_summary.json',
            self.output_dir / 'seasonal_forecast_365d.json',

            # ML predictions
            self.output_dir / 'ml_sr_predictions.json',

            # Forecasts
            self.output_dir / 'forecast_365d.json',
            self.output_dir / 'annual_soiling_forecast.json',

            # Analysis
            self.output_dir / 'monthly_summary.json',
            self.output_dir / 'model_comparison.json',
            self.output_dir / 'operator_proposal.json',

            # Digital twin
            self.output_dir.parent.parent / 'digitaltwin' / self.plant_id / 'timeline_heatmap_data.json',
            self.output_dir.parent.parent / 'digitaltwin' / self.plant_id / 'digital_twins_summary.json',

            # Faults
            self.faults_dir / 'fault_detection_results.json'
        ]

        # Check file existence
        missing_files = []
        existing_files = []

        for file_path in expected_files:
            if self._check_output_exists(file_path):
                existing_files.append(file_path)
            else:
                missing_files.append(file_path)

        # Report results
        self.logger.info(f"\n📊 Validation Results:")
        self.logger.info(f"  ✅ Existing files: {len(existing_files)}/{len(expected_files)}")
        self.logger.info(f"  ❌ Missing files: {len(missing_files)}/{len(expected_files)}")

        if missing_files:
            self.logger.warning("\n⚠️  Missing files:")
            for file_path in missing_files:
                self.logger.warning(f"    - {file_path.relative_to(self.project_root)}")

        # Calculate total data size
        total_size = sum(f.stat().st_size for f in existing_files)
        self.logger.info(f"\n💾 Total data size: {total_size / 1024 / 1024:.1f} MB")

        self.completed_steps.add('validation')
        return len(missing_files) == 0

    # ========== MAIN ORCHESTRATION ==========

    def run(self) -> bool:
        """Execute the complete onboarding pipeline.

        Returns:
            True if all steps completed successfully, False otherwise
        """
        start_time = datetime.now()

        self.logger.info("\n" + "="*70)
        self.logger.info(f"🚀 PLANT ONBOARDING: {self.plant_id.upper()}")
        self.logger.info("="*70)
        self.logger.info(f"Mode: {'DRY RUN' if self.dry_run else 'EXECUTION'}")
        self.logger.info(f"Force regenerate: {self.force}")
        self.logger.info(f"Resume mode: {self.resume}")
        self.logger.info(f"Domains to run: {', '.join(self.steps_to_run)}")
        self.logger.info("="*70)

        # Step 1: Validate prerequisites & extract SCADA date range
        if not self.validate_prerequisites():
            self.logger.error("❌ Prerequisites validation failed")
            return False

        # Step 2: Delegate to domain-specific onboarders (sequential execution)

        # Soiling onboarding (9 steps: external_data → forecasts)
        if 'soiling' in self.steps_to_run:
            self.logger.info("\n" + "="*70)
            self.logger.info("DOMAIN: SOILING ANALYSIS")
            self.logger.info("="*70)

            try:
                soiling_onboarder = SoilingOnboarder(
                    plant_id=self.plant_id,
                    start_date=self.scada_start_date,
                    end_date=self.scada_end_date
                )

                if soiling_onboarder.run():
                    self.completed_steps.add('soiling')
                    self.logger.info("✅ Soiling onboarding completed")
                else:
                    self.failed_steps.append('soiling')
                    self.logger.error("❌ Soiling onboarding failed")
            except Exception as e:
                self.failed_steps.append('soiling')
                self.logger.error(f"❌ Soiling onboarding failed with exception: {e}")

        # Digital twin onboarding (1 step)
        if 'digital_twin' in self.steps_to_run:
            self.logger.info("\n" + "="*70)
            self.logger.info("DOMAIN: DIGITAL TWIN")
            self.logger.info("="*70)

            try:
                dt_onboarder = DigitalTwinOnboarder(self.plant_id)

                if dt_onboarder.run():
                    self.completed_steps.add('digital_twin')
                    self.logger.info("✅ Digital twin onboarding completed")
                else:
                    self.failed_steps.append('digital_twin')
                    self.logger.error("❌ Digital twin onboarding failed")
            except Exception as e:
                self.failed_steps.append('digital_twin')
                self.logger.error(f"❌ Digital twin onboarding failed with exception: {e}")

        # Fault detection onboarding (1 step)
        if 'faults' in self.steps_to_run:
            self.logger.info("\n" + "="*70)
            self.logger.info("DOMAIN: FAULT DETECTION")
            self.logger.info("="*70)

            try:
                fault_onboarder = FaultOnboarder(self.plant_id)

                if fault_onboarder.run():
                    self.completed_steps.add('faults')
                    self.logger.info("✅ Fault detection onboarding completed")
                else:
                    self.failed_steps.append('faults')
                    self.logger.error("❌ Fault detection onboarding failed")
            except Exception as e:
                self.failed_steps.append('faults')
                self.logger.error(f"❌ Fault detection onboarding failed with exception: {e}")

        # Step 3: Analysis & validation (after all domains)
        if 'soiling' in self.completed_steps:
            self.logger.info("\n" + "="*70)
            self.logger.info("POST-PROCESSING: ANALYSIS & VALIDATION")
            self.logger.info("="*70)

            # Generate analysis summaries
            try:
                if self.generate_analysis_summaries():
                    self.logger.info("✅ Analysis summaries generated")
                else:
                    self.logger.warning("⚠️  Analysis summaries generation failed")
            except Exception as e:
                self.logger.error(f"❌ Analysis summaries failed: {e}")

            # Generate economic analysis
            try:
                if self.generate_economic_analysis():
                    self.logger.info("✅ Economic analysis generated")
                else:
                    self.logger.warning("⚠️  Economic analysis generation failed")
            except Exception as e:
                self.logger.error(f"❌ Economic analysis failed: {e}")

        # Validate all outputs
        self.validate_all_outputs()

        # Final summary
        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()

        self.logger.info("\n" + "="*70)
        self.logger.info("📊 ONBOARDING SUMMARY")
        self.logger.info("="*70)
        self.logger.info(f"Plant: {self.plant_id}")
        self.logger.info(f"Duration: {duration:.1f}s ({duration/60:.1f} min)")
        self.logger.info(f"Completed domains: {len(self.completed_steps)}/{len(self.steps_to_run)}")

        if self.failed_steps:
            self.logger.error(f"❌ Failed domains: {len(self.failed_steps)}")
            for domain in self.failed_steps:
                self.logger.error(f"  - {domain}")
            self.logger.info("\n⚠️  ONBOARDING INCOMPLETE")
            return False
        else:
            self.logger.info("✅ ALL DOMAINS COMPLETED SUCCESSFULLY")
            return True


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Complete onboarding script for solar plants',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full onboarding (all domains)
  python scripts/onboard_plant.py --plant-id eta

  # Dry run (show what would execute)
  python scripts/onboard_plant.py --plant-id eta --dry-run

  # Force regenerate everything
  python scripts/onboard_plant.py --plant-id eta --force

  # Run specific domains only
  python scripts/onboard_plant.py --plant-id eta --steps soiling,digital_twin

  # Only soiling domain
  python scripts/onboard_plant.py --plant-id eta --steps soiling

  # Resume (skip completed steps)
  python scripts/onboard_plant.py --plant-id eta --resume

Domain Groups:
  soiling           - Soiling analysis (external data, rdtools, seasonal forecast, foundation model, per-inverter, nodustiq, forecasts)
  digital_twin      - Digital twin training (hybrid physics+ML model)
  faults            - Fault detection (anomaly analysis)
  all               - All domains (default)
        """
    )

    parser.add_argument('--plant-id', required=True,
                       help='Plant identifier (e.g., eta, ribera, alpha1)')
    parser.add_argument('--dry-run', action='store_true',
                       help='Show what would be executed without running commands')
    parser.add_argument('--force', action='store_true',
                       help='Force regenerate existing outputs')
    parser.add_argument('--resume', action='store_true',
                       help='Skip domains with existing outputs')
    parser.add_argument('--steps', type=str,
                       help='Comma-separated list of domains to run (soiling, digital_twin, faults) (default: all)')

    args = parser.parse_args()

    # Parse domains (keeping --steps arg name for compatibility)
    steps = None
    if args.steps:
        steps = [s.strip() for s in args.steps.split(',')]

    # Create onboarder
    onboarder = PlantOnboarder(
        plant_id=args.plant_id,
        dry_run=args.dry_run,
        force=args.force,
        resume=args.resume,
        steps=steps
    )

    # Run onboarding
    success = onboarder.run()

    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
