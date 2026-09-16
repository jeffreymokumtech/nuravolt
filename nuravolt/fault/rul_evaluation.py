"""
Multi-Horizon RUL Model Evaluation Framework

Evaluates RUL (Remaining Useful Life) models at multiple prediction horizons
to provide actionable insights for maintenance scheduling.
"""

from dataclasses import dataclass, field
from typing import Optional
import numpy as np


# Default evaluation horizons (days)
DEFAULT_HORIZONS = [1, 3, 7, 14, 30]


@dataclass
class HorizonMetrics:
    """Metrics for a single prediction horizon."""

    horizon_days: int
    accuracy_pct: float  # % of predictions within horizon
    n_within: int  # Count within horizon
    n_total: int  # Total samples


@dataclass
class MultiHorizonResult:
    """Complete multi-horizon evaluation result."""

    # Per-horizon accuracy
    horizon_metrics: dict[int, HorizonMetrics]

    # Error metrics
    mae: float  # Mean Absolute Error (days)
    rmse: float  # Root Mean Squared Error (days)
    median_ae: float  # Median Absolute Error (days)

    # Operational metrics
    overestimate_rate: float  # % predictions > actual (dangerous - gives false safety)
    underestimate_rate: float  # % predictions < actual (conservative - earlier warnings)

    # Distribution metrics
    error_std: float  # Standard deviation of errors
    error_25th: float  # 25th percentile of absolute errors
    error_75th: float  # 75th percentile of absolute errors
    error_95th: float  # 95th percentile of absolute errors

    # Sample info
    n_samples: int

    def within(self, days: int) -> float:
        """Get accuracy percentage for a specific horizon."""
        if days in self.horizon_metrics:
            return self.horizon_metrics[days].accuracy_pct
        # Interpolate if exact horizon not computed
        errors = np.array([m.accuracy_pct for m in self.horizon_metrics.values()])
        return errors.mean()

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "horizons": {
                f"within_{h}d": m.accuracy_pct
                for h, m in self.horizon_metrics.items()
            },
            "mae": round(self.mae, 4),
            "rmse": round(self.rmse, 4),
            "median_ae": round(self.median_ae, 4),
            "overestimate_rate": round(self.overestimate_rate, 2),
            "underestimate_rate": round(self.underestimate_rate, 2),
            "error_std": round(self.error_std, 4),
            "error_percentiles": {
                "25th": round(self.error_25th, 4),
                "75th": round(self.error_75th, 4),
                "95th": round(self.error_95th, 4),
            },
            "n_samples": self.n_samples,
        }


