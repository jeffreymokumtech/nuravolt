"""
BESS Configuration Dataclasses

Centralized configuration for Battery Energy Storage System analytics.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, List
from enum import Enum


class BessChemistry(Enum):
    """Battery chemistry types with characteristic degradation profiles."""
    LFP = "lfp"      # Lithium Iron Phosphate - lower energy density, longer life
    NMC = "nmc"      # Nickel Manganese Cobalt - higher energy density
    NCA = "nca"      # Nickel Cobalt Aluminum - highest energy density
    LTO = "lto"      # Lithium Titanate - fastest charging, longest life


@dataclass
class BessAssetConfig:
    """
    Configuration for a BESS asset.

    Matches the BessAsset Prisma model structure.
    """
    asset_id: str
    plant_id: str
    name: str

    # Physical specifications
    chemistry: BessChemistry
    nominal_capacity_kwh: float
    nominal_power_kw: float
    module_count: Optional[int] = None
    rack_count: Optional[int] = None

    # Commissioning
    installation_date: Optional[datetime] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    serial_number: Optional[str] = None

    # Current state
    current_soh: Optional[float] = None
    current_soc: Optional[float] = None

    def max_c_rate(self) -> float:
        """Calculate max C-rate based on power and capacity."""
        if self.nominal_capacity_kwh > 0:
            return self.nominal_power_kw / self.nominal_capacity_kwh
        return 1.0


@dataclass
class WarrantyTermsConfig:
    """
    Warranty terms configuration.

    Defines the contractual limits that trigger warranty violations.
    """
    # Capacity guarantee
    capacity_guarantee_pct: float = 0.70  # 70% capacity at end of warranty
    warranty_years: int = 10

    # Cycling limits
    max_cycles: Optional[int] = 5000  # Equivalent full cycles
    max_throughput_mwh: Optional[float] = None

    # Efficiency guarantee
    min_rte: float = 0.85  # Round-trip efficiency

    # SoC limits
    max_avg_soc: float = 0.95  # High SoC threshold
    min_soc: float = 0.10  # Low SoC threshold
    soc_hold_limit_hours: int = 168  # Max hours at extreme SoC (7 days)

    # Temperature limits (Celsius)
    operating_temp_min_c: float = 15.0
    operating_temp_max_c: float = 35.0
    temp_violation_minutes: int = 30  # Minutes to trigger violation

    # C-rate limits
    max_c_rate_continuous: float = 1.0  # 1C continuous
    max_c_rate_peak: float = 1.2  # 1.2C peak
    peak_duration_minutes: int = 15  # Max peak duration

    # Cell voltage limits (Volts)
    cell_voltage_min_v: float = 2.8
    cell_voltage_max_v: float = 3.65


@dataclass
class ViolationDetectionConfig:
    """
    Configuration for warranty violation detection.

    Extends WarrantyTermsConfig with detection-specific parameters.
    """
    # Inherit warranty terms
    warranty_terms: WarrantyTermsConfig = field(default_factory=WarrantyTermsConfig)

    # Temperature detection
    temp_warning_threshold_c: float = 35.0  # Warning at 35C
    temp_critical_threshold_c: float = 40.0  # Critical at 40C
    temp_window_minutes: int = 30  # Rolling window for sustained check

    # SoC detection
    soc_high_warning: float = 0.95
    soc_high_critical: float = 0.98
    soc_low_warning: float = 0.15
    soc_low_critical: float = 0.10
    soc_dwell_hours_warning: int = 24
    soc_dwell_hours_critical: int = 168  # 7 days

    # C-rate detection
    c_rate_warning: float = 1.0
    c_rate_critical: float = 1.2
    c_rate_window_minutes: int = 15

    # Voltage detection
    cell_voltage_warning_low_v: float = 2.85
    cell_voltage_warning_high_v: float = 3.60

    # HVAC correlation
    hvac_temp_correlation_threshold: float = 5.0  # Temp rise when HVAC fails


@dataclass
class CyclingAnalysisConfig:
    """
    Configuration for cycling analysis and rainflow counting.
    """
    # Rainflow parameters
    min_cycle_depth: float = 0.05  # Minimum DoD to count as cycle (5%)
    hysteresis: float = 0.01  # SoC hysteresis for cycle detection

    # Stress factors for weighted cycle counting
    dod_stress_exponent: float = 1.3  # DoD impact on degradation
    temp_stress_factor: float = 0.04  # Temperature coefficient
    c_rate_stress_factor: float = 0.1  # C-rate impact

    # Reference conditions for equivalent cycles
    reference_dod: float = 0.80  # 80% DoD reference
    reference_temp_c: float = 25.0  # 25C reference
    reference_c_rate: float = 0.5  # 0.5C reference


@dataclass
class ArbitrageConfig:
    """
    Configuration for degradation-aware arbitrage optimization.

    A price array handed to the optimizer is one value per settlement period,
    not per hour: Iberia clears 24 hourly periods, GB settles 48 half-hourly
    ones. `time_resolution_minutes` is what turns power into energy, so it must
    match the price array the caller passes or every revenue and degradation
    figure is out by that ratio.
    """
    # Asset parameters (from BessAssetConfig)
    capacity_kwh: float
    max_power_kw: float
    min_soc: float = 0.10
    max_soc: float = 0.90

    # Efficiency parameters
    charge_efficiency: float = 0.95
    discharge_efficiency: float = 0.95

    # Degradation pricing
    use_dynamic_degradation: bool = True
    base_degradation_cost_per_kwh: float = 0.005  # EUR/kWh baseline

    # Chemistry-specific parameters (defaults for LFP)
    dod_stress_factor: float = 1.3
    temp_stress_factor: float = 0.04
    c_rate_stress_factor: float = 0.1

    # Warranty constraints
    respect_warranty_limits: bool = True
    max_daily_cycles: float = 2.0  # Conservative default

    # Optimization parameters
    time_resolution_minutes: int = 60
    forecast_horizon_hours: int = 24

    # Settlement currency of the price array. The revenue fields downstream
    # carry a legacy _eur suffix; this is the authoritative label.
    currency: str = "EUR"

    def __post_init__(self):
        if self.time_resolution_minutes <= 0 or 1440 % self.time_resolution_minutes:
            raise ValueError(
                "time_resolution_minutes must divide a 1440-minute day evenly, got "
                f"{self.time_resolution_minutes}"
            )

    @property
    def period_hours(self) -> float:
        """Hours of energy one settlement period buys or sells at full power."""
        return self.time_resolution_minutes / 60.0

    @property
    def periods_per_day(self) -> int:
        return 1440 // self.time_resolution_minutes

    @classmethod
    def from_asset_config(
        cls,
        asset: BessAssetConfig,
        **overrides
    ) -> "ArbitrageConfig":
        """Create ArbitrageConfig from BessAssetConfig."""
        base = cls(
            capacity_kwh=asset.nominal_capacity_kwh,
            max_power_kw=asset.nominal_power_kw,
        )

        # Apply chemistry-specific defaults
        chemistry_params = cls._get_chemistry_params(asset.chemistry)
        for key, value in chemistry_params.items():
            setattr(base, key, value)

        # Apply overrides
        for key, value in overrides.items():
            if hasattr(base, key):
                setattr(base, key, value)

        return base

    @staticmethod
    def _get_chemistry_params(chemistry: BessChemistry) -> dict:
        """Get chemistry-specific degradation parameters."""
        params = {
            BessChemistry.LFP: {
                "dod_stress_factor": 1.3,
                "temp_stress_factor": 0.04,
                "c_rate_stress_factor": 0.1,
                "base_degradation_cost_per_kwh": 0.004,
            },
            BessChemistry.NMC: {
                "dod_stress_factor": 1.5,
                "temp_stress_factor": 0.05,
                "c_rate_stress_factor": 0.12,
                "base_degradation_cost_per_kwh": 0.006,
            },
            BessChemistry.NCA: {
                "dod_stress_factor": 1.6,
                "temp_stress_factor": 0.06,
                "c_rate_stress_factor": 0.15,
                "base_degradation_cost_per_kwh": 0.007,
            },
            BessChemistry.LTO: {
                "dod_stress_factor": 1.1,
                "temp_stress_factor": 0.02,
                "c_rate_stress_factor": 0.05,
                "base_degradation_cost_per_kwh": 0.003,
            },
        }
        return params.get(chemistry, params[BessChemistry.NMC])


@dataclass
class DegradationModelConfig:
    """
    Configuration for physics-informed degradation modeling.
    """
    chemistry: BessChemistry = BessChemistry.LFP

    # Calendar aging parameters
    calendar_coefficient: float = 0.015  # per year at 25C
    calendar_temp_acceleration: float = 0.04  # per degree C above 25
    calendar_soc_acceleration: float = 0.02  # per 10% above 50% SoC

    # Cyclic aging parameters
    cyclic_coefficient: float = 0.00003  # per cycle at 80% DoD
    cyclic_dod_exponent: float = 1.3
    cyclic_temp_factor: float = 0.04
    cyclic_c_rate_factor: float = 0.1

    @classmethod
    def for_chemistry(cls, chemistry: BessChemistry) -> "DegradationModelConfig":
        """Get chemistry-specific degradation configuration."""
        configs = {
            BessChemistry.LFP: cls(
                chemistry=BessChemistry.LFP,
                calendar_coefficient=0.015,
                cyclic_coefficient=0.00003,
                cyclic_dod_exponent=1.3,
            ),
            BessChemistry.NMC: cls(
                chemistry=BessChemistry.NMC,
                calendar_coefficient=0.02,
                cyclic_coefficient=0.00005,
                cyclic_dod_exponent=1.5,
            ),
            BessChemistry.NCA: cls(
                chemistry=BessChemistry.NCA,
                calendar_coefficient=0.025,
                cyclic_coefficient=0.00006,
                cyclic_dod_exponent=1.6,
            ),
            BessChemistry.LTO: cls(
                chemistry=BessChemistry.LTO,
                calendar_coefficient=0.008,
                cyclic_coefficient=0.00001,
                cyclic_dod_exponent=1.1,
            ),
        }
        return configs.get(chemistry, configs[BessChemistry.NMC])


@dataclass
class BESSPipelineConfig:
    """
    Master configuration for the BESS Intelligence Pipeline.
    """
    # Asset configuration
    asset: BessAssetConfig

    # Sub-module configurations
    warranty_terms: WarrantyTermsConfig = field(default_factory=WarrantyTermsConfig)
    violation_detection: ViolationDetectionConfig = field(
        default_factory=ViolationDetectionConfig
    )
    cycling_analysis: CyclingAnalysisConfig = field(default_factory=CyclingAnalysisConfig)
    degradation_model: Optional[DegradationModelConfig] = None
    arbitrage: Optional[ArbitrageConfig] = None

    # Output settings
    output_dir: Optional[str] = None
    export_json: bool = True
    export_csv: bool = False

    def __post_init__(self):
        """Initialize dependent configurations."""
        if self.degradation_model is None:
            self.degradation_model = DegradationModelConfig.for_chemistry(
                self.asset.chemistry
            )

        if self.arbitrage is None:
            self.arbitrage = ArbitrageConfig.from_asset_config(self.asset)


# Result dataclasses for pipeline outputs

@dataclass
class WarrantyViolation:
    """A detected warranty violation event."""
    violation_type: str
    severity: str  # 'warning', 'critical'
    started_at: datetime
    ended_at: Optional[datetime]
    duration_minutes: Optional[int]
    measured_value: float
    threshold_value: float
    unit: str
    description: str
    affected_modules: List[str] = field(default_factory=list)
    root_cause: Optional[str] = None


@dataclass
class CycleRecord:
    """A day's cycling metrics."""
    date: datetime
    energy_in_kwh: float
    energy_out_kwh: float
    equivalent_cycles: float
    avg_dod: float
    avg_c_rate: float
    avg_temp_c: float
    round_trip_efficiency: float
    stress_weighted_cycles: float
    rainflow_cycles: List[dict] = field(default_factory=list)


