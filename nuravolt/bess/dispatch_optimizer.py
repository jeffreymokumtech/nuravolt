"""
BESS Dispatch Optimization Module

Linear Programming and Model Predictive Control for optimal charge/discharge
scheduling. No ML required - pure mathematical optimization.

Key features:
- Day-ahead arbitrage optimization
- Degradation-aware dispatch (cycle costs)
- SoC constraints and efficiency modeling
- Real-time MPC for rolling horizon control
"""

from dataclasses import dataclass
from typing import Optional
import numpy as np

# Optional dependencies
try:
    import cvxpy as cp
    CVXPY_AVAILABLE = True
except ImportError:
    CVXPY_AVAILABLE = False
    cp = None


@dataclass
class DispatchResult:
    """Result from dispatch optimization"""
    charge_schedule: np.ndarray  # kW for each timestep
    discharge_schedule: np.ndarray  # kW for each timestep
    soc_schedule: np.ndarray  # kWh for each timestep
    revenue: float  # Total revenue/savings
    prices: np.ndarray  # Input prices
    status: str  # 'optimal', 'infeasible', etc.

    @property
    def net_schedule(self) -> np.ndarray:
        """Positive = discharge, negative = charge"""
        return self.discharge_schedule - self.charge_schedule


class BESSDispatchOptimizer:
    """
    Linear Programming optimizer for BESS dispatch.
    No ML required - pure mathematical optimization.

    Transfer pattern from: nuravolt/soiling/schedule_optimizer.py

    Example:
        optimizer = BESSDispatchOptimizer(
            capacity_kwh=1000,
            max_power_kw=250,
            efficiency=0.90
        )
        result = optimizer.optimize_day_ahead(prices=hourly_prices)
    """

    def __init__(
        self,
        capacity_kwh: float,
        max_power_kw: float,
        efficiency: float = 0.90,
        soc_min: float = 0.10,
        soc_max: float = 0.90,
        degradation_cost_per_kwh: float = 0.01
    ):
        """
        Initialize BESS optimizer.

        Args:
            capacity_kwh: Total battery capacity in kWh
            max_power_kw: Maximum charge/discharge power in kW
            efficiency: Round-trip efficiency (0-1)
            soc_min: Minimum SoC as fraction (0-1)
            soc_max: Maximum SoC as fraction (0-1)
            degradation_cost_per_kwh: Cost per kWh throughput for degradation
        """
        if not CVXPY_AVAILABLE:
            raise ImportError(
                "cvxpy is required for dispatch optimization. "
                "Install with: pip install cvxpy"
            )

        self.capacity = capacity_kwh
        self.max_power = max_power_kw
        self.efficiency = efficiency
        self.soc_min = soc_min
        self.soc_max = soc_max
        self.degradation_cost = degradation_cost_per_kwh

    def _build_model(
        self,
        prices: np.ndarray,
        initial_soc: float,
        final_soc: Optional[float],
        timestep_hours: float
    ) -> dict:
        """
        Build the arbitrage LP: variables, objective and base constraints.

        Kept separate so every entry point (plain day-ahead, must-run) solves
        the same model and only appends to its constraint list.

        Returns:
            Dict with the cvxpy variables, objective, constraint list and T
        """
        T = len(prices)

        # Decision variables
        charge = cp.Variable(T, nonneg=True)
        discharge = cp.Variable(T, nonneg=True)
        soc = cp.Variable(T + 1, nonneg=True)

        # Efficiency split (charge efficiency * discharge efficiency = round-trip)
        eta_c = np.sqrt(self.efficiency)
        eta_d = np.sqrt(self.efficiency)

        # Objective: maximize revenue - degradation cost
        revenue = cp.sum(cp.multiply(prices, discharge - charge) * timestep_hours)
        degradation = self.degradation_cost * cp.sum(charge + discharge) * timestep_hours
        objective = cp.Maximize(revenue - degradation)

        # Constraints
        constraints = [
            # Power limits
            charge <= self.max_power,
            discharge <= self.max_power,

            # SoC limits (absolute kWh)
            soc >= self.soc_min * self.capacity,
            soc <= self.soc_max * self.capacity,

            # Initial SoC
            soc[0] == initial_soc * self.capacity,
        ]

        # SoC dynamics (energy balance)
        for t in range(T):
            constraints.append(
                soc[t + 1] == soc[t]
                + charge[t] * eta_c * timestep_hours
                - discharge[t] / eta_d * timestep_hours
            )

        # Final SoC constraint (optional)
        if final_soc is not None:
            constraints.append(soc[T] == final_soc * self.capacity)

        return {
            'T': T,
            'charge': charge,
            'discharge': discharge,
            'soc': soc,
            'objective': objective,
            'constraints': constraints,
        }

    def _solve_model(
        self,
        model: dict,
        prices: np.ndarray,
        initial_soc: float,
        solver: Optional[str]
    ) -> DispatchResult:
        """Solve a model from _build_model and wrap it in a DispatchResult."""
        T = model['T']
        problem = cp.Problem(model['objective'], model['constraints'])

        if solver:
            problem.solve(solver=solver)
        else:
            # Try ECOS first (fast, convex), fallback to others
            try:
                problem.solve(solver=cp.ECOS)
            except Exception:
                problem.solve()

        if problem.status not in [cp.OPTIMAL, cp.OPTIMAL_INACCURATE]:
            return DispatchResult(
                charge_schedule=np.zeros(T),
                discharge_schedule=np.zeros(T),
                soc_schedule=np.full(T + 1, initial_soc * self.capacity),
                revenue=0.0,
                prices=prices,
                status=problem.status
            )

        return DispatchResult(
            charge_schedule=model['charge'].value,
            discharge_schedule=model['discharge'].value,
            soc_schedule=model['soc'].value,
            revenue=float(problem.value),
            prices=prices,
            status='optimal'
        )

    def optimize_day_ahead(
        self,
        prices: np.ndarray,
        initial_soc: float = 0.5,
        final_soc: Optional[float] = None,
        timestep_hours: float = 1.0,
        solver: Optional[str] = None
    ) -> DispatchResult:
        """
        Optimize 24-hour dispatch schedule given price forecast.

        Args:
            prices: Electricity prices ($/kWh) for each timestep
            initial_soc: Initial state of charge as fraction (0-1)
            final_soc: Required final SoC (None = unconstrained)
            timestep_hours: Duration of each timestep in hours
            solver: CVXPY solver name (None = auto-select)

        Returns:
            DispatchResult with optimal schedules and revenue
        """
        prices = np.asarray(prices)
        model = self._build_model(prices, initial_soc, final_soc, timestep_hours)
        return self._solve_model(model, prices, initial_soc, solver)

    def optimize_with_must_run(
        self,
        prices: np.ndarray,
        must_charge_hours: list[int] = None,
        must_discharge_hours: list[int] = None,
        must_charge_kw: Optional[float] = None,
        must_discharge_kw: Optional[float] = None,
        **kwargs
    ) -> DispatchResult:
        """
        Optimize with mandatory charge/discharge periods.

        Useful for ancillary services, tolling contracts or grid operator
        requirements. The named timesteps are pinned to a fixed power by
        equality constraints on the same LP optimize_day_ahead solves, so
        energy balance, the SoC window, power limits and the degradation cost
        all still hold and the optimizer only chooses the free timesteps. No
        binary variables are needed: a must-run window is a known schedule,
        not a decision.

        Args:
            prices: Electricity prices ($/kWh) for each timestep
            must_charge_hours: Timestep indices that must charge
            must_discharge_hours: Timestep indices that must discharge
            must_charge_kw: Power to pin must-charge timesteps to
                (None = max_power_kw)
            must_discharge_kw: Power to pin must-discharge timesteps to
                (None = max_power_kw)
            **kwargs: initial_soc, final_soc, timestep_hours, solver — same
                meaning as in optimize_day_ahead

        Returns:
            DispatchResult. When the pinned windows cannot be met inside the
            SoC window the solver reports infeasible and that status is
            returned as-is: the obligation is never quietly relaxed to
            produce a schedule that looks servable.
        """
        prices = np.asarray(prices)
        T = len(prices)

        charge_hours = sorted(set(must_charge_hours or []))
        discharge_hours = sorted(set(must_discharge_hours or []))

        clash = sorted(set(charge_hours) & set(discharge_hours))
        if clash:
            raise ValueError(
                f"timesteps cannot be must-charge and must-discharge at once: {clash}"
            )
        for t in charge_hours + discharge_hours:
            if not 0 <= t < T:
                raise ValueError(
                    f"must-run timestep {t} is outside the price horizon 0..{T - 1}"
                )

        charge_kw = self.max_power if must_charge_kw is None else float(must_charge_kw)
        discharge_kw = self.max_power if must_discharge_kw is None else float(must_discharge_kw)
        for name, value in (('must_charge_kw', charge_kw), ('must_discharge_kw', discharge_kw)):
            if not 0 <= value <= self.max_power:
                raise ValueError(
                    f"{name}={value} outside the asset's 0..{self.max_power} kW range"
                )

        initial_soc = kwargs.pop('initial_soc', 0.5)
        final_soc = kwargs.pop('final_soc', None)
        timestep_hours = kwargs.pop('timestep_hours', 1.0)
        solver = kwargs.pop('solver', None)
        if kwargs:
            raise TypeError(f"unexpected keyword arguments: {sorted(kwargs)}")

        model = self._build_model(prices, initial_soc, final_soc, timestep_hours)

        # Pin the obligated timesteps. Both sides are fixed so the optimizer
        # can't satisfy a must-charge hour by charging and discharging at once.
        for t in charge_hours:
            model['constraints'].append(model['charge'][t] == charge_kw)
            model['constraints'].append(model['discharge'][t] == 0)
        for t in discharge_hours:
            model['constraints'].append(model['discharge'][t] == discharge_kw)
            model['constraints'].append(model['charge'][t] == 0)

        return self._solve_model(model, prices, initial_soc, solver)


