"""Soiling Climate Router — picks the best soiling model for a new site.

Tiered fallback per Research D:
  T1 foundation model (similarity >= 0.75)  → high confidence
  T2 foundation model (0.55 <= sim < 0.75)  → degraded, blended 70/30 with prior
  T3 climate prior                          → no usable foundation model
  T4 pvlib physics (requires weather feed)  → not yet wired; placeholder
  T5 UNKNOWN fallback                       → flat prior + hard banner

Similarity formula (research D):
  0.30 koppen + 0.25 our_zone + 0.10 distance + 0.20 aod_cos + 0.10 rain_cos + 0.05 dust_source

The router walks ``backenddata/models/soiling_foundation_<ZONE>.pkl`` to find
available foundation models. Per-plant variants under
``backenddata/models/soiling/sr_foundation_<plant>.pkl`` exist but are not
zone-keyed and are therefore not enumerated here.
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Dict, List, Optional, Tuple

from nuravolt.soiling.climate_regions import (
    CLIMATE_PRIORS,
    ClimatePrior,
    ClimateZone,
    _zone_from_latlon,
)

MODELS_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "backenddata", "models")
)

# Canonical centroid + Köppen for each zone's "representative donor"; used as
# the candidate's lat/lon and Köppen code when scoring a foundation model.
ZONE_CENTROIDS: Dict[ClimateZone, Tuple[float, float, str]] = {
    ClimateZone.MEDITERRANEAN:          (37.93, -1.23,  "Csa"),   # ribera (donor)
    ClimateZone.TEMPERATE_CONTINENTAL:  (52.52, 13.40,  "Cfb"),   # epsilon (donor)
    ClimateZone.DESERT_NORTH_AFRICA:    (31.00,  0.00,  "BWh"),
    ClimateZone.DESERT_MENA:            (24.50, 46.50,  "BWh"),
    ClimateZone.DESERT_SOUTHWEST_US:    (34.50, -117.5, "BWh"),
    ClimateZone.TROPICAL_MONSOON_SAHEL: (13.50,  2.10,  "BSh"),
    ClimateZone.SUBTROPICAL_INDIA:      (28.00, 77.00,  "Cwa"),
    ClimateZone.UNKNOWN:                ( 0.00,  0.00,  "??"),
}

# Newer zones may not yet exist in climate_regions; register centroids
# conditionally so this module is forward-compatible with Phase 2 priors.
for _zone_name, _centroid in (
    ("HUMID_SUBTROPICAL",     (33.68, -83.68, "Cfa")),
    ("TROPICAL_SAVANNA",      (-10.0,  25.0,  "Aw")),
    ("SEMIARID_COLD_STEPPE",  (39.00,  35.00, "BSk")),
):
    _zone = getattr(ClimateZone, _zone_name, None)
    if _zone is not None:
        ZONE_CENTROIDS[_zone] = _centroid

HIGH_CONFIDENCE = 0.75
USABLE = 0.55


@dataclass
class RouterResult:
    """Result of a routing decision.

    Attributes
    ----------
    model_id
        Either ``soiling_foundation_<ZONE>`` for a foundation model,
        ``climate_prior`` for a literature climatology fallback, or
        ``unknown`` for the T5 hard fallback.
    confidence
        Similarity score in [0, 1] for T1/T2; 0.45 for T3 priors; 0.0 for T5.
    fallback_used
        True for any tier other than T1.
    fallback_chain_taken
        Ordered list of tier identifiers consulted (always ends with the
        winning tier).
    reasoning
        Human-readable explanation suitable for surfacing in the UI.
    similarity_components
        Per-component breakdown (koppen/our_zone/distance/aod/rain/dust)
        for the winning candidate; empty for T5.
    chosen_zone
        Zone whose foundation model or prior was selected.
    blend_weight_prior
        Recommended weight on the literature prior when blending with the
        chosen model output. 0.0 = pure model, 1.0 = pure prior. T2 uses
        0.30 (70% model / 30% prior); T3/T5 use 1.0.
    monthly_multipliers
        Twelve-element list of soiling-rate climatology (%/day) for the
        chosen zone, *already hemisphere-shifted* for the requested site
        (see ``_hemisphere_shift``). Callers should treat index 0 = Jan,
        11 = Dec at the requested site, regardless of which hemisphere
        the donor zone profile was authored in.
    tier
        Short label of the winning tier ("T1", "T2", "T3", "T5"). Convenience
        accessor derived from ``fallback_chain_taken[-1]``; provided so callers
        don't have to string-parse the chain.
    seasonality_warning
        Free-form note populated when the seasonality is muted/flagged
        (e.g. equatorial sites where N-vs-S hemisphere is ambiguous). Empty
        string if no warning applies.
    """

    model_id: str
    confidence: float
    fallback_used: bool
    fallback_chain_taken: List[str]
    reasoning: str
    similarity_components: Dict[str, float] = field(default_factory=dict)
    chosen_zone: Optional[str] = None
    blend_weight_prior: float = 0.0
    monthly_multipliers: List[float] = field(default_factory=list)
    tier: str = ""
    seasonality_warning: str = ""

    @property
    def model_key(self) -> str:
        """Alias for ``model_id`` so callers using the seasonal-prior shorthand
        get a stable name. Kept as a property (not a field) so the dataclass
        ``asdict`` payload stays backwards compatible with existing JSON
        consumers like ``africa_transferability_report.py``.
        """
        return self.model_id


# ──────────────────────────────────────────────────────────────────────────
# Hemisphere-shift helper (Phase O bug #N: S-hemisphere seasonality)
# ──────────────────────────────────────────────────────────────────────────
#
# All ``ClimatePrior.monthly_soiling_rate_pct_day`` vectors in
# ``climate_regions.py`` are authored in N-hemisphere phasing (index 0 = Jan
# = boreal winter). When the same zone exists in the S-hemisphere (savanna,
# Mediterranean Cape, semi-arid Karoo, humid-subtropical KZN) the *shape*
# transfers but the *phase* is flipped by 6 months. Naïvely returning the
# stored vector for Cape Town would predict peak soiling in Jul/Aug (boreal
# summer = austral winter wet season) — physically backwards.
#
# This single helper centralizes the shift so every entry-point into the
# router gets the same correction, and so the regions.py priors can stay
# canonical N-hemisphere without forcing every caller to duplicate the logic.


_EQUATORIAL_BAND_DEG = 10.0  # |lat| < this → seasonality muted

EQUATORIAL_SEASONALITY_NOTE = (
    "equatorial site (|lat| < 10°) — N/S hemisphere phase is ambiguous, "
    "seasonality muted; monthly multipliers returned as-authored but "
    "callers should treat seasonal predictions as low-confidence."
)


def _hemisphere_shift(monthly_multipliers: List[float], lat: float) -> List[float]:
    """Phase-shift a 12-element monthly climatology to match the site hemisphere.

    All ``ClimatePrior`` vectors in ``climate_regions.py`` are authored in
    N-hemisphere phasing (index 0 = Jan). Calling this once at lookup time
    keeps the source-of-truth priors canonical while still serving S-hemisphere
    sites correctly.

    Behaviour
    ---------
    - ``lat >= +10``  → return as-is (clearly N-hemisphere).
    - ``lat <= -10``  → roll by 6 months (Jan ↔ Jul). Cape Town (-34) and
      Karoo (-32) both get the austral-seasons phase.
    - ``-10 < lat < +10`` (equatorial band) → return as-is. We deliberately
      do *not* flatten to the annual mean here because (a) some equatorial
      zones (e.g. Sahel at lat 10-15 sneaking down to 8 with the ITCZ) still
      have a real dry/wet asymmetry the caller should see, and (b) flattening
      silently hides information. Instead the router decorates the
      ``RouterResult.seasonality_warning`` so the UI can downgrade
      seasonal-confidence messaging.

    Parameters
    ----------
    monthly_multipliers
        12-element list, index 0 = Jan at the *authoring* (N) hemisphere.
    lat
        Site latitude in degrees; positive = N.

    Returns
    -------
    list[float]
        12-element list, index 0 = Jan at the *site* hemisphere.
    """
    if len(monthly_multipliers) != 12:
        raise ValueError(
            f"_hemisphere_shift expects 12 monthly values, got {len(monthly_multipliers)}"
        )
    if lat >= _EQUATORIAL_BAND_DEG:
        return list(monthly_multipliers)
    if lat <= -_EQUATORIAL_BAND_DEG:
        # Roll by 6: Jul becomes Jan, Aug becomes Feb, …
        return list(monthly_multipliers[6:]) + list(monthly_multipliers[:6])
    # Equatorial band: keep as-is; caller adds a seasonality_warning.
    return list(monthly_multipliers)


def _seasonality_warning_for_lat(lat: float) -> str:
    """Return a warning string for equatorial sites, '' otherwise."""
    if -_EQUATORIAL_BAND_DEG < lat < _EQUATORIAL_BAND_DEG:
        return EQUATORIAL_SEASONALITY_NOTE
    return ""


def _monthly_multipliers_for_zone(zone: ClimateZone, lat: float) -> List[float]:
    """Look up a zone's monthly soiling rate prior and apply hemisphere shift.

    Single chokepoint so every router exit path emits a site-hemisphere-correct
    vector. Keeps callers from having to remember to call ``_hemisphere_shift``
    themselves.
    """
    prior = CLIMATE_PRIORS.get(zone)
    if prior is None:
        return []
    return _hemisphere_shift(list(prior.monthly_soiling_rate_pct_day), lat)


# ──────────────────────────────────────────────────────────────────────────
# Scoring helpers (stdlib only)
# ──────────────────────────────────────────────────────────────────────────


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km between two lat/lon points."""
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _cosine(a: List[float], b: List[float]) -> float:
    """Cosine similarity on two equal-length numeric vectors, clipped to [0, 1]."""
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return max(0.0, min(1.0, dot / (na * nb)))


