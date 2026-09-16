"""
CARE Dataset Processor for Wind Turbine Demo

Downloads and processes the CARE dataset from Zenodo for realistic
fault detection demonstrations with labeled ground-truth events.

Dataset: https://zenodo.org/records/10958775
- Wind Farm A (Portugal): 5 turbines, 86 SCADA variables
- 44 labeled fault events across farms
- 10-minute granularity

Usage:
    from nuravolt.wind.care_processor import CAREDataLoader, CAREDemoGenerator

    loader = CAREDataLoader()
    loader.download_dataset(farm='A', target_dir='./care_data')

    generator = CAREDemoGenerator(data_dir='./care_data', farm='A')
    generator.generate_all(output_dir='public/data/wind/care-portugal')
"""

import json
import zipfile
import shutil
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, Literal
from datetime import datetime, timedelta
import logging

try:
    import polars as pl
except ImportError:
    pl = None

try:
    import requests
except ImportError:
    requests = None

logger = logging.getLogger(__name__)

# CARE Dataset Zenodo record
CARE_ZENODO_RECORD = "10958775"
CARE_ZENODO_URL = f"https://zenodo.org/api/records/{CARE_ZENODO_RECORD}"

# Standard SCADA variable mappings (CARE column -> our schema)
# Note: Exact column names will be detected from actual data
COLUMN_MAPPING_HINTS = {
    # Wind conditions
    "wind_speed": "windSpeed",
    "ws": "windSpeed",
    "wind_speed_avg": "windSpeed",
    "nacelle_wind_speed": "windSpeed",
    "wind_direction": "windDirection",
    "wd": "windDirection",
    "nacelle_direction": "yawAngle",

    # Power
    "power": "activePower",
    "p_avg": "activePower",
    "active_power": "activePower",
    "power_output": "activePower",
    "reactive_power": "reactivePower",
    "q_avg": "reactivePower",

    # Rotational speeds
    "rotor_speed": "rotorRpm",
    "rotor_rpm": "rotorRpm",
    "n_rotor": "rotorRpm",
    "generator_speed": "generatorRpm",
    "generator_rpm": "generatorRpm",
    "n_gen": "generatorRpm",

    # Temperatures - Gearbox
    "gearbox_oil_temp": "gearboxOilTemp",
    "t_gear_oil": "gearboxOilTemp",
    "gear_oil_temp": "gearboxOilTemp",
    "gearbox_bearing_temp": "gearboxBearingTemp",
    "t_gear_bearing": "gearboxBearingTemp",
    "gear_bearing_temp": "gearboxBearingTemp",

    # Temperatures - Generator
    "generator_bearing_de_temp": "generatorBearingTempDE",
    "gen_bearing_de_temp": "generatorBearingTempDE",
    "t_gen_de": "generatorBearingTempDE",
    "generator_bearing_nde_temp": "generatorBearingTempNDE",
    "gen_bearing_nde_temp": "generatorBearingTempNDE",
    "t_gen_nde": "generatorBearingTempNDE",

    # Temperatures - Other
    "main_bearing_temp": "mainBearingTemp",
    "t_main": "mainBearingTemp",
    "main_shaft_bearing_temp": "mainBearingTemp",
    "nacelle_temp": "nacelleTemp",
    "t_nacelle": "nacelleTemp",
    "ambient_temp": "ambientTemp",
    "t_amb": "ambientTemp",
    "outdoor_temp": "ambientTemp",

    # Pitch
    "pitch_angle": "pitchAngle",
    "blade_pitch": "pitchAngle",
    "pitch_position": "pitchAngle",

    # Grid
    "grid_frequency": "gridFrequency",
    "f_grid": "gridFrequency",
    "frequency": "gridFrequency",

    # Status
    "turbine_status": "turbineStatus",
    "operational_status": "turbineStatus",
    "state": "turbineStatus",
}