class MPCDispatcher:
    """
    Model Predictive Control for real-time dispatch.
    Re-optimizes at each timestep with updated forecasts.

    Example:
        mpc = MPCDispatcher(optimizer, horizon=24)
        for t in range(simulation_hours):
            charge, discharge = mpc.get_action(
                current_soc=battery.soc,
                price_forecast=get_forecast(t, 24)
            )
            battery.step(charge, discharge)
    """

    def __init__(
        self,
        optimizer: BESSDispatchOptimizer,
        horizon: int = 24
    ):
        """
        Initialize MPC dispatcher.

        Args:
            optimizer: Base optimizer for solving subproblems
            horizon: Lookahead horizon in timesteps
        """
        self.optimizer = optimizer
        self.horizon = horizon
        self.action_history = []

    def get_action(
        self,
        current_soc: float,
        price_forecast: np.ndarray,
        actual_price: Optional[float] = None
    ) -> tuple[float, float]:
        """
        Get optimal action for current timestep.

        Args:
            current_soc: Current SoC as fraction (0-1)
            price_forecast: Price forecast for horizon
            actual_price: Realized price (for logging)

        Returns:
            (charge_kw, discharge_kw) tuple
        """
        # Ensure forecast covers horizon
        forecast = price_forecast[:self.horizon]
        if len(forecast) < self.horizon:
            # Pad with last price if forecast too short
            forecast = np.pad(
                forecast,
                (0, self.horizon - len(forecast)),
                mode='edge'
            )

        # Optimize over horizon
        result = self.optimizer.optimize_day_ahead(
            prices=forecast,
            initial_soc=current_soc
        )

        if result.status != 'optimal':
            # Fallback: do nothing
            return 0.0, 0.0

        # Extract first action
        charge = float(result.charge_schedule[0])
        discharge = float(result.discharge_schedule[0])

        # Log for analysis
        self.action_history.append({
            'soc': current_soc,
            'charge': charge,
            'discharge': discharge,
            'forecast_price': forecast[0],
            'actual_price': actual_price
        })

        return charge, discharge

    def reset(self):
        """Clear action history"""
        self.action_history = []


