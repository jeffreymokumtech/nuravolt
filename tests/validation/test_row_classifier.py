"""The parameterised cascade: it must not move a published number, and it must
not care how big the rig is.

Two guarantees are pinned here.

**Reproduction.** Three near-duplicate classifiers were collapsed into one
parameterised implementation. A refactor that quietly changes a published
accuracy figure is worse than no refactor, so the new code must agree with the
old row for row on the exact split the artifacts were computed from.

**Scale invariance.** The point of the exercise. Every threshold that used to be
in volts or amps is now a fraction of a declared reference, so a rig with a
different number of modules in series or strings in parallel must score
identically. The un-normalised path is asserted to FAIL the same test, because a
test that both paths pass is not testing anything.
"""

from pathlib import Path

import numpy as np
import polars as pl
import pytest

from nuravolt.validation.metrics.classification import compute_report
from nuravolt.validation.row_classifier import (
    CLASS_NAMES,
    LAZZARETTI_REFS,
    PHYSICS_DEFAULTS,
    TUNED_LAZZARETTI,
    ScaleRefs,
    classify,
)

LAZZARETTI = Path("backenddata/datasets/lazzaretti/lazzaretti_faults.parquet")
needs_data = pytest.mark.skipif(
    not LAZZARETTI.exists(), reason="Lazzaretti parquet not present"
)


def _synthetic(n: int = 600, seed: int = 0) -> pl.DataFrame:
    """A small rig with every class represented, at Lazzaretti's scale."""
    rng = np.random.default_rng(seed)
    irr = rng.uniform(250, 1000, n)
    v1 = 270.0 * rng.uniform(0.95, 1.05, n)
    v2 = v1 * rng.uniform(0.98, 1.02, n)
    i1 = 9.0 * (irr / 1000.0) * rng.uniform(0.97, 1.03, n)
    i2 = i1 * rng.uniform(0.98, 1.02, n)
    # inject: a quarter open, a quarter shaded, a quarter voltage-depressed
    q = n // 4
    v2[:q] = 0.5                      # one string collapsed -> open circuit
    i2[:q] = 0.01
    i1[q:2 * q] *= 0.6                # both strings down -> shading
    i2[q:2 * q] *= 0.6
    v1[2 * q:3 * q] *= 0.80           # depressed voltage -> short / degradation
    v2[2 * q:3 * q] *= 0.60
    return pl.DataFrame({
        "poa_irradiance": irr, "module_temp": np.full(n, 25.0),
        "string_voltage_1": v1, "string_voltage_2": v2,
        "string_current_1": i1, "string_current_2": i2,
    })


def _healthy(n: int = 2000, seed: int = 0) -> pl.DataFrame:
    """A fault-free rig, so a contamination experiment is actually controlled."""
    rng = np.random.default_rng(seed)
    irr = rng.uniform(250, 1000, n)
    v1 = 270.0 * rng.uniform(0.98, 1.02, n)
    v2 = v1 * rng.uniform(0.99, 1.01, n)
    i1 = 9.0 * (irr / 1000.0) * rng.uniform(0.98, 1.02, n)
    i2 = i1 * rng.uniform(0.99, 1.01, n)
    return pl.DataFrame({
        "poa_irradiance": irr, "module_temp": np.full(n, 25.0),
        "string_voltage_1": v1, "string_voltage_2": v2,
        "string_current_1": i1, "string_current_2": i2,
    })


