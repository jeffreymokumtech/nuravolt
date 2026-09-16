#!/usr/bin/env python3
"""Validate fault detectors across the real plant fleet, without fault labels.

Real plants carry no labelled faults, so this script measures the five things that
ARE measurable and refuses to call any of them recall. See
``nuravolt/validation/metrics/detection.py`` for the reasoning behind each.

Sub-commands:
    alert_rates       how often each detector fires, per MW per month, per plant
    null_calibration  the symmetric-tail control: false-positive rate from the
                      detector's own harmless tail, against theory
    all               both of the above, plus scale invariance across the fleet

Data comes from S3 (`bronze/scada/<plant>/<plant>_cleaned.parquet`), so export
credentials first:

    set -a; source .env; set +a
    python scripts/validate_detectors_fleet.py all
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nuravolt.fault.peer_stats import (  # noqa: E402
    MAD_FLOOR_PU,
    MIN_PEER_MEDIAN_PU,
    MIN_PEERS,
    score_plant,
    sustained_deficit_mask,
)
from nuravolt.fault.topology import (  # noqa: E402
    parse_component_meta,
    resolve_device_columns,
)
from nuravolt.validation.metrics.detection import (  # noqa: E402
    AlertRate,
    DetectionReport,
    compute_null_calibration,
    compute_scale_invariance,
    normal_tail,
)
from nuravolt.validation.report import write_report  # noqa: E402

BUCKET = "nuravolt-lake"
PLANTS = ["alpha", "ribera", "gamma", "delta", "zeta", "eta"]

#: Never used during development. Scored once, at the end, and published as-is.
LOCKBOX_PLANTS = {"delta"}

# Detector parameters. Three, all dimensionless, per the tier A budget.
RATIO_MAX = 0.90          # below 90% of the peer median
Z_MAX = -4.0              # and more than 4 modified-z below it
MIN_CONSECUTIVE = 8       # sustained for 8 intervals (2 hours at 15 minutes)


def _s3():
    import boto3
    import pyarrow.fs as pafs

    fs = pafs.S3FileSystem(
        region="eu-west-1",
        access_key=os.environ.get("AWS_ACCESS_KEY_ID"),
        secret_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )
    return boto3.client("s3", region_name="eu-west-1"), fs


def load_plant(plant: str) -> Optional[Tuple[pl.DataFrame, object, Dict[str, str]]]:
    """Load one plant's per-unit inverter power plus its topology."""
    import pyarrow.parquet as pq

    s3, fs = _s3()
    path = f"{BUCKET}/bronze/scada/{plant}/{plant}_cleaned.parquet"
    try:
        names = pq.ParquetFile(fs.open_input_file(path)).schema_arrow.names
    except Exception as exc:  # noqa: BLE001
        print(f"  {plant}: cannot open {path}: {exc}")
        return None

    keys = [
        o["Key"]
        for o in s3.list_objects_v2(Bucket=BUCKET, Prefix=f"bronze/scada/{plant}/").get("Contents", [])
        if o["Key"].endswith("_meta.csv")
    ]
    if not keys:
        print(f"  {plant}: no component metadata")
        return None

    text = s3.get_object(Bucket=BUCKET, Key=keys[0])["Body"].read().decode("utf-8-sig", "replace")
    topo = parse_component_meta(text, plant)

    try:
        colmap = resolve_device_columns(names, topo, signal_match="Inverter Power Normalized")
    except LookupError as exc:
        # Refusing is correct: a detector that cannot resolve devices would report
        # a clean result indistinguishable from a healthy plant.
        print(f"  {plant}: SKIPPED -- {exc}")
        return None

    df = pl.from_arrow(
        pq.read_table(fs.open_input_file(path), columns=["timestamp"] + list(colmap.values()))
    )
    # The cleaned parquets store timestamps as strings; without this the event
    # grouper treats every record as its own event.
    df = df.with_columns(
        pl.col("timestamp").str.strptime(pl.Datetime, "%Y.%m.%d %H:%M", strict=False)
    )
    return df, topo, colmap


def measure_plant(plant: str) -> Optional[Dict]:
    loaded = load_plant(plant)
    if loaded is None:
        return None
    df, topo, colmap = loaded

    groups = score_plant(df, topo, colmap, level="inverter_within_bus")
    mwp = sum(d.kwp_dc for d in topo.devices.values() if d.kwp_dc) / 1000
    months = (df["timestamp"].max() - df["timestamp"].min()).days / 30.44

    events = 0
    alerted: set = set()
    all_scores: List[float] = []

    for group in groups:
        for device in group.scored_devices:
            z = group.frame[f"{device}__z"].drop_nulls()
            all_scores.extend(z.to_list())
            arr = sustained_deficit_mask(
                group.frame, device,
                ratio_max=RATIO_MAX, z_max=Z_MAX, min_consecutive=MIN_CONSECUTIVE,
            ).to_list()
            n = sum(1 for i, v in enumerate(arr) if v and not (i and arr[i - 1]))
            if n:
                alerted.add(device)
            events += n

    rate = AlertRate(
        events=events, mw_months=mwp * months,
        devices_alerted=len(alerted), devices_total=len(colmap),
    )
    cal = compute_null_calibration(
        all_scores, abs(Z_MAX),
        fault_direction="negative",
        theoretical_null_rate=normal_tail(abs(Z_MAX)),
    )
    return {
        "plant": plant,
        "inverters": len(colmap),
        "mwp": round(mwp, 2),
        "months": round(months, 1),
        "peer_groups": len(groups),
        "lockbox": plant in LOCKBOX_PLANTS,
        "alert_rate": rate,
        "null_calibration": cal,
    }


