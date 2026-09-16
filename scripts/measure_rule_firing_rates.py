#!/usr/bin/env python3
"""How often does each fault rule actually fire on a real plant?

WHY THIS IS THE CLOSEST THING TO A FALSE-POSITIVE RATE WE HAVE
--------------------------------------------------------------
Real plants carry no fault labels, so precision cannot be computed directly. But
a rule's firing rate is still strong evidence, because the prior is known: a
utility-scale plant does not have a string open circuit on 5% of its daylight
intervals. Any rule firing far above the plausible base rate for its failure mode
is producing false positives, and the more it fires the more certain that is.

We already have one confirmed instance. The 65 degrees C inverter overtemperature
threshold fires on over 5% of daylight inverter-samples on one plant, because the
measured 95th percentile of cabinet temperature in NORMAL operation is 66.2, and
the datasheet says the inverter is rated to 60 ambient with derating from 45. The
threshold is above the machine's rated envelope.

On labelled public data the picture is directly measurable and not reassuring:
in-distribution and tuned, 54% of `degradation` alerts are wrong (precision
0.4626) and 21% of `partial_shading` alerts are. Untuned, `short_circuit` and
`degradation` never fire at all. Across architectures, five of eight classes never
fire and 59% of `dc_link_capacitor_aging` alerts are wrong.

WHAT THIS SCRIPT REPORTS
------------------------
Per fault type, per plant: alerts raised, the fraction of scored device-intervals
that fired, and alerts per MW per month. Plus a plausibility verdict comparing the
firing rate against a stated expected base rate for that failure mode.

Usage:
    set -a; source .env; set +a
    python scripts/measure_rule_firing_rates.py --plants eta
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, Optional

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nuravolt.fault.config import FaultDetectionConfig  # noqa: E402
from nuravolt.fault.rule_based import RuleBasedFaultDetector  # noqa: E402
from nuravolt.fault.topology import (  # noqa: E402
    parse_component_meta,
    resolve_device_columns,
)
from nuravolt.validation.report import write_report  # noqa: E402

BUCKET = "nuravolt-lake"

#: Plausible upper bound on how often each failure mode should be ACTIVE, as a
#: fraction of daylight device-intervals, across a multi-year record. These are
#: engineering judgements, stated openly so they can be argued with, not fitted.
#: A rule firing far above its bound is raising false positives.
PLAUSIBLE_MAX_ACTIVE_FRACTION: Dict[str, float] = {
    "inverter_offline": 0.02,             # a few percent of downtime is a bad year
    "inverter_clipping": 0.30,            # legitimately common on oversized arrays
    "inverter_overtemperature": 0.001,    # should be rare and serious
    "inverter_efficiency_degradation": 0.01,
    "inverter_underperformance_peer": 0.02,
    "dc_overvoltage": 0.001,
    "dc_undervoltage": 0.001,
    "string_open_circuit": 0.005,
    "string_short_circuit": 0.002,
    "string_mismatch_coarse": 0.05,
    "mppt_imbalance": 0.05,
    "mppt_hunting": 0.01,
    "module_overtemperature": 0.005,
    "bypass_diode_active": 0.005,
    "insulation_resistance_low": 0.002,
    "communication_loss": 0.05,
    "communication_partial": 0.05,
    "sensor_frozen": 0.01,
    "irradiance_sensor_drift": 0.02,
    "soiling_detected": 0.40,             # soiling is genuinely usually present
    "vegetation_shading": 0.10,
    "grid_frequency_low": 0.001,
    "grid_frequency_high": 0.001,
    "grid_voltage_sag": 0.002,
    "grid_voltage_swell": 0.002,
    "grid_curtailment": 0.10,
    "export_cap_active": 0.10,
}


def _fs():
    import pyarrow.fs as pafs
    return pafs.S3FileSystem(
        region="eu-west-1",
        access_key=os.environ.get("AWS_ACCESS_KEY_ID"),
        secret_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


#: Local mirror of the S3 slice, so a rule change can be re-measured without
#: re-downloading five years of SCADA for four plants. Keyed by plant only; the
#: cached frame holds every inverter and ``--max-inverters`` slices it after.
CACHE = Path("backenddata/cache/rulerates")


def load_plant(plant: str, max_inverters: Optional[int]):
    import boto3
    import pyarrow.parquet as pq

    CACHE.mkdir(parents=True, exist_ok=True)
    cached, cached_meta = CACHE / f"{plant}.parquet", CACHE / f"{plant}_meta.csv"
    if cached.exists() and cached_meta.exists():
        df = pl.read_parquet(cached)
        topo = parse_component_meta(cached_meta.read_text(), plant)
        inv_tokens = sorted({m.group(1) for c in df.columns
                             if (m := re.search(r":\s*(INV [\d.]+)\s*/", c))})
        if max_inverters:
            inv_tokens = inv_tokens[:max_inverters]
        return df, topo, inv_tokens

    fs, s3 = _fs(), boto3.client("s3", region_name="eu-west-1")
    path = f"{BUCKET}/bronze/scada/{plant}/{plant}_cleaned.parquet"
    names = pq.ParquetFile(fs.open_input_file(path)).schema_arrow.names

    keys = [o["Key"] for o in s3.list_objects_v2(
        Bucket=BUCKET, Prefix=f"bronze/scada/{plant}/").get("Contents", [])
        if o["Key"].endswith("_meta.csv")]
    meta_csv = s3.get_object(
        Bucket=BUCKET, Key=keys[0])["Body"].read().decode("utf-8-sig", "replace")
    topo = parse_component_meta(meta_csv, plant)

    inv_tokens = sorted({m.group(1) for c in names
                         if (m := re.search(r":\s*(INV [\d.]+)\s*/", c))})
    plant_cols = [c for c in names if "/ Plant" in c or "Meteo" in c or "Radiation" in c]
    inv_cols = [c for c in names if any(f": {t} /" in c for t in inv_tokens)]
    tbl = pq.read_table(fs.open_input_file(path),
                        columns=["timestamp"] + plant_cols + inv_cols)
    df = pl.from_arrow(tbl).with_columns(
        pl.col("timestamp").str.strptime(pl.Datetime, "%Y.%m.%d %H:%M", strict=False))
    df.write_parquet(cached)
    cached_meta.write_text(meta_csv)
    if max_inverters:
        inv_tokens = inv_tokens[:max_inverters]
    return df, topo, inv_tokens


def slice_inverter(df: pl.DataFrame, token: str) -> Optional[pl.DataFrame]:
    """Rename one inverter's columns to the names the detector expects."""
    ren: Dict[str, str] = {}
    taken: set = set()   # a target name may be claimed only once

    def claim(col: str, target: str) -> None:
        if target in taken or col in ren:
            return
        ren[col] = target
        taken.add(target)

    # Plant-level signals. Several columns can map to the same target -- Alpha
    # has Irradiation_average plus two Radiation Sensors -- so the first match
    # wins and the rest are left out rather than colliding.
    for c in df.columns:
        if "Irradiation_average" in c:
            claim(c, "poa_irradiance")
    for c in df.columns:
        if "Radiation 1" in c:
            claim(c, "poa_irradiance")
        elif "/ Ambient" in c:
            claim(c, "ambient_temp")
        elif "/ Module" in c:
            claim(c, "module_temp")

    for c in df.columns:
        if f": {token} /" not in c:
            continue
        if "P_AC" in c:
            claim(c, "ac_power")
        elif (m := re.search(r"Input_current_(\d+)", c)):
            claim(c, f"string_current_{int(m.group(1))}")
        elif (m := re.search(r"U_DC_(\d+)", c)):
            claim(c, f"string_voltage_{int(m.group(1))}")
        elif "/ Temperature" in c:
            claim(c, "inverter_temp")

    keep = ["timestamp"] + [c for c in ren]
    keep = [c for c in dict.fromkeys(keep) if c in df.columns]
    if len(keep) < 3:
        return None
    return df.select(keep).rename({k: v for k, v in ren.items() if k in keep})


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plants", nargs="+", default=["eta"])
    ap.add_argument("--max-inverters", type=int, default=None)
    args = ap.parse_args()

    cfg = FaultDetectionConfig.for_eu_plant()
    per_plant: Dict[str, Dict] = {}

    for plant in args.plants:
        df, topo, tokens = load_plant(plant, args.max_inverters)
        mwp = sum(d.kwp_dc for d in topo.devices.values() if d.kwp_dc) / 1000
        months = (df["timestamp"].max() - df["timestamp"].min()).days / 30.44
        print(f"\n{plant}: {len(tokens)} inverters, {mwp:.1f} MWp, {months:.0f} months, "
              f"{len(df):,} intervals")

        counts: Counter = Counter()
        affected: Counter = Counter()
        n_dev_intervals = 0

        # The device model decides which datasheet-anchored detectors can run.
        models = {d.component_type for d in topo.devices.values() if d.is_groupable}
        model = sorted(models)[0] if len(models) == 1 else None
        if model is None:
            print(f"   mixed or unknown device models {sorted(models)}; "
                  f"datasheet-anchored detectors will decline")

        for token in tokens:
            inv = slice_inverter(df, token)
            if inv is None:
                continue
            daylight = inv.filter(pl.col("poa_irradiance") > 100) if "poa_irradiance" in inv.columns else inv
            n_dev_intervals += len(daylight)
            try:
                res = RuleBasedFaultDetector(cfg, component_type=model).detect_all(inv)
            except Exception as exc:  # noqa: BLE001
                print(f"   {token}: detector error {exc.__class__.__name__}: {exc}")
                continue
            for a in res.alerts:
                counts[a.fault_type.value] += 1
                affected[a.fault_type.value] += a.affected_records or 0

        # Plant-level pass: the rules that need to see more than one device at a
        # time. These cannot run inside the per-inverter loop above, which is the
        # architectural reason every inverter-grain rule used to be absolute.
        # Reconcile metadata ids with telemetry tokens. eta's metadata calls
        # its inverters WR.01.001 (Wechselrichter) while its telemetry says
        # INV 01.001, so a naive match resolves zero devices and the peer rules
        # return a clean result from no data at all. resolve_device_columns does
        # digit-sequence matching and RAISES below 50% coverage for exactly that
        # reason.
        temperature_for, power_for, normalizers = {}, {}, {}
        for target, signal in (("temperature_for", "/ Temperature"),
                               ("power_for", "P_AC")):
            try:
                mapped = resolve_device_columns(df.columns, topo, signal_match=signal)
            except LookupError as exc:
                print(f"   {signal}: {exc}")
                mapped = {}
            (temperature_for if target == "temperature_for" else power_for).update(mapped)
        for dev, meta in topo.devices.items():
            if meta.kwp_dc:
                normalizers[dev] = meta.kwp_dc
        try:
            plant_alerts = RuleBasedFaultDetector(cfg, component_type=model).detect_plant_level(
                df, topo,
                power_for=power_for or None,
                temperature_for=temperature_for or None,
                normalizers=normalizers or None,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"   plant-level detector error {exc.__class__.__name__}: {exc}")
            plant_alerts = []
        for a in plant_alerts:
            counts[a.fault_type.value] += 1
            affected[a.fault_type.value] += a.affected_records or 0
        if plant_alerts:
            print(f"   plant-level pass: {len(plant_alerts)} peer alert(s) "
                  f"across {len(temperature_for)} device(s)")

        print(f"   scored {n_dev_intervals:,} daylight device-intervals")
        print(f"   {'fault type':<34}{'events':>8}{'active %':>10}{'/MW/mo':>9}  verdict")
        rows = {}
        for ft, n in counts.most_common():
            frac = affected[ft] / n_dev_intervals if n_dev_intervals else 0.0
            rate = n / mwp / months
            bound = PLAUSIBLE_MAX_ACTIVE_FRACTION.get(ft)
            if bound is None:
                verdict = "no bound stated"
            elif frac > bound * 5:
                verdict = f"IMPLAUSIBLE ({frac/bound:.0f}x the plausible bound)"
            elif frac > bound:
                verdict = f"high ({frac/bound:.1f}x bound)"
            else:
                verdict = "plausible"
            rows[ft] = {"events": n, "active_fraction": round(frac, 6),
                        "alerts_per_mw_month": round(rate, 3),
                        "plausible_max_active_fraction": bound, "verdict": verdict}
            print(f"   {ft:<34}{n:>8,}{frac*100:>9.3f}%{rate:>9.2f}  {verdict}")

        per_plant[plant] = {"inverters": len(tokens), "mwp": round(mwp, 2),
                            "months": round(months, 1),
                            "daylight_device_intervals": n_dev_intervals,
                            "by_fault_type": rows}

    implausible = sorted({ft for p in per_plant.values()
                          for ft, r in p["by_fault_type"].items()
                          if str(r["verdict"]).startswith("IMPLAUSIBLE")})
    write_report("pv", "rule_firing_rates_real_plants", {
        "dataset": "Rule-based fault detector firing rates on real plants",
        "n_samples": sum(p["daylight_device_intervals"] for p in per_plant.values()),
        "per_plant": per_plant,
        "implausible_rules": implausible,
        "method": (
            "Every emitting rule run over real plant SCADA with default EU config. "
            "No fault labels exist, so precision cannot be computed. Instead each "
            "rule's active fraction is compared against a stated plausible upper "
            "bound for that failure mode. A rule far above its bound is raising "
            "false positives; the bounds are engineering judgements, published so "
            "they can be argued with."),
        "what_this_is_not": (
            "Not a false-positive RATE. It is evidence of false positives where a "
            "rule fires far more often than its failure mode can plausibly occur."),
    })
    print(f"\nimplausible rules: {implausible or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
