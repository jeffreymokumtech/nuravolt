"""
Plant Configuration Module

Provides YAML-based configuration for plant-level digital twin training.
Supports multi-plant deployment with standardized configuration schema.

Usage:
    from nuravolt.digitaltwin import PlantConfig

    config = PlantConfig.from_yaml("plant_configs/alpha1.yaml")
    print(config.plant_id, config.location.latitude)
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List, Optional, Union

import yaml


@dataclass
class LocationConfig:
    """Geographic location and timezone configuration."""
    latitude: float
    longitude: float
    altitude: float = 0.0
    timezone: str = "UTC"


@dataclass
class ArrayConfig:
    """Solar array orientation and module parameters."""
    tilt: float
    azimuth: float
    gamma_pdc: float = -0.004  # Temperature coefficient (-0.4%/°C for c-Si)


@dataclass
class CapacityConfig:
    """Plant capacity specifications."""
    nominal_mw: float
    installed_mw: Optional[float] = None


@dataclass
class ColumnMapping:
    """Data column name mappings."""
    irradiance: str
    ambient_temp: str
    module_temp: Optional[str] = None
    wind_speed: Optional[str] = None
    solar_elevation: Optional[str] = None
    solar_azimuth: Optional[str] = None
    humidity: Optional[str] = None


@dataclass
class DustIQMapping:
    """DustIQ soiling sensor column mappings (ground truth)."""
    soiling_loss_1: Optional[str] = None
    soiling_loss_2: Optional[str] = None
    soiling_ratio_1: Optional[str] = None
    soiling_ratio_2: Optional[str] = None

    @property
    def has_dustiq(self) -> bool:
        """Check if any DustIQ column is configured."""
        return any([
            self.soiling_loss_1,
            self.soiling_loss_2,
            self.soiling_ratio_1,
            self.soiling_ratio_2,
        ])


@dataclass
class DCPatternMapping:
    """Column patterns for DC-side measurements.

    Patterns use {inv} for inverter ID and {ch} or {ch:02d} for channel number.

    Examples:
        inverter_power: "Alpha \\(ES\\): {inv} / Inverter Power Normalized"
        dc_current: "Alpha \\(ES\\): {inv} / Input_current_{ch:02d} (A)"
        dc_voltage: "Alpha \\(ES\\): {inv} / U_DC_{ch} (V)"
    """
    inverter_power: Optional[str] = None  # Pattern for power column
    inverter_pac: Optional[str] = None  # Pattern for P_AC column
    inverter_temp: Optional[str] = None  # Pattern for inverter temperature
    dc_current: Optional[str] = None  # Pattern for DC current channels
    dc_current_mppt: Optional[str] = None  # Alternative MPPT current pattern
    dc_voltage: Optional[str] = None  # Pattern for DC voltage channels

    def format_current_col(self, inverter_id: str, channel: int) -> str:
        """Format DC current column name for specific inverter and channel."""
        if not self.dc_current:
            return ""
        return self.dc_current.replace("{inv}", inverter_id).replace(
            "{ch:02d}", f"{channel:02d}"
        ).replace("{ch}", str(channel))

    def format_voltage_col(self, inverter_id: str, channel: int) -> str:
        """Format DC voltage column name for specific inverter and channel."""
        if not self.dc_voltage:
            return ""
        return self.dc_voltage.replace("{inv}", inverter_id).replace(
            "{ch:02d}", f"{channel:02d}"
        ).replace("{ch}", str(channel))

    def format_temp_col(self, inverter_id: str) -> str:
        """Format inverter temperature column name."""
        if not self.inverter_temp:
            return ""
        return self.inverter_temp.replace("{inv}", inverter_id)


@dataclass
class FeaturesConfig:
    """Feature availability flags for the plant."""
    has_dustiq: bool = False  # Has DustIQ soiling sensor
    has_dc_currents: bool = False  # Has per-channel DC current data
    has_dc_voltages: bool = False  # Has per-channel DC voltage data
    has_inverter_temp: bool = False  # Has per-inverter temperature data


@dataclass
class DataConfig:
    """Data source and column configuration."""
    source_path: str
    columns: ColumnMapping
    inverter_pattern: str  # Regex pattern to extract inverter IDs
    timestamp_column: str = "timestamp"
    timestamp_format: Optional[str] = None  # Optional strptime format
    meta_path: Optional[str] = None  # Path to metadata CSV file
    dustiq: DustIQMapping = field(default_factory=DustIQMapping)  # DustIQ sensor columns
    patterns: DCPatternMapping = field(default_factory=DCPatternMapping)  # DC column patterns
    dc_channels: int = 12  # Number of MPPT/DC channels per inverter
    mppt_channels: Optional[int] = None  # Alternative MPPT channel count (if different)
    inverter_count: Optional[int] = None  # Total number of inverters (for auto-discovery)


@dataclass
class InverterSpec:
    """Individual inverter specification."""
    inverter_id: str
    nominal_kw: float
    string_count: Optional[int] = None
    module_count: Optional[int] = None


@dataclass
class GroupSpec:
    """Inverter group specification."""
    group_id: str
    inverters: list[InverterSpec] = field(default_factory=list)

    @property
    def total_capacity_kw(self) -> float:
        """Total capacity of all inverters in group."""
        return sum(inv.nominal_kw for inv in self.inverters)


@dataclass
class ComponentsConfig:
    """Plant component hierarchy."""
    groups: list[GroupSpec] = field(default_factory=list)

    @property
    def all_inverters(self) -> list[InverterSpec]:
        """Flat list of all inverters."""
        return [inv for group in self.groups for inv in group.inverters]

    @property
    def inverter_ids(self) -> List[str]:
        """List of all inverter IDs."""
        return [inv.inverter_id for inv in self.all_inverters]

    @property
    def total_inverters(self) -> int:
        """Total number of inverters."""
        return len(self.all_inverters)

    def get_group_for_inverter(self, inverter_id: str) -> Optional[str]:
        """Get group ID for a given inverter."""
        for group in self.groups:
            for inv in group.inverters:
                if inv.inverter_id == inverter_id:
                    return group.group_id
        return None

    def get_inverter_spec(self, inverter_id: str) -> Optional[InverterSpec]:
        """Get inverter specification by ID."""
        for inv in self.all_inverters:
            if inv.inverter_id == inverter_id:
                return inv
        return None


@dataclass
class TrainingConfig:
    """Model training configuration."""
    max_years: Optional[float] = 3.0  # None means use all available data
    min_pr: float = 0.10
    min_irradiance: float = 50.0
    min_training_samples: int = 500
    validation_split: float = 0.2
    use_enhanced_selection: bool = True
    export_residuals: bool = True  # Export per-inverter loss CSVs for heatmap
    per_inverter: bool = False  # Train 150 separate models instead of 1 plant model


@dataclass
class CatBoostParams:
    """CatBoost hyperparameters."""
    iterations: int = 1000
    depth: int = 8
    learning_rate: float = 0.05
    l2_leaf_reg: float = 3.0
    random_seed: int = 42
    early_stopping_rounds: Optional[int] = 50
    verbose: bool = False


@dataclass
class ModelConfig:
    """Model architecture configuration."""
    use_catboost: bool = True
    use_hybrid_physics: bool = True
    catboost_params: CatBoostParams = field(default_factory=CatBoostParams)
    calibrate_physics: bool = True


@dataclass
class QualityConfig:
    """Quality thresholds for model validation."""
    min_r2: float = 0.70
    max_mae_kw: float = 0.15
    min_coverage: float = 0.80  # Minimum seasonal coverage


@dataclass
class OutputConfig:
    """Output directory and format configuration."""
    base_dir: str = "public/data/digitaltwin"
    save_models: bool = True
    save_json: bool = True
    save_quality_report: bool = True


@dataclass
class PlantConfig:
    """
    Complete plant configuration for digital twin training.

    Attributes:
        plant_id: Unique identifier for the plant
        plant_name: Human-readable plant name
        location: Geographic location configuration
        array: Solar array parameters
        capacity: Plant capacity specifications
        data: Data source and column mappings
        components: Component hierarchy (groups, inverters)
        training: Training parameters
        model: Model architecture settings
        quality: Quality thresholds
        output: Output configuration
    """
    plant_id: str
    plant_name: str
    location: LocationConfig
    array: ArrayConfig
    capacity: CapacityConfig
    data: DataConfig
    components: ComponentsConfig = field(default_factory=ComponentsConfig)
    training: TrainingConfig = field(default_factory=TrainingConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    quality: QualityConfig = field(default_factory=QualityConfig)
    output: OutputConfig = field(default_factory=OutputConfig)
    features: FeaturesConfig = field(default_factory=FeaturesConfig)

    @classmethod
    def from_yaml(cls, yaml_path: Union[str, Path]) -> "PlantConfig":
        """
        Load plant configuration from YAML file.

        Args:
            yaml_path: Path to YAML configuration file

        Returns:
            PlantConfig instance

        Raises:
            FileNotFoundError: If YAML file doesn't exist
            ValueError: If required fields are missing
        """
        yaml_path = Path(yaml_path)
        if not yaml_path.exists():
            raise FileNotFoundError(f"Config file not found: {yaml_path}")

        with open(yaml_path, "r") as f:
            data = yaml.safe_load(f)

        return cls.from_dict(data)

    @classmethod
    def from_api(
        cls,
        plant_id: str,
        api_base: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> "PlantConfig":
        """
        Load plant configuration from NuraVolt API.

        This method fetches the PlantConfig from the NuraVolt DataHub API,
        enabling seamless integration between the UI-configured field mappings
        and Python analytics scripts.

        Args:
            plant_id: The plant ID to fetch configuration for
            api_base: Base URL of the NuraVolt API (default: http://localhost:3000)
            api_key: Optional API key for authentication

        Returns:
            PlantConfig instance

        Raises:
            ConnectionError: If API is not reachable
            ValueError: If plant config not found or invalid

        Example:
            >>> config = PlantConfig.from_api("eta")
            >>> print(config.plant_name, config.location.latitude)
        """
        import os

        try:
            import requests
        except ImportError:
            raise ImportError(
                "requests library is required for API loading. "
                "Install with: pip install requests"
            )

        # Determine API base URL
        if api_base is None:
            api_base = os.getenv("NURAVOLT_API_BASE", "http://localhost:3000")

        # Build request URL
        url = f"{api_base}/api/analytics/plant-config/{plant_id}"

        # Build headers
        headers = {"Accept": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        elif os.getenv("NURAVOLT_API_KEY"):
            headers["Authorization"] = f"Bearer {os.getenv('NURAVOLT_API_KEY')}"

        try:
            response = requests.get(url, headers=headers, timeout=30)
        except requests.exceptions.RequestException as e:
            raise ConnectionError(f"Failed to connect to NuraVolt API: {e}")

        if response.status_code == 404:
            raise ValueError(f"PlantConfig not found for plant: {plant_id}")

        if response.status_code == 422:
            # Config has validation errors
            data = response.json()
            errors = data.get("validation_errors", [])
            raise ValueError(
                f"PlantConfig for {plant_id} has validation errors: {errors}"
            )

        if response.status_code != 200:
            raise ValueError(
                f"API returned status {response.status_code}: {response.text}"
            )

        # Parse response
        data = response.json()
        config_data = data.get("config", data)

        return cls.from_dict(config_data)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PlantConfig":
        """
        Create PlantConfig from dictionary.

        Args:
            data: Configuration dictionary

        Returns:
            PlantConfig instance
        """
        # Parse location
        loc_data = data.get("location", {})
        location = LocationConfig(
            latitude=loc_data["latitude"],
            longitude=loc_data["longitude"],
            altitude=loc_data.get("altitude", 0.0),
            timezone=loc_data.get("timezone", "UTC"),
        )

        # Parse array
        arr_data = data.get("array", {})
        array = ArrayConfig(
            tilt=arr_data["tilt"],
            azimuth=arr_data["azimuth"],
            gamma_pdc=arr_data.get("gamma_pdc", -0.004),
        )

        # Parse capacity
        cap_data = data.get("capacity", {})
        capacity = CapacityConfig(
            nominal_mw=cap_data["nominal_mw"],
            installed_mw=cap_data.get("installed_mw"),
        )

        # Parse data config
        data_cfg = data.get("data", {})
        col_data = data_cfg.get("columns", {})
        columns = ColumnMapping(
            irradiance=col_data["irradiance"],
            ambient_temp=col_data["ambient_temp"],
            module_temp=col_data.get("module_temp"),
            wind_speed=col_data.get("wind_speed"),
            solar_elevation=col_data.get("solar_elevation"),
            solar_azimuth=col_data.get("solar_azimuth"),
            humidity=col_data.get("humidity"),
        )

        # Parse DustIQ soiling sensor config
        dustiq_data = data_cfg.get("dustiq", {})
        dustiq = DustIQMapping(
            soiling_loss_1=dustiq_data.get("soiling_loss_1"),
            soiling_loss_2=dustiq_data.get("soiling_loss_2"),
            soiling_ratio_1=dustiq_data.get("soiling_ratio_1"),
            soiling_ratio_2=dustiq_data.get("soiling_ratio_2"),
        )

        # Parse DC column patterns
        patterns_data = data_cfg.get("patterns", {})
        patterns = DCPatternMapping(
            inverter_power=patterns_data.get("inverter_power"),
            inverter_pac=patterns_data.get("inverter_pac"),
            inverter_temp=patterns_data.get("inverter_temp"),
            dc_current=patterns_data.get("dc_current"),
            dc_current_mppt=patterns_data.get("dc_current_mppt"),
            dc_voltage=patterns_data.get("dc_voltage"),
        )

        data_config = DataConfig(
            source_path=data_cfg["source_path"],
            columns=columns,
            inverter_pattern=data_cfg["inverter_pattern"],
            timestamp_column=data_cfg.get("timestamp_column", "timestamp"),
            timestamp_format=data_cfg.get("timestamp_format"),
            meta_path=data_cfg.get("meta_path"),
            dustiq=dustiq,
            patterns=patterns,
            dc_channels=data_cfg.get("dc_channels", 12),
            mppt_channels=data_cfg.get("mppt_channels"),
            inverter_count=data_cfg.get("inverter_count"),
        )

        # Parse components
        comp_data = data.get("components", {})
        groups = []
        for grp_data in comp_data.get("groups", []):
            inverters = []
            for inv_data in grp_data.get("inverters", []):
                inverters.append(InverterSpec(
                    inverter_id=inv_data["inverter_id"],
                    nominal_kw=inv_data["nominal_kw"],
                    string_count=inv_data.get("string_count"),
                    module_count=inv_data.get("module_count"),
                ))
            groups.append(GroupSpec(
                group_id=grp_data["group_id"],
                inverters=inverters,
            ))
        components = ComponentsConfig(groups=groups)

        # Parse training config
        train_data = data.get("training", {})
        training = TrainingConfig(
            max_years=train_data.get("max_years", 3.0),
            min_pr=train_data.get("min_pr", 0.10),
            min_irradiance=train_data.get("min_irradiance", 50.0),
            min_training_samples=train_data.get("min_training_samples", 500),
            validation_split=train_data.get("validation_split", 0.2),
            use_enhanced_selection=train_data.get("use_enhanced_selection", True),
            export_residuals=train_data.get("export_residuals", True),
            per_inverter=train_data.get("per_inverter", False),
        )

        # Parse model config
        model_data = data.get("model", {})
        cb_data = model_data.get("catboost_params", {})
        catboost_params = CatBoostParams(
            iterations=cb_data.get("iterations", 1000),
            depth=cb_data.get("depth", 8),
            learning_rate=cb_data.get("learning_rate", 0.05),
            l2_leaf_reg=cb_data.get("l2_leaf_reg", 3.0),
            random_seed=cb_data.get("random_seed", 42),
            early_stopping_rounds=cb_data.get("early_stopping_rounds", 50),
            verbose=cb_data.get("verbose", False),
        )
        model_config = ModelConfig(
            use_catboost=model_data.get("use_catboost", True),
            use_hybrid_physics=model_data.get("use_hybrid_physics", True),
            catboost_params=catboost_params,
            calibrate_physics=model_data.get("calibrate_physics", True),
        )

        # Parse quality config
        qual_data = data.get("quality", {})
        quality = QualityConfig(
            min_r2=qual_data.get("min_r2", 0.70),
            max_mae_kw=qual_data.get("max_mae_kw", 0.15),
            min_coverage=qual_data.get("min_coverage", 0.80),
        )

        # Parse output config
        out_data = data.get("output", {})
        output = OutputConfig(
            base_dir=out_data.get("base_dir", "public/data/digitaltwin"),
            save_models=out_data.get("save_models", True),
            save_json=out_data.get("save_json", True),
            save_quality_report=out_data.get("save_quality_report", True),
        )

        # Parse features config
        feat_data = data.get("features", {})
        features = FeaturesConfig(
            has_dustiq=feat_data.get("has_dustiq", dustiq.has_dustiq),
            has_dc_currents=feat_data.get("has_dc_currents", False),
            has_dc_voltages=feat_data.get("has_dc_voltages", False),
            has_inverter_temp=feat_data.get("has_inverter_temp", False),
        )

        return cls(
            plant_id=data["plant_id"],
            plant_name=data["plant_name"],
            location=location,
            array=array,
            capacity=capacity,
            data=data_config,
            components=components,
            training=training,
            model=model_config,
            quality=quality,
            output=output,
            features=features,
        )

    def to_dict(self) -> dict[str, Any]:
        """Convert configuration to dictionary for serialization."""
        return {
            "plant_id": self.plant_id,
            "plant_name": self.plant_name,
            "location": {
                "latitude": self.location.latitude,
                "longitude": self.location.longitude,
                "altitude": self.location.altitude,
                "timezone": self.location.timezone,
            },
            "array": {
                "tilt": self.array.tilt,
                "azimuth": self.array.azimuth,
                "gamma_pdc": self.array.gamma_pdc,
            },
            "capacity": {
                "nominal_mw": self.capacity.nominal_mw,
                "installed_mw": self.capacity.installed_mw,
            },
            "data": {
                "source_path": self.data.source_path,
                "columns": {
                    "irradiance": self.data.columns.irradiance,
                    "ambient_temp": self.data.columns.ambient_temp,
                    "module_temp": self.data.columns.module_temp,
                    "wind_speed": self.data.columns.wind_speed,
                    "solar_elevation": self.data.columns.solar_elevation,
                    "solar_azimuth": self.data.columns.solar_azimuth,
                    "humidity": self.data.columns.humidity,
                },
                "inverter_pattern": self.data.inverter_pattern,
                "timestamp_column": self.data.timestamp_column,
                "timestamp_format": self.data.timestamp_format,
            },
            "components": {
                "groups": [
                    {
                        "group_id": g.group_id,
                        "inverters": [
                            {
                                "inverter_id": inv.inverter_id,
                                "nominal_kw": inv.nominal_kw,
                                "string_count": inv.string_count,
                                "module_count": inv.module_count,
                            }
                            for inv in g.inverters
                        ],
                    }
                    for g in self.components.groups
                ],
            },
            "training": {
                "max_years": self.training.max_years,
                "min_pr": self.training.min_pr,
                "min_irradiance": self.training.min_irradiance,
                "min_training_samples": self.training.min_training_samples,
                "validation_split": self.training.validation_split,
                "use_enhanced_selection": self.training.use_enhanced_selection,
            },
            "model": {
                "use_catboost": self.model.use_catboost,
                "use_hybrid_physics": self.model.use_hybrid_physics,
                "calibrate_physics": self.model.calibrate_physics,
                "catboost_params": {
                    "iterations": self.model.catboost_params.iterations,
                    "depth": self.model.catboost_params.depth,
                    "learning_rate": self.model.catboost_params.learning_rate,
                    "l2_leaf_reg": self.model.catboost_params.l2_leaf_reg,
                    "random_seed": self.model.catboost_params.random_seed,
                    "early_stopping_rounds": self.model.catboost_params.early_stopping_rounds,
                    "verbose": self.model.catboost_params.verbose,
                },
            },
            "quality": {
                "min_r2": self.quality.min_r2,
                "max_mae_kw": self.quality.max_mae_kw,
                "min_coverage": self.quality.min_coverage,
            },
            "output": {
                "base_dir": self.output.base_dir,
                "save_models": self.output.save_models,
                "save_json": self.output.save_json,
                "save_quality_report": self.output.save_quality_report,
            },
        }

    def save_yaml(self, yaml_path: Union[str, Path]) -> None:
        """Save configuration to YAML file."""
        yaml_path = Path(yaml_path)
        yaml_path.parent.mkdir(parents=True, exist_ok=True)

        with open(yaml_path, "w") as f:
            yaml.dump(self.to_dict(), f, default_flow_style=False, sort_keys=False)

    @property
    def output_dir(self) -> Path:
        """Get plant-specific output directory."""
        return Path(self.output.base_dir) / self.plant_id

    def validate(self) -> List[str]:
        """
        Validate configuration for completeness and consistency.

        Returns:
            List of validation error messages (empty if valid)
        """
        errors = []

        # Required fields
        if not self.plant_id:
            errors.append("plant_id is required")
        if not self.plant_name:
            errors.append("plant_name is required")

        # Location validation
        if not (-90 <= self.location.latitude <= 90):
            errors.append(f"Invalid latitude: {self.location.latitude}")
        if not (-180 <= self.location.longitude <= 180):
            errors.append(f"Invalid longitude: {self.location.longitude}")

        # Array validation
        if not (0 <= self.array.tilt <= 90):
            errors.append(f"Invalid tilt angle: {self.array.tilt}")
        if not (0 <= self.array.azimuth <= 360):
            errors.append(f"Invalid azimuth: {self.array.azimuth}")

        # Data validation
        if not self.data.source_path:
            errors.append("data.source_path is required")
        if not self.data.inverter_pattern:
            errors.append("data.inverter_pattern is required")

        # Training validation (None is valid - means use all data)
        if self.training.max_years is not None and self.training.max_years <= 0:
            errors.append(f"Invalid max_years: {self.training.max_years}")
        if not (0 < self.training.min_pr < 1):
            errors.append(f"Invalid min_pr: {self.training.min_pr}")

        # Quality validation
        if not (0 < self.quality.min_r2 < 1):
            errors.append(f"Invalid min_r2: {self.quality.min_r2}")

        return errors


def load_plant_config(plant_id: str, config_dir: Union[str, Path] = "plant_configs") -> PlantConfig:
    """
    Load plant configuration by plant ID.

    Args:
        plant_id: Plant identifier (e.g., "alpha1")
        config_dir: Directory containing plant YAML files

    Returns:
        PlantConfig instance
    """
    config_path = Path(config_dir) / f"{plant_id}.yaml"
    return PlantConfig.from_yaml(config_path)


def list_available_plants(config_dir: Union[str, Path] = "plant_configs") -> List[str]:
    """
    List all available plant configurations.

    Args:
        config_dir: Directory containing plant YAML files

    Returns:
        List of plant IDs
    """
    config_dir = Path(config_dir)
    if not config_dir.exists():
        return []

    plant_ids = []
    for yaml_file in config_dir.glob("*.yaml"):
        if yaml_file.stem != "_template":
            plant_ids.append(yaml_file.stem)

    return sorted(plant_ids)
