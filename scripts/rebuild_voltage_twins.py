#!/usr/bin/env python3
"""
Rebuild voltage twin parquets to fix the Voc/Vmpp confusion bug.

Background
----------
`train_hierarchical_twins.py` emits an hourly voltage prediction for *every*
hour of every day, including hours when the MPPT is idle (sun below horizon,
inverter decoupled from the DC bus, measured voltage = 0). The "prediction"
during those hours is a Voc-derived baseline (~620 V) which has nothing to
do with the measured operating-point voltage. Result on the MPPT chart: a
flat predicted line at ~620 V running across a measured line that's 0 at
night and 400–650 V during the day. The big residuals at night are noise,
not signal.

This script post-processes the existing `mppt_voltage_hourly.parquet` to:

1. Drop predicted (and residual) rows whenever the MPPT is not actively
   tracking — defined as `voltage_actual <= 50 V`. Actual measurements are
   retained as-is so the operator can still see the diurnal pattern.

2. Apply a per-MPPT scale factor so that the daytime predicted mean matches
   the daytime actual mean, eliminating any remaining Voc-vs-Vmpp absolute
   offset. The scale is clamped to [0.3, 2.0] so a broken/zero inverter
   doesn't get its prediction inflated to compensate.

After this runs, the MPPT chart shows a clean break at night, a predicted
line that tracks the actual operating voltage during the day, and a
residual centred on zero with structural-only deviations.

This is a focused post-hoc fix. The real fix is to rewrite the trainer to
emit only-when-tracking predictions natively — left for a separate pass.

Usage:
    python scripts/rebuild_voltage_twins.py
    python scripts/rebuild_voltage_twins.py --plant alpha
    python scripts/rebuild_voltage_twins.py --dry-run
"""

import argparse
import os
import sys
from pathlib import Path

import polars as pl
import psycopg2
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1] / "backenddata" / "twins"
TRACKING_THRESHOLD_V = 50.0  # MPPT considered "tracking" if actual voltage > this
SCALE_MIN = 0.3
SCALE_MAX = 2.0


def load_plant_id_map() -> dict[str, str]:
    """Return slug → uuid map from the Plant table."""
    load_dotenv()
    url = os.environ.get(
        "DATABASE_URL",
        "postgresql://nuravolt:nuravolt@localhost:5432/nuravolt",
    )
    from urllib.parse import urlparse

    p = urlparse(url)
    conn = psycopg2.connect(
        host=p.hostname,
        port=p.port or 5432,
        dbname=p.path.lstrip("/"),
        user=p.username,
        password=p.password,
    )
    cur = conn.cursor()
    cur.execute('SELECT slug, id FROM "Plant"')
    rows = cur.fetchall()
    conn.close()
    return {slug: uuid for slug, uuid in rows}


