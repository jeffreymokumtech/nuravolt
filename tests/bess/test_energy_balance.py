"""A battery cannot discharge energy it never stored.

The modelled dispatch twin used to break that. Over 396 days on a 10 MWh asset
it took in 1,437 MWh and put out 2,792 MWh, a net generator, with 218 of those
days reading energy_in = 0 beside a full discharge. The cause was not a bad
number, it was a missing ledger: `optimize` applied price opportunities in
PROFITABILITY order rather than clock order, so a discharge could be scheduled
before the charge that was supposed to fill it, and a min/max SoC clamp then
absorbed the difference silently.

These tests pin the physics rather than the numbers. For any horizon:

    energy_out / discharge_efficiency
        <= energy_in * charge_efficiency + (soc_start - min_soc) * capacity

and over a window that starts with an empty usable band, total out is strictly
less than total in, at a ratio approaching charge_efficiency x
discharge_efficiency. No network, no database.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from nuravolt.bess.arbitrage_optimizer import DegradationAwareArbitrage
from nuravolt.bess.config import ArbitrageConfig

# The asset the twin actually models: 5 MW / 10 MWh LFP, a 2 hour duration,
# run in the conservative SoC band bess_intelligence.py configures.
CAPACITY_KWH = 10_000.0
POWER_KW = 5_000.0
MIN_SOC = 0.20
MAX_SOC = 0.88


def make_config(**overrides) -> ArbitrageConfig:
    params = dict(
        capacity_kwh=CAPACITY_KWH,
        max_power_kw=POWER_KW,
        min_soc=MIN_SOC,
        max_soc=MAX_SOC,
        time_resolution_minutes=60,
        base_degradation_cost_per_kwh=0.004,  # LFP
    )
    params.update(overrides)
    return ArbitrageConfig(**params)


def duck_curve(seed: int) -> np.ndarray:
    """A day-ahead shape with a morning peak, a cheap solar midday and an
    evening peak. Deterministic per seed, with the spread varying day to day so
    the screen has flat days and volatile ones to reject and accept."""
    rng = np.random.default_rng(seed)
    shape = np.array([62, 55, 48, 44, 42, 45, 58, 74, 88, 72, 50, 32,
                      24, 22, 26, 38, 58, 82, 105, 118, 110, 92, 78, 68], dtype=float)
    level = rng.uniform(25.0, 90.0)
    spread = rng.uniform(0.15, 1.6)  # some days barely move, some are volatile
    return level + (shape - shape.mean()) * spread


def energies(sched, cfg) -> tuple:
    """Grid-side energy in and out, integrated from the power arrays."""
    charge = np.asarray(sched.charge_schedule_kw)
    discharge = np.asarray(sched.discharge_schedule_kw)
    return (
        float(np.abs(charge).sum() * cfg.period_hours),
        float(discharge.sum() * cfg.period_hours),
    )


# ---------------------------------------------------------------------------
# The ledger itself


def test_soc_trace_is_exactly_what_the_power_schedule_implies():
    """No clamp, no backfill, no gap. Reconstructing the state of charge from
    the dispatch alone must reproduce the reported trace slot for slot.

    This is the assertion the old code could not pass. It wrote SoC at
    scattered indices out of order, clamped the overflow into min/max, then ran
    `if soc_schedule[i] == 0: soc_schedule[i] = soc_schedule[i - 1]` to fill the
    holes. The published trace was not the trace the power schedule described.
    """
    cfg = make_config()
    sched = DegradationAwareArbitrage(cfg).optimize(prices=duck_curve(3), initial_soc=0.5)

    soc = 0.5
    for k, (charge_kw, discharge_kw) in enumerate(
        zip(sched.charge_schedule_kw, sched.discharge_schedule_kw)
    ):
        # soc_schedule[k] is the state the slot-k dispatch acted on.
        assert sched.soc_schedule[k] == pytest.approx(soc, abs=1e-12), f"slot {k}"
        soc += abs(min(charge_kw, 0.0)) * cfg.period_hours * cfg.charge_efficiency / cfg.capacity_kwh
        soc -= max(discharge_kw, 0.0) * cfg.period_hours / (cfg.discharge_efficiency * cfg.capacity_kwh)

    # ...and the state after the last slot is `final_soc`, not soc_schedule[-1].
    assert sched.final_soc == pytest.approx(soc, abs=1e-12)


def test_soc_never_leaves_the_configured_band():
    """Trades are sized to the band, so nothing has to be clamped back into it."""
    cfg = make_config()
    optimizer = DegradationAwareArbitrage(cfg)
    soc = 0.5
    for day in range(40):
        sched = optimizer.optimize(prices=duck_curve(day), initial_soc=soc)
        trace = list(sched.soc_schedule) + [sched.final_soc]
        assert min(trace) >= MIN_SOC - 1e-9, f"day {day} discharged below min_soc"
        assert max(trace) <= MAX_SOC + 1e-9, f"day {day} charged above max_soc"
        soc = sched.final_soc


def test_a_day_cannot_discharge_more_than_it_holds():
    """The regression, at its sharpest.

    Start with a nearly empty battery (0.25 against a 0.20 floor, so 500 kWh of
    usable stock) and hand it a descending price curve. The early slots clear
    above the discharge threshold, so the screen wants to sell into them, while
    no charge is profitable because every future price is lower than the
    present one. The battery must sell the 500 kWh it holds and not one kWh
    more.

    The old ledger checked only that SOME energy was available and then wrote a
    full-power period regardless, clamping SoC to the floor. It would have sold
    a full 5,000 kWh period out of 500 kWh of stock.
    """
    cfg = make_config()
    prices = np.linspace(200.0, 20.0, 24)  # strictly descending
    sched = DegradationAwareArbitrage(cfg).optimize(prices=prices, initial_soc=0.25)

    energy_in, energy_out = energies(sched, cfg)
    stock_cell_kwh = (0.25 - MIN_SOC) * CAPACITY_KWH  # 500 kWh in the cell

    assert energy_in == 0.0, "no charge should clear on a strictly descending curve"
    assert energy_out > 0.0, "it did hold stock, and the peak was worth selling"
    # Grid-side output is the cell stock net of the discharge loss.
    assert energy_out <= stock_cell_kwh * cfg.discharge_efficiency + 1e-9
    assert energy_out == pytest.approx(stock_cell_kwh * cfg.discharge_efficiency, rel=1e-9)


def test_an_empty_battery_dispatches_nothing():
    """At the floor there is nothing to sell, however good the price."""
    cfg = make_config()
    prices = np.linspace(200.0, 20.0, 24)
    sched = DegradationAwareArbitrage(cfg).optimize(prices=prices, initial_soc=MIN_SOC)

    energy_in, energy_out = energies(sched, cfg)
    assert energy_in == 0.0
    assert energy_out == 0.0
    assert sched.expected_cycles == 0.0
    assert sched.final_soc == pytest.approx(MIN_SOC)


# ---------------------------------------------------------------------------
# Per-day feasibility


@pytest.mark.parametrize("initial_soc", [MIN_SOC, 0.35, 0.5, 0.7, MAX_SOC])
def test_per_day_feasibility_against_the_ledger(initial_soc):
    """The standard, day by day, from every starting state:

        energy_out / eta_d <= energy_in * eta_c + (soc_start - min_soc) * cap
    """
    cfg = make_config()
    optimizer = DegradationAwareArbitrage(cfg)

    for day in range(60):
        sched = optimizer.optimize(prices=duck_curve(day), initial_soc=initial_soc)
        energy_in, energy_out = energies(sched, cfg)

        drawn_from_cell = energy_out / cfg.discharge_efficiency
        available = (
            energy_in * cfg.charge_efficiency
            + (initial_soc - MIN_SOC) * CAPACITY_KWH
        )
        assert drawn_from_cell <= available + 1e-6, (
            f"day {day} from soc {initial_soc}: discharged {drawn_from_cell:.1f} kWh "
            f"from the cell against {available:.1f} kWh available"
        )


def test_reported_energy_totals_match_the_power_arrays():
    """`energy_in_kwh` / `energy_out_kwh` are stated so a balance can be checked
    without re-integrating, so they must not drift from the arrays."""
    cfg = make_config()
    for day in range(10):
        sched = DegradationAwareArbitrage(cfg).optimize(prices=duck_curve(day), initial_soc=0.5)
        energy_in, energy_out = energies(sched, cfg)
        assert sched.energy_in_kwh == pytest.approx(energy_in, rel=1e-12)
        assert sched.energy_out_kwh == pytest.approx(energy_out, rel=1e-12)


# ---------------------------------------------------------------------------
# Whole-window conservation


def run_window(days: int, cfg: ArbitrageConfig, carry: str = "final_soc") -> dict:
    """Chain `days` days, carrying state across midnight the way the twin does.

    `carry` selects which value becomes tomorrow's initial_soc: `final_soc` is
    the state after the last slot, `last_slot` is the state BEFORE it, which is
    what a caller reading soc_schedule[-1] would pick up.
    """
    optimizer = DegradationAwareArbitrage(cfg)
    soc = cfg.min_soc  # start with an empty usable band: no stored gift
    total_in = total_out = 0.0
    for day in range(days):
        sched = optimizer.optimize(prices=duck_curve(day), initial_soc=soc)
        energy_in, energy_out = energies(sched, cfg)
        total_in += energy_in
        total_out += energy_out
        soc = sched.final_soc if carry == "final_soc" else sched.soc_schedule[-1]
    return {"total_in": total_in, "total_out": total_out, "final_soc": soc}


def test_the_window_is_a_net_consumer_not_a_net_generator():
    cfg = make_config()
    window = run_window(120, cfg)

    assert window["total_in"] > 0.0, "a 120 day arbitrage window that never charged is not a test"
    assert window["total_out"] < window["total_in"], (
        f"took in {window['total_in'] / 1000:.1f} MWh, put out "
        f"{window['total_out'] / 1000:.1f} MWh: a net generator is impossible"
    )


def test_window_ratio_lands_on_the_configured_round_trip_efficiency():
    cfg = make_config()
    window = run_window(120, cfg)
    rte = cfg.charge_efficiency * cfg.discharge_efficiency

    ratio = window["total_out"] / window["total_in"]
    # Energy left in the cell at the end depresses the ratio slightly below the
    # round trip; nothing can push it above.
    assert ratio <= rte + 1e-9
    assert ratio == pytest.approx(rte, abs=0.01)


def test_window_energy_balance_closes_exactly():
    """Stronger than the ratio: every kWh is accounted for by the end state."""
    cfg = make_config()
    window = run_window(120, cfg)

    stored_change = (window["final_soc"] - cfg.min_soc) * cfg.capacity_kwh
    into_cell = window["total_in"] * cfg.charge_efficiency
    out_of_cell = window["total_out"] / cfg.discharge_efficiency
    assert into_cell - out_of_cell == pytest.approx(stored_change, abs=1e-6)


def test_carrying_the_second_to_last_soc_refunds_the_final_slot():
    """Why `final_soc` exists, and exactly when it matters.

    soc_schedule[-1] is the state BEFORE the last slot runs. A caller chaining
    days on it spends the final slot's energy in the power trace and then hands
    the ledger back unspent: energy from nowhere, once per day, compounding.

    It only bites when the final slot actually trades, which is why it hides. On
    an ordinary duck curve the last hour is neither a peak nor a trough and
    never dispatches, so the two carries agree and the leak is invisible. This
    uses a flat day with a single closing price spike, which is the case that
    exposes it.
    """
    cfg = make_config()
    prices = np.array([50.0] * 23 + [500.0])
    sched = DegradationAwareArbitrage(cfg).optimize(prices=prices, initial_soc=MAX_SOC)

    _, energy_out = energies(sched, cfg)
    assert energy_out > 0.0, "the closing spike is worth selling into"

    withdrawn_from_cell = energy_out / cfg.discharge_efficiency
    # The honest carry: the ledger closed on the energy that was sold.
    assert (MAX_SOC - sched.final_soc) * CAPACITY_KWH == pytest.approx(
        withdrawn_from_cell, abs=1e-6
    )
    # The leaky carry: nothing was withdrawn at all, so the next day starts the
    # day rich by everything the final slot sold.
    refunded = (sched.soc_schedule[-1] - sched.final_soc) * CAPACITY_KWH
    assert refunded == pytest.approx(withdrawn_from_cell, abs=1e-6)
    assert refunded > 1_000.0, "a full closing period on a 10 MWh asset is not small"


def test_a_window_closes_its_balance_when_days_are_chained_on_final_soc():
    cfg = make_config()
    window = run_window(120, cfg, carry="final_soc")
    stored_change = (window["final_soc"] - cfg.min_soc) * cfg.capacity_kwh
    residual = (
        window["total_in"] * cfg.charge_efficiency
        - window["total_out"] / cfg.discharge_efficiency
        - stored_change
    )
    assert residual == pytest.approx(0.0, abs=1e-6)


# ---------------------------------------------------------------------------
# Warranty throughput budget


def test_max_daily_cycles_is_enforced_when_warranty_limits_are_respected():
    """`respect_warranty_limits` was declared and never enforced. A tight budget
    must actually bind the day's throughput."""
    cfg = make_config(max_daily_cycles=0.25, respect_warranty_limits=True)
    sched = DegradationAwareArbitrage(cfg).optimize(prices=duck_curve(3), initial_soc=0.5)

    energy_in, energy_out = energies(sched, cfg)
    budget = 2.0 * cfg.max_daily_cycles * cfg.capacity_kwh
    assert energy_in + energy_out <= budget + 1e-6
    assert sched.expected_cycles <= cfg.max_daily_cycles + 1e-9
    assert sched.expected_cycles > 0.0, "a 0.25 cycle budget still permits trading"


