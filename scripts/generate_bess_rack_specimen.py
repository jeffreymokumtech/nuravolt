#!/usr/bin/env python3
"""Generate a labelled rack level specimen for one plant's battery.

The engine is ``nuravolt/pipeline/bess_rack_specimen.py``; read its docstring
before changing anything here. In one line: the rack channels are DERIVED FROM
THE ASSET'S OWN DISPATCH TWIN and are labelled modelled at every layer, so the
rack drill-down, the imbalance sub index and the spread outlier detector are all
demonstrable today without a BMS and without pretending anything was measured.

    python scripts/generate_bess_rack_specimen.py --plant ribera
    python scripts/generate_bess_rack_specimen.py --plant ribera --dry-run
    python scripts/generate_bess_rack_specimen.py --plant ribera --scan 5

What lands:

  analysis_results   daily rack, unit and asset rollups under model_version
                     'modelled-bess-rack-specimen-v1', every row stamped
                     metadata.provenance='modelled'.
  BessAsset          rack_count, plus a metadata.rack_specimen block that tells
                     the whole story from the row alone. module_count is left
                     null on purpose.
  AnalysisArtifact   kind 'bess_state_of_safety', for the most recent modelled
                     day only, provisional and labelled "(modelled rack
                     specimen)".

Rollback is one statement:

    DELETE FROM analysis_results
     WHERE model_version = 'modelled-bess-rack-specimen-v1';

ORDERING. ``synthesize_bess_history`` publishes the same artifact kind on the
modelled dispatch twin basis (imbalance unavailable). Run this AFTER it, or the
nightly sweep will replace the specimen's safety headline with the twin's. The
analysis_results rows are unaffected either way: they live under their own
model_version.

NEVER run this against a plant whose battery has real telemetry. It refuses
anyway (the telemetry regime guard), but the refusal is a backstop, not a plan.
"""

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from nuravolt.pipeline.bess_rack_specimen import (  # noqa: E402
    DEFAULT_CADENCE_MINUTES,
    DEFAULT_DAYS,
    DEFAULT_DRIFTING_RACK,
    DRIFT_DAYS,
    MODEL_VERSION,
    RACK_ENERGY_KWH,
    generate_rack_specimen,
    scan_outlier_days,
)


def clean_dsn(dsn: str) -> str:
    """Drop connection parameters psycopg2 does not understand."""
    parts = urlsplit(dsn)
    keep = [
        (k, v)
        for k, v in parse_qsl(parts.query)
        if k in ("sslmode", "sslrootcert", "sslcert", "sslkey", "options")
    ]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(keep), parts.fragment))


def fetch_plant(conn, ident: str) -> dict:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT id, slug, name, asset_type, country, timezone '
            'FROM "Plant" WHERE slug = %s OR id::text = %s',
            (ident, ident),
        )
        row = cur.fetchone()
    if not row:
        sys.exit(f"plant not found: {ident}")
    return dict(row)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plant", required=True, help="plant slug or id")
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS,
                    help=f"days of specimen to write (default {DEFAULT_DAYS})")
    ap.add_argument("--cadence-minutes", type=int, default=DEFAULT_CADENCE_MINUTES,
                    help=(f"poll cadence of the specimen (default {DEFAULT_CADENCE_MINUTES}); "
                          "must divide a 1440 minute day and be fine enough that a 30 "
                          "minute dwell window holds at least 3 samples"))
    ap.add_argument("--drift-days", type=int, default=DRIFT_DAYS,
                    help=f"length of the drift window (default {DRIFT_DAYS})")
    ap.add_argument("--drifting-rack", default=DEFAULT_DRIFTING_RACK,
                    help=f"rack suffix that drifts (default {DEFAULT_DRIFTING_RACK})")
    ap.add_argument("--rack-energy-kwh", type=float, default=RACK_ENERGY_KWH,
                    help=(f"energy per modelled rack (default {RACK_ENERGY_KWH:.0f}, which "
                          "gives a 10 MWh asset 16 racks in 2 units). Lower it on a small "
                          "asset so the topology has enough siblings to be an outlier of; "
                          "the cells per MWh check reports when the result leaves the band "
                          "real products span."))
    ap.add_argument("--model-version", default=MODEL_VERSION,
                    help="must start with 'modelled-'; the writer refuses anything else")
    ap.add_argument("--no-safety", action="store_true",
                    help="compute but do not publish the state of safety artifact")
    ap.add_argument("--dry-run", action="store_true",
                    help="compute and report, write nothing")
    ap.add_argument("--scan", type=int, metavar="EVERY", default=0,
                    help=("verification: run the real outlier scan on every Nth day and "
                          "report where the detector crosses. Writes nothing."))
    args = ap.parse_args()

    load_dotenv(PROJECT_ROOT / ".env")
    load_dotenv(PROJECT_ROOT / ".env.local", override=False)
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL is not set")

    conn = psycopg2.connect(clean_dsn(dsn))
    try:
        plant = fetch_plant(conn, args.plant)

        if args.scan:
            rows = scan_outlier_days(
                conn, plant,
                days=args.days, every=args.scan,
                cadence_minutes=args.cadence_minutes,
                drift_days=args.drift_days,
                drifting_rack=args.drifting_rack,
                rack_energy_kwh=args.rack_energy_kwh,
            )
            print(json.dumps({"plant": plant["slug"], "scan": rows}, indent=2, default=str))
            return 0

        summary = generate_rack_specimen(
            conn, plant,
            days=args.days,
            cadence_minutes=args.cadence_minutes,
            drift_days=args.drift_days,
            drifting_rack=args.drifting_rack,
            rack_energy_kwh=args.rack_energy_kwh,
            model_version=args.model_version,
            publish_safety=not args.no_safety,
            dry_run=args.dry_run,
        )
        print(json.dumps(summary, indent=2, default=str))
        return 0 if "skipped" not in summary else 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
