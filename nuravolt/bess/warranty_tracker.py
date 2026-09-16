"""
Warranty Analytics and Compliance Tracking Module

Track warranty KPIs, model degradation, and forecast warranty dates.
Independent of OEM systems for objective monitoring.

Reference: TWAICE, ACCURE approaches
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional
import numpy as np


@dataclass
class WarrantyTerms:
    """Standard BESS warranty structure"""
    capacity_guarantee_pct: float = 0.70  # 70% after warranty period
    warranty_years: int = 10
    max_cycles: int = 5000  # Equivalent full cycles
    max_throughput_mwh: Optional[float] = None  # Optional throughput limit
    min_rte: float = 0.85  # Minimum round-trip efficiency
    max_avg_soc: float = 0.80  # Some warranties limit high SoC time
    max_operating_temp: float = 35.0  # °C


@dataclass
class WarrantyStatus:
    """Current warranty compliance status"""
    current_soh: float
    warranty_soh_threshold: float
    soh_margin: float
    is_compliant: bool

    cycle_usage_pct: float
    cycles_remaining: float

    time_usage_pct: float
    years_remaining: float

    risk_factors: list
    recommendation: str

    projected_warranty_date: Optional[datetime] = None


class WarrantyTracker:
    """
    Track warranty KPIs independent of OEM systems.

    Example:
        terms = WarrantyTerms(capacity_guarantee_pct=0.70, warranty_years=10)
        tracker = WarrantyTracker(terms, nominal_capacity_kwh=1000)

        # Update from daily operations
        tracker.update_from_cycle({
            'energy_in_kwh': 800,
            'energy_out_kwh': 720,
            'duration_hours': 8,
            'avg_soc': 0.5,
            'avg_temp': 28
        })

        # Get warranty status
        status = tracker.get_warranty_status()
        print(f"Cycles remaining: {status.cycles_remaining}")
    """

    def __init__(
        self,
        terms: WarrantyTerms,
        nominal_capacity_kwh: float,
        installation_date: Optional[datetime] = None
    ):
        self.terms = terms
        self.nominal_capacity = nominal_capacity_kwh
        self.installation_date = installation_date or datetime.now()

        self.metrics = {
            'equivalent_full_cycles': 0.0,
            'total_throughput_kwh': 0.0,
            'high_soc_hours': 0.0,
            'high_temp_hours': 0.0,
            'current_capacity_kwh': nominal_capacity_kwh,
            'last_capacity_test_date': None,
        }

        self.cycle_history = []

    def update_from_cycle(self, cycle_data: dict):
        """
        Update metrics from a charge/discharge cycle.

        Args:
            cycle_data: Dict with:
                - energy_in_kwh: Energy charged
                - energy_out_kwh: Energy discharged
                - duration_hours: Cycle duration
                - avg_soc: Average state of charge
                - avg_temp: Average temperature
                - max_temp: Maximum temperature (optional)
                - dod: Depth of discharge (optional)
        """
        energy_in = cycle_data.get('energy_in_kwh', 0)
        energy_out = cycle_data.get('energy_out_kwh', 0)
        duration = cycle_data.get('duration_hours', 0)
        avg_soc = cycle_data.get('avg_soc', 0.5)
        avg_temp = cycle_data.get('avg_temp', 25)

        # Equivalent Full Cycles (EFC)
        # EFC = throughput / (2 * nominal_capacity)
        throughput = energy_in + energy_out
        efc_increment = throughput / (2 * self.nominal_capacity)
        self.metrics['equivalent_full_cycles'] += efc_increment

        # Total throughput
        self.metrics['total_throughput_kwh'] += throughput

        # High SoC time (warranty stress factor)
        if avg_soc > self.terms.max_avg_soc:
            self.metrics['high_soc_hours'] += duration

        # High temperature time
        if avg_temp > self.terms.max_operating_temp:
            self.metrics['high_temp_hours'] += duration

        # Store cycle for trend analysis
        self.cycle_history.append({
            'timestamp': datetime.now(),
            'efc': efc_increment,
            'throughput': throughput,
            'avg_temp': avg_temp,
            'avg_soc': avg_soc
        })

    def measure_capacity(self, full_cycle_energy_kwh: float):
        """
        Update measured capacity from a full charge/discharge test.

        Should be performed periodically (monthly/quarterly) for accurate SoH.
        """
        self.metrics['current_capacity_kwh'] = full_cycle_energy_kwh
        self.metrics['last_capacity_test_date'] = datetime.now()

    def get_current_soh(self) -> float:
        """Get current State of Health as fraction (0-1)"""
        return self.metrics['current_capacity_kwh'] / self.nominal_capacity

    def get_warranty_status(self) -> WarrantyStatus:
        """
        Get comprehensive warranty compliance status.
        """
        # Current SoH
        soh = self.get_current_soh()

        # Cycle usage
        cycle_usage_pct = (
            self.metrics['equivalent_full_cycles'] / self.terms.max_cycles
        )
        cycles_remaining = (
            self.terms.max_cycles - self.metrics['equivalent_full_cycles']
        )

        # Time-based warranty remaining
        years_elapsed = (
            datetime.now() - self.installation_date
        ).days / 365.25
        time_usage_pct = years_elapsed / self.terms.warranty_years
        years_remaining = self.terms.warranty_years - years_elapsed

        # Risk factors
        risk_factors = self._identify_risk_factors()

        # Compliance check
        is_compliant = (
            soh >= self.terms.capacity_guarantee_pct
            and cycle_usage_pct <= 1.0
            and time_usage_pct <= 1.0
        )

        # Recommendation
        recommendation = self._generate_recommendation(
            soh, cycle_usage_pct, risk_factors
        )

        # Project warranty date
        projected_date = self._project_warranty_date(soh)

        return WarrantyStatus(
            current_soh=soh,
            warranty_soh_threshold=self.terms.capacity_guarantee_pct,
            soh_margin=soh - self.terms.capacity_guarantee_pct,
            is_compliant=is_compliant,
            cycle_usage_pct=cycle_usage_pct,
            cycles_remaining=max(0, cycles_remaining),
            time_usage_pct=time_usage_pct,
            years_remaining=max(0, years_remaining),
            risk_factors=risk_factors,
            recommendation=recommendation,
            projected_warranty_date=projected_date
        )

    def _identify_risk_factors(self) -> list:
        """Identify factors that may void or stress warranty"""
        risks = []

        if self.metrics['high_temp_hours'] > 1000:
            risks.append(
                f"High temperature operation: {self.metrics['high_temp_hours']:.0f} hours "
                f"above {self.terms.max_operating_temp}°C"
            )

        if self.metrics['high_soc_hours'] > 2000:
            risks.append(
                f"High SoC dwelling: {self.metrics['high_soc_hours']:.0f} hours "
                f"above {self.terms.max_avg_soc:.0%} SoC"
            )

        # Check if capacity test is overdue
        if self.metrics['last_capacity_test_date']:
            days_since_test = (
                datetime.now() - self.metrics['last_capacity_test_date']
            ).days
            if days_since_test > 90:
                risks.append(
                    f"Capacity test overdue: {days_since_test} days since last test"
                )

        return risks

    def _generate_recommendation(
        self,
        soh: float,
        cycle_pct: float,
        risk_factors: list
    ) -> str:
        """Generate operational recommendation"""
        if soh < self.terms.capacity_guarantee_pct:
            return "CRITICAL: Below warranty threshold. Document for warranty claim."

        if soh < self.terms.capacity_guarantee_pct + 0.05:
            return "WARNING: Approaching warranty threshold. Reduce DoD and cycle depth."

        if cycle_pct > 0.8:
            return "INFO: 80% of cycle warranty used. Schedule capacity test."

        if len(risk_factors) > 0:
            return f"ADVISORY: {len(risk_factors)} risk factor(s) identified. Review operations."

        return "OK: Operating within warranty parameters."

    def _project_warranty_date(self, current_soh: float) -> Optional[datetime]:
        """Project when warranty threshold will be reached"""
        if len(self.cycle_history) < 30:
            return None  # Not enough data

        # Calculate degradation rate from recent history
        recent = self.cycle_history[-90:]  # Last 90 cycles
        if len(recent) < 30:
            return None

        # Simple linear projection
        days_elapsed = (datetime.now() - self.installation_date).days
        soh_lost = 1.0 - current_soh

        if soh_lost <= 0 or days_elapsed <= 0:
            return None

        daily_degradation = soh_lost / days_elapsed
        soh_to_threshold = current_soh - self.terms.capacity_guarantee_pct

        if daily_degradation <= 0:
            return None

        days_to_threshold = soh_to_threshold / daily_degradation

        return datetime.now() + timedelta(days=days_to_threshold)

    def get_kpi_summary(self) -> dict:
        """Get summary of key warranty KPIs"""
        soh = self.get_current_soh()
        status = self.get_warranty_status()

        return {
            'soh': soh,
            'soh_pct': f"{soh:.1%}",
            'warranty_threshold': f"{self.terms.capacity_guarantee_pct:.0%}",
            'soh_margin': f"{status.soh_margin:.1%}",
            'cycles_used': self.metrics['equivalent_full_cycles'],
            'cycles_remaining': status.cycles_remaining,
            'cycle_usage_pct': f"{status.cycle_usage_pct:.1%}",
            'years_remaining': f"{status.years_remaining:.1f}",
            'throughput_mwh': self.metrics['total_throughput_kwh'] / 1000,
            'is_compliant': status.is_compliant,
            'risk_count': len(status.risk_factors),
        }


class EmpiricalDegradationModel:
    """
    Semi-empirical model for capacity fade prediction.

    Capacity_loss = f(cycles, temperature, DoD, time)

    Reference: https://www.twaice.com/research/modeling-capacity-fade-of-li-ion-batteries
    """

    def __init__(self, chemistry: str = 'lfp'):
        """
        Args:
            chemistry: Battery chemistry ('lfp', 'nmc', 'nca')
        """
        # Default parameters (should be calibrated to actual data)
        self.params = self._get_chemistry_params(chemistry)

    def _get_chemistry_params(self, chemistry: str) -> dict:
        """Get default parameters by chemistry"""
        params = {
            'lfp': {
                'cyclic_coefficient': 0.00003,
                'calendar_coefficient': 0.015,
                'temperature_factor': 0.04,
                'dod_exponent': 1.3,
            },
            'nmc': {
                'cyclic_coefficient': 0.00005,
                'calendar_coefficient': 0.02,
                'temperature_factor': 0.05,
                'dod_exponent': 1.5,
            },
            'nca': {
                'cyclic_coefficient': 0.00006,
                'calendar_coefficient': 0.025,
                'temperature_factor': 0.06,
                'dod_exponent': 1.6,
            },
        }
        return params.get(chemistry, params['nmc'])

    def predict_capacity_loss(
        self,
        cycles: float,
        years: float,
        avg_temp: float = 25.0,
        avg_dod: float = 0.8
    ) -> float:
        """
        Predict capacity loss fraction (0-1).

        Args:
            cycles: Equivalent full cycles
            years: Calendar years
            avg_temp: Average operating temperature (°C)
            avg_dod: Average depth of discharge (0-1)

        Returns:
            Capacity loss as fraction (0-1)
        """
        p = self.params

        # Cyclic aging (DoD-dependent)
        cyclic_loss = (
            p['cyclic_coefficient']
            * cycles
            * (avg_dod ** p['dod_exponent'])
        )

        # Calendar aging (Arrhenius-like temperature dependence)
        temp_factor = 1 + p['temperature_factor'] * max(0, avg_temp - 25)
        calendar_loss = p['calendar_coefficient'] * years * temp_factor

        # Total loss (independent mechanisms)
        total_loss = cyclic_loss + calendar_loss

        return min(total_loss, 1.0)

    def predict_soh(
        self,
        cycles: float,
        years: float,
        avg_temp: float = 25.0,
        avg_dod: float = 0.8
    ) -> float:
        """Predict State of Health (1 - capacity_loss)"""
        return 1.0 - self.predict_capacity_loss(cycles, years, avg_temp, avg_dod)

    def forecast_warranty_date(
        self,
        current_soh: float,
        warranty_threshold: float,
        usage_profile: dict
    ) -> dict:
        """
        Forecast when warranty threshold will be reached.

        Args:
            current_soh: Current state of health (0-1)
            warranty_threshold: Warranty SoH threshold (e.g., 0.70)
            usage_profile: Dict with 'cycles_per_year', 'avg_dod', 'avg_temp'

        Returns:
            Dict with years_to_warranty and projected_soh
        """
        cycles_per_year = usage_profile.get('cycles_per_year', 365)
        avg_dod = usage_profile.get('avg_dod', 0.8)
        avg_temp = usage_profile.get('avg_temp', 25)

        # Binary search for warranty date
        low, high = 0, 30  # years

        while high - low > 0.1:
            mid = (low + high) / 2
            cycles = mid * cycles_per_year
            loss = self.predict_capacity_loss(
                cycles=cycles,
                years=mid,
                avg_temp=avg_temp,
                avg_dod=avg_dod
            )
            projected_soh = 1 - loss

            if projected_soh < warranty_threshold:
                high = mid
            else:
                low = mid

        return {
            'years_to_warranty': round(mid, 1),
            'projected_soh_at_warranty': round(
                1 - self.predict_capacity_loss(
                    cycles=mid * cycles_per_year,
                    years=mid,
                    avg_temp=avg_temp,
                    avg_dod=avg_dod
                ),
                3
            ),
            'cycles_to_warranty': int(mid * cycles_per_year),
            'usage_profile': usage_profile
        }

    def optimize_usage_for_warranty(
        self,
        target_years: float,
        warranty_threshold: float,
        constraints: dict = None
    ) -> dict:
        """
        Find optimal usage profile to meet warranty target.

        Args:
            target_years: Target warranty duration
            warranty_threshold: Required SoH at end
            constraints: Optional bounds on parameters

        Returns:
            Recommended usage profile
        """
        # Simple optimization: reduce DoD and cycles to meet target
        constraints = constraints or {}
        max_cycles_per_year = constraints.get('max_cycles_per_year', 730)
        max_dod = constraints.get('max_dod', 0.9)

        # Binary search for max allowable cycles
        for dod in [0.8, 0.7, 0.6, 0.5]:
            for cycles in range(int(max_cycles_per_year), 0, -50):
                loss = self.predict_capacity_loss(
                    cycles=cycles * target_years,
                    years=target_years,
                    avg_temp=25,
                    avg_dod=dod
                )
                if 1 - loss >= warranty_threshold:
                    return {
                        'recommended_cycles_per_year': cycles,
                        'recommended_dod': dod,
                        'projected_soh': 1 - loss,
                        'meets_warranty': True
                    }

        return {
            'recommended_cycles_per_year': 100,
            'recommended_dod': 0.5,
            'projected_soh': None,
            'meets_warranty': False,
            'warning': 'Unable to meet warranty target with current parameters'
        }
