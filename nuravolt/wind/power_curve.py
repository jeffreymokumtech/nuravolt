"""
Power Curve Analysis and Performance Monitoring Module

Wind turbine performance monitoring via power curve analysis.
Analog to Performance Ratio (PR) for solar PV systems.

Transfer pattern from: nuravolt/digitaltwin/hybrid_model.py
Reference: IEC 61400-12-1 standard
"""

from dataclasses import dataclass
from typing import Optional, Callable
import numpy as np

try:
    from scipy.interpolate import interp1d
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False
    interp1d = None

try:
    import polars as pl
    POLARS_AVAILABLE = True
except ImportError:
    POLARS_AVAILABLE = False
    pl = None

try:
    from sklearn.ensemble import IsolationForest
    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False
    IsolationForest = None


@dataclass
class TurbineSpecs:
    """Wind turbine specifications"""
    rated_power_kw: float
    rotor_diameter_m: float = 126.0
    hub_height_m: float = 90.0
    cut_in_speed: float = 3.0  # m/s
    cut_out_speed: float = 25.0  # m/s
    rated_speed: float = 12.0  # m/s


@dataclass
class PerformanceResult:
    """Result from power curve analysis"""
    efficiency: float  # Actual/Expected ratio
    power_deficit_kw: float
    expected_power_kw: float
    actual_power_kw: float
    is_underperforming: bool
    cause_category: str = ""  # 'curtailment', 'degradation', 'icing', 'normal'


class PowerCurveAnalyzer:
    """
    Wind turbine performance monitoring via power curve analysis.

    Analog to Performance Ratio (PR) for solar PV systems.
    Compares actual power output against expected (from OEM curve).

    Example:
        analyzer = PowerCurveAnalyzer(oem_curve, rated_power_kw=3000)

        # Calculate efficiency for a single point
        result = analyzer.analyze_point(wind_speed=10.0, actual_power=2500)
        print(f"Efficiency: {result.efficiency:.1%}")

        # Batch analysis
        df_analyzed = analyzer.analyze_dataframe(scada_df)
    """

    # Standard air density at sea level (kg/m³)
    STD_AIR_DENSITY = 1.225

    def __init__(
        self,
        oem_power_curve: dict,
        rated_power_kw: float,
        specs: Optional[TurbineSpecs] = None
    ):
        """
        Initialize power curve analyzer.

        Args:
            oem_power_curve: Dict with 'wind_speed' and 'power' arrays
            rated_power_kw: Rated turbine power in kW
            specs: Optional turbine specifications
        """
        if not SCIPY_AVAILABLE:
            raise ImportError(
                "scipy required for power curve analysis. "
                "Install with: pip install scipy"
            )

        self.rated_power = rated_power_kw
        self.specs = specs or TurbineSpecs(rated_power_kw=rated_power_kw)

        # Create interpolated power curve
        self.power_curve = interp1d(
            oem_power_curve['wind_speed'],
            oem_power_curve['power'],
            kind='linear',
            bounds_error=False,
            fill_value=(0, rated_power_kw)
        )

        # Store raw curve for reference
        self.oem_speeds = np.array(oem_power_curve['wind_speed'])
        self.oem_powers = np.array(oem_power_curve['power'])

    def calculate_expected_power(
        self,
        wind_speed: float,
        air_density: Optional[float] = None
    ) -> float:
        """
        Calculate expected power from OEM curve with optional air density correction.

        Args:
            wind_speed: Wind speed in m/s
            air_density: Air density in kg/m³ (None uses standard 1.225)

        Returns:
            Expected power in kW
        """
        expected = float(self.power_curve(wind_speed))

        # Air density correction (power ∝ density)
        if air_density is not None:
            density_factor = air_density / self.STD_AIR_DENSITY
            expected = expected * density_factor

        return expected

    def analyze_point(
        self,
        wind_speed: float,
        actual_power: float,
        air_density: Optional[float] = None,
        is_curtailed: bool = False
    ) -> PerformanceResult:
        """
        Analyze single operating point against power curve.

        Args:
            wind_speed: Wind speed in m/s
            actual_power: Actual power output in kW
            air_density: Optional air density correction
            is_curtailed: Whether turbine is known to be curtailed

        Returns:
            PerformanceResult with efficiency and diagnostics
        """
        expected = self.calculate_expected_power(wind_speed, air_density)

        if expected <= 0:
            return PerformanceResult(
                efficiency=1.0,
                power_deficit_kw=0,
                expected_power_kw=0,
                actual_power_kw=actual_power,
                is_underperforming=False,
                cause_category='below_cut_in'
            )

        efficiency = actual_power / expected
        deficit = expected - actual_power

        # Determine cause category
        if is_curtailed:
            cause = 'curtailment'
        elif efficiency < 0.5 and wind_speed > self.specs.rated_speed:
            cause = 'curtailment'  # Likely curtailed at high wind
        elif efficiency < 0.85:
            cause = 'degradation'
        else:
            cause = 'normal'

        return PerformanceResult(
            efficiency=efficiency,
            power_deficit_kw=max(0, deficit),
            expected_power_kw=expected,
            actual_power_kw=actual_power,
            is_underperforming=efficiency < 0.90,
            cause_category=cause
        )

    def analyze_dataframe(self, df: "pl.DataFrame") -> "pl.DataFrame":
        """
        Analyze entire DataFrame of SCADA data.

        Required columns: wind_speed, power
        Optional columns: air_density, rotor_speed, status_code

        Returns:
            DataFrame with added analysis columns
        """
        if not POLARS_AVAILABLE:
            raise ImportError("polars required for DataFrame analysis")

        wind_speeds = df['wind_speed'].to_numpy()
        actual_powers = df['power'].to_numpy()

        air_densities = (
            df['air_density'].to_numpy()
            if 'air_density' in df.columns
            else None
        )

        expected_powers = []
        efficiencies = []
        deficits = []

        for i, (ws, ap) in enumerate(zip(wind_speeds, actual_powers)):
            ad = air_densities[i] if air_densities is not None else None
            exp = self.calculate_expected_power(ws, ad)
            expected_powers.append(exp)
            efficiencies.append(ap / exp if exp > 0 else 1.0)
            deficits.append(max(0, exp - ap))

        return df.with_columns([
            pl.lit(expected_powers).alias('expected_power'),
            pl.lit(efficiencies).alias('efficiency'),
            pl.lit(deficits).alias('power_deficit'),
            (pl.lit(efficiencies) < 0.90).alias('is_underperforming')
        ])

    def filter_valid_data(self, df: "pl.DataFrame") -> "pl.DataFrame":
        """
        Remove invalid operating points (curtailment, maintenance, etc.).

        Reference: IEC 61400-12-1 data filtering requirements
        """
        if not POLARS_AVAILABLE:
            raise ImportError("polars required for DataFrame filtering")

        filters = [
            # Wind speed in operational range
            pl.col('wind_speed') >= self.specs.cut_in_speed,
            pl.col('wind_speed') <= self.specs.cut_out_speed,
        ]

        # Filter out curtailment if high wind with low power
        filters.append(
            ~(
                (pl.col('wind_speed') > self.specs.rated_speed) &
                (pl.col('power') < 0.5 * self.rated_power)
            )
        )

        # Filter for running turbine if rotor_speed available
        if 'rotor_speed' in df.columns:
            filters.append(pl.col('rotor_speed') > 1.0)

        # Filter for no faults if status_code available
        if 'status_code' in df.columns:
            filters.append(pl.col('status_code') == 0)

        return df.filter(pl.all_horizontal(filters))