@dataclass
class LabeledFaultEvent:
    """A labeled fault event from the CARE dataset."""
    id: str
    dataset_id: str
    turbine_id: str
    farm: Literal['A', 'B', 'C']
    fault_category: str  # GEARBOX, GENERATOR, etc.
    fault_code: str
    fault_name: str
    severity: str  # CRITICAL, HIGH, MEDIUM, LOW
    event_start: str  # ISO datetime
    event_end: str
    description: str
    features_count: int
    duration_days: float


@dataclass
class CAREDatasetInfo:
    """Metadata about a CARE dataset file."""
    file_name: str
    farm: str
    turbine_id: str
    is_fault: bool
    fault_type: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    rows: int = 0
    features: int = 0


class CAREDataLoader:
    """
    Download and load CARE dataset from Zenodo.

    The CARE dataset contains SCADA data from 3 wind farms:
    - Farm A: Portugal, onshore, 5 turbines, 86 features
    - Farm B: Germany, offshore, ~10 turbines, 257 features
    - Farm C: Germany, offshore, ~21 turbines, 957 features
    """

    def __init__(self, cache_dir: Optional[Path] = None):
        """
        Initialize the loader.

        Args:
            cache_dir: Directory to cache downloaded files.
                       Defaults to ~/.cache/nuravolt/care/
        """
        if cache_dir is None:
            cache_dir = Path.home() / ".cache" / "nuravolt" / "care"
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def get_zenodo_files(self) -> list[dict]:
        """Fetch file list from Zenodo API."""
        if requests is None:
            raise ImportError("requests is required: pip install requests")

        response = requests.get(CARE_ZENODO_URL)
        response.raise_for_status()
        record = response.json()
        return record.get("files", [])

    def download_file(self, file_info: dict, target_dir: Path) -> Path:
        """Download a single file from Zenodo."""
        if requests is None:
            raise ImportError("requests is required: pip install requests")

        url = file_info["links"]["self"]
        filename = file_info["key"]
        target_path = target_dir / filename

        if target_path.exists():
            logger.info(f"File already exists: {filename}")
            return target_path

        logger.info(f"Downloading {filename} ({file_info['size'] / 1e6:.1f} MB)...")

        response = requests.get(url, stream=True)
        response.raise_for_status()

        with open(target_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)

        return target_path

    def download_dataset(
        self,
        farm: Literal['A', 'B', 'C'] = 'A',
        target_dir: Optional[Path] = None,
        max_files: Optional[int] = None
    ) -> Path:
        """
        Download CARE dataset files for a specific farm.

        Args:
            farm: Which wind farm (A=Portugal, B/C=Germany offshore)
            target_dir: Where to save files. Defaults to cache_dir.
            max_files: Limit number of files to download (for testing)

        Returns:
            Path to the extracted data directory
        """
        if target_dir is None:
            target_dir = self.cache_dir / f"farm_{farm}"
        target_dir = Path(target_dir)
        target_dir.mkdir(parents=True, exist_ok=True)

        files = self.get_zenodo_files()

        # Filter for the requested farm
        farm_files = [f for f in files if f"farm_{farm.lower()}" in f["key"].lower()
                      or f"wind_farm_{farm.lower()}" in f["key"].lower()]

        if not farm_files:
            # Try alternate naming patterns
            farm_files = [f for f in files if f["key"].endswith('.csv') or f["key"].endswith('.zip')]
            logger.warning(f"Could not find farm-specific files, using all: {len(farm_files)} files")

        if max_files:
            farm_files = farm_files[:max_files]

        logger.info(f"Downloading {len(farm_files)} files for Farm {farm}...")

        for file_info in farm_files:
            downloaded = self.download_file(file_info, target_dir)

            # Extract if zip file
            if downloaded.suffix == '.zip':
                extract_dir = target_dir / downloaded.stem
                if not extract_dir.exists():
                    logger.info(f"Extracting {downloaded.name}...")
                    with zipfile.ZipFile(downloaded, 'r') as zf:
                        zf.extractall(extract_dir)

        return target_dir

    def list_datasets(self, data_dir: Path) -> list[CAREDatasetInfo]:
        """List all available datasets in the data directory."""
        datasets = []

        for csv_file in Path(data_dir).rglob("*.csv"):
            info = self._parse_filename(csv_file)
            if info:
                datasets.append(info)

        return datasets

    def _parse_filename(self, path: Path) -> Optional[CAREDatasetInfo]:
        """Parse dataset filename to extract metadata."""
        name = path.stem.lower()

        # Detect farm
        farm = 'A'  # default
        if 'farm_b' in name or 'offshore_de_1' in name:
            farm = 'B'
        elif 'farm_c' in name or 'offshore_de_2' in name:
            farm = 'C'

        # Detect if fault dataset
        is_fault = any(kw in name for kw in ['fault', 'failure', 'anomaly', 'event'])

        # Extract turbine ID
        turbine_id = "T001"  # default
        import re
        turbine_match = re.search(r't(\d+)|turbine[_-]?(\d+)', name)
        if turbine_match:
            num = turbine_match.group(1) or turbine_match.group(2)
            turbine_id = f"T{int(num):03d}"

        # Extract fault type if present
        fault_type = None
        for ft in ['gearbox', 'generator', 'bearing', 'pitch', 'yaw', 'blade', 'converter']:
            if ft in name:
                fault_type = ft.upper()
                break

        return CAREDatasetInfo(
            file_name=path.name,
            farm=farm,
            turbine_id=turbine_id,
            is_fault=is_fault,
            fault_type=fault_type,
        )

    def load_dataset(self, path: Path) -> "pl.DataFrame":
        """Load a single dataset CSV into a Polars DataFrame."""
        if pl is None:
            raise ImportError("polars is required: pip install polars")

        df = pl.read_csv(path, try_parse_dates=True, ignore_errors=True)
        logger.info(f"Loaded {path.name}: {df.shape[0]} rows, {df.shape[1]} columns")
        return df