def rebuild_one(parquet_path: Path, dry_run: bool = False) -> None:
    print(f"\n=== {parquet_path}")
    df = pl.read_parquet(parquet_path)
    n_in = df.height
    print(f"  loaded:  {n_in:>12,} rows")

    # The metric column packs both the MPPT index and the kind. Split them
    # out so we can pivot cleanly per (time, device_id).
    df = df.with_columns(
        [
            pl.col("metric")
            .str.extract(r"mppt_(\d+)_voltage_", 1)
            .cast(pl.Int8)
            .alias("mppt"),
            pl.col("metric").str.extract(r"voltage_(\w+)$", 1).alias("kind"),
        ]
    )

    wide = df.pivot(
        on="kind",
        index=["time", "device_id", "mppt"],
        values="value",
    )
    # Guard against schema drift.
    for col in ("actual", "predicted", "residual"):
        if col not in wide.columns:
            print(f"  ! missing column '{col}', skipping this parquet")
            return

    # Tracking flag drives both the row-drop and the scale fit.
    wide = wide.with_columns(
        (pl.col("actual") > TRACKING_THRESHOLD_V).alias("tracking")
    )

    # Per-device scale: mean(actual) / mean(predicted) over tracking samples
    # only, clamped so a broken inverter doesn't pull the scale into nonsense.
    scales = (
        wide.filter(pl.col("tracking") & (pl.col("predicted") > 0))
        .group_by("device_id")
        .agg(
            [
                pl.col("actual").mean().alias("mean_actual"),
                pl.col("predicted").mean().alias("mean_predicted"),
                pl.len().alias("n_samples"),
            ]
        )
        .with_columns(
            (pl.col("mean_actual") / pl.col("mean_predicted"))
            .clip(SCALE_MIN, SCALE_MAX)
            .alias("scale")
        )
        .select(["device_id", "scale"])
    )
    print(f"  scales:  {scales.height:>12,} devices fitted")
    if scales.height > 0:
        s = scales["scale"]
        print(
            f"           min={s.min():.3f} median={s.median():.3f} max={s.max():.3f}"
        )

    wide = wide.join(scales, on="device_id", how="left")

    # Apply: scale predicted only when tracking, NULL elsewhere. Recompute
    # residual identically — when predicted is null, residual is null too.
    wide = wide.with_columns(
        [
            pl.when(pl.col("tracking"))
            .then(pl.col("predicted") * pl.col("scale"))
            .otherwise(None)
            .alias("predicted_new"),
        ]
    )
    wide = wide.with_columns(
        [
            pl.when(pl.col("tracking"))
            .then(pl.col("actual") - pl.col("predicted_new"))
            .otherwise(None)
            .alias("residual_new"),
        ]
    )

    # Unpivot back to the original long schema: (time, device_id, metric, value).
    actual_long = wide.select(
        [
            "time",
            "device_id",
            (pl.lit("mppt_") + pl.col("mppt").cast(pl.Utf8) + pl.lit("_voltage_actual")).alias(
                "metric"
            ),
            pl.col("actual").alias("value"),
        ]
    )
    pred_long = wide.select(
        [
            "time",
            "device_id",
            (pl.lit("mppt_") + pl.col("mppt").cast(pl.Utf8) + pl.lit("_voltage_predicted")).alias(
                "metric"
            ),
            pl.col("predicted_new").alias("value"),
        ]
    )
    resid_long = wide.select(
        [
            "time",
            "device_id",
            (pl.lit("mppt_") + pl.col("mppt").cast(pl.Utf8) + pl.lit("_voltage_residual")).alias(
                "metric"
            ),
            pl.col("residual_new").alias("value"),
        ]
    )
    out = pl.concat([actual_long, pred_long, resid_long])
    out = out.filter(pl.col("value").is_not_null())
    out = out.select(["time", "device_id", "metric", "value"])
    out = out.sort(["device_id", "time", "metric"])

    n_out = out.height
    dropped = n_in - n_out
    print(
        f"  rebuilt: {n_out:>12,} rows  ({dropped:,} predicted/residual dropped as non-tracking)"
    )

    if dry_run:
        print("  (dry-run: not writing)")
        return

    tmp = parquet_path.with_suffix(".parquet.tmp")
    out.write_parquet(tmp)
    os.replace(tmp, parquet_path)
    print(f"  → wrote {parquet_path}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plant", help="restrict to one plant slug")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    slug_to_uuid = load_plant_id_map()
    print(f"Loaded {len(slug_to_uuid)} plant slug→uuid mappings")

    targets: list[tuple[str, Path]] = []
    for slug, uuid in slug_to_uuid.items():
        if args.plant and slug != args.plant:
            continue
        path = BACKEND / uuid / "mppt_voltage_hourly.parquet"
        if path.exists():
            targets.append((slug, path))

    if not targets:
        print("No twin parquets found.")
        return 1

    print(f"Targets ({len(targets)}):")
    for slug, path in targets:
        print(f"  - {slug}: {path}")

    for _, path in targets:
        rebuild_one(path, dry_run=args.dry_run)

    print(
        "\nDone. To refresh the DB-backed daily series next:\n"
        "  python scripts/aggregate_twins_to_db.py"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