class PowerCurveAnomalyDetector:
    """
    Detect underperformance using statistical methods.

    Uses Isolation Forest for unsupervised anomaly detection
    on power curve deviation patterns.

    Example:
        detector = PowerCurveAnomalyDetector()
        detector.fit(historical_clean_data)

        df_with_anomalies = detector.detect(current_data)
        anomalies = df_with_anomalies.filter(pl.col('is_anomaly'))
    """

    FEATURE_COLS = ['wind_speed', 'efficiency', 'power_deficit']

    def __init__(self, contamination: float = 0.05):
        """
        Args:
            contamination: Expected fraction of anomalies (0-1)
        """
        if not SKLEARN_AVAILABLE:
            raise ImportError(
                "scikit-learn required for anomaly detection. "
                "Install with: pip install scikit-learn"
            )

        self.contamination = contamination
        self.isolation_forest = None
        self.is_fitted = False

    def fit(self, df: "pl.DataFrame"):
        """
        Fit on clean historical data.

        df should contain: wind_speed, efficiency, power_deficit
        and optionally: pitch_angle, rotor_speed
        """
        if not POLARS_AVAILABLE:
            raise ImportError("polars required")

        # Select available features
        available_features = [
            col for col in self.FEATURE_COLS + ['pitch_angle', 'rotor_speed']
            if col in df.columns
        ]

        features = df.select(available_features).to_numpy()

        self.isolation_forest = IsolationForest(
            contamination=self.contamination,
            random_state=42,
            n_jobs=-1
        )
        self.isolation_forest.fit(features)
        self._feature_cols = available_features
        self.is_fitted = True

    def detect(self, df: "pl.DataFrame") -> "pl.DataFrame":
        """
        Detect anomalies in current data.

        Returns DataFrame with anomaly_score and is_anomaly columns.
        """
        if not self.is_fitted:
            raise ValueError("Must fit before detecting")

        features = df.select(self._feature_cols).to_numpy()

        scores = self.isolation_forest.decision_function(features)
        predictions = self.isolation_forest.predict(features)

        return df.with_columns([
            pl.lit(scores).alias('anomaly_score'),
            pl.lit(predictions == -1).alias('is_anomaly')
        ])


