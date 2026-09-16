"""
BESS RUL (Remaining Useful Life) Prediction Models

Regression-based models that predict "days until fault X" for battery energy
storage systems. Each model uses linear trend extrapolation over a rolling
history window, analogous to the PV rul_models.py pattern but adapted to
BESS degradation physics.

Models:
- RULCapacityFadeModel:   Days until SoH drops below warranty threshold (70%)
- RULThermalStressModel:  Days until cumulative thermal stress exceeds safe limit
- RULCycleLifeModel:      Days until equivalent full cycles reach warranty limit
- RULRteDecayModel:       Days until round-trip efficiency drops below 85%
- RULCellImbalanceModel:  Days until max cell voltage spread exceeds 50 mV
"""

from __future__ import annotations

from typing import Optional
import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Urgency helpers
# ---------------------------------------------------------------------------

def _urgency_label(days: float) -> str:
    """Map days-to-fault to an operator-friendly urgency string."""
    if days < 3:
        return "urgent"
    if days < 14:
        return "soon"
    if days < 60:
        return "planned"
    return "monitoring"


def _linear_trend(x: np.ndarray, y: np.ndarray) -> tuple[float, float, float]:
    """
    Fit a 1-D linear regression y = slope * x + intercept.

    Returns:
        slope (per-day change), intercept, r_squared (0-1)
    """
    if len(x) < 2:
        return 0.0, float(y[-1]) if len(y) else 0.0, 0.0

    coeffs = np.polyfit(x, y, 1)
    slope, intercept = float(coeffs[0]), float(coeffs[1])

    # R-squared
    y_hat = slope * x + intercept
    ss_res = np.sum((y - y_hat) ** 2)
    ss_tot = np.sum((y - np.mean(y)) ** 2)
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 1e-12 else 0.0
    r2 = float(np.clip(r2, 0.0, 1.0))

    return slope, intercept, r2


# ---------------------------------------------------------------------------
# Model 1: Capacity Fade (SoH)
# ---------------------------------------------------------------------------

class RULCapacityFadeModel:
    """
    Predict days until State-of-Health drops below the warranty threshold.

    The model fits a linear trend to historical SoH observations, then
    extrapolates to find when the trend line crosses the threshold.

    Primary feature: soh (State of Health, 0–1 fraction)
    Threshold:       warranty_threshold (default 0.70)
    Trend:           linear regression over the last `window_days` points
    Confidence:      R² of the trend fit
    """

    FAULT_TYPE = "capacity_fade"
    DISPLAY_NAME = "Capacity Fade Warning"
    UNIT = "%"
    RECOMMENDED_ACTION = "Review dispatch strategy to reduce cycling stress and calendar aging"

    def __init__(self, warranty_threshold: float = 0.70, window_days: int = 30):
        self.warranty_threshold = warranty_threshold
        self.window_days = window_days

    def predict(self, history_df: pd.DataFrame) -> dict:
        """
        Predict days until SoH falls below warranty_threshold.

        Args:
            history_df: DataFrame with columns ['date', 'soh'].
                        'date' must be parseable or already datetime-like.
                        'soh' is a float in [0, 1].

        Returns:
            Prediction dict with days_to_fault, confidence, current_value,
            threshold, trend, is_urgent, and urgency.
        """
        df = _prepare(history_df, "soh", self.window_days)
        if df is None or len(df) < 3:
            return _fallback(self.warranty_threshold, "soh")

        x = df["day_index"].to_numpy(dtype=float)
        y = df["soh"].to_numpy(dtype=float)

        slope, intercept, r2 = _linear_trend(x, y)

        current_value = float(y[-1])
        gap = current_value - self.warranty_threshold  # positive = still healthy

        # Extrapolate: x_fault = (threshold - intercept) / slope
        if slope >= 0 or gap <= 0:
            # Not degrading or already past threshold
            days_to_fault = 0.0 if gap <= 0 else float("inf")
        else:
            x_fault = (self.warranty_threshold - intercept) / slope
            days_remaining = x_fault - x[-1]
            days_to_fault = max(0.0, float(days_remaining))

        if days_to_fault == float("inf"):
            days_to_fault = 3650.0  # Cap at 10 years for stable systems

        return _build_result(
            days_to_fault=days_to_fault,
            confidence=r2,
            current_value=current_value,
            threshold=self.warranty_threshold,
            trend=slope,
        )


