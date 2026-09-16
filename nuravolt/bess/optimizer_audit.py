"""
BESS optimizer performance audit.

Compares the revenue a battery actually realized against a degradation-aware
perfect-foresight benchmark computed from published day-ahead prices, day by
day, with matched state-of-charge boundary conditions so both trajectories
start and end each day with the same energy in the battery.

The benchmark LP is solved with scipy's HiGHS solver (no cvxpy dependency);
``nuravolt.bess.dispatch_optimizer`` remains the cvxpy-based scheduling tool,
this module is the *audit* counterpart built for forensic comparison.

Key outputs per day: realized vs optimal net revenue (both charged the same
degradation cost per kWh throughput), capture ratio, realized vs optimal
equivalent full cycles, captured price spread, and share of discharge energy
placed in the top price quartile. Perfect foresight is a theoretical ceiling:
good commercial optimizers typically capture 70-90% of it, which is the
context the report gives these numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd
from scipy.optimize import linprog


@dataclass
class AuditAssetSpec:
    """Physical and contractual parameters of the audited battery."""
    capacity_kwh: float
    max_power_kw: float
    round_trip_efficiency: float = 0.88
    soc_min: float = 0.05
    soc_max: float = 0.95
    degradation_cost_per_kwh: float = 0.005  # EUR per kWh throughput
    asset_name: str = "BESS"

    @property
    def eta_one_way(self) -> float:
        return float(np.sqrt(self.round_trip_efficiency))


@dataclass
class DayAudit:
    """Audit result for one delivery day."""
    day: pd.Timestamp
    status: str  # 'ok', 'ok_relaxed', 'skipped_coverage', 'skipped_prices', 'infeasible'
    realized_revenue_eur: float = 0.0
    realized_net_eur: float = 0.0
    optimal_revenue_eur: float = 0.0
    optimal_net_eur: float = 0.0
    capture_ratio: Optional[float] = None
    realized_efc: float = 0.0
    optimal_efc: float = 0.0
    realized_spread_eur_mwh: Optional[float] = None
    optimal_spread_eur_mwh: Optional[float] = None
    realized_top_quartile_share: Optional[float] = None
    optimal_top_quartile_share: Optional[float] = None
    coverage: float = 0.0
    # Measured day-end SoC minus the end state implied by metered power under
    # the model's efficiency (kWh). Large values flag SoC/power telemetry
    # inconsistency (BMS taper, aux loads, calibration drift).
    soc_ledger_mismatch_kwh: Optional[float] = None


@dataclass
class OptimizerAuditResult:
    asset: AuditAssetSpec
    days: list[DayAudit]
    price_source: str
    zone: Optional[str]
    power_sign_flipped: bool
    power_price_correlation: float
    sample_days: dict = field(default_factory=dict)

    def daily_frame(self) -> pd.DataFrame:
        rows = [vars(d).copy() for d in self.days]
        df = pd.DataFrame(rows)
        if not df.empty:
            df = df.set_index("day").sort_index()
        return df

    @property
    def valid_days(self) -> list[DayAudit]:
        return [d for d in self.days if d.status in ("ok", "ok_relaxed")]

    def summary(self) -> dict:
        valid = self.valid_days
        total_realized = sum(d.realized_net_eur for d in valid)
        total_optimal = sum(d.optimal_net_eur for d in valid)
        n_days = len(valid)
        gap = total_optimal - total_realized
        capture = (total_realized / total_optimal) if total_optimal > 1e-9 else None
        return {
            "asset_name": self.asset.asset_name,
            "capacity_kwh": self.asset.capacity_kwh,
            "max_power_kw": self.asset.max_power_kw,
            "round_trip_efficiency": self.asset.round_trip_efficiency,
            "degradation_cost_per_kwh": self.asset.degradation_cost_per_kwh,
            "price_source": self.price_source,
            "zone": self.zone,
            "days_analyzed": n_days,
            "days_skipped": len(self.days) - n_days,
            "realized_net_eur": round(total_realized, 2),
            "optimal_net_eur": round(total_optimal, 2),
            "revenue_gap_eur": round(gap, 2),
            "capture_ratio": round(capture, 4) if capture is not None else None,
            "annualized_gap_eur": round(gap / n_days * 365, 0) if n_days else None,
            "realized_efc_total": round(sum(d.realized_efc for d in valid), 1),
            "optimal_efc_total": round(sum(d.optimal_efc for d in valid), 1),
            "power_sign_flipped": self.power_sign_flipped,
            "power_price_correlation": round(self.power_price_correlation, 3),
            "soc_ledger_mismatch_mean_abs_kwh": self._mean_abs_mismatch(),
        }

    def _mean_abs_mismatch(self) -> Optional[float]:
        vals = [abs(d.soc_ledger_mismatch_kwh) for d in self.valid_days
                if d.soc_ledger_mismatch_kwh is not None]
        return round(float(np.mean(vals)), 1) if vals else None

    def to_dict(self) -> dict:
        df = self.daily_frame()
        daily = []
        if not df.empty:
            for day, row in df.iterrows():
                rec = {"day": pd.Timestamp(day).date().isoformat()}
                for key, value in row.items():
                    if isinstance(value, (np.floating, np.integer)):
                        value = value.item()
                    if isinstance(value, float) and np.isnan(value):
                        value = None
                    rec[key] = value
                daily.append(rec)
        return {"summary": self.summary(), "daily": daily, "sample_days": self.sample_days}


def _normalize_soc(series: pd.Series) -> pd.Series:
    """Accept SoC as fraction (0-1) or percent (0-100)."""
    s = series.astype(float)
    if s.max() > 1.5:
        s = s / 100.0
    return s.clip(0.0, 1.0)


def _solve_day_lp(
    prices_kwh: np.ndarray,
    dt_hours: float,
    spec: AuditAssetSpec,
    s0_kwh: float,
    s_end_kwh: float,
    soc_lo_kwh: float,
    soc_hi_kwh: float,
    relax_final: bool = False,
):
    """Perfect-foresight LP for one day. Returns (charge, discharge, soc, ok)."""
    T = len(prices_kwh)
    eta = np.sqrt(np.clip(spec.round_trip_efficiency, 0.5, 1.0))
    lam = spec.degradation_cost_per_kwh

    # x = [c_0..c_{T-1}, d_0..d_{T-1}, s_1..s_T]
    n = 3 * T
    cost = np.zeros(n)
    cost[:T] = prices_kwh * dt_hours + lam * dt_hours           # charging buys energy
    cost[T:2 * T] = -prices_kwh * dt_hours + lam * dt_hours     # discharging sells energy

    a_eq = np.zeros((T, n))
    b_eq = np.zeros(T)
    for t in range(T):
        a_eq[t, t] = -eta * dt_hours            # charge adds eta*c*dt
        a_eq[t, T + t] = dt_hours / eta         # discharge removes d/eta*dt
        a_eq[t, 2 * T + t] = 1.0                # s_{t+1}
        if t == 0:
            b_eq[t] = s0_kwh
        else:
            a_eq[t, 2 * T + t - 1] = -1.0       # -s_t

    bounds = [(0.0, spec.max_power_kw)] * (2 * T) + [(soc_lo_kwh, soc_hi_kwh)] * T
    if relax_final:
        slack = 0.05 * spec.capacity_kwh
        bounds[-1] = (max(soc_lo_kwh, s_end_kwh - slack), min(soc_hi_kwh, s_end_kwh + slack))
    else:
        bounds[-1] = (s_end_kwh, s_end_kwh)

    res = linprog(cost, A_eq=a_eq, b_eq=b_eq, bounds=bounds, method="highs")
    if not res.success:
        return None, None, None, False
    x = res.x
    return x[:T], x[T:2 * T], x[2 * T:], True


def _spread(prices_mwh: np.ndarray, charge_kw: np.ndarray, discharge_kw: np.ndarray) -> Optional[float]:
    """Discharge-weighted minus charge-weighted average price (EUR/MWh)."""
    c_sum, d_sum = charge_kw.sum(), discharge_kw.sum()
    if c_sum < 1e-6 or d_sum < 1e-6:
        return None
    return float((prices_mwh * discharge_kw).sum() / d_sum - (prices_mwh * charge_kw).sum() / c_sum)


def _top_quartile_share(prices_mwh: np.ndarray, discharge_kw: np.ndarray) -> Optional[float]:
    d_sum = discharge_kw.sum()
    if d_sum < 1e-6:
        return None
    threshold = np.quantile(prices_mwh, 0.75)
    return float(discharge_kw[prices_mwh >= threshold].sum() / d_sum)


def run_optimizer_audit(
    telemetry: pd.DataFrame,
    prices: pd.DataFrame,
    spec: AuditAssetSpec,
    power_col: str = "power_kw",
    soc_col: Optional[str] = "soc",
    power_sign: str = "auto",
    day_tz: str = "UTC",
    min_coverage: float = 0.8,
) -> OptimizerAuditResult:
    """
    Audit realized dispatch against the perfect-foresight day-ahead benchmark.

    Args:
        telemetry: DataFrame with a DatetimeIndex (tz-aware or assumed UTC) and
            a signed battery power column. Optional SoC column (fraction or %).
        prices: Output of nuravolt.markets.fetch_day_ahead_prices.
        spec: Battery parameters used for both realized accounting and the LP.
        power_col: Signed AC power column name.
        soc_col: SoC column name, or None to integrate a pseudo-SoC from power.
        power_sign: 'discharge_positive', 'charge_positive', or 'auto'
            (auto flips the sign if power anti-correlates with price, since a
            merchant battery discharges into expensive hours).
        day_tz: Timezone used for delivery-day boundaries (e.g. Europe/Madrid).
        min_coverage: Minimum fraction of expected samples for a day to count.
    """
    if power_col not in telemetry.columns:
        raise ValueError(f"telemetry is missing power column {power_col!r}")
    df = telemetry.copy()
    if not isinstance(df.index, pd.DatetimeIndex):
        raise ValueError("telemetry must have a DatetimeIndex")
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    df = df.sort_index()
    df = df[~df.index.duplicated(keep="first")]

    dt_hours = df.index.to_series().diff().median() / pd.Timedelta(hours=1)
    if not np.isfinite(dt_hours) or dt_hours <= 0:
        raise ValueError("could not infer telemetry timestep")

    # Align prices onto the telemetry grid (price valid from its interval start).
    price_series = prices["price_eur_mwh"].sort_index()
    if isinstance(price_series.index, pd.DatetimeIndex) and price_series.index.tz is None:
        # Same assumption the telemetry gets at the top of this function: a
        # naive index is taken as UTC. This is not cosmetic. A naive price
        # index unioned with the (now aware) telemetry index degrades to an
        # object index whose aware block sorts after every naive entry, so
        # ffill paints the ENTIRE telemetry with the final naive price. A
        # constant price makes the power-price correlation NaN, the realized
        # revenue the sign of the net energy balance (negative, because of
        # losses), and the perfect-foresight optimum roughly zero, all while
        # returning numbers that look computed. Every artifact generated from
        # a naive price frame carried exactly that signature.
        price_series.index = price_series.index.tz_localize("UTC")
    aligned_prices = price_series.reindex(
        price_series.index.union(df.index)
    ).ffill().reindex(df.index)
    df["_price_mwh"] = aligned_prices

    net = df[power_col].astype(float)
    corr = float(np.corrcoef(net.fillna(0.0), df["_price_mwh"].fillna(df["_price_mwh"].mean()))[0, 1]) \
        if df["_price_mwh"].notna().sum() > 10 else 0.0
    flipped = False
    if power_sign == "charge_positive":
        net = -net
        flipped = True
    elif power_sign == "auto" and corr < -0.02:
        net = -net
        flipped = True
    df["_net_kw"] = net

    # Measured SoC (state at the START of each sample's interval, the standard
    # BMS convention) is used only to anchor each day's starting state and to
    # quantify SoC/power ledger consistency. The benchmark's energy budget is
    # derived from metered power so that realized dispatch is feasible for the
    # LP by construction, guaranteeing optimal >= realized.
    has_measured_soc = bool(soc_col and soc_col in df.columns)
    if has_measured_soc:
        df["_soc_kwh"] = _normalize_soc(df[soc_col]) * spec.capacity_kwh

    local_index = df.index.tz_convert(day_tz)
    df["_day"] = local_index.date

    expected_per_day = int(round(24.0 / dt_hours))
    lam = spec.degradation_cost_per_kwh
    days: list[DayAudit] = []
    day_details: dict[str, dict] = {}

    groups = [(pd.Timestamp(day_value), group) for day_value, group in df.groupby("_day")]
    eta = spec.eta_one_way
    chained_s0 = 0.5 * spec.capacity_kwh  # fallback anchor when SoC is unmeasured

    for i, (day_ts, group) in enumerate(groups):
        audit = DayAudit(day=day_ts, status="ok")
        coverage = len(group) / expected_per_day
        audit.coverage = round(float(coverage), 3)
        if coverage < min_coverage:
            audit.status = "skipped_coverage"
            days.append(audit)
            continue
        if group["_price_mwh"].isna().mean() > 0.05:
            audit.status = "skipped_prices"
            days.append(audit)
            continue

        prices_mwh = group["_price_mwh"].ffill().bfill().to_numpy(dtype=float)
        prices_kwh = prices_mwh / 1000.0
        net_kw = group["_net_kw"].fillna(0.0).to_numpy(dtype=float)
        charge_kw = np.clip(-net_kw, 0.0, None)
        discharge_kw = np.clip(net_kw, 0.0, None)

        realized_revenue = float((prices_kwh * net_kw).sum() * dt_hours)
        realized_throughput = float((charge_kw + discharge_kw).sum() * dt_hours)
        realized_net = realized_revenue - lam * realized_throughput

        if has_measured_soc and not np.isnan(group["_soc_kwh"].iloc[0]):
            s0 = float(group["_soc_kwh"].iloc[0])
        else:
            s0 = chained_s0

        # Power-ledger trajectory: what realized actions do to the battery
        # under the model's own dynamics. Its end state is the benchmark's
        # required end state, so the realized schedule is always feasible.
        step_delta = (charge_kw * eta - discharge_kw / eta) * dt_hours
        trajectory = s0 + np.cumsum(step_delta)
        s_end = float(trajectory[-1])
        chained_s0 = float(np.clip(s_end, spec.soc_min * spec.capacity_kwh,
                                   spec.soc_max * spec.capacity_kwh))

        soc_lo = min(spec.soc_min * spec.capacity_kwh, float(trajectory.min()), s0, s_end)
        soc_hi = max(spec.soc_max * spec.capacity_kwh, float(trajectory.max()), s0, s_end)

        # SoC/power consistency: measured state at the start of the next day
        # vs the power-implied end state of this day.
        if has_measured_soc and i + 1 < len(groups):
            measured_next = groups[i + 1][1]["_soc_kwh"].iloc[0]
            if not np.isnan(measured_next):
                audit.soc_ledger_mismatch_kwh = round(float(measured_next) - s_end, 1)

        c_opt, d_opt, soc_opt, ok = _solve_day_lp(
            prices_kwh, dt_hours, spec, s0, s_end, soc_lo, soc_hi
        )
        if not ok:
            c_opt, d_opt, soc_opt, ok = _solve_day_lp(
                prices_kwh, dt_hours, spec, s0, s_end, soc_lo, soc_hi, relax_final=True
            )
            audit.status = "ok_relaxed" if ok else "infeasible"
        if not ok:
            days.append(audit)
            continue

        optimal_revenue = float((prices_kwh * (d_opt - c_opt)).sum() * dt_hours)
        optimal_throughput = float((c_opt + d_opt).sum() * dt_hours)
        optimal_net = optimal_revenue - lam * optimal_throughput

        audit.realized_revenue_eur = round(realized_revenue, 2)
        audit.realized_net_eur = round(realized_net, 2)
        audit.optimal_revenue_eur = round(optimal_revenue, 2)
        audit.optimal_net_eur = round(optimal_net, 2)
        audit.realized_efc = round(realized_throughput / (2 * spec.capacity_kwh), 3)
        audit.optimal_efc = round(optimal_throughput / (2 * spec.capacity_kwh), 3)
        audit.realized_spread_eur_mwh = _spread(prices_mwh, charge_kw, discharge_kw)
        audit.optimal_spread_eur_mwh = _spread(prices_mwh, c_opt, d_opt)
        audit.realized_top_quartile_share = _top_quartile_share(prices_mwh, discharge_kw)
        audit.optimal_top_quartile_share = _top_quartile_share(prices_mwh, d_opt)
        days.append(audit)

        day_details[day_ts.date().isoformat()] = {
            "timestamps": [ts.isoformat() for ts in group.index],
            "price_eur_mwh": [round(float(p), 2) for p in prices_mwh],
            "realized_net_kw": [round(float(v), 1) for v in net_kw],
            "optimal_net_kw": [round(float(v), 1) for v in (d_opt - c_opt)],
            "realized_soc_kwh": [round(float(v), 1) for v in trajectory],
            "optimal_soc_kwh": [round(float(v), 1) for v in soc_opt],
            "gap_eur": round(optimal_net - realized_net, 2),
        }

    # Per-day capture ratios are only meaningful when the benchmark is material:
    # dividing by a near-zero benchmark day (flat prices, forced idle) produces
    # noise like -2900%. Threshold: 10% of the median positive benchmark day.
    positive_optimal = [d.optimal_net_eur for d in days
                        if d.status in ("ok", "ok_relaxed") and d.optimal_net_eur > 0]
    materiality = 0.10 * float(np.median(positive_optimal)) if positive_optimal else 0.0
    for d in days:
        if d.status in ("ok", "ok_relaxed") and d.optimal_net_eur > max(materiality, 1e-6):
            d.capture_ratio = round(d.realized_net_eur / d.optimal_net_eur, 4)

    # Keep step-level detail only for two illustrative days (largest gap + median gap).
    sample_days: dict[str, dict] = {}
    scored = [(k, v["gap_eur"]) for k, v in day_details.items()]
    if scored:
        scored.sort(key=lambda kv: kv[1])
        worst_key = scored[-1][0]
        median_key = scored[len(scored) // 2][0]
        sample_days["largest_gap"] = {"day": worst_key, **day_details[worst_key]}
        if median_key != worst_key:
            sample_days["median_gap"] = {"day": median_key, **day_details[median_key]}

    return OptimizerAuditResult(
        asset=spec,
        days=days,
        price_source=prices.attrs.get("price_source", "unknown"),
        zone=prices.attrs.get("zone"),
        power_sign_flipped=flipped,
        power_price_correlation=corr,
        sample_days=sample_days,
    )
