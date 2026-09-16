"""Run the SoilingClimateRouter against 9 representative African coordinates.

Emits ``backenddata/validation/soiling/africa_transferability.json`` with the
per-region routing decision + honest expectation derived from research C.

Each site is scored with the full router (T1→T2→T3→T5) plus its standalone
component scores for every available foundation model so reviewers can see
*why* a tier was picked. The ``honest_expectation`` and ``proxy_analog`` text
is hand-curated from Research B/C and is the canonical sales-honest framing
for each region — do not silently soften this language.

Honest expectation tiers (controls UI/sales messaging):

- ``high_confidence_production``   — T1 router hit, no recalibration needed
                                     before going live with forecasts.
- ``usable_with_caveat``           — T2 blend or T1 with material bias
                                     mismatch; needs 90-day field
                                     recalibration but production-eligible.
- ``literature_only``              — T3 prior, no foundation model match;
                                     ship priors with explicit "literature
                                     only" banner; soiling rates carry wide
                                     error bars.
- ``needs_dustiq_rollout``         — climate regime not represented anywhere
                                     in the training pool; field DustIQ
                                     deployment required before quoting
                                     accuracy.

Run: ``python scripts/africa_transferability_report.py``
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Tuple

# Allow ``python scripts/africa_transferability_report.py`` to work from
# any cwd by ensuring repo root is on sys.path before the nuravolt import.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from nuravolt.soiling.climate_router import get_soiling_router  # noqa: E402

OUT_PATH = os.path.abspath(
    os.path.join(
        os.path.dirname(__file__),
        "..",
        "backenddata",
        "validation",
        "soiling",
        "africa_transferability.json",
    )
)


# (region, lat, lon, koppen, honest_tier, proxy_analog, honest_expectation)
AfricanSite = Tuple[str, float, float, str, str, str, str]

AFRICAN_SITES: List[AfricanSite] = [
    (
        "Morocco Atlas",
        31.79,
        -7.09,
        "Csa",
        "high_confidence_production",
        "Spanish Mediterranean DustIQ (ribera + zeta)",
        (
            "HIGH-confidence Mediterranean transfer; Ribera/Zeta donors "
            "directly applicable. Saharan-dust intrusion (calima) shared with "
            "donor sites; expect ~1.2-1.5x dustier on average — recalibrate "
            "after 90d."
        ),
    ),
    (
        "Egypt Aswan",
        24.09,
        32.90,
        "BWh",
        "literature_only",
        "Atacama (ATAMOSTEC) + KAUST Thuwal literature priors — no US/EU analog",
        (
            "OUT-OF-DISTRIBUTION for US/EU trained models. Hyper-arid (<5 mm/yr); "
            "no donor captures dust cementation. Use literature priors "
            "(Atacama, KAUST) with wide error bars 0.4-1.0 %/day until "
            "field-calibrated."
        ),
    ),
    (
        "Algeria Sahara",
        28.0,
        2.5,
        "BWh",
        "literature_only",
        "DESERT_NORTH_AFRICA prior (Boppana 2024, Ilse 2018) — literature only",
        (
            "Same Sahara-interior caveat as Aswan. DESERT_NORTH_AFRICA prior is "
            "literature-only; no observed validation. Pilot + calibrate, do "
            "not deploy and trust."
        ),
    ),
    (
        "Sahel Niamey",
        13.50,
        2.10,
        "BSh",
        "needs_dustiq_rollout",
        "TROPICAL_MONSOON_SAHEL prior + INDAAF PM10 driver (no trained donor)",
        (
            "Bimodal Harmattan/monsoon regime not present in any training donor. "
            "Use TROPICAL_MONSOON_SAHEL prior; flag confidence DEGRADED. Pair "
            "with INDAAF PM10 driver if available."
        ),
    ),
    (
        "S. Africa Cape",
        -33.92,
        18.42,
        "Csb",
        "high_confidence_production",
        "Spanish Mediterranean DustIQ (ribera + zeta)",
        (
            "HIGHEST African confidence. Csb maps to MEDITERRANEAN donors; no "
            "Saharan dust at Cape latitudes means transfer slightly "
            "over-predicts; expect ~30-50% lower magnitude. Lead with this "
            "region for African proof points."
        ),
    ),
    (
        "S. Africa Karoo",
        -32.0,
        22.0,
        "BSk",
        "literature_only",
        "SEMIARID_COLD_STEPPE prior (Karaveli 2020, Pretorius 2020) — literature only",
        (
            "Maps to new SEMIARID_COLD_STEPPE prior; literature only "
            "(Pretorius 2020). S. hemisphere phase shift required at "
            "forecast generator. Confidence MEDIUM."
        ),
    ),
    (
        "Senegal Dakar",
        14.69,
        -17.44,
        "BSh",
        "needs_dustiq_rollout",
        "TROPICAL_MONSOON_SAHEL prior + Sococim ACP-2025 literature scaling",
        (
            "Coastal Sahel — Harmattan dust mixed with marine sea-salt. Same "
            "caveat as Niamey but lower magnitude due to ocean moderation. "
            "Sococim ACP-2025 literature scaling recommended."
        ),
    ),
    (
        "Kenya Nairobi",
        -1.29,
        36.82,
        "Cwb",
        "needs_dustiq_rollout",
        "TROPICAL_SAVANNA prior — no trained donor for tropical-highland regime",
        (
            "Tropical highland (Aw boundary). Twice-yearly rainy seasons not "
            "represented in any donor. Treat as essentially uncalibrated; "
            "expect low baseline ~0.05-0.1 %/day per literature."
        ),
    ),
    (
        "UAE Abu Dhabi",
        24.45,
        54.39,
        "BWh",
        "literature_only",
        "DESERT_MENA prior (Boppana 2024, Adinoyi 2013) — literature only",
        (
            "DESERT_MENA prior — literature only (Boppana 2024, Adinoyi 2013). "
            "Shamal-driven Arabian dust regime, similar magnitude to N. "
            "Africa but seasonally distinct. Confidence LOW-MEDIUM."
        ),
    ),
]


def main() -> None:
    router = get_soiling_router()

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "router_models_available": [z.value for z in router._available_zones],
        "tier_legend": {
            "high_confidence_production": (
                "T1 router hit; production-eligible with no recalibration."
            ),
            "usable_with_caveat": (
                "T2 blend (70/30 model+prior); production-eligible after 90d "
                "recalibration."
            ),
            "literature_only": (
                "T3 climate prior; ship with explicit literature-only banner."
            ),
            "needs_dustiq_rollout": (
                "Regime unrepresented in training pool; field DustIQ required "
                "before quoting accuracy."
            ),
        },
        "sites": [],
    }

    for (
        region,
        lat,
        lon,
        koppen,
        honest_tier,
        proxy_analog,
        expectation,
    ) in AFRICAN_SITES:
        result = router.pick_best_model(lat, lon, koppen=koppen)
        all_scores = router.score(lat, lon, koppen=koppen)
        out["sites"].append(
            {
                "region": region,
                "lat": lat,
                "lon": lon,
                "koppen": koppen,
                "router_result": asdict(result),
                "all_candidate_scores": all_scores,
                "honest_tier": honest_tier,
                "proxy_analog": proxy_analog,
                "honest_expectation": expectation,
            }
        )

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2)

    print(f"Wrote {OUT_PATH}")
    print()
    print(
        f"{'Region':<22s}  {'Model':<42s}  {'Conf':>5s}  {'Tier':<12s}  {'Honest':<28s}"
    )
    print("-" * 120)
    for s in out["sites"]:
        r = s["router_result"]
        tier_short = r["fallback_chain_taken"][-1].replace("_foundation_model", "")
        print(
            f"  {s['region']:<22s}  {r['model_id']:<42s}  "
            f"{r['confidence']:5.2f}  {tier_short:<12s}  "
            f"{s['honest_tier']:<28s}"
        )


if __name__ == "__main__":
    main()
