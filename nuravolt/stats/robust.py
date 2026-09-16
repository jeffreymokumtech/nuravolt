"""Robust dispersion and outlier scoring, shared across asset classes.

These were written for battery racks in ``nuravolt/bess/imbalance.py`` and are
promoted here unchanged because the PV fault path needs exactly the same thing:
score a device against its siblings without letting the failing device set the
scale it is judged against.

WHY MEDIAN AND MAD, NOT MEAN AND STANDARD DEVIATION
---------------------------------------------------
Outlier scoring uses the modified z score

    mz = 0.6745 * (x - median(x)) / MAD(x)

(Iglewicz and Hoaglin, "How to Detect and Handle Outliers", ASTM 1993; also
NIST/SEMATECH e-Handbook of Statistical Methods, section 1.3.5.17), flagged at
|mz| > 3.5.

This is load bearing, not a style preference. A mean/standard deviation test
computes its dispersion estimate *from a population that contains the outlier*,
so one badly failing member inflates the standard deviation enough to hide
itself: the worse it gets, the wider the band it is measured against. The median
and the MAD have a 50 percent breakdown point, so they are unmoved by exactly
the case this module exists to catch. ``tests/bess/test_imbalance.py`` pins that
behaviour with a fixture where a mean/std test misses a rack that MAD catches.

WHY THIS MATTERS FOR CROSS-PLANT TRANSFER
-----------------------------------------
A modified z score against same-timestamp siblings carries **no portable
constant**. Irradiance, temperature, plant size, module orientation and vendor
all cancel, because every sibling sees the same conditions at the same instant.
The only parameters are the flag level and the dwell window, and 3.5 comes from
published statistical practice rather than from fitting our own data. That is
what makes a detector built on this primitive a tier A detector: there is no
threshold to get wrong on the next plant.

NEVER RETURN ZERO FOR "NOT MEASURABLE"
--------------------------------------
Every function here returns nan, not 0.0, when a population is too small to
score. A computed looking zero reads as "perfectly balanced" and is the most
dangerous number these functions could produce.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

#: Iglewicz and Hoaglin scale factor: 0.6745 is the 0.75 quantile of the
#: standard normal, which makes MAD a consistent estimator of sigma for
#: normally distributed data.
MODIFIED_Z_SCALE = 0.6745

#: Iglewicz and Hoaglin's documented fallback when MAD is exactly zero (more
#: than half the population sharing one value). Uses the mean absolute
#: deviation instead, scaled by sqrt(pi/2) = 1.253314.
MEAN_AD_SCALE = 1.253314

#: Conventional flag level for the modified z score.
MODIFIED_Z_FLAG = 3.5


def median_absolute_deviation(values: Sequence[float]) -> float:
    """MAD of the finite values, or nan when fewer than two are finite."""
    arr = np.asarray(values, dtype=float)
    arr = arr[np.isfinite(arr)]
    if arr.size < 2:
        return float("nan")
    return float(np.median(np.abs(arr - np.median(arr))))


def modified_z_scores(values: Sequence[float]) -> np.ndarray:
    """
    Modified z scores on the median and the MAD.

    Returns nan for non finite inputs and for populations too small to score
    (fewer than two finite values), so a caller can never mistake "not
    measurable" for "zero deviation".
    """
    arr = np.asarray(values, dtype=float)
    out = np.full(arr.shape, np.nan, dtype=float)
    if arr.size == 0:
        return out

    finite = np.isfinite(arr)
    if finite.sum() < 2:
        return out

    sample = arr[finite]
    med = float(np.median(sample))
    mad = float(np.median(np.abs(sample - med)))

    if mad > 0:
        out[finite] = MODIFIED_Z_SCALE * (sample - med) / mad
        return out

    # MAD is zero when more than half the population shares one value. Iglewicz
    # and Hoaglin's documented fallback swaps in the mean absolute deviation.
    mean_ad = float(np.mean(np.abs(sample - med)))
    if mean_ad > 0:
        out[finite] = (sample - med) / (MEAN_AD_SCALE * mean_ad)
        return out

    # Every finite value is identical: genuinely zero deviation.
    out[finite] = 0.0
    return out


def classic_z_scores(values: Sequence[float]) -> np.ndarray:
    """
    Mean/standard deviation z scores. Present only so the test suite can
    demonstrate what this module deliberately does not use, and why.
    """
    arr = np.asarray(values, dtype=float)
    out = np.full(arr.shape, np.nan, dtype=float)
    finite = np.isfinite(arr)
    if finite.sum() < 2:
        return out
    sample = arr[finite]
    sd = float(np.std(sample, ddof=1))
    if sd == 0:
        out[finite] = 0.0
        return out
    out[finite] = (sample - float(np.mean(sample))) / sd
    return out
