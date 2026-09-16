"""Configuration for maintenance schedule optimization."""

from dataclasses import dataclass, field
from typing import Dict, Optional


@dataclass
class SchedulerConfig:
    """Configuration for the maintenance schedule optimizer."""

    # Priority scoring weights
    urgency_weight: float = 0.6  # Weight for days-to-fault (higher = prioritize urgency)
    impact_weight: float = 0.4  # Weight for economic impact (higher = prioritize $)

    # Resource constraints
    max_tasks_per_day: int = 3  # Maximum maintenance tasks per day (crew capacity)
    crew_day_rate_eur: float = 500.0  # Daily crew cost in EUR
    travel_time_hours: float = 1.0  # Default travel time between plants (hours)

    # Scheduling parameters
    planning_horizon_days: int = 30  # How far ahead to schedule
    min_days_between_visits: int = 7  # Minimum days between visits to same plant

    # Urgency thresholds (days)
    urgent_threshold_days: int = 3  # < 3 days = urgent
    soon_threshold_days: int = 7  # 3-7 days = soon
    planned_threshold_days: int = 30  # 7-30 days = planned

    # Economic parameters
    electricity_rate_eur_per_mwh: float = 80.0  # Default PPA rate
    working_hours_per_day: float = 8.0  # Hours available per day

    # Ticketing integration
    auto_create_tickets: bool = True  # Auto-create tickets for scheduled tasks
    ticket_priority_mapping: Dict[str, str] = field(
        default_factory=lambda: {
            "urgent": "CRITICAL",
            "soon": "HIGH",
            "planned": "MEDIUM",
            "monitoring": "LOW",
        }
    )


# Repair cost estimates per fault type (EUR)
REPAIR_COSTS: Dict[str, float] = {
    "string_degradation": 200.0,  # Connector repair/replacement
    "inverter_thermal": 1500.0,  # Fan replacement, cleaning, derating
    "module_degradation": 500.0,  # Module testing, replacement planning
    "thermal_hotspot": 800.0,  # Bypass diode, cell inspection
    "mismatch": 300.0,  # String balancing, connection check
    "bypass_diode": 600.0,  # Diode replacement
    "insulation": 2000.0,  # Cable repair, ground fault isolation
}

# Repair time estimates per fault type (hours)
REPAIR_HOURS: Dict[str, float] = {
    "string_degradation": 2.0,  # Quick connection fix
    "inverter_thermal": 4.0,  # Cooling system work
    "module_degradation": 3.0,  # Testing + documentation
    "thermal_hotspot": 3.0,  # Thermal inspection + repair
    "mismatch": 2.0,  # String comparison + adjustment
    "bypass_diode": 2.0,  # Diode replacement
    "insulation": 6.0,  # Cable inspection + repair
}

# Energy loss rate if fault occurs (kWh/day per MW capacity)
# Based on typical impact of each fault type
DAILY_ENERGY_LOSS_KWH_PER_MW: Dict[str, float] = {
    "string_degradation": 50.0,  # ~1% daily loss on affected string
    "inverter_thermal": 200.0,  # Significant derating or shutdown
    "module_degradation": 30.0,  # Gradual efficiency loss
    "thermal_hotspot": 100.0,  # Affected modules produce less
    "mismatch": 80.0,  # Current limiting on mismatched strings
    "bypass_diode": 60.0,  # Bypassed cells reduce output
    "insulation": 150.0,  # Safety shutdown if Riso too low
}

# Fault severity for prioritization (higher = more critical)
FAULT_SEVERITY: Dict[str, int] = {
    "insulation": 10,  # Safety critical (fire/shock risk)
    "thermal_hotspot": 9,  # Fire risk
    "bypass_diode": 8,  # Fire risk if diode fails
    "inverter_thermal": 7,  # Equipment damage risk
    "string_degradation": 5,  # Performance impact
    "mismatch": 4,  # Performance impact
    "module_degradation": 3,  # Long-term issue
}

# Plant priority tiers (for multi-plant scheduling)
# Higher tier = higher priority for maintenance
PLANT_PRIORITY_TIERS: Dict[str, int] = {
    "tier_1": 3,  # Critical plants (largest, most revenue)
    "tier_2": 2,  # Standard plants
    "tier_3": 1,  # Lower priority plants
}

# Default plant tier assignments (can be overridden per plant)
DEFAULT_PLANT_TIER: str = "tier_2"


def get_repair_cost(fault_type: str) -> float:
    """Get repair cost for a fault type."""
    return REPAIR_COSTS.get(fault_type, 500.0)


def get_repair_hours(fault_type: str) -> float:
    """Get repair time for a fault type."""
    return REPAIR_HOURS.get(fault_type, 3.0)


def get_daily_energy_loss(fault_type: str) -> float:
    """Get daily energy loss rate for a fault type (kWh/day per MW)."""
    return DAILY_ENERGY_LOSS_KWH_PER_MW.get(fault_type, 50.0)


def get_fault_severity(fault_type: str) -> int:
    """Get fault severity score (1-10)."""
    return FAULT_SEVERITY.get(fault_type, 5)


def calculate_revenue_at_risk(
    fault_type: str,
    days_to_fault: float,
    capacity_mw: float,
    electricity_rate: float = 80.0,
) -> float:
    """
    Calculate revenue at risk if fault is not addressed.

    Args:
        fault_type: Type of fault
        days_to_fault: Days until fault threshold is reached
        capacity_mw: Plant capacity in MW
        electricity_rate: EUR per MWh

    Returns:
        Revenue at risk in EUR
    """
    daily_loss_kwh = get_daily_energy_loss(fault_type) * capacity_mw
    daily_loss_mwh = daily_loss_kwh / 1000

    # Revenue lost from fault day until end of planning horizon
    # (conservative: assume 30 days of impact)
    impact_days = min(30, max(0, 30 - days_to_fault))
    revenue_at_risk = daily_loss_mwh * electricity_rate * impact_days

    return revenue_at_risk


def calculate_priority_score(
    days_to_fault: float,
    revenue_at_risk: float,
    repair_cost: float,
    fault_severity: int,
    config: Optional[SchedulerConfig] = None,
) -> float:
    """
    Calculate priority score for a maintenance task.

    Higher score = higher priority.

    Args:
        days_to_fault: Predicted days until fault
        revenue_at_risk: EUR at risk if not addressed
        repair_cost: Cost to repair in EUR
        fault_severity: Severity score (1-10)
        config: Scheduler configuration

    Returns:
        Priority score (0-100)
    """
    if config is None:
        config = SchedulerConfig()

    # Urgency component (0-60 based on weight)
    # Inverse relationship: fewer days = higher urgency
    max_days = config.planning_horizon_days
    urgency_score = max(0, (max_days - days_to_fault) / max_days) * 100

    # Economic impact component (0-40 based on weight)
    # Net benefit = revenue saved - cost
    net_benefit = revenue_at_risk - repair_cost
    # Normalize to 0-100 (assume max benefit of 10000 EUR)
    impact_score = min(100, max(0, net_benefit / 100))

    # Severity bonus (0-10)
    severity_bonus = fault_severity

    # Weighted combination
    priority = (
        config.urgency_weight * urgency_score
        + config.impact_weight * impact_score
        + severity_bonus
    )

    return min(100, max(0, priority))
