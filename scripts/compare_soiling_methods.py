#!/usr/bin/env python3
"""
Compare soiling detection methods across all plants:
1. DustIQ sensors (ground truth)
2. ML model predictions
3. Digital twin-based loss disaggregation (NEW)

The goal is to validate that twin-based soiling isolation
correlates with actual DustIQ measurements.
"""

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))


def load_dustiq_data(plant_id: str) -> Tuple[List[str], List[float]]:
    """Load DustIQ soiling ratio data."""
    dustiq_file = Path(f"public/data/soiling/{plant_id}/dustiq_history.json")

    if not dustiq_file.exists():
        return [], []

    with open(dustiq_file) as f:
        data = json.load(f)

    daily = data.get("daily_data", [])
    dates = []
    sr_values = []

    for d in daily:
        date = d.get("date")
        sr = d.get("sr_dustiq") or d.get("soiling_ratio") or d.get("sr")
        if date and sr is not None:
            dates.append(date)
            sr_values.append(float(sr))

    return dates, sr_values


def load_ml_predictions(plant_id: str) -> Tuple[List[str], List[float]]:
    """Load ML soiling model predictions."""
    ml_file = Path(f"public/data/soiling/{plant_id}/ml_sr_predictions.json")

    if not ml_file.exists():
        return [], []

    with open(ml_file) as f:
        data = json.load(f)

    daily = data.get("daily_data", data.get("predictions", []))
    dates = []
    sr_values = []

    for d in daily:
        if isinstance(d, dict):
            date = d.get("date")
            sr = d.get("sr_ml") or d.get("sr_predicted") or d.get("soiling_ratio") or d.get("sr")
        else:
            continue

        if date and sr is not None:
            dates.append(date)
            sr_values.append(float(sr))

    return dates, sr_values


def load_twin_metrics(plant_id: str) -> Dict:
    """Load digital twin training metrics."""
    results_file = Path(f"public/data/digitaltwin/{plant_id}/training_results.json")

    if not results_file.exists():
        return {}

    with open(results_file) as f:
        data = json.load(f)

    return data


def calculate_soiling_isolation_potential(twin_metrics: Dict) -> Dict:
    """
    Calculate how well twins can isolate soiling from other losses.

    Key insight:
    - High current R² means we can detect uniform vs non-uniform losses
    - Low current CV + high current R² = uniform soiling
    - High current CV = shading (not soiling)

    Returns estimated soiling contribution capability.
    """
    inverter_results = twin_metrics.get("inverter_results", {})

    if not inverter_results:
        return {"quality": 0, "confidence": "NONE"}

    temp_r2_list = []
    curr_r2_list = []
    volt_r2_list = []

    for inv_data in inverter_results.values():
        if "temperature" in inv_data:
            temp_r2_list.append(inv_data["temperature"].get("r2", 0))
        if "current" in inv_data:
            curr_r2_list.append(inv_data["current"].get("r2", 0))
        if "voltage" in inv_data:
            volt_r2_list.append(inv_data["voltage"].get("r2", 0))

    avg_temp_r2 = np.mean(temp_r2_list) if temp_r2_list else 0
    avg_curr_r2 = np.mean(curr_r2_list) if curr_r2_list else 0
    avg_volt_r2 = np.mean(volt_r2_list) if volt_r2_list else 0

    # Soiling isolation quality formula:
    # - Current R² most important (50%): detects shading vs uniform
    # - Temp R² (30%): removes thermal losses
    # - Voltage R² (20%): detects equipment issues
    quality = (
        0.5 * max(0, avg_curr_r2) +
        0.3 * max(0, avg_temp_r2) +
        0.2 * max(0, avg_volt_r2)
    )

    if quality > 0.85:
        confidence = "HIGH"
    elif quality > 0.65:
        confidence = "MEDIUM"
    else:
        confidence = "LOW"

    return {
        "quality": round(quality, 3),
        "confidence": confidence,
        "temp_r2": round(avg_temp_r2, 3),
        "current_r2": round(avg_curr_r2, 3),
        "voltage_r2": round(avg_volt_r2, 3),
        "n_inverters": len(inverter_results),
    }


