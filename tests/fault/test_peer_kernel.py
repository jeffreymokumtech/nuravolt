"""Properties the shared peer kernel must hold, or the tier A claim is empty.

The claim these detectors make is that they carry no portable constant: the same
code works on a 3 A residential string and a 15 A utility one, on a plant at 5 C
and one at 45 C, without retuning. That claim is testable, and these are the
tests. Each one fails if a scale, an offset or the device under test leaks into
the reference it is judged against.
"""

import polars as pl
import pytest

from nuravolt.fault.peer_stats import (
    PEER_Z_FLAG,
    leave_one_out_scores,
    peer_deficit,
    peer_excess,
    sustained,
)


def _frame(**channels) -> pl.DataFrame:
    n = len(next(iter(channels.values())))
    return pl.DataFrame({"timestamp": list(range(n)), **channels})


class TestLeaveOneOut:
    def test_target_does_not_enter_its_own_reference(self):
        """A dead channel must not drag down the median it is judged against.

        With four channels and one at zero, an all-columns median sits between
        the healthy value and zero. Leave-one-out keeps the reference at the
        healthy value, which is the difference between detecting the fault and
        deciding it is only half a fault.
        """
        df = _frame(a=[1.0] * 8, b=[1.0] * 8, c=[1.0] * 8, d=[0.0] * 8)
        scored = leave_one_out_scores(df, "d", ["a", "b", "c", "d"])
        assert scored["_peer_centre"].to_list() == [1.0] * 8
        assert scored["_peer_ratio"].to_list() == [0.0] * 8

    def test_too_few_siblings_yields_a_null_z_not_a_confident_one(self):
        """A MAD from two points is not a dispersion estimate; say so."""
        df = _frame(a=[1.0] * 8, b=[1.0] * 8, c=[0.5] * 8)
        scored = leave_one_out_scores(df, "c", ["a", "b", "c"])
        assert scored["_peer_ratio"].drop_nulls().to_list() == [0.5] * 8
        assert scored["_peer_z"].null_count() == 8, (
            "with 2 siblings the z must be null, never a fabricated number"
        )

    def test_uniform_healthy_fleet_stays_quiet(self):
        """Without the MAD floor a uniform fleet makes every speck of noise huge."""
        df = _frame(**{k: [1.0, 1.0001, 0.9999] * 4 for k in "abcde"})
        df = df.with_columns((pl.col("e") - 0.001).alias("e"))
        scored, tripped = peer_deficit(df, "e", list("abcde"),
                                       ratio_max=0.999, min_consecutive=1)
        assert scored.filter(tripped).height == 0, (
            "a 0.1% difference on a uniform fleet was raised as a fault"
        )


class TestScaleInvariance:
    """Scale invariance is a property of the PIPELINE, not of the bare kernel.

    The ratio is scale free on its own. The z is not, because ``mad_floor`` is an
    absolute number and has to be -- without it a uniform healthy fleet drives the
    MAD to zero and every speck of noise becomes an enormous score. So the caller
    normalises first and the floor then means "this fraction of the channel's own
    capacity" on every plant. These tests pin both halves of that bargain.
    """

    @pytest.mark.parametrize("k", [0.2, 1.0, 7.5, 100.0])
    def test_normalised_pipeline_is_unchanged_by_a_common_scale(self, k):
        """Through ``_self_normalised``, the decision must not move with scale.

        This is the property that lets one rule serve a 3 A residential string and
        a 15 A utility one. If it fails, there is an amp value hiding in the logic.
        """
        from nuravolt.fault.rule_based import _self_normalised

        # The faulty channel must be healthy for part of the record, or
        # self-normalisation rescales its deficit away -- see
        # TestSelfNormalisationLimit below.
        base = dict(a=[1.0] * 24, b=[1.0] * 24, c=[1.0] * 24, d=[1.0] * 24,
                    e=[1.0] * 12 + [0.5] * 12)

        def decide(scale):
            df = _frame(**{n: [v * scale for v in vals] for n, vals in base.items()})
            df, cols = _self_normalised(df, list(base))
            scored, mask = peer_deficit(df, cols[-1], cols,
                                        ratio_max=0.85, min_consecutive=2)
            return scored.filter(mask).height

        assert decide(k) == decide(1.0) > 0, f"scale {k} changed the decision"

    def test_raw_input_breaks_the_z_and_that_is_documented(self):
        """Hand the kernel un-normalised data and the z stops meaning anything.

        Not a bug to fix -- an absolute floor cannot be scale free -- but a
        precondition worth failing loudly about if anyone removes the
        normalisation step upstream. At scale 0.2 a genuine 50% deficit produces
        z = -3.37, which does not clear the 3.5 flag, and the fault is missed.
        """
        base = dict(a=[0.2] * 12, b=[0.2] * 12, c=[0.2] * 12, d=[0.2] * 12,
                    e=[0.1] * 12)
        scored, mask = peer_deficit(_frame(**base), "e", list(base),
                                    ratio_max=0.85, min_consecutive=2)
        assert scored.filter(mask).height == 0
        assert scored["_peer_z"][0] > -PEER_Z_FLAG


class TestOffsetInvariance:
    @pytest.mark.parametrize("offset", [-10.0, 0.0, 25.0])
    def test_excess_test_is_unchanged_by_a_common_offset(self, offset):
        """Warm the whole site by 25 C: a difference test must decide identically.

        Temperature is an interval scale, so this is the correct invariance and a
        ratio test would fail it. It is also the operational point: the detector
        must not care whether it is January or August.
        """
        base = {k: [30.0] * 16 for k in "abcd"}
        base["hot"] = [45.0] * 16
        shifted = {k: [v + offset for v in vals] for k, vals in base.items()}
        s1, m1 = peer_excess(_frame(**base), "hot", list(base),
                             delta_min=8.0, min_consecutive=4, mad_floor=1.5)
        s2, m2 = peer_excess(_frame(**shifted), "hot", list(base),
                             delta_min=8.0, min_consecutive=4, mad_floor=1.5)
        assert s1.filter(m1).height == s2.filter(m2).height > 0