class TestReproduction:
    """The refactor may not move a published number."""

    @needs_data
    @pytest.mark.parametrize("legacy_module,thresholds,published", [
        ("pv_row_classifier", TUNED_LAZZARETTI, 0.8348),
        ("pv_row_classifier_physics", PHYSICS_DEFAULTS, 0.5188),
    ])
    def test_matches_the_legacy_classifier_row_for_row(
        self, legacy_module, thresholds, published
    ):
        import importlib

        from nuravolt.validation.adapters.lazzaretti import load_lazzaretti

        legacy = importlib.import_module(f"nuravolt.validation.{legacy_module}")
        split = load_lazzaretti(split="test", test_fraction=0.20, daylight_only=True)

        old = legacy.classify_dataframe(split.signals).to_numpy()
        new = classify(split.signals, thresholds, LAZZARETTI_REFS).to_numpy()

        differing = int((old != new).sum())
        assert differing == 0, (
            f"{legacy_module}: {differing} of {len(old)} rows changed prediction. "
            f"The refactor must be behaviour preserving on the split the published "
            f"artifact was computed from."
        )

        rep = compute_report(
            split.label_names.to_list(), new.tolist(), list(CLASS_NAMES), "repro"
        )
        assert rep.macro_f1 == pytest.approx(published, abs=1e-4), (
            f"macro-F1 {rep.macro_f1:.4f} != published {published}"
        )


class TestScaleInvariance:
    """A rig of a different size must score the same."""

    GEOMETRIES = [(0.5, 1.0), (0.75, 1.0), (1.5, 1.0), (2.0, 1.0),
                  (1.0, 0.5), (1.0, 2.0), (0.75, 2.0)]

    @staticmethod
    def _rescale(df, k_v, k_i):
        v = [c for c in df.columns if c.startswith("string_voltage_")]
        i = [c for c in df.columns if c.startswith("string_current_")]
        return df.with_columns([pl.col(c) * k_v for c in v] + [pl.col(c) * k_i for c in i])

    @pytest.mark.parametrize("k_v,k_i", GEOMETRIES)
    def test_estimated_references_make_the_cascade_invariant(self, k_v, k_i):
        df = _synthetic()
        v = [c for c in df.columns if c.startswith("string_voltage_")]
        i = [c for c in df.columns if c.startswith("string_current_")]

        def predict(frame):
            refs = ScaleRefs.from_data(frame, voltage_cols=v, current_cols=i)
            return classify(frame, TUNED_LAZZARETTI, refs).to_list()

        assert predict(self._rescale(df, k_v, k_i)) == predict(df), (
            f"scaling voltage by {k_v} and current by {k_i} changed the verdict; "
            f"a threshold in volts or amps is still hiding in the cascade"
        )

    def test_fixed_references_do_NOT_survive_the_same_test(self):
        """The control. If this ever passes, the invariance test above is vacuous.

        Fixed references are what shipped: thresholds pinned to one rig's volts
        and amps. They must break under a change of geometry, or normalisation is
        not what is doing the work above.
        """
        df = _synthetic()
        base = classify(df, TUNED_LAZZARETTI, LAZZARETTI_REFS).to_list()
        broke = [
            (k_v, k_i) for k_v, k_i in self.GEOMETRIES
            if classify(self._rescale(df, k_v, k_i), TUNED_LAZZARETTI,
                        LAZZARETTI_REFS).to_list() != base
        ]
        assert broke, (
            "fixed-reference thresholds survived every geometry change, which "
            "means this fixture cannot detect the defect the normalisation fixes"
        )


class TestChannelGeneralisation:
    """Two strings or twelve, the same code path."""

    def test_duplicating_channels_does_not_change_the_verdict(self):
        """N=4 built by duplicating each of 2 channels must equal N=2.

        median-over-N reduces to mean-over-2, and max-minus-min reduces to the
        absolute difference, so this is the identity that makes the
        generalisation safe on the dataset the published numbers came from.
        """
        df = _synthetic()
        wide = df.with_columns([
            pl.col("string_voltage_1").alias("string_voltage_3"),
            pl.col("string_voltage_2").alias("string_voltage_4"),
            pl.col("string_current_1").alias("string_current_3"),
            pl.col("string_current_2").alias("string_current_4"),
        ])
        assert (classify(wide, TUNED_LAZZARETTI, LAZZARETTI_REFS).to_list()
                == classify(df, TUNED_LAZZARETTI, LAZZARETTI_REFS).to_list())

    def test_one_channel_is_refused(self):
        df = _synthetic().drop(["string_voltage_2", "string_current_2"])
        with pytest.raises(ValueError, match="at least 2"):
            classify(df, TUNED_LAZZARETTI, LAZZARETTI_REFS)