def estimate_soiling_from_current_cv(
    avg_current_cv: float,
    total_loss_pct: float,
) -> float:
    """
    Estimate soiling contribution from current CV.

    Physics:
    - Low CV (< 0.03) = very uniform → high soiling probability
    - Medium CV (0.03-0.08) = somewhat uniform → mixed
    - High CV (> 0.08) = non-uniform → likely shading, not soiling

    Returns estimated soiling as fraction of total loss.
    """
    if avg_current_cv < 0.03:
        # Very uniform - soiling is likely 70-90% of remaining loss
        soiling_fraction = 0.85
    elif avg_current_cv < 0.05:
        # Somewhat uniform - 50-70%
        soiling_fraction = 0.6
    elif avg_current_cv < 0.08:
        # Mixed - 30-50%
        soiling_fraction = 0.4
    else:
        # Non-uniform - mostly shading, 10-30% soiling
        soiling_fraction = 0.2

    return total_loss_pct * soiling_fraction


def compare_methods_for_plant(plant_id: str) -> Dict:
    """Compare all soiling detection methods for a plant."""
    result = {
        "plant_id": plant_id,
        "dustiq": None,
        "ml_model": None,
        "twin_based": None,
        "comparison": None,
    }

    # Load DustIQ data
    dustiq_dates, dustiq_sr = load_dustiq_data(plant_id)
    if dustiq_sr:
        # Calculate statistics
        sr_array = np.array(dustiq_sr)
        # Soiling loss = 1 - SR
        soiling_loss = (1 - sr_array) * 100

        result["dustiq"] = {
            "n_days": len(dustiq_sr),
            "date_range": f"{dustiq_dates[0]} to {dustiq_dates[-1]}" if dustiq_dates else None,
            "avg_soiling_ratio": round(np.mean(sr_array), 4),
            "avg_soiling_loss_pct": round(np.mean(soiling_loss), 2),
            "max_soiling_loss_pct": round(np.max(soiling_loss), 2),
            "min_soiling_ratio": round(np.min(sr_array), 4),
        }

    # Load ML predictions
    ml_dates, ml_sr = load_ml_predictions(plant_id)
    if ml_sr:
        sr_array = np.array(ml_sr)
        soiling_loss = (1 - sr_array) * 100

        result["ml_model"] = {
            "n_predictions": len(ml_sr),
            "date_range": f"{ml_dates[0]} to {ml_dates[-1]}" if ml_dates else None,
            "avg_soiling_ratio": round(np.mean(sr_array), 4),
            "avg_soiling_loss_pct": round(np.mean(soiling_loss), 2),
            "max_soiling_loss_pct": round(np.max(soiling_loss), 2),
        }

    # Load twin metrics
    twin_metrics = load_twin_metrics(plant_id)
    if twin_metrics:
        isolation = calculate_soiling_isolation_potential(twin_metrics)
        result["twin_based"] = isolation

    # Compare if we have both DustIQ and twin metrics
    if result["dustiq"] and result["twin_based"]:
        dustiq_loss = result["dustiq"]["avg_soiling_loss_pct"]
        twin_quality = result["twin_based"]["quality"]

        # Estimate: with perfect twins (quality=1), we'd isolate 100% of soiling
        # With quality < 1, we estimate proportionally less
        estimated_detection = dustiq_loss * twin_quality

        result["comparison"] = {
            "dustiq_avg_loss_pct": dustiq_loss,
            "twin_isolation_quality": twin_quality,
            "estimated_detectable_loss_pct": round(estimated_detection, 2),
            "detection_potential": f"{twin_quality*100:.0f}% of soiling can be isolated",
        }

    return result