# ---------------------------------------------------------------------------
# Model 2: Thermal Stress
# ---------------------------------------------------------------------------

class RULThermalStressModel:
    """
    Predict days until cumulative high-temperature exposure exceeds safe limit.

    Uses an exponential moving average (EMA) of daily peak temperatures to
    project forward. A day counts as a "thermal stress day" when the EMA
    exceeds `temp_limit_c`. The safe limit is expressed in cumulative stress
    days (default 90, representing ~3 months of continuous high-heat exposure).

    Primary feature: daily_max_temp_c (peak cell or ambient temperature per day)
    Threshold:       temp_limit_c (default 45 °C)
    Confidence:      R² of EMA trend
    """

    FAULT_TYPE = "thermal_stress"
    DISPLAY_NAME = "Thermal Stress Warning"
    UNIT = "°C"
    RECOMMENDED_ACTION = (
        "Inspect HVAC / cooling system. Reduce peak power during hottest hours "
        "to lower cell temperature."
    )

    def __init__(
        self,
        temp_limit_c: float = 45.0,
        safe_stress_days: float = 90.0,
        ema_span: int = 7,
        window_days: int = 30,
    ):
        self.temp_limit_c = temp_limit_c
        self.safe_stress_days = safe_stress_days
        self.ema_span = ema_span
        self.window_days = window_days

    def predict(self, history_df: pd.DataFrame) -> dict:
        """
        Predict days until cumulative thermal stress exceeds safe limit.

        Args:
            history_df: DataFrame with columns ['date', 'daily_max_temp_c'].

        Returns:
            Prediction dict.
        """
        df = _prepare(history_df, "daily_max_temp_c", self.window_days)
        if df is None or len(df) < 3:
            return _fallback(self.temp_limit_c, "daily_max_temp_c")

        temps = df["daily_max_temp_c"].to_numpy(dtype=float)

        # EMA of daily max temperature
        ema_series = pd.Series(temps).ewm(span=self.ema_span, adjust=False).mean().to_numpy()

        # Cumulative stress: count days EMA exceeded limit
        above = (ema_series > self.temp_limit_c).astype(float)
        cumulative_stress = float(np.sum(above))

        # Trend in EMA values for confidence estimate
        x = df["day_index"].to_numpy(dtype=float)
        slope, _, r2 = _linear_trend(x, ema_series)

        current_ema = float(ema_series[-1])
        remaining_capacity = max(0.0, self.safe_stress_days - cumulative_stress)

        if current_ema <= self.temp_limit_c:
            # Not currently in stress zone; estimate distant horizon
            days_to_fault = 3650.0
        elif remaining_capacity <= 0:
            days_to_fault = 0.0
        else:
            # Rate: days per day of cumulative stress accrual (roughly 1 if above threshold)
            # Project remaining capacity at current daily stress rate
            daily_stress_rate = float(np.mean(above[-14:]) if len(above) >= 14 else np.mean(above))
            if daily_stress_rate > 0:
                days_to_fault = remaining_capacity / daily_stress_rate
            else:
                days_to_fault = 3650.0

        return _build_result(
            days_to_fault=days_to_fault,
            confidence=r2,
            current_value=current_ema,
            threshold=self.temp_limit_c,
            trend=slope,
        )


# ---------------------------------------------------------------------------
# Model 3: Cycle Life
# ---------------------------------------------------------------------------