def test_a_slack_budget_does_not_bind():
    """The 2.0 cycles/day default must not be silently shaping the dispatch."""
    cfg = make_config(max_daily_cycles=2.0, respect_warranty_limits=True)
    unlimited = make_config(respect_warranty_limits=False)

    for day in range(30):
        bound = DegradationAwareArbitrage(cfg).optimize(prices=duck_curve(day), initial_soc=0.5)
        free = DegradationAwareArbitrage(unlimited).optimize(prices=duck_curve(day), initial_soc=0.5)
        assert bound.expected_cycles == pytest.approx(free.expected_cycles, rel=1e-12)


# ---------------------------------------------------------------------------
# Dispatch is applied in clock order


def test_a_charge_is_never_scheduled_after_the_discharge_it_funds():
    """The ordering property, stated directly: at every slot, cumulative cell
    energy withdrawn can never exceed cumulative cell energy put in plus the
    opening stock. Profitability ordering broke this; clock ordering cannot."""
    cfg = make_config()
    sched = DegradationAwareArbitrage(cfg).optimize(prices=duck_curve(7), initial_soc=0.4)

    opening_stock = (0.4 - MIN_SOC) * CAPACITY_KWH
    stored_in = withdrawn = 0.0
    for k, (charge_kw, discharge_kw) in enumerate(
        zip(sched.charge_schedule_kw, sched.discharge_schedule_kw)
    ):
        stored_in += abs(min(charge_kw, 0.0)) * cfg.period_hours * cfg.charge_efficiency
        withdrawn += max(discharge_kw, 0.0) * cfg.period_hours / cfg.discharge_efficiency
        assert withdrawn <= stored_in + opening_stock + 1e-6, (
            f"slot {k}: sold {withdrawn:.1f} kWh against {stored_in + opening_stock:.1f} kWh"
        )