class MultiHorizonEvaluator:
    """
    Evaluate RUL models at multiple prediction horizons.

    Provides comprehensive evaluation metrics for maintenance scheduling:
    - Per-horizon accuracy (1, 3, 7, 14, 30 days)
    - Error statistics (MAE, RMSE, percentiles)
    - Operational metrics (over/underestimate rates)

    Example:
        evaluator = MultiHorizonEvaluator()
        result = evaluator.evaluate(y_true, y_pred)
        print(f"Within 3 days: {result.within(3):.1f}%")
        print(f"MAE: {result.mae:.2f} days")
    """

    def __init__(self, horizons: Optional[list[int]] = None):
        """
        Initialize evaluator with custom horizons.

        Args:
            horizons: List of horizon days to evaluate (default: [1, 3, 7, 14, 30])
        """
        self.horizons = horizons or DEFAULT_HORIZONS

    def evaluate(
        self,
        y_true: np.ndarray,
        y_pred: np.ndarray,
    ) -> MultiHorizonResult:
        """
        Evaluate predictions at all horizons.

        Args:
            y_true: Actual days to fault
            y_pred: Predicted days to fault

        Returns:
            MultiHorizonResult with all metrics
        """
        y_true = np.asarray(y_true).flatten()
        y_pred = np.asarray(y_pred).flatten()

        if len(y_true) != len(y_pred):
            raise ValueError(f"Length mismatch: y_true={len(y_true)}, y_pred={len(y_pred)}")

        n_samples = len(y_true)
        errors = y_pred - y_true  # Positive = overestimate
        abs_errors = np.abs(errors)

        # Compute per-horizon metrics
        horizon_metrics = {}
        for horizon in self.horizons:
            n_within = np.sum(abs_errors <= horizon)
            horizon_metrics[horizon] = HorizonMetrics(
                horizon_days=horizon,
                accuracy_pct=round(n_within / n_samples * 100, 2),
                n_within=int(n_within),
                n_total=n_samples,
            )

        # Error statistics
        mae = float(np.mean(abs_errors))
        rmse = float(np.sqrt(np.mean(errors ** 2)))
        median_ae = float(np.median(abs_errors))
        error_std = float(np.std(errors))

        # Percentiles of absolute errors
        error_25th = float(np.percentile(abs_errors, 25))
        error_75th = float(np.percentile(abs_errors, 75))
        error_95th = float(np.percentile(abs_errors, 95))

        # Operational metrics
        overestimate_rate = float(np.mean(errors > 0) * 100)  # Predicted MORE time
        underestimate_rate = float(np.mean(errors < 0) * 100)  # Predicted LESS time

        return MultiHorizonResult(
            horizon_metrics=horizon_metrics,
            mae=mae,
            rmse=rmse,
            median_ae=median_ae,
            overestimate_rate=overestimate_rate,
            underestimate_rate=underestimate_rate,
            error_std=error_std,
            error_25th=error_25th,
            error_75th=error_75th,
            error_95th=error_95th,
            n_samples=n_samples,
        )

    def generate_report(
        self,
        result: MultiHorizonResult,
        model_name: str = "RUL Model",
    ) -> str:
        """
        Generate a formatted evaluation report.

        Args:
            result: MultiHorizonResult from evaluate()
            model_name: Name of the model for the report header

        Returns:
            Formatted string report
        """
        lines = [
            f"\n{'=' * 60}",
            f"MULTI-HORIZON EVALUATION: {model_name}",
            f"{'=' * 60}",
            f"\nSamples: {result.n_samples:,}",
            "",
            "HORIZON ACCURACY",
            "-" * 40,
        ]

        for horizon in sorted(result.horizon_metrics.keys()):
            m = result.horizon_metrics[horizon]
            bar = "#" * int(m.accuracy_pct / 5)  # Visual bar
            lines.append(f"  Within {horizon:2d}d: {m.accuracy_pct:6.1f}% {bar}")

        lines.extend([
            "",
            "ERROR METRICS",
            "-" * 40,
            f"  MAE:        {result.mae:.2f} days",
            f"  RMSE:       {result.rmse:.2f} days",
            f"  Median AE:  {result.median_ae:.2f} days",
            f"  Std Dev:    {result.error_std:.2f} days",
            "",
            "ERROR PERCENTILES",
            "-" * 40,
            f"  25th:       {result.error_25th:.2f} days",
            f"  75th:       {result.error_75th:.2f} days",
            f"  95th:       {result.error_95th:.2f} days",
            "",
            "OPERATIONAL METRICS",
            "-" * 40,
            f"  Overestimate:  {result.overestimate_rate:.1f}% (predicts more time - risky)",
            f"  Underestimate: {result.underestimate_rate:.1f}% (predicts less time - conservative)",
            "",
        ])

        # Add interpretation
        if result.overestimate_rate > 50:
            lines.append("  WARNING: Model tends to overestimate RUL (may miss faults)")
        elif result.underestimate_rate > 50:
            lines.append("  NOTE: Model is conservative (may trigger early alerts)")
        else:
            lines.append("  Model is well-calibrated")

        lines.append("=" * 60)

        return "\n".join(lines)

    def compare_models(
        self,
        results: dict[str, MultiHorizonResult],
    ) -> str:
        """
        Generate comparison table for multiple models.

        Args:
            results: Dict mapping model names to their results

        Returns:
            Formatted comparison table
        """
        if not results:
            return "No results to compare"

        # Header
        horizons = sorted(list(results.values())[0].horizon_metrics.keys())

        lines = [
            "",
            "MODEL COMPARISON TABLE",
            "=" * 100,
        ]

        # Column headers
        header = f"{'Model':<25} {'MAE':>8}"
        for h in horizons:
            header += f" {'W/' + str(h) + 'd':>8}"
        lines.append(header)
        lines.append("-" * 100)

        # Data rows
        for name, result in sorted(results.items()):
            row = f"{name:<25} {result.mae:>7.2f}d"
            for h in horizons:
                pct = result.horizon_metrics[h].accuracy_pct
                row += f" {pct:>7.1f}%"
            lines.append(row)

        lines.append("=" * 100)

        return "\n".join(lines)


