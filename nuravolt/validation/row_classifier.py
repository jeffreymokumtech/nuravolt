"""One cascade, parameterised — replacing three near-duplicate classifiers.

WHY THIS EXISTS
---------------
Three published macro-F1 numbers were being read as a single story:

    0.835  in-distribution, thresholds tuned on the dataset
    0.519  in-distribution, untuned physics defaults
    0.189  "a different plant architecture"

The first two are a fair comparison: identical rows, identical taxonomy, a pure
threshold swap. The third is not a comparison at all. It came from a *third*
implementation with disjoint input columns, a different label vocabulary and
thresholds themselves fitted to that dataset's percentiles. Three modules,
``pv_row_classifier``, ``pv_row_classifier_physics`` and ``gpvs_row_classifier``,
each carrying its own copy of the cascade and its own constants -- the 200 W/m2
daylight floor alone existed as four independent literals.

So an artifact recorded a *module name*, and a reader had to know which module
meant what. Here an artifact records a **parameter set**: the thresholds and the
scale references that produced it, by value. There is nothing left to confuse.

WHAT MAKES IT PORTABLE
----------------------
The old cascade carried three separable dependencies on how one particular rig
was built, and every one of them is now divided out:

===============================  =========================  ====================
dependency                       old form                   now
===============================  =========================  ====================
modules in series                240 / 245 / 260 volts      fraction of ``v_ref``
strings in parallel x Isc        EXPECTED_CURRENT_PER_W_M2  fraction of ``i_ref``
                                 = 0.009, this rig's Isc
inverter input count             exactly 2 channels         median over N
===============================  =========================  ====================

Lazzaretti runs 270-370 V and ~9 A per string. The GPVS bench runs ~99 V and
sub-amp. A threshold in volts cannot span that, and the committed artifacts are
the receipt: ``string_open_circuit`` and ``string_short_circuit`` score F1 0.995
and 0.983 in-distribution, and 0.000 and 0.000 on the other rig.

WHAT IS DELIBERATELY *NOT* NORMALISED
-------------------------------------
The 200 W/m2 daylight floor. Irradiance is an absolute physical quantity measured
the same way on every site, so it is not a property of this array the way a string
voltage is. Dividing it by something would be cargo-culting the pattern.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np
import polars as pl

CLASS_NAMES = ("normal", "open_circuit", "short_circuit", "partial_shading", "degradation")

#: Irradiance below which nothing is judged, in W/m2. Absolute on purpose: see
#: the module docstring.
DAYLIGHT_FLOOR_W_M2 = 200.0

#: The Lazzaretti rig's operating point, measured rather than assumed: the median
#: of ``v_mean`` over its 295,974 labelled-healthy daylight rows, and the median
#: of ``i_mean / (irradiance/1000)`` above 800 W/m2. The second recovers 8.985
#: A/kW, which is what the legacy literal ``EXPECTED_CURRENT_PER_W_M2 = 0.009``
#: always was: this rig's per-string current, hard-coded.
LAZZARETTI_V_REF_V = 270.38
LAZZARETTI_I_REF_A_PER_1000 = 9.0


@dataclass(frozen=True)
class ScaleRefs:
    """How big this rig is, so the thresholds do not have to know.

    ``v_ref`` is the voltage a healthy string sits at under good irradiance
    (Vmp x modules-in-series). ``i_ref_per_1000wm2`` is the current one string
    carries at 1000 W/m2 (Imp x strings-per-input).

    ``provenance`` is carried into the artifact because it changes what the
    result may be claimed to be:

    ``nameplate``
        Derived from declared module count and datasheet figures. Uses no target
        data at all, so a score computed with it is genuinely zero-shot.
    ``self_normalised``
        Estimated from the target record's own distribution. Uses target
        features, never target labels -- unsupervised adaptation, not fitting.
        On Lazzaretti this lands within 0.87% of the estimate from labelled
        healthy rows only, because a median tolerates 40% fault contamination.
    ``legacy_literal``
        Recovered from the constants that were hard-coded into the original
        classifier. Only for reproducing the published numbers.
    """

    v_ref: float
    i_ref_per_1000wm2: float
    provenance: str = "unspecified"

    def __post_init__(self) -> None:
        if not (self.v_ref > 0) or not (self.i_ref_per_1000wm2 > 0):
            raise ValueError(
                f"scale references must be positive, got v_ref={self.v_ref}, "
                f"i_ref={self.i_ref_per_1000wm2}. A zero reference would divide "
                f"every feature to infinity and the cascade would silently label "
                f"the whole record."
            )

    @classmethod
    def from_nameplate(
        cls,
        *,
        modules_in_series: int,
        module_vmp_v: float,
        strings_in_parallel: int = 1,
        module_imp_a: float,
    ) -> "ScaleRefs":
        """Zero-shot: from the commissioning drawing and a datasheet."""
        return cls(
            v_ref=modules_in_series * module_vmp_v,
            i_ref_per_1000wm2=strings_in_parallel * module_imp_a,
            provenance="nameplate",
        )

    @classmethod
    def from_data(
        cls,
        signals: pl.DataFrame,
        *,
        voltage_cols: Sequence[str],
        current_cols: Sequence[str],
        irradiance_col: str = "poa_irradiance",
        high_irradiance_w_m2: float = 800.0,
        quantile: float = 0.50,
    ) -> "ScaleRefs":
        """Unsupervised: from the target record's own distribution, no labels.

        The median rather than a high quantile, and the reason is the same one
        that makes median-and-MAD load-bearing everywhere else in this package:
        it has a 50% breakdown point, so a record that is 40% faulted still
        yields the healthy operating point. Measured on Lazzaretti, using every
        daylight row moves ``v_ref`` by +0.87% against using only the labelled
        healthy ones, and ``i_ref`` by -0.16%.
        """
        irr = signals[irradiance_col].to_numpy()
        day = irr >= DAYLIGHT_FLOOR_W_M2
        if not day.any():
            raise ValueError(
                f"no rows above {DAYLIGHT_FLOOR_W_M2} W/m2; cannot estimate a "
                f"scale reference from darkness"
            )
        v = np.stack([signals[c].to_numpy() for c in voltage_cols])
        i = np.stack([signals[c].to_numpy() for c in current_cols])
        # nan-aware throughout: real SCADA has gaps, and np.median propagates a
        # single NaN to the whole reference, which __post_init__ then refuses --
        # correctly, but with a message about the symptom rather than the cause.
        with np.errstate(invalid="ignore"):
            v_mean = np.nanmedian(np.maximum(v, 0.0), axis=0)
            i_mean = np.nanmedian(i, axis=0)

        hi = day & (irr >= high_irradiance_w_m2)
        if not hi.any():          # thin record: fall back to all daylight
            hi = day
        with np.errstate(invalid="ignore"):
            v_ref = float(np.nanmedian(v_mean[day]))
            i_ref = float(np.nanmedian(i_mean[hi] / (irr[hi] / 1000.0)))
        if not np.isfinite(v_ref) or not np.isfinite(i_ref):
            raise ValueError(
                f"scale reference is not finite (v_ref={v_ref}, i_ref={i_ref}). "
                f"Every candidate row was null or non-positive across all "
                f"{len(voltage_cols)} voltage and {len(current_cols)} current "
                f"channels, so this device's operating point cannot be estimated."
            )
        return cls(v_ref=v_ref, i_ref_per_1000wm2=i_ref, provenance="self_normalised")

    def to_dict(self) -> dict:
        return {
            "v_ref_v": round(self.v_ref, 4),
            "i_ref_a_per_1000wm2": round(self.i_ref_per_1000wm2, 4),
            "provenance": self.provenance,
        }


#: The scale the original classifier had baked into it as literals.
LAZZARETTI_REFS = ScaleRefs(
    v_ref=LAZZARETTI_V_REF_V,
    i_ref_per_1000wm2=LAZZARETTI_I_REF_A_PER_1000,
    provenance="legacy_literal",
)


@dataclass(frozen=True)
class CascadeThresholds:
    """Every discriminator, dimensionless.

    Voltages are fractions of ``ScaleRefs.v_ref`` and currents fractions of
    ``ScaleRefs.i_ref_per_1000wm2``, so nothing here is a property of one array.
    """

    name: str

    # open circuit
    open_current_ratio_max: float
    open_v_imbalance_min: float

    # short circuit
    short_v_imbalance_min: float
    short_v_mean_max_pu: float
    short_current_ratio_min: float

    # partial shading
    shading_v_mean_min_pu: float
    shading_current_ratio_max: float

    # degradation
    degradation_iv_imbalance_sum_min: float
    degradation_v_mean_max_pu: float
    degradation_current_ratio_min: float

    #: Set for the physics variant, which discriminates on min/max voltage ratio
    #: and absolute-current floors rather than on irradiance-expected current.
    variant: str = "imbalance"
    open_v_ratio_max: float = 0.0
    open_i_floor_pu: float = 0.0
    short_v_ratio_max: float = 0.0
    short_i_floor_pu: float = 0.0
    shading_i_ratio_max: float = 0.0
    degradation_i_cv_min: float = 0.0
    degradation_i_floor_pu: float = 0.0

    def to_dict(self) -> dict:
        d = {k: v for k, v in self.__dict__.items()}
        return d


#: Reproduces ``pv_row_classifier.py``. Each voltage fraction is the original
#: literal divided by the rig's measured operating voltage, so the number that
#: used to be "245 volts" now reads "91% of nominal operating voltage" -- the
#: same statement, minus the dependency on how many modules are in series.
TUNED_LAZZARETTI = CascadeThresholds(
    name="tuned_lazzaretti",
    variant="imbalance",
    open_current_ratio_max=0.60,
    open_v_imbalance_min=1.0,
    short_v_imbalance_min=0.15,
    short_v_mean_max_pu=245.0 / LAZZARETTI_V_REF_V,      # 0.9061
    short_current_ratio_min=0.90,
    shading_v_mean_min_pu=240.0 / LAZZARETTI_V_REF_V,    # 0.8876
    shading_current_ratio_max=0.90,
    degradation_iv_imbalance_sum_min=0.10,
    degradation_v_mean_max_pu=260.0 / LAZZARETTI_V_REF_V,  # 0.9616
    degradation_current_ratio_min=0.95,
)

#: Reproduces ``pv_row_classifier_physics.py``. Its thresholds come from
#: ``nuravolt/fault/config.py`` and were never tuned on any dataset -- but three
#: were in absolute amps (0.5 / 1.0 / 0.1 A), which is the same portability
#: defect in a different unit, and config.py has since migrated production off
#: them for exactly that reason. They are expressed against ``i_ref`` here.
PHYSICS_DEFAULTS = CascadeThresholds(
    name="physics_defaults",
    variant="minmax",
    open_current_ratio_max=0.0,
    open_v_imbalance_min=0.0,
    short_v_imbalance_min=0.0,
    short_v_mean_max_pu=0.0,
    short_current_ratio_min=0.0,
    shading_v_mean_min_pu=0.0,
    shading_current_ratio_max=0.0,
    degradation_iv_imbalance_sum_min=0.0,
    degradation_v_mean_max_pu=0.0,
    degradation_current_ratio_min=0.0,
    open_v_ratio_max=0.2,
    open_i_floor_pu=0.5 / LAZZARETTI_I_REF_A_PER_1000,     # was 0.5 A
    short_v_ratio_max=0.7,
    short_i_floor_pu=1.0 / LAZZARETTI_I_REF_A_PER_1000,    # was 1.0 A
    shading_i_ratio_max=0.85,
    degradation_i_cv_min=0.15,
    degradation_i_floor_pu=0.1 / LAZZARETTI_I_REF_A_PER_1000,  # was 0.1 A
)


def _channels(signals: pl.DataFrame, prefix: str) -> list:
    """Every ``{prefix}_N`` column present, in numeric order."""
    found = []
    for c in signals.columns:
        if c.startswith(prefix + "_"):
            tail = c[len(prefix) + 1:]
            if tail.isdigit():
                found.append((int(tail), c))
    return [c for _, c in sorted(found)]


def classify(
    signals: pl.DataFrame,
    thresholds: CascadeThresholds = TUNED_LAZZARETTI,
    refs: ScaleRefs = LAZZARETTI_REFS,
    *,
    irradiance_col: str = "poa_irradiance",
) -> pl.Series:
    """Run the cascade. Returns a ``predicted_class`` series.

    Generalised from exactly two strings to N: every two-channel statistic is
    replaced by the form that reduces to it at N=2. ``mean`` becomes ``median``
    (identical for two values, robust beyond), and ``|a-b|`` becomes
    ``max-min``. So a 12-input utility inverter and a 2-string test rig run the
    same code, and on Lazzaretti the answer is unchanged.
    """
    v_cols = _channels(signals, "string_voltage")
    i_cols = _channels(signals, "string_current")
    if len(v_cols) < 2 or len(i_cols) < 2:
        raise ValueError(
            f"need at least 2 string_voltage_N and 2 string_current_N columns; "
            f"found {len(v_cols)} and {len(i_cols)}. Present: {sorted(signals.columns)}"
        )
    if irradiance_col not in signals.columns:
        raise ValueError(f"missing irradiance column {irradiance_col!r}")

    irr = signals[irradiance_col].to_numpy()
    v = np.stack([signals[c].to_numpy() for c in v_cols])
    i = np.stack([signals[c].to_numpy() for c in i_cols])

    n = len(signals)
    preds = np.full(n, "normal", dtype=object)
    daylight = irr >= DAYLIGHT_FLOOR_W_M2

    # Per-unit. Everything below this line is dimensionless.
    # nan-aware: a device with one dead channel must still be judged on the
    # channels that are reporting, not dropped silently.
    v_clamped = np.maximum(v, 0.0)
    with np.errstate(invalid="ignore"):
        v_mean_pu = np.nanmedian(v_clamped, axis=0) / refs.v_ref
        i_mean_pu = np.nanmedian(i, axis=0) / refs.i_ref_per_1000wm2

        # Spread uses raw (unclamped) voltage in the numerator and the clamped
        # median in the denominator, reproducing the original exactly.
        v_span = (np.nanmax(v, axis=0) - np.nanmin(v, axis=0)) / refs.v_ref
        i_span = (np.nanmax(i, axis=0) - np.nanmin(i, axis=0)) / refs.i_ref_per_1000wm2

    expected_i_pu = (irr / 1000.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        current_ratio = np.where(expected_i_pu > 0, i_mean_pu / expected_i_pu, 1.0)
        i_imbalance = np.where(i_mean_pu > 1e-6 / refs.i_ref_per_1000wm2,
                               i_span / i_mean_pu, 0.0)
        v_imbalance = np.where(v_mean_pu > 1e-6 / refs.v_ref,
                               v_span / v_mean_pu, 0.0)

    t = thresholds
    if t.variant == "imbalance":
        oc = daylight & (current_ratio < t.open_current_ratio_max) & (
            v_imbalance > t.open_v_imbalance_min)
        preds[oc] = "open_circuit"

        sc = daylight & ~oc & (
            (v_imbalance > t.short_v_imbalance_min)
            & (v_mean_pu < t.short_v_mean_max_pu)
            & (current_ratio > t.short_current_ratio_min))
        preds[sc] = "short_circuit"

        ps = daylight & ~oc & ~sc & (
            (v_mean_pu > t.shading_v_mean_min_pu)
            & (current_ratio < t.shading_current_ratio_max))
        preds[ps] = "partial_shading"

        deg = daylight & ~oc & ~sc & ~ps & (
            ((i_imbalance + v_imbalance) > t.degradation_iv_imbalance_sum_min)
            & (v_mean_pu < t.degradation_v_mean_max_pu)
            & (current_ratio > t.degradation_current_ratio_min))
        preds[deg] = "degradation"
    else:
        v_abs, i_abs = np.abs(v), np.abs(i)
        with np.errstate(invalid="ignore"):
            v_hi, v_lo = np.nanmax(v_abs, axis=0), np.nanmin(v_abs, axis=0)
            i_hi, i_lo = np.nanmax(i_abs, axis=0), np.nanmin(i_abs, axis=0)
        v_ratio = np.where(v_hi > 0, v_lo / v_hi, 1.0)
        i_ratio = np.where(i_hi > 0, i_lo / i_hi, 1.0)
        i_lo_pu, i_hi_pu = i_lo / refs.i_ref_per_1000wm2, i_hi / refs.i_ref_per_1000wm2

        oc = daylight & (v_ratio < t.open_v_ratio_max) & (i_lo_pu < t.open_i_floor_pu)
        preds[oc] = "open_circuit"

        sc = daylight & ~oc & (v_ratio < t.short_v_ratio_max) & (
            i_hi_pu > t.short_i_floor_pu)
        preds[sc] = "short_circuit"

        ps = daylight & ~oc & ~sc & (i_ratio < t.shading_i_ratio_max)
        preds[ps] = "partial_shading"

        with np.errstate(divide="ignore", invalid="ignore"):
            i_cv = np.where(i_mean_pu > t.degradation_i_floor_pu,
                            i_span / i_mean_pu / 2, 0.0)
        deg = daylight & ~oc & ~sc & ~ps & (i_cv > t.degradation_i_cv_min)
        preds[deg] = "degradation"

    return pl.Series("predicted_class", preds, dtype=pl.Utf8)


def parameter_record(thresholds: CascadeThresholds, refs: ScaleRefs) -> dict:
    """What an artifact should carry instead of a module name."""
    return {
        "cascade": "nuravolt/validation/row_classifier.py::classify",
        "thresholds": thresholds.to_dict(),
        "scale_refs": refs.to_dict(),
        "daylight_floor_w_m2": DAYLIGHT_FLOOR_W_M2,
        "note": (
            "Every threshold here is dimensionless; the rig's size enters only "
            "through scale_refs. Two artifacts differing only in scale_refs are "
            "the same detector on two different plants."
        ),
    }