class TestSustained:
    def test_a_single_interval_never_trips(self):
        s = pl.DataFrame({"m": [False, True, False, True, False, True]}).select(
            sustained(pl.col("m"), 3)
        ).to_series()
        assert not any(s.fill_null(False).to_list())

    def test_a_run_restarts_after_one_good_interval(self):
        """Three good, one bad, three good must not count as six."""
        pattern = [True, True, True, False, True, True, True]
        s = pl.DataFrame({"m": pattern}).select(sustained(pl.col("m"), 4)).to_series()
        assert not any(s.fill_null(False).to_list()), (
            "an interrupted run accumulated across the interruption"
        )

    def test_min_consecutive_of_one_is_a_passthrough(self):
        pattern = [True, False, True]
        s = pl.DataFrame({"m": pattern}).select(sustained(pl.col("m"), 1)).to_series()
        assert s.to_list() == pattern


class TestBand:
    def test_ratio_min_excludes_deficits_too_deep_to_be_this_fault(self):
        """A bypass diode has a characteristic depth; an open string is deeper.

        Without the lower bound the diode rule also claims the open string, and
        two rules fire for one fault.
        """
        df = _frame(a=[1.0] * 8, b=[1.0] * 8, c=[1.0] * 8,
                    d=[1.0] * 8, diode=[0.97] * 8, dead=[0.02] * 8)
        cols = ["a", "b", "c", "d", "diode", "dead"]
        s_hit, hit = peer_deficit(df, "diode", cols, ratio_max=0.989,
                                  ratio_min=0.90, min_consecutive=2,
                                  mad_floor=0.002)
        s_miss, miss = peer_deficit(df, "dead", cols, ratio_max=0.989,
                                    ratio_min=0.90, min_consecutive=2,
                                    mad_floor=0.002)
        assert s_hit.filter(hit).height > 0, "the diode-depth deficit was not caught"
        assert s_miss.filter(miss).height == 0, "an open string was reported as a diode"


class TestFloorBandInteraction:
    """The MAD floor must sit below the band any rule using it wants to detect.

    A floor wider than the signature makes the z gate an unconditional veto: the
    fault becomes statistically indistinguishable by construction, silently. The
    bypass diode rule is the live case -- its band starts at 1.1% of string
    voltage while the current-oriented floor is 2%.
    """

    def test_the_z_gate_is_not_the_binding_constraint(self):
        """The band must state what the detector will actually raise.

        The z only reaches its flag at ``mad_floor * flag / 0.6745``. If the band's
        lower edge sits below that, the config advertises a sensitivity the gate
        silently refuses to honour -- which is how a 3% edge quietly behaved like a
        5.19% one. Keep the two in step.
        """
        from nuravolt.fault.config import FaultDetectionConfig
        from nuravolt.stats.robust import MODIFIED_Z_SCALE

        cfg = FaultDetectionConfig.for_eu_plant()
        mh = cfg.module_health
        effective = mh.bypass_diode_mad_floor_pu * cfg.string.peer_z_flag / MODIFIED_Z_SCALE
        assert mh.bypass_diode_deficit_pu_min >= effective, (
            f"band starts at {mh.bypass_diode_deficit_pu_min:.3f} but the z gate "
            f"does not trip until {effective:.3f}"
        )
        assert mh.bypass_diode_mad_floor_pu < mh.bypass_diode_deficit_pu_min

    def test_a_multi_diode_deficit_survives_the_z_gate(self):
        """What the rule DOES claim: a bypassed module, three diodes deep."""
        from nuravolt.fault.config import FaultDetectionConfig

        mh = FaultDetectionConfig.for_eu_plant().module_health
        df = _frame(a=[1.0] * 10, b=[1.0] * 10, c=[1.0] * 10,
                    d=[1.0] * 10, diode=[1.0 - 0.08] * 10)
        cols = ["a", "b", "c", "d", "diode"]
        scored, mask = peer_deficit(
            df, "diode", cols,
            ratio_max=1.0 - mh.bypass_diode_deficit_pu_min,
            ratio_min=1.0 - mh.bypass_diode_deficit_pu_max,
            min_consecutive=mh.bypass_diode_dwell_intervals,
            mad_floor=mh.bypass_diode_mad_floor_pu,
        )
        assert scored.filter(mask).height > 0, (
            "an 8% deficit -- a bypassed module -- was vetoed"
        )

    def test_a_single_diode_is_deliberately_NOT_claimed(self):
        """What the rule does NOT claim, and why, so nobody quietly re-adds it.

        A single diode removes about 1.1% of string voltage. Measured on delta,
        the dispersion between HEALTHY MPPT inputs on one inverter has a p90 MAD of
        1.03% per-unit. The signature is inside the noise, so no threshold
        separates them -- U_DC is reported per MPPT input and separate inputs are
        not clamped to a common voltage.

        If this test starts failing, either the band was widened back without new
        evidence, or someone has string-level voltage behind one MPPT and the claim
        can honestly be extended.
        """
        from nuravolt.fault.config import FaultDetectionConfig

        mh = FaultDetectionConfig.for_eu_plant().module_health
        assert mh.bypass_diode_deficit_pu_min >= 0.02, (
            "the band reaches into normal cross-MPPT dispersion; a single-diode "
            "claim is not supported by per-input voltage telemetry"
        )