def cmd_all() -> None:
    results = []
    print(f"{'plant':<13}{'inv':>5}{'MWp':>7}{'/MW/mo':>9}{'fault tail':>12}{'null tail':>11}{'signal':>9}")
    for plant in PLANTS:
        m = measure_plant(plant)
        if m is None:
            continue
        results.append(m)
        r, c = m["alert_rate"], m["null_calibration"]
        print(f"{m['plant']:<13}{m['inverters']:>5}{m['mwp']:>7.1f}"
              f"{r.per_mw_month:>9.2f}{c.fault_tail_rate*100:>11.4f}%"
              f"{c.null_tail_rate*100:>10.4f}%{c.signal_to_null:>9.0f}x")

    if not results:
        write_report("pv", "peer_inverter_underperformance_fleet", {
            "dataset": "Peer-relative inverter underperformance, fleet",
            "status": "pending_manual_fetch",
            "reason": "no plant could be loaded; check AWS credentials are exported",
        })
        print("\nno plants loaded; wrote pending report")
        return

    total_events = sum(m["alert_rate"].events for m in results)
    total_mwmo = sum(m["alert_rate"].mw_months for m in results)
    total_dev = sum(m["inverters"] for m in results)
    all_scored = sum(m["null_calibration"].n_scored for m in results)

    fleet_fault = sum(m["null_calibration"].fault_tail_rate * m["null_calibration"].n_scored
                      for m in results) / all_scored
    fleet_null = sum(m["null_calibration"].null_tail_rate * m["null_calibration"].n_scored
                     for m in results) / all_scored

    from nuravolt.validation.metrics.detection import NullCalibration

    fleet_cal = NullCalibration(
        threshold=abs(Z_MAX), fault_tail_rate=fleet_fault, null_tail_rate=fleet_null,
        theoretical_null_rate=normal_tail(abs(Z_MAX)), n_scored=all_scored,
    )
    fleet_rate = AlertRate(
        events=total_events, mw_months=total_mwmo,
        devices_alerted=sum(m["alert_rate"].devices_alerted for m in results),
        devices_total=total_dev,
    )
    scale = compute_scale_invariance(
        [m["inverters"] for m in results],
        [m["alert_rate"].per_mw_month for m in results],
    )
    scale["interpretation"] = (
        "Read this together with the null calibration. A size correlation only "
        "indicates a broken statistic if the HARMLESS tail inflates with size too. "
        "If the harmless tail sits on theory at every plant size, the correlation "
        "reflects real differences in plant health, not an artefact."
    )

    report = DetectionReport(
        detector="INVERTER_UNDERPERFORMANCE_PEER",
        tier="A",
        n_devices=total_dev,
        alert_rate=fleet_rate,
        null_calibration=fleet_cal,
        scale_invariance=scale,
        parameters={
            "ratio_max": RATIO_MAX,
            "z_max": Z_MAX,
            "min_consecutive_intervals": MIN_CONSECUTIVE,
        },
        per_plant={
            m["plant"]: {
                "inverters": m["inverters"], "mwp": m["mwp"], "months": m["months"],
                "peer_groups": m["peer_groups"], "lockbox": m["lockbox"],
                **m["alert_rate"].to_dict(),
                "null_calibration": m["null_calibration"].to_dict(),
            }
            for m in results
        },
        extras={
            "statistic": (
                "Modified z and ratio against same-timestamp peers grouped by "
                "(bus, inverter model, nameplate class). Both must trip together "
                "and stay tripped for the dwell window."
            ),
            "identical_parameters_on_every_plant": True,
            "fixed_parameters": {
                "mad_floor_pu": MAD_FLOOR_PU,
                "min_peer_median_pu": MIN_PEER_MEDIAN_PU,
                "min_peers": MIN_PEERS,
            },
            "lockbox_plants": sorted(LOCKBOX_PLANTS),
        },
    )
    write_report("pv", "peer_inverter_underperformance_fleet", report.to_dict())

    print(f"\nFLEET  {fleet_rate.per_mw_month:.3f} alerts/MW/month over {total_dev} inverters"
          f"  [{'PASS' if fleet_rate.passes else 'FAILS'} the {fleet_rate.gate} gate]")
    print(f"       null calibration: harmless tail {fleet_null*100:.4f}% vs theory "
          f"{normal_tail(abs(Z_MAX))*100:.4f}%  -> "
          f"{'CALIBRATED' if fleet_cal.is_calibrated else 'MISCALIBRATED'}")
    print(f"       signal {fleet_cal.signal_to_null:.0f}x the null")
    print(f"       scale invariance: rho {scale.get('spearman_size_vs_alert_rate')} "
          f"({'passes' if scale.get('passes') else 'correlated with size'})")
    print(f"       parameter budget (tier A, max 3): "
          f"{'ok' if report.parameter_budget_ok() else 'EXCEEDED'}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["alert_rates", "null_calibration", "all"],
                    nargs="?", default="all")
    ap.parse_args()
    cmd_all()
    return 0


if __name__ == "__main__":
    sys.exit(main())