def _koppen_score(a: Optional[str], b: Optional[str]) -> float:
    """Köppen-code similarity per research D.

    Returns 1.0 for exact match, 0.6 for same first two letters
    (e.g. Csa vs Csb), 0.3 for same first letter (e.g. BWh vs BSh),
    0.0 otherwise. Missing/unknown codes score 0.0.
    """
    if not a or not b or a == "??" or b == "??":
        return 0.0
    if a == b:
        return 1.0
    if len(a) >= 2 and len(b) >= 2 and a[:2] == b[:2]:
        return 0.6
    if a[0] == b[0]:
        return 0.3
    return 0.0


# Cross-family partial-credit groups per research D's our_zone_match table.
_DESERT_GROUP = {
    ClimateZone.DESERT_NORTH_AFRICA,
    ClimateZone.DESERT_MENA,
    ClimateZone.DESERT_SOUTHWEST_US,
}
_MONSOON_GROUP = {
    ClimateZone.TROPICAL_MONSOON_SAHEL,
    ClimateZone.SUBTROPICAL_INDIA,
}
_TEMPERATE_GROUP = {
    ClimateZone.MEDITERRANEAN,
    ClimateZone.TEMPERATE_CONTINENTAL,
}


def _zone_score(
    cand: ClimateZone, site: ClimateZone, cand_lat: float, site_lat: float
) -> float:
    """Our-internal ClimateZone match per research D."""
    if cand == site:
        return 1.0
    if cand in _DESERT_GROUP and site in _DESERT_GROUP:
        return 0.6
    if cand in _MONSOON_GROUP and site in _MONSOON_GROUP:
        return 0.5
    if (
        cand in _TEMPERATE_GROUP
        and site in _TEMPERATE_GROUP
        and (cand_lat * site_lat > 0)  # same hemisphere
    ):
        return 0.4
    return 0.0


