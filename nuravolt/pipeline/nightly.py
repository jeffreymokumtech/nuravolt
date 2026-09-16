#!/usr/bin/env python
"""Nightly analytics sweep across all customer plants.

Run by .github/workflows/analytics-nightly.yml after dbt-daily. For every
plant in ONBOARDING / TRAINING / OPERATIONAL:

  - ONBOARDING plants (dispatch missed or failed): run the cold-start
    onboarding inline — this is the safety net for the API trigger.
  - TRAINING plants: refresh the provisional forecast so it stays anchored to
    today. The upgrade to plant-trained per-inverter models (scripts/
    train_per_inverter_sr.py) hooks in here once per-plant lake data
    thresholds are met — tracked in AnalyticsJob detail as data_days.
  - OPERATIONAL plants: refreshed incrementally. The cold-start arms
    (coldstart soiling curve, fault and soiling-stream synthesis) are skipped
    so they cannot overwrite trained or measured output; the refresh arms
    (twin, quality analytics, power forecast, battery) still run.

That branching is real, not aspirational: this sweep passes `--incremental` to
onboard_plant.py for OPERATIONAL plants. It used to re-run the full cold start
for every plant every night regardless of status, which is how modelled data
would have quietly landed on top of real data.

Every plant gets an AnalyticsJob row (job_type='nightly') so failures are
visible in the product.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

import psycopg2  # noqa: E402
import psycopg2.extras  # noqa: E402


def _connect():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is not set")
    return psycopg2.connect(dsn)


#: Statuses that get the incremental refresh instead of a full cold start.
INCREMENTAL_STATUSES = {"OPERATIONAL"}


def main() -> int:
    conn = _connect()
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            # OPERATIONAL plants stay in the sweep for daily twin/forecast
            # refreshes, but they take the incremental arm below so the
            # cold-start generators cannot overwrite trained or measured output.
            'SELECT id, slug, status FROM "Plant" '
            "WHERE status IN ('ONBOARDING', 'TRAINING', 'OPERATIONAL') AND organization_id IS NOT NULL"
        )
        plants = [dict(r) for r in cur.fetchall()]

    n_incremental = sum(1 for p in plants if p["status"] in INCREMENTAL_STATUSES)
    print(
        f"[nightly] {len(plants)} plant(s) to process "
        f"({n_incremental} incremental, {len(plants) - n_incremental} cold start)"
    )
    failures = 0

    for plant in plants:
        incremental = plant["status"] in INCREMENTAL_STATUSES
        job_id = str(uuid.uuid4())
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO "AnalyticsJob" (id, plant_id, job_type, status, github_run_id) '
                "VALUES (%s, %s, 'nightly', 'running', %s)",
                (job_id, plant["id"], os.environ.get("GITHUB_RUN_ID")),
            )
        conn.commit()

        cmd = [
            sys.executable,
            str(PROJECT_ROOT / "nuravolt" / "pipeline" / "onboard_plant.py"),
            "--plant-id",
            plant["id"],
            "--job-id",
            job_id,
        ]
        if incremental:
            cmd.append("--incremental")

        result = subprocess.run(cmd, capture_output=True, text=True)
        ok = result.returncode == 0
        mode = "incremental" if incremental else "coldstart"
        print(f"[nightly] {plant['slug']} ({mode}): {'ok' if ok else 'FAILED'}")
        if not ok:
            failures += 1
            print(result.stdout[-2000:], file=sys.stderr)
            print(result.stderr[-2000:], file=sys.stderr)
            with conn.cursor() as cur:
                cur.execute(
                    'UPDATE "AnalyticsJob" SET status = %s, error = %s, finished_at = NOW() WHERE id = %s',
                    ("failed", (result.stderr or result.stdout)[-1000:], job_id),
                )
            conn.commit()

    conn.close()
    print(json.dumps({"processed": len(plants), "failures": failures}))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
