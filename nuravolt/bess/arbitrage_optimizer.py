"""
BESS Degradation-Aware Arbitrage Optimization Module

Optimizes battery dispatch for revenue while accounting for the true cost
of degradation in each charge/discharge cycle.

Trade profitability = revenue - degradation_cost

The key insight: if a trade brings in EUR 5 but costs EUR 7 in physical wear,
you're losing money - just slowly liquidating your hardware.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import List, Optional, Tuple
import numpy as np

from nuravolt.bess.config import (
    ArbitrageConfig,
    BessChemistry,
    DispatchSchedule,
)
from nuravolt.bess.warranty_tracker import EmpiricalDegradationModel


@dataclass
class ArbitrageOpportunity:
    """A potential arbitrage opportunity.

    Bounds are settlement-period indices into the price array, not hours: a GB
    price array is 48 half-hourly periods, an Iberian one 24 hourly periods.
    Multiply by ArbitrageConfig.period_hours to get wall-clock time.
    """
    start_slot: int
    end_slot: int
    action: str  # 'charge' or 'discharge'
    avg_price: float  # EUR/MWh
    price_spread: float  # Price difference to exploit
    estimated_revenue_eur: float
    estimated_degradation_cost_eur: float
    net_profit_eur: float
    is_profitable: bool


@dataclass
class CycleCost:
    """Detailed breakdown of cycle cost."""
    base_cost: float  # Chemistry baseline
    dod_multiplier: float  # Depth of discharge impact
    temp_multiplier: float  # Temperature impact
    c_rate_multiplier: float  # C-rate impact
    warranty_penalty: float  # Extra cost if near warranty limits
    total_cost_per_kwh: float


class DegradationCostCalculator:
    """
    Calculate the real-time cost of battery degradation.

    Uses chemistry-specific models to price the "wear and tear" of each
    charge/discharge operation based on operating conditions.
    """

    def __init__(
        self,
        config: ArbitrageConfig,
        degradation_model: Optional[EmpiricalDegradationModel] = None
    ):
        """
        Initialize the cost calculator.

        Args:
            config: Arbitrage configuration with degradation parameters
            degradation_model: Optional physics-based degradation model
        """
        self.config = config
        self.degradation = degradation_model or EmpiricalDegradationModel()

    def calculate_cycle_cost(
        self,
        dod: float,
        avg_temp_c: float,
        c_rate: float,
        current_soh: float = 1.0,
        warranty_margin: float = 0.10
    ) -> CycleCost:
        """
        Calculate the cost of a single cycle at given conditions.

        Args:
            dod: Depth of discharge (0-1)
            avg_temp_c: Average temperature during cycle
            c_rate: Average C-rate during cycle
            current_soh: Current state of health (affects warranty penalty)
            warranty_margin: SoH margin to warranty threshold

        Returns:
            CycleCost with detailed breakdown
        """
        config = self.config

        # Base cost per kWh (chemistry-dependent)
        base_cost = config.base_degradation_cost_per_kwh

        # DoD multiplier (exponential stress)
        dod_multiplier = (dod / 0.8) ** config.dod_stress_factor

        # Temperature multiplier (linear above 25C)
        temp_multiplier = 1 + config.temp_stress_factor * max(0, avg_temp_c - 25)

        # C-rate multiplier (linear above 0.5C)
        c_rate_multiplier = 1 + config.c_rate_stress_factor * max(0, c_rate - 0.5)

        # Warranty penalty (increases as approaching threshold)
        if warranty_margin < 0.05:
            # Critical - near warranty threshold
            warranty_penalty = 3.0
        elif warranty_margin < 0.10:
            # Warning zone
            warranty_penalty = 1.5
        else:
            warranty_penalty = 1.0

        # Total cost per kWh throughput
        total_cost = (
            base_cost
            * dod_multiplier
            * temp_multiplier
            * c_rate_multiplier
            * warranty_penalty
        )

        return CycleCost(
            base_cost=base_cost,
            dod_multiplier=dod_multiplier,
            temp_multiplier=temp_multiplier,
            c_rate_multiplier=c_rate_multiplier,
            warranty_penalty=warranty_penalty,
            total_cost_per_kwh=total_cost,
        )

    def calculate_throughput_cost(
        self,
        throughput_kwh: float,
        dod: float,
        avg_temp_c: float,
        c_rate: float,
        current_soh: float = 1.0,
        warranty_margin: float = 0.10
    ) -> float:
        """
        Calculate total degradation cost for a given throughput.

        Args:
            throughput_kwh: Total energy throughput (charge + discharge)
            dod: Depth of discharge
            avg_temp_c: Average temperature
            c_rate: Average C-rate
            current_soh: Current state of health
            warranty_margin: Margin to warranty threshold

        Returns:
            Total degradation cost in EUR
        """
        cycle_cost = self.calculate_cycle_cost(
            dod=dod,
            avg_temp_c=avg_temp_c,
            c_rate=c_rate,
            current_soh=current_soh,
            warranty_margin=warranty_margin,
        )

        return throughput_kwh * cycle_cost.total_cost_per_kwh


class DegradationAwareArbitrage:
    """
    Arbitrage optimization with real-time degradation pricing.

    Optimizes charge/discharge schedule to maximize:
        Net Revenue = Gross Revenue - Degradation Cost

    This ensures trades are only executed when they're truly profitable,
    not just generating revenue at the expense of battery life.

    Example:
        config = ArbitrageConfig(
            capacity_kwh=1000,
            max_power_kw=500,
        )
        optimizer = DegradationAwareArbitrage(config)

        schedule = optimizer.optimize(
            prices=price_forecast,
            initial_soc=0.5,
            current_soh=0.95,
        )

        print(f"Net revenue: EUR {schedule.net_revenue_eur:.2f}")
    """

    def __init__(
        self,
        config: ArbitrageConfig,
        degradation_model: Optional[EmpiricalDegradationModel] = None
    ):
        """
        Initialize the arbitrage optimizer.

        Args:
            config: Arbitrage configuration
            degradation_model: Physics-based degradation model
        """
        self.config = config
        self.cost_calculator = DegradationCostCalculator(config, degradation_model)

    def optimize(
        self,
        prices: np.ndarray,
        initial_soc: float = 0.5,
        current_soh: float = 1.0,
        warranty_margin: float = 0.10,
        temp_forecast: Optional[np.ndarray] = None,
        schedule_date: Optional[datetime] = None
    ) -> DispatchSchedule:
        """
        Optimize dispatch schedule considering degradation costs.

        Uses a greedy heuristic that:
        1. Identifies profitable arbitrage opportunities
        2. Only executes trades where revenue > degradation cost
        3. Respects SoC limits and warranty constraints

        Args:
            prices: Price forecast, one value per settlement period, in
                config.currency per MWh. The period length comes from
                config.time_resolution_minutes and must match the array the
                caller passes: 48 half-hourly GB periods costed as full hours
                would double every revenue figure.
            initial_soc: Starting state of charge
            current_soh: Current state of health
            warranty_margin: Margin to warranty threshold
            temp_forecast: Temperature forecast (uses 25C if not provided),
                one value per settlement period
            schedule_date: Date for the schedule

        Returns:
            Optimized DispatchSchedule
        """
        config = self.config
        prices = np.asarray(prices, dtype=float)
        n_slots = len(prices)

        # Default temperature if not provided
        if temp_forecast is None:
            temp_forecast = np.full(n_slots, 25.0)

        # Initialize schedules
        charge_schedule = np.zeros(n_slots)
        discharge_schedule = np.zeros(n_slots)
        soc_schedule = np.zeros(n_slots + 1)
        soc_schedule[0] = initial_soc

        # Find arbitrage opportunities
        opportunities = self._find_opportunities(
            prices=prices,
            temp_forecast=temp_forecast,
            current_soh=current_soh,
            warranty_margin=warranty_margin,
        )

        # The price screen says which slots are WORTH trading. It does not, and
        # cannot, say which are POSSIBLE: that depends on the state of charge
        # when the slot arrives, which depends on every trade before it. So the
        # screen only sets an intent per slot, and the dispatch below walks the
        # day in clock order against a real SoC ledger.
        #
        # Applying opportunities in profitability order instead, as this did,
        # scheduled a discharge whose stored energy had not been bought yet and
        # then let a min/max SoC clamp absorb the difference. The battery came
        # out a net generator: 396 modelled days took in 1,437 MWh and put out
        # 2,792 MWh, with 218 of those days reading energy_in = 0 next to a
        # full discharge. Energy from nowhere.
        intents = self._slot_intents(opportunities, n_slots)

        # Warranty throughput budget for the day, in grid-side kWh, on the same
        # basis as `expected_cycles` below. `respect_warranty_limits` was
        # previously declared and never enforced.
        throughput_budget = float("inf")
        if config.respect_warranty_limits and config.max_daily_cycles is not None:
            throughput_budget = 2.0 * config.max_daily_cycles * config.capacity_kwh

        # Energy one settlement period moves at full rated power.
        period_energy_kwh = config.max_power_kw * config.period_hours
        # Guard against scheduling float dust as a dispatch setpoint. This is a
        # numerical floor, not a commercial minimum trade size.
        min_trade_kwh = 1e-9 * max(period_energy_kwh, 1.0)

        total_revenue = 0.0
        total_degradation_cost = 0.0
        grid_throughput_kwh = 0.0
        soc = float(initial_soc)

        for slot in range(n_slots):
            action = intents.get(slot)
            budget_kwh = max(0.0, throughput_budget - grid_throughput_kwh)

            if action == "charge":
                # Grid-side energy that fits under max_soc. Charging is lossy,
                # so headroom in the cell buys MORE than that from the grid.
                headroom_cell_kwh = max(0.0, (config.max_soc - soc) * config.capacity_kwh)
                grid_kwh = min(
                    period_energy_kwh,
                    headroom_cell_kwh / config.charge_efficiency,
                    budget_kwh,
                )
                if grid_kwh > min_trade_kwh:
                    # Partial power is a real setpoint: a battery that is nearly
                    # full ramps down, it does not take a full period and throw
                    # the surplus away.
                    charge_schedule[slot] = -grid_kwh / config.period_hours
                    # cell_kwh <= headroom_cell_kwh by construction, so soc
                    # cannot cross max_soc and nothing needs clamping.
                    cell_kwh = grid_kwh * config.charge_efficiency
                    soc += cell_kwh / config.capacity_kwh
                    grid_throughput_kwh += grid_kwh
                    total_revenue -= prices[slot] * grid_kwh / 1000  # charging costs money

            elif action == "discharge":
                # Grid-side energy backed by stored charge above min_soc.
                # Discharging is lossy, so the cell gives up more than the grid
                # receives.
                stored_cell_kwh = max(0.0, (soc - config.min_soc) * config.capacity_kwh)
                grid_kwh = min(
                    period_energy_kwh,
                    stored_cell_kwh * config.discharge_efficiency,
                    budget_kwh,
                )
                if grid_kwh > min_trade_kwh:
                    discharge_schedule[slot] = grid_kwh / config.period_hours
                    cell_kwh = grid_kwh / config.discharge_efficiency
                    soc -= cell_kwh / config.capacity_kwh
                    grid_throughput_kwh += grid_kwh
                    total_revenue += (
                        prices[slot] * grid_kwh * config.discharge_efficiency / 1000
                    )

            # Every slot is written, in order, whether or not it traded. The old
            # "if soc_schedule[i] == 0: carry the previous value" backfill
            # existed because opportunities wrote scattered indices out of
            # order; it papered over the gaps instead of closing them.
            soc_schedule[slot + 1] = soc

        # Calculate total degradation cost
        total_throughput = (
            np.abs(charge_schedule).sum() + discharge_schedule.sum()
        ) * config.period_hours

        if total_throughput > 0:
            avg_dod = self._calculate_avg_dod(soc_schedule)
            avg_c_rate = self._calculate_avg_c_rate(
                charge_schedule, discharge_schedule, config.capacity_kwh
            )
            avg_temp = float(np.mean(temp_forecast))

            total_degradation_cost = self.cost_calculator.calculate_throughput_cost(
                throughput_kwh=total_throughput,
                dod=avg_dod,
                avg_temp_c=avg_temp,
                c_rate=avg_c_rate,
                current_soh=current_soh,
                warranty_margin=warranty_margin,
            )

        # Calculate equivalent cycles
        expected_cycles = total_throughput / (2 * config.capacity_kwh)

        energy_in_kwh = float(np.abs(charge_schedule).sum() * config.period_hours)
        energy_out_kwh = float(discharge_schedule.sum() * config.period_hours)

        return DispatchSchedule(
            schedule_date=schedule_date or datetime.now(),
            # Delivery hours, not slots: 48 half-hourly periods are 24 hours.
            horizon_hours=int(round(n_slots * config.period_hours)),
            resolution_minutes=config.time_resolution_minutes,
            charge_schedule_kw=charge_schedule.tolist(),
            discharge_schedule_kw=discharge_schedule.tolist(),
            # One value per settlement period, each the SoC at the START of its
            # slot, so soc_schedule[k] pairs with charge/discharge[k]. The state
            # AFTER the last slot is `final_soc`, not soc_schedule[-1]: a caller
            # chaining days must carry `final_soc`, or the last slot's energy is
            # spent in the power trace and then silently refunded to the ledger.
            soc_schedule=soc_schedule[:-1].tolist(),
            price_forecast=prices.tolist(),
            expected_revenue_eur=total_revenue,
            degradation_cost_eur=total_degradation_cost,
            net_revenue_eur=total_revenue - total_degradation_cost,
            optimizer_type="degradation_aware_greedy",
            status="optimal",
            expected_cycles=expected_cycles,
            currency=config.currency,
            final_soc=float(soc_schedule[-1]),
            energy_in_kwh=energy_in_kwh,
            energy_out_kwh=energy_out_kwh,
        )

    def _slot_intents(self, opportunities: List[ArbitrageOpportunity], n_slots: int) -> dict:
        """Reduce the screened opportunities to at most one intent per slot.

        Opportunities arrive sorted by profitability, so where two overlap on a
        slot the more profitable one claims it. Charge and discharge screens key
        off opposite sides of the price band and cannot currently collide, but
        the opportunity API allows multi-slot ranges, so the precedence is made
        explicit rather than left to whichever happened to be written last.
        """
        intents: dict = {}
        for opp in opportunities:
            if not opp.is_profitable:
                continue
            first = max(0, opp.start_slot)
            last = min(opp.end_slot, n_slots - 1)
            for slot in range(first, last + 1):
                intents.setdefault(slot, opp.action)
        return intents

    def _find_opportunities(
        self,
        prices: np.ndarray,
        temp_forecast: np.ndarray,
        current_soh: float,
        warranty_margin: float
    ) -> List[ArbitrageOpportunity]:
        """
        Identify potential arbitrage opportunities.

        Looks for:
        - Low price periods for charging
        - High price periods for discharging
        - Price spreads that exceed degradation costs

        Args:
            prices: Price array
            temp_forecast: Temperature forecast
            current_soh: Current SoH
            warranty_margin: Warranty margin

        Returns:
            List of arbitrage opportunities sorted by profitability
        """
        config = self.config
        n_slots = len(prices)

        # Calculate price statistics
        avg_price = np.mean(prices)
        price_std = np.std(prices)

        # Thresholds for charge/discharge
        charge_threshold = avg_price - 0.5 * price_std
        discharge_threshold = avg_price + 0.5 * price_std

        opportunities = []

        # Find charging opportunities (low price periods)
        for i in range(n_slots):
            if prices[i] < charge_threshold:
                # Estimate degradation cost for this charge
                c_rate = config.max_power_kw / config.capacity_kwh
                cycle_cost = self.cost_calculator.calculate_cycle_cost(
                    dod=0.4,  # Assume 40% DoD for partial cycle
                    avg_temp_c=float(temp_forecast[i]),
                    c_rate=c_rate,
                    current_soh=current_soh,
                    warranty_margin=warranty_margin,
                )

                # Energy for one settlement period
                energy_kwh = config.max_power_kw * config.period_hours

                # Cost to charge
                charge_cost = prices[i] * energy_kwh / 1000

                # Find best discharge opportunity
                future_prices = prices[i + 1:] if i < n_slots - 1 else []
                if len(future_prices) > 0:
                    best_discharge_price = np.max(future_prices)
                    discharge_revenue = (
                        best_discharge_price * energy_kwh * config.discharge_efficiency / 1000
                    )

                    # Full cycle degradation cost
                    degradation_cost = (
                        cycle_cost.total_cost_per_kwh * energy_kwh * 2  # Charge + discharge
                    )

                    net_profit = discharge_revenue - charge_cost - degradation_cost

                    opportunities.append(ArbitrageOpportunity(
                        start_slot=i,
                        end_slot=i,
                        action="charge",
                        avg_price=prices[i],
                        price_spread=best_discharge_price - prices[i],
                        estimated_revenue_eur=discharge_revenue - charge_cost,
                        estimated_degradation_cost_eur=degradation_cost,
                        net_profit_eur=net_profit,
                        is_profitable=net_profit > 0,
                    ))

        # Find discharging opportunities (high price periods).
        #
        # These carry no degradation charge of their own, and that is deliberate
        # rather than an omission: the charge screen above prices a WHOLE cycle
        # (`energy_kwh * 2`, charge leg plus discharge leg), so billing the
        # discharge again would double-count the wear of a single round trip.
        # Energy that is already in the cell was paid for, in money and in
        # degradation, on the day it was bought.
        #
        # What they are not is unconditional. Every one of these is sized
        # against the SoC ledger in `optimize`, and a slot with nothing stored
        # behind it dispatches nothing.
        for i in range(n_slots):
            if prices[i] > discharge_threshold:
                opportunities.append(ArbitrageOpportunity(
                    start_slot=i,
                    end_slot=i,
                    action="discharge",
                    avg_price=prices[i],
                    price_spread=prices[i] - avg_price,
                    estimated_revenue_eur=0,  # Sized by the ledger at dispatch
                    estimated_degradation_cost_eur=0,  # Priced on the charge leg
                    net_profit_eur=0,
                    is_profitable=True,
                ))

        # Sort by profitability
        return sorted(
            opportunities,
            key=lambda x: x.net_profit_eur,
            reverse=True
        )

    def _calculate_avg_dod(self, soc_schedule: np.ndarray) -> float:
        """Calculate average depth of discharge from SoC schedule."""
        if len(soc_schedule) < 2:
            return 0.0

        max_soc = np.max(soc_schedule)
        min_soc = np.min(soc_schedule)

        return max_soc - min_soc

    def _calculate_avg_c_rate(
        self,
        charge_schedule: np.ndarray,
        discharge_schedule: np.ndarray,
        capacity_kwh: float
    ) -> float:
        """Calculate average C-rate from power schedules."""
        all_power = np.abs(charge_schedule) + discharge_schedule
        non_zero = all_power[all_power > 0]

        if len(non_zero) == 0:
            return 0.0

        return float(np.mean(non_zero) / capacity_kwh)

    def evaluate_trade(
        self,
        charge_price: float,
        discharge_price: float,
        energy_kwh: float,
        dod: float,
        avg_temp_c: float,
        c_rate: float,
        current_soh: float = 1.0,
        warranty_margin: float = 0.10
    ) -> dict:
        """
        Evaluate whether a specific trade is profitable.

        Args:
            charge_price: Price to buy power (EUR/MWh)
            discharge_price: Price to sell power (EUR/MWh)
            energy_kwh: Energy to trade
            dod: Expected depth of discharge
            avg_temp_c: Expected temperature
            c_rate: Expected C-rate
            current_soh: Current state of health
            warranty_margin: Margin to warranty threshold

        Returns:
            Dictionary with trade analysis
        """
        config = self.config

        # Calculate costs
        charge_cost = charge_price * energy_kwh / 1000  # EUR
        discharge_revenue = (
            discharge_price * energy_kwh * config.discharge_efficiency / 1000
        )

        gross_revenue = discharge_revenue - charge_cost

        # Degradation cost
        degradation_cost = self.cost_calculator.calculate_throughput_cost(
            throughput_kwh=energy_kwh * 2,  # Full cycle
            dod=dod,
            avg_temp_c=avg_temp_c,
            c_rate=c_rate,
            current_soh=current_soh,
            warranty_margin=warranty_margin,
        )

        net_revenue = gross_revenue - degradation_cost

        return {
            "charge_cost_eur": charge_cost,
            "discharge_revenue_eur": discharge_revenue,
            "gross_revenue_eur": gross_revenue,
            "degradation_cost_eur": degradation_cost,
            "net_revenue_eur": net_revenue,
            "is_profitable": net_revenue > 0,
            "breakeven_spread": degradation_cost / (energy_kwh / 1000),  # EUR/MWh
            "actual_spread": discharge_price - charge_price,
            "recommendation": (
                "EXECUTE" if net_revenue > 0 else "SKIP - degradation cost exceeds profit"
            ),
        }