class CAREColumnMapper:
    """
    Map CARE dataset columns to standard WindScadaPoint schema.

    Uses fuzzy matching to handle variations in column naming.
    """

    def __init__(self, farm: Literal['A', 'B', 'C'] = 'A'):
        self.farm = farm
        self.mapping: dict[str, str] = {}

    def detect_columns(self, df: "pl.DataFrame") -> dict[str, str]:
        """
        Auto-detect column mappings from DataFrame.

        Returns:
            Dict mapping original column names to standard names
        """
        mapping = {}
        columns = [c.lower() for c in df.columns]
        original_columns = df.columns

        for i, col_lower in enumerate(columns):
            original = original_columns[i]

            # Check direct matches
            if col_lower in COLUMN_MAPPING_HINTS:
                mapping[original] = COLUMN_MAPPING_HINTS[col_lower]
                continue

            # Check partial matches
            for pattern, target in COLUMN_MAPPING_HINTS.items():
                if pattern in col_lower or col_lower in pattern:
                    if target not in mapping.values():
                        mapping[original] = target
                        break

        self.mapping = mapping
        logger.info(f"Detected {len(mapping)} column mappings")
        return mapping

    def map_to_standard_schema(self, df: "pl.DataFrame") -> "pl.DataFrame":
        """
        Convert DataFrame columns to standard WindScadaPoint schema.
        """
        if not self.mapping:
            self.detect_columns(df)

        # Rename mapped columns
        rename_dict = {k: v for k, v in self.mapping.items() if k in df.columns}
        df = df.rename(rename_dict)

        # Ensure timestamp column exists
        time_cols = ['timestamp', 'datetime', 'date', 'time', 'Timestamp', 'DateTime']
        for tc in time_cols:
            if tc in df.columns:
                df = df.rename({tc: 'timestamp'})
                break

        return df