@dataclass
class WarrantyHealthScore:
    """Composite warranty health assessment."""
    score: int  # 0-100
    risk_level: str  # 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'

    # Component scores
    soh_score: int
    cycle_score: int
    time_score: int
    efficiency_score: int
    violations_score: int

    # Key metrics
    current_soh: float
    warranty_threshold: float
    soh_margin: float
    cycles_used: float
    cycles_remaining: float
    years_remaining: float

    # Projections
    projected_eol_date: Optional[datetime]

    # Risk factors
    risk_factors: List[str]
    recommendation: str


@dataclass
class DispatchSchedule:
    """Optimized dispatch schedule result."""
    schedule_date: datetime

    # Delivery hours covered, NOT the number of slots: 48 half-hourly periods
    # are a 24-hour horizon. len(soc_schedule) is the slot count.
    horizon_hours: int
    resolution_minutes: int

    # Schedule arrays (one value per settlement period)
    charge_schedule_kw: List[float]
    discharge_schedule_kw: List[float]
    # State of charge at the START of each period, so soc_schedule[k] is the
    # state the period-k dispatch acted on. The state after the final period is
    # `final_soc`, which is NOT in this list.
    soc_schedule: List[float]
    price_forecast: List[float]

    # Economics. Denominated in `currency`; the _eur suffixes are legacy names
    # kept so the existing readers and DB columns line up.
    expected_revenue_eur: float
    degradation_cost_eur: float
    net_revenue_eur: float

    # Optimization metadata
    optimizer_type: str
    status: str
    expected_cycles: float

    currency: str = "EUR"

    # State of charge after the last settlement period. A caller chaining days
    # must carry THIS into the next day's initial_soc. soc_schedule[-1] is the
    # state before the last period ran, so carrying it spends the final slot's
    # energy in the power trace and then hands the ledger back unspent, which
    # compounds into energy from nowhere over a long horizon.
    final_soc: Optional[float] = None

    # Grid-side energy the schedule buys and sells over the horizon. Both are
    # derived from the power arrays; they are stated so an energy balance can be
    # checked without re-integrating them. Over a horizon that starts and ends
    # at the same state of charge, energy_out_kwh < energy_in_kwh always, and
    # the ratio approaches charge_efficiency x discharge_efficiency.
    energy_in_kwh: Optional[float] = None
    energy_out_kwh: Optional[float] = None


@dataclass
class BESSAnalysisResult:
    """Complete analysis result from the BESS Intelligence Pipeline."""
    asset_id: str
    analysis_timestamp: datetime

    # Warranty status
    warranty_health: WarrantyHealthScore
    active_violations: List[WarrantyViolation]

    # Cycling metrics
    total_cycles: float
    total_throughput_mwh: float
    recent_cycles: List[CycleRecord]

    # Dispatch optimization (if run)
    dispatch_schedule: Optional[DispatchSchedule]

    # Metadata
    data_start: datetime
    data_end: datetime
    data_points: int
