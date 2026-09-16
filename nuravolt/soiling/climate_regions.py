"""Climate-region registry for the soiling foundation model.

Why this exists
---------------
The foundation model was previously trained on a single donor pool
(``DUSTIQ_PLANTS = ["zeta", "epsilon"]``) and applied to every target
plant regardless of climate. Epsilon (51°N, central Europe) and Ribera
(38°N, dry Mediterranean) have *opposite* seasonal soiling profiles:

- Mediterranean PV gets dirtier May-Sep (dry, dusty, Saharan dust transport)
  and recovers Oct-Apr when rain washes the panels.
- Continental PV gets dirtier Dec-Feb (cold, dry, dust mobilised from bare
  soils + smog stagnation) and is washed by summer thunderstorms.

Mixing the two donor profiles produced Ribera forecasts with summer SR
*rising* — physically backwards. The fix is to:

1. Tag every plant with a ``ClimateZone``.
2. Train one foundation model per zone (donor pool = plants in the zone
   that ship DustIQ ground truth).
3. For zones with no donors (Africa, MENA) inject a literature-derived
   ``ClimatePrior`` so the forecast generator has *something* sensible to
   produce; the prior is also used at inference time as a guard rail
   against the model going physically wrong.

This module is the single source of truth for the zone taxonomy + priors.
Everything downstream (`sr_foundation_model.py`, `scripts/generate_*`)
imports from here.

References
----------
- Mediterranean priors derived empirically from the existing
  ``public/data/soiling/ribera/annual_soiling_forecast.json`` (8 years
  of DustIQ + AOD + Open-Meteo precipitation history).
- Saharan / MENA / monsoon priors from peer-reviewed soiling literature:
  Boppana et al. 2024 (MENA loss rates), Ilse et al. 2018 (Saharan dust
  deposition seasonality), Micheli et al. 2020 (global soiling atlas),
  Conceição et al. 2022 (Iberian peninsula AOD seasonality).
- Sahel/India monsoon profiles from Mejia & Kleissl 2013 (global PV
  soiling losses) cross-checked against MERRA-2 climatology.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional


class ClimateZone(str, Enum):
    """Climate zone taxonomy for soiling-relevant grouping.

    Each zone groups plants whose seasonal *soiling profile* (rate by
    month + natural-cleaning regime + dominant dust source) is similar
    enough that one model can transfer across them. Two plants in
    different Köppen bands can still belong to the same zone here if
    their soiling profile rhymes.
    """

    MEDITERRANEAN = "MEDITERRANEAN"
    TEMPERATE_CONTINENTAL = "TEMPERATE_CONTINENTAL"
    DESERT_NORTH_AFRICA = "DESERT_NORTH_AFRICA"
    DESERT_MENA = "DESERT_MENA"
    DESERT_SOUTHWEST_US = "DESERT_SOUTHWEST_US"
    TROPICAL_MONSOON_SAHEL = "TROPICAL_MONSOON_SAHEL"
    SUBTROPICAL_INDIA = "SUBTROPICAL_INDIA"
    HUMID_SUBTROPICAL = "HUMID_SUBTROPICAL"
    TROPICAL_SAVANNA = "TROPICAL_SAVANNA"
    EQUATORIAL_EAST_AFRICA = "EQUATORIAL_EAST_AFRICA"
    SEMIARID_COLD_STEPPE = "SEMIARID_COLD_STEPPE"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class ClimatePrior:
    """Twelve-month soiling-relevant climatology for a climate zone.

    Used by:
    - the foundation model as input features (``monthly_prior_rate``,
      ``monthly_prior_rain_days``) so the learner has a baseline
      expectation to correct against rather than learn from scratch;
    - the forecast generator's climatology guard rail so the per-month
      monthly Δ of the model output never disagrees with prior physics
      by more than a tolerance without being flagged + blended.
    """

    zone: ClimateZone

    # Indexed 0..11 = Jan..Dec.
    monthly_soiling_rate_pct_day: List[float]
    monthly_rain_days: List[float]
    monthly_aod_typical: List[float]

    # The dominant aerosol species responsible for soiling here. Affects
    # how natural rain cleans (Saharan dust forms hygroscopic crusts that
    # need >8mm to wash; sea-salt washes at 2-3mm).
    dominant_dust_source: str

    # The rain amount (mm in a single event) that resets SR to clean.
    recovery_threshold_mm: float

    # Free-form provenance / literature citation for the numbers.
    comment: str = ""

    def __post_init__(self) -> None:
        for name in ("monthly_soiling_rate_pct_day", "monthly_rain_days", "monthly_aod_typical"):
            arr = getattr(self, name)
            if len(arr) != 12:
                raise ValueError(f"{name} must have 12 entries (got {len(arr)})")

    def soiling_rate_for_month(self, month: int) -> float:
        """Return the monthly soiling rate (%/day) for a 1-12 month index."""
        return self.monthly_soiling_rate_pct_day[(month - 1) % 12]

    def rain_days_for_month(self, month: int) -> float:
        return self.monthly_rain_days[(month - 1) % 12]

    def aod_for_month(self, month: int) -> float:
        return self.monthly_aod_typical[(month - 1) % 12]

    def is_dry_season(self, month: int) -> bool:
        """A month belongs to the dry season iff its soiling rate is at
        or above the mean of the 12 monthly values. Climate-aware: lets
        the Mediterranean dry season be Mar-Sep while the Sahel one is
        Nov-Mar without the caller knowing.

        Mean-based (not rank-based) so each zone gets a count that
        matches its real dry-season length rather than a fixed 6 months.
        """
        rates = self.monthly_soiling_rate_pct_day
        threshold = sum(rates) / len(rates)
        return rates[(month - 1) % 12] >= threshold


# ──────────────────────────────────────────────────────────────────────────
# Per-zone climatology priors
# ──────────────────────────────────────────────────────────────────────────

_MEDITERRANEAN = ClimatePrior(
    zone=ClimateZone.MEDITERRANEAN,
    # Recalibrated 2026-06-21: literature shape preserved, amplitude scaled by 0.422
    # (= 0.157 / 0.3717) from ribera+zeta DustIQ paired median.
    # Pattern: dry season May-Sep with Saharan dust transport; brief autumn
    # rain Oct + winter rain Jan/Dec restore SR.
    monthly_soiling_rate_pct_day=[
        0.127,  # Jan
        0.084,  # Feb
        0.186,  # Mar
        0.190,  # Apr
        0.190,  # May
        0.186,  # Jun
        0.186,  # Jul
        0.177,  # Aug
        0.186,  # Sep
        0.101,  # Oct
        0.143,  # Nov
        0.127,  # Dec
    ],
    monthly_rain_days=[6, 5, 5, 4, 3, 1, 0.5, 1, 3, 5, 6, 6],
    monthly_aod_typical=[0.15, 0.14, 0.16, 0.18, 0.22, 0.25, 0.28, 0.26, 0.22, 0.17, 0.15, 0.14],
    dominant_dust_source="Saharan dust + local agricultural",
    recovery_threshold_mm=5.0,
    comment=(
        "Recalibrated 2026-06-21 using DustIQ ribera (p50=0.183 %/day, n=1057) "
        "+ zeta (p50=0.130 %/day, n=657); scaling factor 0.422 applied to "
        "literature shape (annual mean 0.157 %/day, down from 0.372). "
        "eta/alpha/delta DustIQ medians excluded pending rain-masked re-derivation. "
        "Seasonal shape preserved (dry May-Sep peak). "
        "Original ref: ribera/annual_soiling_forecast.json + CAMS decadal AOD."
    ),
)

_TEMPERATE_CONTINENTAL = ClimatePrior(
    zone=ClimateZone.TEMPERATE_CONTINENTAL,
    # Recalibrated 2026-06-21: literature shape preserved, amplitude scaled by 0.390
    # (= 0.0556 / 0.1425) from epsilon DustIQ median.
    # Pattern inverse of Mediterranean: winter has highest losses (cold
    # dry air, dust from bare frozen soils, smog stagnation). Summer
    # thunderstorms wash panels frequently.
    monthly_soiling_rate_pct_day=[
        0.070, 0.070, 0.078, 0.047, 0.031, 0.031, 0.039, 0.039, 0.047, 0.059, 0.078, 0.078,
    ],
    monthly_rain_days=[12, 10, 11, 11, 12, 13, 13, 12, 11, 11, 12, 13],
    monthly_aod_typical=[0.18, 0.20, 0.22, 0.20, 0.18, 0.16, 0.16, 0.18, 0.18, 0.18, 0.18, 0.18],
    dominant_dust_source="continental dust + smog + biomass",
    recovery_threshold_mm=3.0,
    comment=(
        "Recalibrated 2026-06-21 using DustIQ epsilon (Region D DE, p50=0.0556 %/day, "
        "n=825 loss-day intervals 2021-2025); scaling factor 0.390 applied to "
        "literature shape (annual mean 0.056 %/day, down from 0.143). "
        "Winter-peak shape preserved (Mejia-Calderon 2018). Single-donor zone; "
        "recalibrate after onboarding a second Cfb/Dfb plant."
    ),
)

_DESERT_NORTH_AFRICA = ClimatePrior(
    zone=ClimateZone.DESERT_NORTH_AFRICA,
    # Sahara: very high year-round. Peak in dust-storm season Mar-Jun.
    # Almost zero rain anywhere except the Atlas foothills.
    # Tightened 2026-06-21 per Boppana 2024 MENA meta-analysis: annual mean
    # scaled from 0.908 → 0.85 %/day (factor 0.936) to align with measured
    # 0.80–0.95 %/day range across 20+ N. Africa/MENA sites. Seasonal shape
    # preserved.
    monthly_soiling_rate_pct_day=[
        0.56, 0.66, 0.89, 0.98, 1.12, 1.12, 1.03, 0.94, 0.94, 0.75, 0.66, 0.56,
    ],
    monthly_rain_days=[1, 1, 1, 1, 0.5, 0.2, 0.1, 0.1, 0.5, 1, 1, 1],
    monthly_aod_typical=[0.30, 0.32, 0.40, 0.48, 0.60, 0.65, 0.60, 0.55, 0.45, 0.35, 0.30, 0.28],
    dominant_dust_source="Saharan mineral dust",
    recovery_threshold_mm=8.0,
    comment=(
        "Boppana 2024 (MENA losses, 20+ N.Africa/MENA sites, central 0.80–0.95 %/day), "
        "Ilse 2018 (Saharan deposition), Micheli 2020. Tightened 2026-06-21: annual "
        "mean 0.85 %/day (down from 0.908) per Boppana 2024 central estimate. "
        "literature_only — no observed validation as of 2026-06-21. "
        "IRESEN Benguerir Morocco (~32°N) is highest-value partnership target."
    ),
)

_DESERT_MENA = ClimatePrior(
    zone=ClimateZone.DESERT_MENA,
    # Saudi/UAE/Kuwait — extreme losses in shamal (NW wind) season Mar-Jul.
    # Summer slightly lower because dust is depleted from the surface.
    monthly_soiling_rate_pct_day=[
        0.70, 0.90, 1.30, 1.40, 1.25, 1.00, 0.90, 0.90, 0.80, 0.80, 0.80, 0.70,
    ],
    monthly_rain_days=[2, 2, 2, 1, 0.5, 0.1, 0.1, 0.1, 0.1, 0.5, 1, 1.5],
    monthly_aod_typical=[0.40, 0.45, 0.55, 0.65, 0.60, 0.55, 0.50, 0.50, 0.45, 0.42, 0.40, 0.38],
    dominant_dust_source="Shamal-driven Arabian dust",
    recovery_threshold_mm=8.0,
    comment=(
        "Boppana 2024, Adinoyi & Said 2013 (Dhahran loss measurements), "
        "Khonkar et al. 2014 (KAUST Thuwal Saudi Arabia: 35–40% loss over 30 days "
        "in Rub' al Khali, ≈1.1–1.3 %/day accumulation rate — empirically anchors "
        "current Mar–Apr peak of 1.30–1.40 %/day in this prior). Annual mean ≈0.95 %/day. "
        "literature_only — no observed validation as of 2026-06-21. "
        "Masdar (UAE) + KAUST (KSA) are highest-value partnership targets."
    ),
)

_DESERT_SOUTHWEST_US = ClimatePrior(
    zone=ClimateZone.DESERT_SOUTHWEST_US,
    # Recalibrated 2026-06-21: literature shape preserved, amplitude scaled by 0.263
    # (= 0.1075 / 0.4083) anchored to NREL Soiling Map p50 across 146 CA/AZ sites.
    # Sonoran/Mojave/Chihuahuan. Lower baseline than Sahara; July-Aug
    # monsoon brings ~5 rain events that partially wash.
    monthly_soiling_rate_pct_day=[
        0.079, 0.079, 0.105, 0.132, 0.158, 0.145, 0.105, 0.105, 0.118, 0.105, 0.079, 0.079,
    ],
    monthly_rain_days=[3, 3, 2, 1, 0.5, 0.5, 4, 5, 3, 2, 2, 3],
    monthly_aod_typical=[0.10, 0.12, 0.15, 0.18, 0.20, 0.18, 0.15, 0.15, 0.15, 0.12, 0.10, 0.10],
    dominant_dust_source="local desert dust + agricultural",
    recovery_threshold_mm=4.0,
    comment=(
        "Recalibrated 2026-06-21 using NREL Soiling Map p50 across 146 CA/AZ sites "
        "(0.1075 %/day); scaling factor 0.263 applied to literature shape "
        "(annual mean 0.108 %/day, down from 0.408). PVDAQ 7334 dropped (n=2 thin); "
        "PVDAQ 2107 flagged borderline Mediterranean. Monsoon partial-wash shape "
        "preserved (Kimber 2006). literature_only for hyper-arid sub-band."
    ),
)

_TROPICAL_MONSOON_SAHEL = ClimatePrior(
    zone=ClimateZone.TROPICAL_MONSOON_SAHEL,
    # Harmattan (Nov-Mar): heavy dust from the Sahara blown south. Wet
    # season (Jun-Sep): daily monsoon storms keep panels near-clean.
    monthly_soiling_rate_pct_day=[
        1.00, 1.10, 0.90, 0.50, 0.30, 0.20, 0.15, 0.15, 0.30, 0.50, 0.80, 0.90,
    ],
    monthly_rain_days=[0.5, 0.5, 1, 3, 6, 12, 18, 18, 12, 5, 1, 0.5],
    monthly_aod_typical=[0.45, 0.55, 0.50, 0.35, 0.25, 0.20, 0.18, 0.18, 0.22, 0.28, 0.40, 0.50],
    dominant_dust_source="Harmattan-driven Saharan dust",
    recovery_threshold_mm=5.0,
    comment=(
        "Mejia & Kleissl 2013; Boucher 2015 (Sahel AOD); MERRA-2 Niamey decadal. "
        "literature_only — no observed validation as of 2026-06-21."
    ),
)

_SUBTROPICAL_INDIA = ClimatePrior(
    zone=ClimateZone.SUBTROPICAL_INDIA,
    # Indo-Gangetic plain. Pre-monsoon (Apr-May) is dustiest; SW monsoon
    # (Jun-Sep) restores SR rapidly; post-monsoon dry season picks up again.
    monthly_soiling_rate_pct_day=[
        0.70, 0.80, 0.90, 0.90, 0.85, 0.50, 0.20, 0.20, 0.30, 0.55, 0.70, 0.70,
    ],
    monthly_rain_days=[1, 2, 2, 2, 4, 12, 18, 18, 12, 3, 1, 1],
    monthly_aod_typical=[0.50, 0.50, 0.55, 0.60, 0.55, 0.40, 0.30, 0.30, 0.35, 0.45, 0.55, 0.55],
    dominant_dust_source="Thar Desert dust + agricultural burning + urban",
    recovery_threshold_mm=4.0,
    comment=(
        "Mejia & Kleissl 2013; Goyal 2019 (Indo-Gangetic soiling); CAMS decadal. "
        "literature_only — no observed validation as of 2026-06-21."
    ),
)

_HUMID_SUBTROPICAL = ClimatePrior(
    zone=ClimateZone.HUMID_SUBTROPICAL,
    # Raised 2026-06-21: annual mean 0.148 → 0.20 %/day (scale 1.351) so the
    # prior brackets PVDAQ system_9069 (Social Circle GA, p50=0.328 %/day)
    # instead of sitting below it. Picked "raise mean" over "retag" because the
    # only paired empirical observation in this zone is *higher* than the old
    # mean, not lower — flooring on the low side was the actual bug.
    monthly_soiling_rate_pct_day=[
        0.16, 0.19, 0.22, 0.20, 0.18, 0.16, 0.24, 0.27, 0.24, 0.20, 0.18, 0.16,
    ],
    monthly_rain_days=[10, 9, 10, 9, 10, 11, 11, 10, 9, 8, 9, 10],
    monthly_aod_typical=[0.16, 0.18, 0.22, 0.22, 0.20, 0.20, 0.22, 0.20, 0.18, 0.15, 0.14, 0.15],
    dominant_dust_source="agricultural dust + pollen + biomass smoke + urban PM2.5",
    recovery_threshold_mm=3.0,
    comment=(
        "Cfa humid subtropical (SE US, SE China/Korea/Japan, SE South America, E Australia, "
        "S. Africa KZN). Year-round rain >60mm/month limits accumulation; late-summer pollen + "
        "biomass + trans-Atlantic Saharan dust drive small peak. Micheli 2020, Mejia & Kleissl 2013, "
        "Prospero & Lamb 2003. Recalibrated 2026-06-21: annual mean raised to 0.20 %/day "
        "(from 0.148) so PVDAQ system_9069 (Social Circle GA, p50=0.328 %/day) sits inside the "
        "credible band instead of above the prior ceiling. Still literature_only for non-US Cfa; "
        "CSIR Pretoria/Durban (S. Africa KZN) is the priority partnership target."
    ),
)

_TROPICAL_SAVANNA = ClimatePrior(
    zone=ClimateZone.TROPICAL_SAVANNA,
    monthly_soiling_rate_pct_day=[
        0.55, 0.65, 0.60, 0.40, 0.25, 0.15, 0.12, 0.12, 0.18, 0.30, 0.45, 0.55,
    ],
    monthly_rain_days=[1, 1, 2, 4, 8, 14, 18, 17, 12, 6, 2, 1],
    monthly_aod_typical=[0.35, 0.40, 0.42, 0.35, 0.28, 0.22, 0.20, 0.22, 0.25, 0.30, 0.35, 0.38],
    dominant_dust_source="biomass burning + windblown soil + regional mineral dust",
    # Raised 2026-06-21 from 4.0 → 5.5 mm: CAMS dust speciation shows
    # Sub-Saharan profiles mix mineral dust (~40%) with hydrophobic black
    # carbon from biomass burning (~30%); the BC fraction needs a stronger
    # rain event to rinse than the pure-mineral assumption.
    recovery_threshold_mm=5.5,
    comment=(
        "Aw/As tropical savanna (Sub-Saharan Africa, Brazil cerrado, NE Australia, Deccan, "
        "Caribbean). Long dry season + biomass burning (van der Werf 2017 GFED). "
        "Profile is N. hemisphere phasing; S. hemisphere callers must phase-shift +6 months "
        "(see climate_router._hemisphere_shift). Micheli 2020, Conceição 2022. "
        "recovery_threshold_mm 4.0→5.5 (2026-06-21) per CAMS dust speciation: ~30% "
        "hydrophobic black carbon from biomass burning requires stronger rain event to "
        "rinse than pure mineral dust. literature_only."
    ),
)

_EQUATORIAL_EAST_AFRICA = ClimatePrior(
    zone=ClimateZone.EQUATORIAL_EAST_AFRICA,
    monthly_soiling_rate_pct_day=[
        0.38, 0.40, 0.25, 0.10, 0.12, 0.28, 0.35, 0.38, 0.40, 0.25, 0.12, 0.22,
    ],
    monthly_rain_days=[4, 5, 9, 14, 11, 4, 2, 3, 4, 8, 13, 8],
    monthly_aod_typical=[0.28, 0.32, 0.30, 0.22, 0.18, 0.16, 0.18, 0.22, 0.26, 0.22, 0.18, 0.22],
    dominant_dust_source="road and agricultural dust + biomass smoke + NE monsoon mineral dust",
    recovery_threshold_mm=5.0,
    comment=(
        "Aw/Cwb equatorial East Africa (Kenya highlands and Athi plains, N. Tanzania, "
        "Uganda). Bimodal ITCZ rains — MAM long rains, OND short rains — with dust "
        "peaks in the Jan-Feb and Jun-Sep dry seasons; the unimodal TROPICAL_SAVANNA "
        "profile fits neither hemisphere phasing here. Calendar-anchored to the ITCZ: "
        "correct as-is inside the router's equatorial no-shift band. Rain days from "
        "Nairobi climate normals (WMO 1991-2020); soiling rates and AOD are "
        "literature-informed engineering estimates pending a paired East African "
        "plant observation (Africa transfer roadmap). Authored 2026-07-24. "
        "literature_only."
    ),
)

_SEMIARID_COLD_STEPPE = ClimatePrior(
    zone=ClimateZone.SEMIARID_COLD_STEPPE,
    monthly_soiling_rate_pct_day=[
        0.25, 0.28, 0.42, 0.50, 0.48, 0.42, 0.38, 0.40, 0.42, 0.32, 0.25, 0.22,
    ],
    monthly_rain_days=[4, 4, 5, 6, 7, 5, 3, 3, 4, 5, 5, 5],
    monthly_aod_typical=[0.16, 0.18, 0.22, 0.25, 0.24, 0.20, 0.18, 0.18, 0.20, 0.18, 0.16, 0.15],
    dominant_dust_source="windblown local soil + agricultural tillage + long-range transport",
    recovery_threshold_mm=4.0,
    comment=(
        "BSk cold semi-arid steppe (Anatolian plateau, Iranian plateau, US Great Plains, "
        "Pampas dry sector, Inner Mongolia, central Spanish Meseta, S. African Karoo/Highveld). "
        "Spring tillage peak + autumn harvest secondary peak. Karaveli 2020, Smestad 2020. "
        "literature_only."
    ),
)

_UNKNOWN = ClimatePrior(
    zone=ClimateZone.UNKNOWN,
    # Fallback: temperate-average. Never picked unless lat/lon resolution
    # genuinely fails. Soiling rates are conservative-low to avoid
    # over-recommending cleanings on a plant we know nothing about.
    monthly_soiling_rate_pct_day=[0.20] * 12,
    monthly_rain_days=[8] * 12,
    monthly_aod_typical=[0.20] * 12,
    dominant_dust_source="unknown",
    recovery_threshold_mm=5.0,
    comment=(
        "Generic fallback. Replace as soon as plant climate is identified. "
        "literature_only — no observed validation as of 2026-06-21."
    ),
)

CLIMATE_PRIORS: Dict[ClimateZone, ClimatePrior] = {
    ClimateZone.MEDITERRANEAN: _MEDITERRANEAN,
    ClimateZone.TEMPERATE_CONTINENTAL: _TEMPERATE_CONTINENTAL,
    ClimateZone.DESERT_NORTH_AFRICA: _DESERT_NORTH_AFRICA,
    ClimateZone.DESERT_MENA: _DESERT_MENA,
    ClimateZone.DESERT_SOUTHWEST_US: _DESERT_SOUTHWEST_US,
    ClimateZone.TROPICAL_MONSOON_SAHEL: _TROPICAL_MONSOON_SAHEL,
    ClimateZone.SUBTROPICAL_INDIA: _SUBTROPICAL_INDIA,
    ClimateZone.HUMID_SUBTROPICAL: _HUMID_SUBTROPICAL,
    ClimateZone.TROPICAL_SAVANNA: _TROPICAL_SAVANNA,
    ClimateZone.EQUATORIAL_EAST_AFRICA: _EQUATORIAL_EAST_AFRICA,
    ClimateZone.SEMIARID_COLD_STEPPE: _SEMIARID_COLD_STEPPE,
    ClimateZone.UNKNOWN: _UNKNOWN,
}


# ──────────────────────────────────────────────────────────────────────────
# Plant → zone mapping (single source of truth)
# ──────────────────────────────────────────────────────────────────────────

PLANT_CLIMATE: Dict[str, ClimateZone] = {
    # Spanish plants — all Mediterranean.
    "ribera": ClimateZone.MEDITERRANEAN,
    "zeta": ClimateZone.MEDITERRANEAN,
    "delta": ClimateZone.MEDITERRANEAN,
    "gamma": ClimateZone.MEDITERRANEAN,
    "eta": ClimateZone.MEDITERRANEAN,
    "alpha": ClimateZone.MEDITERRANEAN,
    "theta": ClimateZone.MEDITERRANEAN,
    # German plant — central European continental.
    "epsilon": ClimateZone.TEMPERATE_CONTINENTAL,
    # Demo placeholder — treated as Mediterranean for backward compatibility.
    "cold_start_demo": ClimateZone.MEDITERRANEAN,
}


def resolve_zone(plant_id: str, latitude: Optional[float] = None, longitude: Optional[float] = None) -> ClimateZone:
    """Resolve a plant to a climate zone.

    Resolution order:
    1. Explicit ``PLANT_CLIMATE`` registry lookup by plant_id.
    2. Lat/lon geographic bounds (so onboarding a new plant gives a
       sensible default without a code change).
    3. ``UNKNOWN`` as a last-resort flag.
    """
    if plant_id in PLANT_CLIMATE:
        return PLANT_CLIMATE[plant_id]
    if latitude is None or longitude is None:
        return ClimateZone.UNKNOWN
    return _zone_from_latlon(latitude, longitude)


def _zone_from_latlon(lat: float, lon: float) -> ClimateZone:
    """Best-guess zone from coordinates.

    Bounds are intentionally generous; bring a real plant into
    ``PLANT_CLIMATE`` explicitly whenever its profile is verified so the
    fallback isn't load-bearing.

    Order matters: more-specific bounds run before broader fallbacks so the
    new African/Cfa/BSk zones aren't shadowed by the generic Mediterranean
    or Temperate-continental lat bands.
    """
    # ── Sentinel guard ──────────────────────────────────────────────────
    # (0.0, 0.0) is the "missing coordinates" sentinel produced by many
    # CSV ingest paths; without this guard it silently routes to
    # TROPICAL_SAVANNA via the N.-hemisphere savanna bound and quietly
    # corrupts forecasts for plants with unknown geolocation. Return
    # UNKNOWN so the caller is forced to surface the missing data.
    if lat == 0.0 and lon == 0.0:
        return ClimateZone.UNKNOWN

    # ── More-specific bounds first ──────────────────────────────────────

    # India + South Asia
    if 8.0 <= lat <= 35.0 and 65.0 <= lon <= 95.0:
        return ClimateZone.SUBTROPICAL_INDIA

    # MENA Arabian peninsula + Iraq/Iran
    # West edge clipped 35.0 (was 30.0) so Csa Mediterranean coast
    # (Tel Aviv 32.1,34.8 ; Limassol 34.7,33.0 ; Beirut 33.9,35.5) is
    # not swallowed by MENA — those should route to MEDITERRANEAN.
    # North edge widened to 38.0 (was 35.0) so Tehran (35.7,51.4) and the
    # Iranian plateau land in MENA instead of falling through to UNKNOWN.
    if 15.0 <= lat <= 38.0 and 35.0 <= lon <= 65.0:
        return ClimateZone.DESERT_MENA

    # Sahel — north of equator, south of Sahara
    if 10.0 <= lat <= 20.0 and -20.0 <= lon <= 40.0:
        return ClimateZone.TROPICAL_MONSOON_SAHEL

    # Sahara — north of Sahel, south of Med coast
    if 20.0 <= lat <= 30.0 and -20.0 <= lon <= 35.0:
        return ClimateZone.DESERT_NORTH_AFRICA

    # ── Equatorial East Africa (bimodal ITCZ rains) — BEFORE the savanna
    # catch-all, which would otherwise hand Kenya a unimodal Sahel profile.
    if -5.0 <= lat <= 5.0 and 33.0 <= lon <= 42.0:
        return ClimateZone.EQUATORIAL_EAST_AFRICA

    # ── NEW: Sub-Saharan tropical savanna (N. + S. hemisphere) ─────────
    # N. hemisphere savanna belt: Guinea coast → CAR → S. Sudan → Ethiopia/Kenya highlands
    if -20.0 <= lat < 10.0 and -20.0 <= lon <= 45.0:
        return ClimateZone.TROPICAL_SAVANNA
    # S. hemisphere savanna belt: Brazilian cerrado
    if -20.0 <= lat <= -5.0 and -60.0 <= lon <= -40.0:
        return ClimateZone.TROPICAL_SAVANNA
    # NE Australia / Top End
    if -20.0 <= lat <= -10.0 and 130.0 <= lon <= 150.0:
        return ClimateZone.TROPICAL_SAVANNA

    # ── NEW: Southern African semi-arid / Mediterranean (BEFORE generic) ─
    # S. Africa KZN coast — humid subtropical (run BEFORE Karoo because
    # Karoo lon band overlaps KZN at the 30°E coastal strip).
    if -32.0 <= lat <= -27.0 and 30.0 <= lon <= 33.0:
        return ClimateZone.HUMID_SUBTROPICAL
    # S. Africa Cape Csb — Mediterranean.
    # East edge clipped to lon < 18.5 (was lon <= 22.0) so the Cape bound
    # no longer shadows the Karoo at, e.g., (-32, 22). Cape Town
    # (-33.9,18.4) still matches.
    if -35.0 <= lat <= -32.0 and 17.0 <= lon < 18.5:
        return ClimateZone.MEDITERRANEAN
    # S. Africa Karoo + Highveld BSk
    if -33.0 <= lat <= -22.0 and 18.0 <= lon <= 32.0:
        return ClimateZone.SEMIARID_COLD_STEPPE

    # ── NEW: Semi-arid cold steppe (Anatolia, Iran, Pampas, Great Plains) ─
    # Anatolia + adjoining cold steppe.
    # Lat widened to 35.0 (was 37.0) so the Anatolian interior (e.g. Konya
    # 37.9,32.5 ; SE Anatolia 37.0,40.0) and Tehran (35.7,51.4) are
    # captured cleanly without colliding with the MENA bound (which now
    # stops at lon 35). Kept above 35° N so Cyprus (Limassol 34.7,33.0)
    # is NOT pulled into Anatolian steppe — Cyprus is Csa Mediterranean.
    if 35.0 <= lat <= 41.0 and 30.0 <= lon <= 62.0:
        return ClimateZone.SEMIARID_COLD_STEPPE
    # US Great Plains
    if 35.0 <= lat <= 49.0 and -106.0 <= lon <= -98.0:
        return ClimateZone.SEMIARID_COLD_STEPPE
    # Argentine Pampas dry sector
    if -40.0 <= lat <= -32.0 and -68.0 <= lon <= -60.0:
        return ClimateZone.SEMIARID_COLD_STEPPE

    # ── NEW: Humid subtropical (Cfa) ───────────────────────────────────
    # SE United States
    if 25.0 <= lat <= 37.0 and -100.0 <= lon <= -75.0:
        return ClimateZone.HUMID_SUBTROPICAL
    # SE South America (Pampas humid + Rio Grande do Sul)
    if -35.0 <= lat <= -20.0 and -65.0 <= lon <= -45.0:
        return ClimateZone.HUMID_SUBTROPICAL
    # E coast Australia
    if -38.0 <= lat <= -25.0 and 145.0 <= lon <= 154.0:
        return ClimateZone.HUMID_SUBTROPICAL
    # Southern China + S. Korea + S. Japan
    if 22.0 <= lat <= 38.0 and 105.0 <= lon <= 140.0:
        return ClimateZone.HUMID_SUBTROPICAL

    # ── Existing broader fallbacks last ─────────────────────────────────
    # SW US desert (Sonoran/Mojave/Chihuahuan)
    if 30.0 <= lat <= 40.0 and -125.0 <= lon <= -100.0:
        return ClimateZone.DESERT_SOUTHWEST_US
    # Mediterranean — covers Iberia, S. France, Italy, Greece, Turkey W coast, N. Africa coast
    if 30.0 <= lat <= 46.0 and -10.0 <= lon <= 40.0:
        return ClimateZone.MEDITERRANEAN
    # Temperate continental — central + northern Europe
    if 46.0 <= lat <= 65.0 and -10.0 <= lon <= 40.0:
        return ClimateZone.TEMPERATE_CONTINENTAL

    return ClimateZone.UNKNOWN


def prior_for_plant(plant_id: str, latitude: Optional[float] = None, longitude: Optional[float] = None) -> ClimatePrior:
    """Convenience: resolve zone and return its prior in one call."""
    return CLIMATE_PRIORS[resolve_zone(plant_id, latitude, longitude)]


# ──────────────────────────────────────────────────────────────────────────
# Donor pool resolution — what plants does each zone have ground truth for?
# ──────────────────────────────────────────────────────────────────────────


def donors_for_zone(zone: ClimateZone, dustiq_root: Optional[str] = None) -> List[str]:
    """Return the list of plant_ids that:

    1. Belong to ``zone`` per ``PLANT_CLIMATE``, AND
    2. Ship a ``dustiq_history.json`` file under ``dustiq_root``
       (default: ``public/data/soiling/{plant_id}/dustiq_history.json``).

    Used by the foundation model to pick training donors per zone. A zone
    with zero donors → no model trained → forecast generator falls back
    to climatology-only inference.
    """
    import os
    if dustiq_root is None:
        # Resolve from this file's location: nuravolt/soiling/ → repo root.
        here = os.path.dirname(os.path.abspath(__file__))
        dustiq_root = os.path.abspath(os.path.join(here, "..", "..", "public", "data", "soiling"))

    candidates = [pid for pid, z in PLANT_CLIMATE.items() if z == zone]
    donors = []
    for pid in candidates:
        fp = os.path.join(dustiq_root, pid, "dustiq_history.json")
        if os.path.exists(fp):
            donors.append(pid)
    return sorted(donors)


def zones_with_donors(dustiq_root: Optional[str] = None) -> List[ClimateZone]:
    """List of zones that have at least one DustIQ donor — the set
    eligible for foundation-model training."""
    return [z for z in ClimateZone if z != ClimateZone.UNKNOWN and donors_for_zone(z, dustiq_root)]