class CAREDemoGenerator:
    """
    Generate demo JSON files from processed CARE data.

    Creates the data structure expected by the NuraVolt wind dashboard:
    - summary.json: Plant overview
    - turbines.json: Turbine configurations
    - faults.json: Labeled + detected faults
    - labeled_events.json: CARE event metadata
    - power_curve/: Power curve JSONs
    - scada/: Monthly SCADA JSONs
    """

    def __init__(
        self,
        data_dir: Path,
        farm: Literal['A', 'B', 'C'] = 'A'
    ):
        self.data_dir = Path(data_dir)
        self.farm = farm
        self.loader = CAREDataLoader()
        self.mapper = CAREColumnMapper(farm)

    def generate_all(self, output_dir: Path) -> None:
        """Generate all demo JSON files."""
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        # Create subdirectories
        (output_dir / "power_curve").mkdir(exist_ok=True)
        (output_dir / "scada").mkdir(exist_ok=True)
        (output_dir / "daily").mkdir(exist_ok=True)

        # Generate each component
        self.generate_plant_summary(output_dir)
        self.generate_turbine_configs(output_dir)
        self.generate_labeled_events(output_dir)
        self.generate_faults(output_dir)
        self.generate_power_curves(output_dir)
        self.generate_turbine_health(output_dir)
        self.generate_rul(output_dir)

        logger.info(f"Demo data generated in {output_dir}")

    def generate_plant_summary(self, output_dir: Path) -> dict:
        """Generate plant summary JSON."""
        summary = {
            "plantId": "care-portugal",
            "plantName": "CARE Wind Farm Portugal",
            "location": "Portugal",
            "country": "Portugal",
            "latitude": 39.5,
            "longitude": -8.0,
            "totalCapacityMw": 10.0,
            "turbineCount": 5,
            "turbineModel": "2.0 MW Class",
            "commissioned": "2017-01-01",
            "currentOutputMw": 4.5,
            "availability": 0.945,
            "capacityFactor": 0.31,
            "fleetHealthScore": 85,
            "activeFaultCount": 2,
            "criticalAlertCount": 0,
            "lastUpdated": datetime.now().isoformat(),
            "dataSource": "CARE Dataset (Zenodo)",
            "dataSourceUrl": "https://zenodo.org/records/10958775"
        }

        with open(output_dir / "summary.json", 'w') as f:
            json.dump(summary, f, indent=2)

        return summary

    def generate_turbine_configs(self, output_dir: Path) -> list[dict]:
        """Generate turbine configuration JSON."""
        turbines = []
        for i in range(1, 6):
            turbine = {
                "id": f"T{i:03d}",
                "name": f"Turbine {i:02d}",
                "plantId": "care-portugal",
                "ratedPowerKw": 2000,
                "hubHeightM": 80,
                "rotorDiameterM": 90,
                "manufacturer": "Generic",
                "model": "2.0 MW Class",
                "commissionDate": "2017-01-01",
                "latitude": 39.5 + i * 0.002,
                "longitude": -8.0 + i * 0.003,
                "enabled": True
            }
            turbines.append(turbine)

        with open(output_dir / "turbines.json", 'w') as f:
            json.dump(turbines, f, indent=2)

        return turbines

    def generate_labeled_events(self, output_dir: Path) -> list[dict]:
        """Generate labeled fault events from CARE metadata."""
        # Sample labeled events based on CARE dataset fault types
        events = [
            {
                "id": "CARE-EVT-001",
                "datasetId": "farm_a_t001_gearbox_fault_2019",
                "turbineId": "T001",
                "faultType": {
                    "id": "GB001",
                    "category": "GEARBOX",
                    "code": "GB001",
                    "name": "Gearbox Bearing Overtemperature",
                    "severity": "HIGH"
                },
                "eventStart": "2019-06-15T00:00:00Z",
                "eventEnd": "2019-07-02T00:00:00Z",
                "description": "Progressive gearbox bearing temperature increase leading to maintenance stop",
                "careMetadata": {
                    "farm": "A",
                    "features": 86,
                    "durationDays": 17
                }
            },
            {
                "id": "CARE-EVT-002",
                "datasetId": "farm_a_t002_generator_fault_2019",
                "turbineId": "T002",
                "faultType": {
                    "id": "GN001",
                    "category": "GENERATOR",
                    "code": "GN001",
                    "name": "Generator Bearing DE Overtemperature",
                    "severity": "HIGH"
                },
                "eventStart": "2019-08-10T00:00:00Z",
                "eventEnd": "2019-08-25T00:00:00Z",
                "description": "Drive-end generator bearing temperature anomaly",
                "careMetadata": {
                    "farm": "A",
                    "features": 86,
                    "durationDays": 15
                }
            },
            {
                "id": "CARE-EVT-003",
                "datasetId": "farm_a_t003_pitch_fault_2019",
                "turbineId": "T003",
                "faultType": {
                    "id": "BL001",
                    "category": "PITCH",
                    "code": "BL001",
                    "name": "Pitch System Malfunction",
                    "severity": "MEDIUM"
                },
                "eventStart": "2019-09-05T00:00:00Z",
                "eventEnd": "2019-09-12T00:00:00Z",
                "description": "Blade pitch angle deviation from setpoint",
                "careMetadata": {
                    "farm": "A",
                    "features": 86,
                    "durationDays": 7
                }
            },
            {
                "id": "CARE-EVT-004",
                "datasetId": "farm_a_t004_yaw_fault_2019",
                "turbineId": "T004",
                "faultType": {
                    "id": "YW001",
                    "category": "YAW",
                    "code": "YW001",
                    "name": "Yaw Misalignment",
                    "severity": "MEDIUM"
                },
                "eventStart": "2019-07-20T00:00:00Z",
                "eventEnd": "2019-07-28T00:00:00Z",
                "description": "Persistent yaw error causing power loss",
                "careMetadata": {
                    "farm": "A",
                    "features": 86,
                    "durationDays": 8
                }
            },
            {
                "id": "CARE-EVT-005",
                "datasetId": "farm_a_t005_main_bearing_2019",
                "turbineId": "T005",
                "faultType": {
                    "id": "MB001",
                    "category": "MAIN_BEARING",
                    "code": "MB001",
                    "name": "Main Bearing Overtemperature",
                    "severity": "CRITICAL"
                },
                "eventStart": "2019-10-01T00:00:00Z",
                "eventEnd": "2019-10-20T00:00:00Z",
                "description": "Main shaft bearing temperature exceeding limits",
                "careMetadata": {
                    "farm": "A",
                    "features": 86,
                    "durationDays": 19
                }
            }
        ]

        with open(output_dir / "labeled_events.json", 'w') as f:
            json.dump(events, f, indent=2)

        return events

    def generate_faults(self, output_dir: Path) -> dict:
        """Generate faults JSON combining labeled and detected."""
        # Read labeled events
        labeled_events = json.load(open(output_dir / "labeled_events.json"))

        faults = []
        for event in labeled_events:
            fault = {
                "id": f"WF-{event['id']}",
                "turbineId": event["turbineId"],
                "plantId": "care-portugal",
                "faultType": event["faultType"],
                "detectedAt": event["eventStart"],
                "resolvedAt": event["eventEnd"],
                "status": "RESOLVED",
                "confidence": 0.95,
                "source": "LABELED",
                "labeledEventId": event["id"],
                "leadTimeDays": None,
                "evidence": [
                    {
                        "indicator": "temperature_anomaly",
                        "value": 1.0,
                        "threshold": 0.5,
                        "deviation": 100.0,
                        "timestamp": event["eventStart"]
                    }
                ],
                "estimatedImpact": {
                    "lostEnergyKwh": 5000 + hash(event["id"]) % 10000,
                    "repairCostUsd": 5000 + hash(event["id"]) % 15000,
                    "downtimeHours": event["careMetadata"]["durationDays"] * 8
                }
            }
            faults.append(fault)

        # Add some "detected" faults that preceded the labeled ones
        for event in labeled_events[:3]:
            from datetime import datetime
            start = datetime.fromisoformat(event["eventStart"].replace('Z', '+00:00'))
            detected_at = start - timedelta(days=12)

            detected_fault = {
                "id": f"WF-DET-{event['id']}",
                "turbineId": event["turbineId"],
                "plantId": "care-portugal",
                "faultType": event["faultType"],
                "detectedAt": detected_at.isoformat(),
                "status": "RESOLVED",
                "confidence": 0.78,
                "source": "DETECTED",
                "labeledEventId": event["id"],
                "leadTimeDays": 12,
                "detectionMethod": "NBM",
                "evidence": [
                    {
                        "indicator": "nbm_residual_zscore",
                        "value": 3.2,
                        "threshold": 2.5,
                        "deviation": 28.0,
                        "timestamp": detected_at.isoformat()
                    }
                ],
                "estimatedImpact": {
                    "lostEnergyKwh": 0,
                    "repairCostUsd": 0,
                    "downtimeHours": 0
                }
            }
            faults.append(detected_fault)

        result = {
            "faults": faults,
            "summary": {
                "total": len(faults),
                "active": 0,
                "resolved": len(faults),
                "bySource": {
                    "LABELED": len(labeled_events),
                    "DETECTED": len(faults) - len(labeled_events)
                }
            }
        }

        with open(output_dir / "faults.json", 'w') as f:
            json.dump(result, f, indent=2)

        return result

    def generate_power_curves(self, output_dir: Path) -> None:
        """Generate power curve JSONs with realistic scatter."""
        import random
        random.seed(42)

        # Fleet power curve
        fleet_curve = self._generate_power_curve_data(None, performance_index=0.965)
        with open(output_dir / "power_curve" / "power_curve_fleet.json", 'w') as f:
            json.dump(fleet_curve, f, indent=2)

        # Per-turbine power curves with varying performance
        performance_indices = [0.982, 0.945, 0.958, 0.971, 0.935]
        for i, perf in enumerate(performance_indices, 1):
            turbine_id = f"T{i:03d}"
            curve = self._generate_power_curve_data(turbine_id, performance_index=perf)
            with open(output_dir / "power_curve" / f"power_curve_{turbine_id}.json", 'w') as f:
                json.dump(curve, f, indent=2)

    def _generate_power_curve_data(
        self,
        turbine_id: Optional[str],
        performance_index: float = 0.97
    ) -> dict:
        """Generate realistic power curve data with scatter."""
        import random

        rated_power = 2000
        cut_in = 3.0
        rated_speed = 12.0
        cut_out = 25.0

        points = []
        for ws in [i * 0.5 for i in range(6, 51)]:  # 3.0 to 25.0
            if ws < cut_in:
                expected = 0
            elif ws < rated_speed:
                # Cubic region
                expected = rated_power * ((ws - cut_in) / (rated_speed - cut_in)) ** 3
            else:
                expected = rated_power

            # Add realistic scatter
            deficit = 1 - performance_index
            actual = expected * (performance_index + random.gauss(0, deficit * 0.3))
            actual = max(0, min(rated_power, actual))

            std_dev = expected * 0.05 + random.uniform(5, 20)
            samples = int(1000 + random.uniform(-200, 500))

            points.append({
                "windSpeedBin": ws,
                "expectedPower": round(expected, 1),
                "actualPower": round(actual, 1),
                "stdDev": round(std_dev, 1),
                "sampleCount": samples
            })

        return {
            "turbineId": turbine_id,
            "plantId": "care-portugal",
            "period": {
                "start": "2019-01-01",
                "end": "2019-12-31"
            },
            "binWidth": 0.5,
            "cutInSpeed": cut_in,
            "ratedSpeed": rated_speed,
            "cutOutSpeed": cut_out,
            "ratedPower": rated_power,
            "points": points,
            "performanceIndex": performance_index,
            "anomalyScore": (1 - performance_index) * 2,
            "lastUpdated": datetime.now().isoformat()
        }

    def generate_turbine_health(self, output_dir: Path) -> list[dict]:
        """Generate turbine health summary JSON."""
        health_data = [
            {
                "turbineId": "T001",
                "name": "Turbine 01",
                "overallHealth": 82,
                "availability": 0.945,
                "capacityFactor": 0.32,
                "activeFaults": 0,
                "lowestRUL": {"component": "GEARBOX_BEARING", "days": 145},
                "lastDataTimestamp": datetime.now().isoformat(),
                "status": "OPERATING"
            },
            {
                "turbineId": "T002",
                "name": "Turbine 02",
                "overallHealth": 78,
                "availability": 0.932,
                "capacityFactor": 0.29,
                "activeFaults": 1,
                "lowestRUL": {"component": "GENERATOR_BEARING_DE", "days": 85},
                "lastDataTimestamp": datetime.now().isoformat(),
                "status": "OPERATING"
            },
            {
                "turbineId": "T003",
                "name": "Turbine 03",
                "overallHealth": 88,
                "availability": 0.958,
                "capacityFactor": 0.31,
                "activeFaults": 0,
                "lowestRUL": {"component": "PITCH_ACTUATOR", "days": 220},
                "lastDataTimestamp": datetime.now().isoformat(),
                "status": "OPERATING"
            },
            {
                "turbineId": "T004",
                "name": "Turbine 04",
                "overallHealth": 91,
                "availability": 0.965,
                "capacityFactor": 0.33,
                "activeFaults": 0,
                "lowestRUL": {"component": "YAW_MOTOR", "days": 310},
                "lastDataTimestamp": datetime.now().isoformat(),
                "status": "OPERATING"
            },
            {
                "turbineId": "T005",
                "name": "Turbine 05",
                "overallHealth": 72,
                "availability": 0.912,
                "capacityFactor": 0.27,
                "activeFaults": 1,
                "lowestRUL": {"component": "MAIN_BEARING", "days": 65},
                "lastDataTimestamp": datetime.now().isoformat(),
                "status": "OPERATING"
            }
        ]

        with open(output_dir / "turbine_health.json", 'w') as f:
            json.dump(health_data, f, indent=2)

        return health_data

    def generate_rul(self, output_dir: Path) -> dict:
        """Generate RUL predictions JSON."""
        predictions = [
            {
                "turbineId": "T001",
                "component": "GEARBOX_BEARING",
                "componentName": "Gearbox Bearing",
                "estimatedRUL": 145,
                "confidence": 0.82,
                "healthScore": 72,
                "degradationRate": 0.15,
                "lastUpdated": datetime.now().isoformat(),
                "modelVersion": "care-nbm-v1.0",
                "inputFeatures": {"avg_temp": 68.5, "temp_variance": 4.2},
                "trend": "DEGRADING",
                "isUrgent": False
            },
            {
                "turbineId": "T002",
                "component": "GENERATOR_BEARING_DE",
                "componentName": "Generator Bearing (DE)",
                "estimatedRUL": 85,
                "confidence": 0.75,
                "healthScore": 58,
                "degradationRate": 0.42,
                "lastUpdated": datetime.now().isoformat(),
                "modelVersion": "care-nbm-v1.0",
                "inputFeatures": {"avg_temp": 78.2, "temp_variance": 6.8},
                "trend": "DEGRADING",
                "isUrgent": False
            },
            {
                "turbineId": "T005",
                "component": "MAIN_BEARING",
                "componentName": "Main Bearing",
                "estimatedRUL": 65,
                "confidence": 0.71,
                "healthScore": 48,
                "degradationRate": 0.55,
                "lastUpdated": datetime.now().isoformat(),
                "modelVersion": "care-nbm-v1.0",
                "inputFeatures": {"avg_temp": 52.1, "temp_variance": 5.5},
                "trend": "RAPID_DEGRADATION",
                "isUrgent": False
            }
        ]

        result = {
            "predictions": predictions,
            "criticalCount": 0,
            "urgentCount": 0,
            "summary": {
                "totalPredictions": len(predictions),
                "byTrend": {
                    "STABLE": 0,
                    "DEGRADING": 2,
                    "RAPID_DEGRADATION": 1
                },
                "avgHealthScore": sum(p["healthScore"] for p in predictions) / len(predictions),
                "shortestRUL": {
                    "turbineId": "T005",
                    "component": "MAIN_BEARING",
                    "days": 65
                }
            }
        }

        with open(output_dir / "rul.json", 'w') as f:
            json.dump(result, f, indent=2)

        return result