class RULCycleLifeModel:
    """
    Predict days until cumulative equivalent full cycles reach the warranty limit.

    Uses a rolling average daily cycling rate (EFC/day) to project forward.

    Primary feature: cumulative_efc (equivalent full cycles, cumulative)
    Threshold:       max_cycles (default 6000 EFC)
    Trend:           daily_efc_rate = mean EFC/day over last `window_days`
    Confidence:      R² of the daily rate trend
    """

    FAULT_TYPE = "cycle_life"
    DISPLAY_NAME = "Cycle Life Warning"
    UNIT = "EFC"
    RECOMMENDED_ACTION = (
        "Reduce daily cycling frequency. Consider partial-cycle dispatching "
        "to stay within warranty budget."
    )

    def __init__(self, max_cycles: float = 6000.0, window_days: int = 30):
        self.max_cycles = max_cycles
        self.window_days = window_days

    def predict(self, history_df: pd.DataFrame) -> dict:
        """
        Predict days until cumulative EFC reaches max_cycles.

        Args:
            history_df: DataFrame with columns ['date', 'cumulative_efc'].
                        'cumulative_efc' is monotonically increasing.

        Returns:
            Prediction dict.
        """
        df = _prepare(history_df, "cumulative_efc", self.window_days)
        if df is None or len(df) < 3:
            return _fallback(self.max_cycles, "cumulative_efc")

        x = df["day_index"].to_numpy(dtype=float)
        y = df["cumulative_efc"].to_numpy(dtype=float)

        slope, _, r2 = _linear_trend(x, y)

        current_cycles = float(y[-1])
        remaining_cycles = max(0.0, self.max_cycles - current_cycles)

        daily_rate = max(0.0, slope)  # EFC per day (slope of cumulative trend)

        if daily_rate <= 1e-6:
            days_to_fault = 3650.0
        elif remaining_cycles <= 0:
            days_to_fault = 0.0
        else:
            days_to_fault = remaining_cycles / daily_rate

        return _build_result(
            days_to_fault=days_to_fault,
            confidence=r2,
            current_value=current_cycles,
            threshold=self.max_cycles,
            trend=slope,
        )


# ---------------------------------------------------------------------------
# Model 4: Round-Trip Efficiency Decay
# ---------------------------------------------------------------------------

class RULRteDecayModel:
    """
    Predict days until round-trip efficiency drops below the warranty floor.

    Applies a 30-day moving average to smooth daily RTE measurements, then
    fits a linear trend to project when the smoother crosses min_rte.

    Primary feature: daily_rte (round-trip efficiency per day, 0–1 fraction)
    Threshold:       min_rte (default 0.85)
    Confidence:      R² of trend on the smoothed series
    """

    FAULT_TYPE = "rte_decay"
    DISPLAY_NAME = "Round-Trip Efficiency Decay"
    UNIT = "%"
    RECOMMENDED_ACTION = (
        "Investigate internal resistance increase. Check connections, BMS "
        "calibration, and consider capacity test to confirm degradation."
    )

    def __init__(self, min_rte: float = 0.85, window_days: int = 30):
        self.min_rte = min_rte
        self.window_days = window_days

    def predict(self, history_df: pd.DataFrame) -> dict:
        """
        Predict days until smoothed RTE crosses min_rte.

        Args:
            history_df: DataFrame with columns ['date', 'daily_rte'].
                        'daily_rte' is a float in (0, 1].

        Returns:
            Prediction dict.
        """
        df = _prepare(history_df, "daily_rte", self.window_days)
        if df is None or len(df) < 3:
            return _fallback(self.min_rte, "daily_rte")

        rte_raw = df["daily_rte"].to_numpy(dtype=float)

        # 30-day moving average (or full window if shorter)
        ma_len = min(self.window_days, len(rte_raw))
        smoothed = pd.Series(rte_raw).rolling(window=ma_len, min_periods=1).mean().to_numpy()

        x = df["day_index"].to_numpy(dtype=float)
        slope, intercept, r2 = _linear_trend(x, smoothed)

        current_value = float(smoothed[-1])
        gap = current_value - self.min_rte  # positive = still above floor

        if slope >= 0 or gap <= 0:
            days_to_fault = 0.0 if gap <= 0 else 3650.0
        else:
            x_fault = (self.min_rte - intercept) / slope
            days_to_fault = max(0.0, float(x_fault - x[-1]))

        return _build_result(
            days_to_fault=days_to_fault,
            confidence=r2,
            current_value=current_value,
            threshold=self.min_rte,
            trend=slope,
        )


# ---------------------------------------------------------------------------
# Model 5: Cell Imbalance
# ---------------------------------------------------------------------------