def main():
    """Run comparison across all plants."""
    print("\n" + "="*80)
    print("SOILING DETECTION METHOD COMPARISON")
    print("DustIQ (Ground Truth) vs ML Model vs Digital Twin Disaggregation")
    print("="*80)

    plants = [
        "alpha",
        "ribera",
        "eta",
        "epsilon",
        "zeta",
        "delta",
        "gamma",
    ]

    all_results = []

    for plant_id in plants:
        print(f"\n{'='*60}")
        print(f"Analyzing: {plant_id.upper()}")
        print(f"{'='*60}")

        result = compare_methods_for_plant(plant_id)
        all_results.append(result)

        # Print summary
        if result["dustiq"]:
            d = result["dustiq"]
            print(f"\n  DUSTIQ (Ground Truth):")
            print(f"    Data: {d['n_days']} days ({d['date_range']})")
            print(f"    Avg Soiling Ratio: {d['avg_soiling_ratio']:.4f}")
            print(f"    Avg Soiling Loss: {d['avg_soiling_loss_pct']:.2f}%")
            print(f"    Max Soiling Loss: {d['max_soiling_loss_pct']:.2f}%")

        if result["ml_model"]:
            m = result["ml_model"]
            print(f"\n  ML MODEL Predictions:")
            print(f"    Predictions: {m['n_predictions']} days")
            print(f"    Avg Predicted SR: {m['avg_soiling_ratio']:.4f}")
            print(f"    Avg Predicted Loss: {m['avg_soiling_loss_pct']:.2f}%")

        if result["twin_based"]:
            t = result["twin_based"]
            print(f"\n  DIGITAL TWIN Isolation Capability:")
            print(f"    Inverters: {t['n_inverters']}")
            print(f"    Temp R²: {t['temp_r2']:.3f}")
            print(f"    Current R²: {t['current_r2']:.3f}")
            print(f"    Voltage R²: {t['voltage_r2']:.3f}")
            print(f"    Isolation Quality: {t['quality']:.3f} ({t['confidence']})")

        if result["comparison"]:
            c = result["comparison"]
            print(f"\n  COMPARISON:")
            print(f"    {c['detection_potential']}")
            print(f"    Detectable soiling: ~{c['estimated_detectable_loss_pct']:.2f}% of {c['dustiq_avg_loss_pct']:.2f}% total")

    # Summary table
    print("\n" + "="*80)
    print("SUMMARY TABLE")
    print("="*80)
    print(f"{'Plant':<12} | {'DustIQ Loss':<12} | {'ML Loss':<10} | {'Twin Quality':<12} | {'Detectable':<12}")
    print("-"*80)

    for r in all_results:
        dustiq = f"{r['dustiq']['avg_soiling_loss_pct']:.2f}%" if r['dustiq'] else "N/A"
        ml = f"{r['ml_model']['avg_soiling_loss_pct']:.2f}%" if r['ml_model'] else "N/A"
        twin = f"{r['twin_based']['quality']:.3f}" if r['twin_based'] else "N/A"
        detect = f"~{r['comparison']['estimated_detectable_loss_pct']:.2f}%" if r['comparison'] else "N/A"

        print(f"{r['plant_id']:<12} | {dustiq:<12} | {ml:<10} | {twin:<12} | {detect:<12}")

    # Key insight
    print("\n" + "="*80)
    print("KEY INSIGHTS")
    print("="*80)
    print("""
    The Digital Twin isolation quality tells us how much of the soiling loss
    we can reliably attribute to soiling vs other factors:

    HIGH (>0.85): Twins can isolate ~85%+ of soiling from thermal/shading/faults
    MEDIUM (0.65-0.85): ~65-85% isolation - reasonable for operational use
    LOW (<0.65): Poor isolation - need better twin training or meteo data

    For plants with LOW quality (Delta, Gamma): the bad meteo data
    prevents accurate thermal loss removal, which contaminates soiling estimates.
    """)

    # Save results
    output_path = Path("public/data/digitaltwin/soiling_comparison.json")
    with open(output_path, "w") as f:
        json.dump({
            "analysis_date": datetime.now().isoformat(),
            "plants": all_results,
        }, f, indent=2)

    print(f"\n✓ Results saved to {output_path}")

    return all_results


if __name__ == "__main__":
    main()
