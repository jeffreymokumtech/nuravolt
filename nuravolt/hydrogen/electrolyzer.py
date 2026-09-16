"""PEM electrolyzer physics: part-load efficiency, degradation, stack RUL.

Numbers are typical for current commercial PEM systems and are documented
inline so they can be replaced per-vendor once real electrolyzer telemetry
is connected (the same "provisional twin" convention as
nuravolt/pipeline/bess_intelligence.py):

  - H2 higher heating value  39.4 kWh/kg  (HHV, the electrolysis floor)
  - System SEC at rated load ~52.5 kWh/kg (≈75 % HHV system efficiency, BOL)
  - Part-load behaviour: stack SEC falls toward part load (lower current
    density → lower overpotential) while balance-of-plant consumption is
    roughly fixed, so SYSTEM SEC rises steeply below ~15 % load.
  - Stack degradation: SEC drifts up with operating hours; end-of-life is
    conventionally +10 % SEC over BOL (~60–80 kh for modern PEM stacks).
"""

from __future__ import annotations

from dataclasses import dataclass

H2_HHV_KWH_PER_KG = 39.4
H2_LHV_KWH_PER_KG = 33.3

# Balance-of-plant (rectifier idle losses, water treatment, controls) as a
# fraction of rated power that is consumed regardless of load.
BOP_FIXED_FRACTION = 0.02

# Stack SEC at BOL: falls from rated toward part load (lower overpotential).
STACK_SEC_RATED_KWH_PER_KG = 50.0
STACK_SEC_PART_LOAD_GAIN = 4.0  # kWh/kg cheaper at very low current density

# Degradation: SEC increase per 1000 stack-hours (typical PEM 0.10–0.20 %/kh).
SEC_DRIFT_PCT_PER_KH = 0.15
EOL_SEC_INCREASE_PCT = 10.0


@dataclass
class ElectrolyzerSpec:
    rated_power_kw: float
    technology: str = "PEM"
    sec_bol_kwh_per_kg: float = 52.5  # system, at rated load
    min_load_fraction: float = 0.1


def specific_consumption_kwh_per_kg(
    load_fraction: float,
    stack_hours: float = 0.0,
    spec: ElectrolyzerSpec | None = None,
) -> float:
    """System SEC (kWh per kg H2) at a given load fraction and stack age.

    system_kW = stack_kW(load) + BoP_kW(fixed)  →  SEC = system_kW / (kg/h).
    The stack term improves toward part load; the fixed BoP term dominates
    at very low loads, which is why electrolyzers are not run below their
    minimum turndown.
    """
    spec = spec or ElectrolyzerSpec(rated_power_kw=1000.0)
    load = max(spec.min_load_fraction, min(1.0, load_fraction))

    stack_sec_bol = STACK_SEC_RATED_KWH_PER_KG - STACK_SEC_PART_LOAD_GAIN * (1.0 - load)
    drift = 1.0 + (SEC_DRIFT_PCT_PER_KH / 100.0) * (stack_hours / 1000.0)
    stack_sec = stack_sec_bol * drift

    stack_kw = spec.rated_power_kw * load
    kg_per_h = stack_kw / stack_sec
    system_kw = stack_kw + spec.rated_power_kw * BOP_FIXED_FRACTION
    return system_kw / kg_per_h


def production_kg(
    power_kw: float,
    hours: float,
    stack_hours: float = 0.0,
    spec: ElectrolyzerSpec | None = None,
) -> float:
    """kg of H2 produced running at power_kw for `hours`."""
    spec = spec or ElectrolyzerSpec(rated_power_kw=max(power_kw, 1.0))
    if power_kw <= 0 or hours <= 0:
        return 0.0
    load = power_kw / spec.rated_power_kw
    sec = specific_consumption_kwh_per_kg(load, stack_hours, spec)
    return power_kw * hours / sec


def stack_efficiency_pct(sec_kwh_per_kg: float, basis: str = "HHV") -> float:
    """Energy efficiency for a given SEC, on HHV (default) or LHV basis."""
    hv = H2_HHV_KWH_PER_KG if basis.upper() == "HHV" else H2_LHV_KWH_PER_KG
    return 100.0 * hv / sec_kwh_per_kg if sec_kwh_per_kg > 0 else 0.0


def stack_rul_hours(stack_hours: float, sec_now: float, sec_bol: float) -> float:
    """Hours until SEC reaches the +10 % end-of-life threshold.

    Uses the observed average drift rate (sec_now vs BOL over stack_hours);
    falls back to the nominal drift constant for young stacks with no
    measurable drift yet.
    """
    eol_sec = sec_bol * (1.0 + EOL_SEC_INCREASE_PCT / 100.0)
    if sec_now >= eol_sec:
        return 0.0
    if stack_hours > 100 and sec_now > sec_bol:
        rate_per_h = (sec_now - sec_bol) / stack_hours
    else:
        rate_per_h = sec_bol * (SEC_DRIFT_PCT_PER_KH / 100.0) / 1000.0
    if rate_per_h <= 0:
        rate_per_h = sec_bol * (SEC_DRIFT_PCT_PER_KH / 100.0) / 1000.0
    return (eol_sec - sec_now) / rate_per_h