class RULCellImbalanceModel:
    """
    Predict days until max cell voltage spread exceeds the imbalance threshold.

    A growing voltage spread across cells indicates lithium plating, dendrite
    growth, or early-stage cell failure, which accelerates uncontrolled if
    unchecked. The model extrapolates a 14-day linear trend.

    Primary feature: cell_voltage_spread_mv (max - min cell voltage in mV)
    Threshold:       max_spread_mv (default 50 mV)
    Confidence:      R² of the 14-day trend fit
    """

    FAULT_TYPE = "cell_imbalance"
    DISPLAY_NAME = "Cell Voltage Imbalance Warning"
    UNIT = "mV"
    RECOMMENDED_ACTION = (
        "Schedule a full balance cycle. If spread continues growing, "
        "inspect individual cells for early-stage failure."
    )

    def __init__(self, max_spread_mv: float = 50.0, window_days: int = 14):
        self.max_spread_mv = max_spread_mv
        self.window_days = window_days

    def predict(self, history_df: pd.DataFrame) -> dict:
        """
        Predict days until cell voltage spread exceeds max_spread_mv.

        Args:
            history_df: DataFrame with columns ['date', 'cell_voltage_spread_mv'].
                        'cell_voltage_spread_mv' is the daily maximum spread in mV.

        Returns:
            Prediction dict.
        """
        df = _prepare(history_df, "cell_voltage_spread_mv", self.window_days)
        if df is None or len(df) < 3:
            return _fallback(self.max_spread_mv, "cell_voltage_spread_mv")

        x = df["day_index"].to_numpy(dtype=float)
        y = df["cell_voltage_spread_mv"].to_numpy(dtype=float)

        slope, intercept, r2 = _linear_trend(x, y)

        current_value = float(y[-1])
        gap = self.max_spread_mv - current_value  # positive = still below threshold

        if slope <= 0 or gap <= 0:
            days_to_fault = 0.0 if gap <= 0 else 3650.0
        else:
            x_fault = (self.max_spread_mv - intercept) / slope
            days_to_fault = max(0.0, float(x_fault - x[-1]))

        return _build_result(
            days_to_fault=days_to_fault,
            confidence=r2,
            current_value=current_value,
            threshold=self.max_spread_mv,
            trend=slope,
        )


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

ALL_BESS_RUL_MODELS: dict[str, type] = {
    "capacity_fade": RULCapacityFadeModel,
    "thermal_stress": RULThermalStressModel,
    "cycle_life": RULCycleLifeModel,
    "rte_decay": RULRteDecayModel,
    "cell_imbalance": RULCellImbalanceModel,
}


def create_bess_rul_model(fault_type: str) -> object:
    """
    Factory function — create a default-configured BESS RUL model.

    Args:
        fault_type: One of 'capacity_fade', 'thermal_stress', 'cycle_life',
                    'rte_decay', 'cell_imbalance'.

    Returns:
        Configured model instance.
    """
    if fault_type not in ALL_BESS_RUL_MODELS:
        raise ValueError(
            f"Unknown BESS fault type: {fault_type!r}. "
            f"Options: {list(ALL_BESS_RUL_MODELS.keys())}"
        )
    return ALL_BESS_RUL_MODELS[fault_type]()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _prepare(
    history_df: pd.DataFrame,
    feature_col: str,
    window_days: int,
) -> Optional[pd.DataFrame]:
    """
    Validate, sort, and window the history DataFrame.

    Returns None when data is insufficient.
    """
    if history_df is None or len(history_df) == 0:
        return None
    if feature_col not in history_df.columns:
        return None
    if "date" not in history_df.columns:
        return None

    df = history_df[["date", feature_col]].copy()
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").dropna(subset=[feature_col]).reset_index(drop=True)

    # Keep last `window_days` rows
    if len(df) > window_days:
        df = df.iloc[-window_days:].reset_index(drop=True)

    if len(df) < 3:
        return None

    # Numeric day index starting from 0
    first_day = df["date"].iloc[0]
    df["day_index"] = (df["date"] - first_day).dt.days.astype(float)

    return df


def _build_result(
    days_to_fault: float,
    confidence: float,
    current_value: float,
    threshold: float,
    trend: float,
) -> dict:
    """Assemble the standard prediction output dict."""
    days_to_fault = min(days_to_fault, 3650.0)  # Cap at 10 years
    urgency = _urgency_label(days_to_fault)
    return {
        "days_to_fault": round(days_to_fault, 1),
        "confidence": round(float(np.clip(confidence, 0.0, 1.0)), 3),
        "current_value": round(current_value, 4),
        "threshold": threshold,
        "trend": round(trend, 6),
        "is_urgent": days_to_fault < 3,
        "urgency": urgency,
    }


def _fallback(threshold: float, feature_name: str) -> dict:
    """Return a low-confidence sentinel when data is insufficient."""
    return {
        "days_to_fault": 3650.0,
        "confidence": 0.0,
        "current_value": None,
        "threshold": threshold,
        "trend": None,
        "is_urgent": False,
        "urgency": "monitoring",
    }