def simple_arbitrage_schedule(
    prices: np.ndarray,
    capacity_kwh: float,
    max_power_kw: float,
    efficiency: float = 0.90,
    charge_threshold_pct: float = 0.25,
    discharge_threshold_pct: float = 0.75
) -> dict:
    """
    Simple rule-based arbitrage (no optimization, no dependencies).

    Charge when price < 25th percentile, discharge when > 75th percentile.
    Good for quick baseline or when cvxpy unavailable.

    Args:
        prices: Price array
        capacity_kwh: Battery capacity
        max_power_kw: Max power
        efficiency: Round-trip efficiency
        charge_threshold_pct: Percentile below which to charge
        discharge_threshold_pct: Percentile above which to discharge

    Returns:
        Dict with schedules and estimated revenue
    """
    prices = np.asarray(prices)

    charge_threshold = np.percentile(prices, charge_threshold_pct * 100)
    discharge_threshold = np.percentile(prices, discharge_threshold_pct * 100)

    charge_schedule = np.where(prices < charge_threshold, max_power_kw, 0.0)
    discharge_schedule = np.where(prices > discharge_threshold, max_power_kw, 0.0)

    # Simulate SoC
    soc = [0.5 * capacity_kwh]
    eta = np.sqrt(efficiency)

    for t in range(len(prices)):
        new_soc = soc[-1] + charge_schedule[t] * eta - discharge_schedule[t] / eta
        # Clip to capacity
        new_soc = np.clip(new_soc, 0.1 * capacity_kwh, 0.9 * capacity_kwh)

        # Adjust schedules if SoC limits hit
        if new_soc >= 0.9 * capacity_kwh:
            charge_schedule[t] = 0
        if new_soc <= 0.1 * capacity_kwh:
            discharge_schedule[t] = 0

        soc.append(new_soc)

    # Calculate revenue
    revenue = np.sum(prices * (discharge_schedule - charge_schedule))

    return {
        'charge_schedule': charge_schedule,
        'discharge_schedule': discharge_schedule,
        'soc_schedule': np.array(soc),
        'revenue': revenue,
        'method': 'simple_arbitrage'
    }
