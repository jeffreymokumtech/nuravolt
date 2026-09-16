"""Green-hydrogen (electrolyzer) analytics.

Mirrors the BESS package layout: physics + health models here,
provisional-twin synthesis in nuravolt/pipeline/hydrogen_synth.py,
DB-first API routes under src/app/api/hydrogen/.
"""

from nuravolt.hydrogen.electrolyzer import (
    ElectrolyzerSpec,
    specific_consumption_kwh_per_kg,
    production_kg,
    stack_efficiency_pct,
    stack_rul_hours,
    H2_HHV_KWH_PER_KG,
    H2_LHV_KWH_PER_KG,
)

__all__ = [
    "ElectrolyzerSpec",
    "specific_consumption_kwh_per_kg",
    "production_kg",
    "stack_efficiency_pct",
    "stack_rul_hours",
    "H2_HHV_KWH_PER_KG",
    "H2_LHV_KWH_PER_KG",
]