def evaluate_rul_model(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    horizons: Optional[list[int]] = None,
) -> dict:
    """
    Convenience function to evaluate RUL predictions.

    Args:
        y_true: Actual days to fault
        y_pred: Predicted days to fault
        horizons: Custom horizons (default: [1, 3, 7, 14, 30])

    Returns:
        Dictionary with all metrics
    """
    evaluator = MultiHorizonEvaluator(horizons)
    result = evaluator.evaluate(y_true, y_pred)
    return result.to_dict()


# Success criteria by fault type
SUCCESS_CRITERIA = {
    "thermal_hotspot": {
        "target_mae": 1.0,
        "within_1d": 70,
        "within_3d": 90,
        "within_7d": 95,
    },
    "string_degradation": {
        "target_mae": 2.0,
        "within_1d": 50,
        "within_3d": 80,
        "within_7d": 95,
    },
    "bypass_diode": {
        "target_mae": 2.0,
        "within_1d": 50,
        "within_3d": 80,
        "within_7d": 95,
    },
    "mismatch": {
        "target_mae": 3.0,
        "within_1d": 40,
        "within_3d": 70,
        "within_7d": 90,
    },
    "module_degradation": {
        "target_mae": 7.0,
        "within_1d": 20,
        "within_3d": 50,
        "within_7d": 80,
    },
    "insulation": {
        "target_mae": 7.0,
        "within_1d": 20,
        "within_3d": 50,
        "within_7d": 80,
    },
}


def check_success_criteria(
    fault_type: str,
    result: MultiHorizonResult,
) -> tuple[bool, dict]:
    """
    Check if model meets success criteria for fault type.

    Args:
        fault_type: Type of fault model
        result: Evaluation result

    Returns:
        Tuple of (meets_criteria, details_dict)
    """
    criteria = SUCCESS_CRITERIA.get(fault_type, SUCCESS_CRITERIA["module_degradation"])

    checks = {
        "mae": result.mae <= criteria["target_mae"],
        "within_1d": result.within(1) >= criteria["within_1d"],
        "within_3d": result.within(3) >= criteria["within_3d"],
        "within_7d": result.within(7) >= criteria["within_7d"],
    }

    details = {
        "criteria": criteria,
        "actual": {
            "mae": result.mae,
            "within_1d": result.within(1),
            "within_3d": result.within(3),
            "within_7d": result.within(7),
        },
        "checks": checks,
    }

    meets_all = all(checks.values())

    return meets_all, details


if __name__ == "__main__":
    # Demo usage
    np.random.seed(42)

    # Simulate predictions
    y_true = np.random.uniform(0, 30, 1000)
    y_pred = y_true + np.random.normal(0, 2, 1000)  # Add noise

    evaluator = MultiHorizonEvaluator()
    result = evaluator.evaluate(y_true, y_pred)

    print(evaluator.generate_report(result, "Demo Model"))

    # Check success criteria
    meets, details = check_success_criteria("string_degradation", result)
    print(f"\nMeets success criteria: {meets}")
    print(f"Details: {details}")