class TestScaleRefs:
    def test_a_zero_reference_is_refused(self):
        """Dividing by it would label the entire record, silently."""
        with pytest.raises(ValueError, match="must be positive"):
            ScaleRefs(v_ref=0.0, i_ref_per_1000wm2=9.0)
        with pytest.raises(ValueError, match="must be positive"):
            ScaleRefs(v_ref=270.0, i_ref_per_1000wm2=-1.0)

    @pytest.mark.parametrize("contaminated_fraction,tolerated", [
        (0.10, True), (0.30, True), (0.49, True), (0.55, False), (0.60, False),
    ])
    def test_estimate_holds_until_faults_are_the_majority(
        self, contaminated_fraction, tolerated
    ):
        """The median is why labels are not needed to calibrate the scale.

        A share of a fault-free record is driven to a third of nominal voltage.
        A mean-based estimator would follow it down at any contamination; the
        median does not move until faults are the MAJORITY. Measured on this
        fixture the reference holds within 2.0% up to 49% contamination and then
        collapses by 66% at 55% -- the 50% breakdown point, which is a property
        of the estimator and not a defect.

        The failing cases are asserted to fail, so the test cannot quietly
        become vacuous if the estimator is ever swapped for a mean.

        Lazzaretti sits near 40% faulted daylight rows, and there the estimate
        lands within 0.87% of one computed from labelled healthy rows only.
        """
        df = _healthy()
        v = [c for c in df.columns if c.startswith("string_voltage_")]
        i = [c for c in df.columns if c.startswith("string_current_")]
        clean = ScaleRefs.from_data(df, voltage_cols=v, current_cols=i)

        cut = int(len(df) * contaminated_fraction)
        sick = df.with_columns([
            pl.when(pl.arange(0, len(df)) < cut)
            .then(pl.col(c) / 3).otherwise(pl.col(c)).alias(c)
            for c in v
        ])
        got = ScaleRefs.from_data(sick, voltage_cols=v, current_cols=i)
        moved = abs(got.v_ref / clean.v_ref - 1.0)

        assert (moved <= 0.05) is tolerated, (
            f"at {contaminated_fraction:.0%} contamination the estimate moved "
            f"{100 * (got.v_ref / clean.v_ref - 1):+.2f}%; expected "
            f"{'it to hold' if tolerated else 'breakdown'}"
        )

    def test_nameplate_construction_is_zero_shot(self):
        refs = ScaleRefs.from_nameplate(
            modules_in_series=8, module_vmp_v=33.8,
            strings_in_parallel=1, module_imp_a=9.0,
        )
        assert refs.provenance == "nameplate"
        assert refs.v_ref == pytest.approx(270.4, abs=0.5)


class TestPendingMarkerNeverOverwritesAResult:
    """A validator that loses its input must not destroy the last measurement.

    This is a regression test for real data loss. Making the GPVS validator
    resilient to its missing download wrote a ``pending_manual_fetch`` marker
    unconditionally, which replaced the only surviving record of that run --
    macro-F1, per-class figures and the confusion matrix. The dataset is a manual
    download that is no longer on disk, so the run could not be repeated; the
    confusion matrix was never recovered.
    """

    def test_result_exists_distinguishes_a_result_from_a_marker(self, tmp_path):
        import json

        from nuravolt.validation.report import result_exists

        algo = tmp_path / "pv"
        algo.mkdir()
        (algo / "real.json").write_text(json.dumps({"macro_f1": 0.42}))
        (algo / "marker.json").write_text(json.dumps({"status": "pending_manual_fetch"}))

        assert result_exists("pv", "real", root=tmp_path) is True
        assert result_exists("pv", "marker", root=tmp_path) is False
        assert result_exists("pv", "absent", root=tmp_path) is False

    def test_unreadable_artifact_is_not_mistaken_for_a_result(self, tmp_path):
        """Corrupt JSON must not block a validator from recording its state."""
        from nuravolt.validation.report import result_exists

        algo = tmp_path / "pv"
        algo.mkdir()
        (algo / "broken.json").write_text("{not json")
        assert result_exists("pv", "broken", root=tmp_path) is False
