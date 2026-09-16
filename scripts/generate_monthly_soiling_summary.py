#!/usr/bin/env python3
"""Regenerate monthly_summary.json coherently with each plant's own data.

The old alpha fixture carried the raw donor plant's numbers (6,000 MWh/yr
lost at 17-28% — while the same page's headline says 96% SR / 4% loss).
This derives the monthly soiling loss from the plant's own story instead:

    clean energy per month   = sum of predicted_mwh from plant_power_history.json
    soiling loss share       = headline loss (1 - avgSoilingRatio from
                               ml_plant_summary) shaped by the plant's AOD
                               climatology seasonal_factor (monthly_soiling_
                               rates.json; default Mediterranean shape when
                               absent). DustIQ daily SR is deliberately NOT
                               used here: the donor sensor says the recent
                               year was near-clean, which contradicts the
                               plant's demo identity (96% SR fleet).
    revenue                  = energy x implied price from ml_plant_summary
                               (ytdRevenueLoss_EUR / ytdEnergyLoss_MWh, ~65 EUR/MWh)

Months covered: the 13 calendar months ending at the plant's data_end, so the
"by month" chart shows history, not future months.

Run: python scripts/generate_monthly_soiling_summary.py
"""

import json
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ROOTS = [REPO / "public/data", REPO / "public/data/showcase"]
N_MONTHS = 13


def month_key(day: str) -> str:
    return day[:7]


# Fallback seasonal soiling shape (Mediterranean: wet winters, dusty summers),
# same scale as monthly_soiling_rates.json seasonal_factor.
DEFAULT_SEASONAL = {
    1: 0.72, 2: 0.76, 3: 0.88, 4: 1.0, 5: 1.15, 6: 1.3,
    7: 1.4, 8: 1.35, 9: 1.15, 10: 0.95, 11: 0.8, 12: 0.72,
}


def rebuild(root: Path, plant: str) -> None:
    hist_path = root / "digitaltwin" / plant / "plant_power_history.json"
    soiling_dir = root / "soiling" / plant
    if not hist_path.exists() or not soiling_dir.exists():
        return
    history = json.loads(hist_path.read_text())
    daily = history.get("daily") or []
    if not daily:
        return

    # Monthly clean energy from the twin's expected production.
    clean_by_month = defaultdict(float)
    for row in daily:
        clean_by_month[month_key(row["date"])] += row.get("predicted_mwh") or 0.0

    # Seasonal shape from the plant's AOD climatology when present.
    seasonal = dict(DEFAULT_SEASONAL)
    rates_path = soiling_dir / "monthly_soiling_rates.json"
    if rates_path.exists():
        try:
            rates = json.loads(rates_path.read_text()).get("monthly_rates") or []
            for r in rates:
                month_no = int(str(r.get("month", "0000-00"))[5:7] or 0)
                sf = r.get("seasonal_factor")
                if 1 <= month_no <= 12 and isinstance(sf, (int, float)):
                    seasonal[month_no] = float(sf)
        except Exception:
            pass

    fallback_sr = 0.96
    eur_per_mwh = 65.0
    summary_path = soiling_dir / "ml_plant_summary.json"
    if summary_path.exists():
        try:
            s = json.loads(summary_path.read_text())
            fallback_sr = s.get("currentStatus", {}).get("avgSoilingRatio") or fallback_sr
            ei = s.get("economicImpact", {})
            loss = ei.get("ytdEnergyLoss_MWh") or 0
            eur = ei.get("ytdRevenueLoss_EUR") or 0
            if loss > 1 and eur > 0:
                eur_per_mwh = eur / loss
        except Exception:
            pass

    months = sorted(clean_by_month)[-N_MONTHS:]
    if not months:
        return

    headline_loss_pct = max(0.5, (1 - fallback_sr) * 100)
    mean_factor = sum(seasonal[int(m[5:7])] for m in months) / len(months)

    monthly_data = []
    cum_e = cum_r = 0.0
    for m in months:
        clean = clean_by_month[m]
        loss_pct = headline_loss_pct * seasonal[int(m[5:7])] / mean_factor
        e_loss = clean * loss_pct / 100
        r_loss = e_loss * eur_per_mwh
        cum_e += e_loss
        cum_r += r_loss
        monthly_data.append(
            {
                "date": f"{m}-01",
                "energy_if_clean_mwh": round(clean, 2),
                "energy_with_soiling_mwh": round(clean - e_loss, 2),
                "energy_loss_mwh": round(e_loss, 2),
                "energy_loss_pct": round(loss_pct, 2),
                "revenue_if_clean_eur": round(clean * eur_per_mwh, 2),
                "revenue_with_soiling_eur": round((clean - e_loss) * eur_per_mwh, 2),
                "revenue_loss_eur": round(r_loss, 2),
                "cumulative_energy_loss_mwh": round(cum_e, 2),
                "cumulative_revenue_loss_eur": round(cum_r, 2),
            }
        )

    out = {
        "metadata": {
            "plant_id": plant,
            "period": {"start": monthly_data[0]["date"], "end": monthly_data[-1]["date"]},
            "n_months": len(monthly_data),
            "source": "plant_power_history predicted energy x fleet SR, AOD-climatology seasonal shape",
            "eur_per_mwh": round(eur_per_mwh, 2),
        },
        "monthly_data": monthly_data,
    }
    (soiling_dir / "monthly_summary.json").write_text(json.dumps(out, indent=1))
    total = sum(m["energy_loss_mwh"] for m in monthly_data[-12:])
    print(
        f"{root.name}/{plant}: {len(monthly_data)} months ending {months[-1]}, "
        f"trailing-12 loss {total:.0f} MWh @ €{eur_per_mwh:.0f}/MWh"
    )


def main():
    for root in ROOTS:
        dt_dir = root / "digitaltwin"
        if not dt_dir.exists():
            continue
        for plant_dir in sorted(dt_dir.iterdir()):
            if plant_dir.is_dir():
                rebuild(root, plant_dir.name)


if __name__ == "__main__":
    main()