class BinMethodAnalyzer:
    """
    IEC 61400-12-1 standard bin method for power curve verification.

    More rigorous than simple comparison - creates binned reference
    curve from clean data for statistical validation.

    Example:
        bin_analyzer = BinMethodAnalyzer()
        reference = bin_analyzer.create_reference_curve(clean_historical_data)

        # Compare current performance
        comparison = bin_analyzer.compare_to_reference(current_data)
        print(f"AEP loss: {comparison['aep_loss_pct']:.1%}")
    """

    def __init__(self, bin_width: float = 0.5):
        """
        Args:
            bin_width: Wind speed bin width in m/s (IEC standard: 0.5)
        """
        self.bin_width = bin_width
        self.reference_curve = {}
        self.bins = np.arange(0, 30, bin_width)

    def create_reference_curve(self, df: "pl.DataFrame") -> dict:
        """
        Create binned reference curve from clean data.

        Args:
            df: Clean historical data with wind_speed and power columns

        Returns:
            Dict of bin statistics
        """
        if not POLARS_AVAILABLE:
            raise ImportError("polars required")

        reference = {}

        for i, bin_start in enumerate(self.bins[:-1]):
            bin_end = self.bins[i + 1]
            bin_label = f"{bin_start:.1f}-{bin_end:.1f}"

            bin_data = df.filter(
                (pl.col('wind_speed') >= bin_start) &
                (pl.col('wind_speed') < bin_end)
            )

            if len(bin_data) >= 3:  # Minimum samples per bin
                power_values = bin_data['power'].to_numpy()
                reference[bin_label] = {
                    'mean_power': float(np.mean(power_values)),
                    'std_power': float(np.std(power_values)),
                    'count': len(bin_data),
                    'bin_center': (bin_start + bin_end) / 2
                }

        self.reference_curve = reference
        return reference

    def compare_to_reference(self, df: "pl.DataFrame") -> dict:
        """
        Compare current data to reference curve.

        Returns:
            Dict with comparison metrics and deviations by bin
        """
        if not self.reference_curve:
            raise ValueError("Must create reference curve first")

        deviations = {}
        total_deficit = 0
        total_expected = 0

        for bin_label, ref_stats in self.reference_curve.items():
            bin_start = float(bin_label.split('-')[0])
            bin_end = float(bin_label.split('-')[1])

            bin_data = df.filter(
                (pl.col('wind_speed') >= bin_start) &
                (pl.col('wind_speed') < bin_end)
            )

            if len(bin_data) > 0:
                current_mean = float(bin_data['power'].mean())
                deviation = current_mean - ref_stats['mean_power']
                deviation_pct = deviation / ref_stats['mean_power'] if ref_stats['mean_power'] > 0 else 0

                deviations[bin_label] = {
                    'current_mean': current_mean,
                    'reference_mean': ref_stats['mean_power'],
                    'deviation_kw': deviation,
                    'deviation_pct': deviation_pct,
                    'count': len(bin_data)
                }

                total_deficit += abs(min(0, deviation)) * len(bin_data)
                total_expected += ref_stats['mean_power'] * len(bin_data)

        aep_loss_pct = total_deficit / total_expected if total_expected > 0 else 0

        return {
            'bin_deviations': deviations,
            'total_deficit_kwh': total_deficit,
            'aep_loss_pct': aep_loss_pct,
            'bins_analyzed': len(deviations)
        }

    def estimate_aep_loss(
        self,
        current_curve: dict,
        wind_distribution: np.ndarray,
        hours_per_year: int = 8760
    ) -> float:
        """
        Estimate Annual Energy Production loss from curve degradation.

        Args:
            current_curve: Current measured power curve by bin
            wind_distribution: Hours at each wind speed bin
            hours_per_year: Total hours (default 8760)

        Returns:
            Estimated AEP loss in MWh/year
        """
        total_loss_kwh = 0

        for bin_label, ref_stats in self.reference_curve.items():
            if bin_label in current_curve:
                current_power = current_curve[bin_label]['mean_power']
                ref_power = ref_stats['mean_power']
                deficit = max(0, ref_power - current_power)

                # Find corresponding bin index for hours
                bin_idx = int(float(bin_label.split('-')[0]) / self.bin_width)
                if bin_idx < len(wind_distribution):
                    hours_at_speed = wind_distribution[bin_idx]
                    total_loss_kwh += deficit * hours_at_speed

        return total_loss_kwh / 1000  # Convert to MWh