def _dust_score(cand: str, site: str) -> float:
    """Dominant-dust-source tie-breaker per research D."""
    a, b = (cand or "").lower(), (site or "").lower()
    if not a or not b or a == "unknown" or b == "unknown":
        return 0.0
    if a == b:
        return 1.0
    if ("saharan" in a and "saharan" in b) or ("desert" in a and "desert" in b):
        return 0.7
    return 0.4


# ──────────────────────────────────────────────────────────────────────────
# Router
# ──────────────────────────────────────────────────────────────────────────


class SoilingClimateRouter:
    """Routes a new site to the best soiling model.

    Foundation-model availability is determined by scanning
    ``backenddata/models/soiling_foundation_<ZONE>.pkl``. Models are not
    loaded by the router — that's the caller's job. The router only
    decides *which* model to use and how much weight to give the
    literature prior alongside it.
    """

    def __init__(self, models_dir: str = MODELS_DIR) -> None:
        self.models_dir = models_dir
        self._available_zones = self._scan_available_foundation_models()

    def _scan_available_foundation_models(self) -> List[ClimateZone]:
        """Walk the models dir for ``soiling_foundation_<ZONE>.pkl`` files.

        Only zones that have a matching pickle on disk are considered for
        T1/T2 routing. UNKNOWN is never enumerated (it's not a real zone).
        """
        found: List[ClimateZone] = []
        for z in ClimateZone:
            if z == ClimateZone.UNKNOWN:
                continue
            fp = os.path.join(self.models_dir, f"soiling_foundation_{z.value}.pkl")
            if os.path.exists(fp):
                found.append(z)
        return found

    def _score_candidate(
        self,
        candidate_zone: ClimateZone,
        site_lat: float,
        site_lon: float,
        site_koppen: Optional[str],
        site_zone: ClimateZone,
        site_prior: ClimatePrior,
    ) -> Dict[str, float]:
        """Score a single candidate model against the site.

        Returns the per-component dict + the weighted total under key
        ``total``. All values are in [0, 1].
        """
        cand_centroid = ZONE_CENTROIDS.get(candidate_zone)
        if cand_centroid is None:
            # No centroid registered → degrade gracefully.
            cand_lat, cand_lon, cand_koppen = 0.0, 0.0, "??"
        else:
            cand_lat, cand_lon, cand_koppen = cand_centroid
        cand_prior = CLIMATE_PRIORS[candidate_zone]

        koppen = _koppen_score(cand_koppen, site_koppen)
        zone = _zone_score(candidate_zone, site_zone, cand_lat, site_lat)
        dist = math.exp(
            -_haversine_km(cand_lat, cand_lon, site_lat, site_lon) / 2000.0
        )
        aod = _cosine(cand_prior.monthly_aod_typical, site_prior.monthly_aod_typical)
        rain = _cosine(cand_prior.monthly_rain_days, site_prior.monthly_rain_days)
        dust = _dust_score(
            cand_prior.dominant_dust_source, site_prior.dominant_dust_source
        )

        total = (
            0.30 * koppen
            + 0.25 * zone
            + 0.10 * dist
            + 0.20 * aod
            + 0.10 * rain
            + 0.05 * dust
        )
        return {
            "koppen": koppen,
            "our_zone": zone,
            "distance": dist,
            "aod_cosine": aod,
            "rain_cosine": rain,
            "dust_source": dust,
            "total": max(0.0, min(1.0, total)),
        }

    def score(
        self, lat: float, lon: float, koppen: Optional[str] = None
    ) -> Dict[str, float]:
        """Score every available foundation model against this site.

        Returns ``{zone_name: total_similarity}``. Useful for diagnostics
        and the transferability report.
        """
        site_zone = _zone_from_latlon(lat, lon)
        site_prior = CLIMATE_PRIORS[site_zone]
        return {
            z.value: self._score_candidate(
                z, lat, lon, koppen, site_zone, site_prior
            )["total"]
            for z in self._available_zones
        }

    def pick_best_model(
        self, lat: float, lon: float, koppen: Optional[str] = None
    ) -> RouterResult:
        """Decide which model (or prior) to use for a new site.

        Walks the T1 → T2 → T3 → T5 fallback chain. T4 (pvlib physics) is
        not yet wired; we fall straight to T5 if the site zone is UNKNOWN
        and no foundation model scores in range.
        """
        site_zone = _zone_from_latlon(lat, lon)
        site_prior = CLIMATE_PRIORS[site_zone]
        chain: List[str] = []

        scored: List[Tuple[ClimateZone, Dict[str, float]]] = []
        for z in self._available_zones:
            comp = self._score_candidate(z, lat, lon, koppen, site_zone, site_prior)
            scored.append((z, comp))
        scored.sort(key=lambda x: x[1]["total"], reverse=True)

        # T5 early-exit: no models AND zone unresolved.
        if not scored and site_zone == ClimateZone.UNKNOWN:
            chain.append("T5_unknown_fallback")
            return RouterResult(
                model_id="unknown",
                confidence=0.0,
                fallback_used=True,
                fallback_chain_taken=chain,
                reasoning=(
                    "No foundation models available and site zone unresolved; "
                    "flat 0.2%/day placeholder. Site survey required."
                ),
                chosen_zone="UNKNOWN",
                blend_weight_prior=1.0,
            )

        if scored:
            best_zone, best_comp = scored[0]
            sim = best_comp["total"]

            # T1 — high-confidence foundation model
            if sim >= HIGH_CONFIDENCE:
                chain.append("T1_high_confidence_foundation_model")
                return RouterResult(
                    model_id=f"soiling_foundation_{best_zone.value}",
                    confidence=sim,
                    fallback_used=False,
                    fallback_chain_taken=chain,
                    reasoning=(
                        f"High-confidence match to {best_zone.value} foundation "
                        f"model (similarity {sim:.2f})."
                    ),
                    similarity_components=best_comp,
                    chosen_zone=best_zone.value,
                    blend_weight_prior=0.0,
                )

            # T2 — degraded foundation model, 70/30 blend
            if sim >= USABLE:
                chain.append("T2_degraded_foundation_model")
                dominant_miss = min(
                    ("koppen", "our_zone", "aod_cosine", "rain_cosine"),
                    key=lambda k: best_comp[k],
                )
                return RouterResult(
                    model_id=f"soiling_foundation_{best_zone.value}",
                    confidence=sim,
                    fallback_used=True,
                    fallback_chain_taken=chain,
                    reasoning=(
                        f"Degraded match to {best_zone.value} foundation model "
                        f"(similarity {sim:.2f}); dominant mismatch: "
                        f"{dominant_miss}. Blending 70% model / 30% climate prior. "
                        f"Recalibrate after first 90 days of field data."
                    ),
                    similarity_components=best_comp,
                    chosen_zone=best_zone.value,
                    blend_weight_prior=0.30,
                )

        # T3 — climate prior (similarity insufficient, but site zone known)
        if site_zone != ClimateZone.UNKNOWN:
            chain.append("T3_climate_prior")
            return RouterResult(
                model_id="climate_prior",
                confidence=0.45,
                fallback_used=True,
                fallback_chain_taken=chain,
                reasoning=(
                    f"No foundation model scores above {USABLE:.2f}; using "
                    f"literature-derived {site_zone.value} climate prior. "
                    f"No plant-specific learning."
                ),
                similarity_components=scored[0][1] if scored else {},
                chosen_zone=site_zone.value,
                blend_weight_prior=1.0,
            )

        # T4 pvlib physics — not yet wired; collapse to T5.
        chain.append("T5_unknown_fallback")
        return RouterResult(
            model_id="unknown",
            confidence=0.0,
            fallback_used=True,
            fallback_chain_taken=chain,
            reasoning=(
                "Unresolved climate zone and no foundation model match. "
                "Flat placeholder used; site survey required."
            ),
            chosen_zone="UNKNOWN",
            blend_weight_prior=1.0,
        )


@lru_cache(maxsize=1)
def get_soiling_router() -> SoilingClimateRouter:
    """Process-wide singleton accessor."""
    return SoilingClimateRouter()
