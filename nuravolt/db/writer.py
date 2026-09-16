"""
TimescaleDB writer for NuraVolt analytics pipeline.

Bulk-inserts time-series data into two hypertables:
  - measurements   (raw sensor/inverter readings)
  - analysis_results (model outputs: soiling, faults, digital twin, etc.)

Usage:
    from nuravolt.db.writer import TimeseriesWriter

    writer = TimeseriesWriter()

    # Write source measurements
    writer.write_measurements(
        plant_id='uuid-here',
        source_id='optional-uuid',
        records=[
            {'time': datetime(2024, 1, 1, 12), 'device_id': 'INV_01_001',
             'metric': 'power_ac', 'value': 45.2, 'unit': 'kW'},
        ]
    )

    # Write analysis results
    writer.write_analysis_results(
        plant_id='uuid-here',
        domain='soiling',
        records=[
            {'time': datetime(2024, 1, 1), 'device_id': 'INV_01_001',
             'metric': 'soiling_ratio', 'value': 0.95},
        ],
        model_version='v1.0',
        run_id='optional-uuid'
    )

    writer.close()

    # Or use as context manager:
    with TimeseriesWriter() as writer:
        writer.write_measurements(...)
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

try:
    import psycopg2
    import psycopg2.extras

    _HAS_PSYCOPG2 = True
except ImportError:
    _HAS_PSYCOPG2 = False
    logger.warning(
        "psycopg2 not installed. Database writes will be unavailable. "
        "Install with: pip install psycopg2-binary"
    )


# ---------------------------------------------------------------------------
# SQL templates
# ---------------------------------------------------------------------------

_MEASUREMENTS_INSERT = """
INSERT INTO measurements (time, plant_id, device_id, metric, value, unit, quality, source_id)
VALUES %s
ON CONFLICT (time, plant_id, device_id, metric)
DO UPDATE SET
    value   = EXCLUDED.value,
    quality = EXCLUDED.quality,
    unit    = EXCLUDED.unit
"""

_MEASUREMENTS_TEMPLATE = (
    "(%(time)s, %(plant_id)s, %(device_id)s, %(metric)s, "
    "%(value)s, %(unit)s, %(quality)s, %(source_id)s)"
)

_ANALYSIS_INSERT = """
INSERT INTO analysis_results
    (time, plant_id, device_id, domain, metric, value,
     confidence, model_version, run_id, metadata)
VALUES %s
ON CONFLICT (time, plant_id, COALESCE(device_id, ''), domain, metric, COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid))
DO UPDATE SET
    value         = EXCLUDED.value,
    confidence    = EXCLUDED.confidence,
    model_version = EXCLUDED.model_version,
    metadata      = EXCLUDED.metadata
"""

_ANALYSIS_TEMPLATE = (
    "(%(time)s, %(plant_id)s, %(device_id)s, %(domain)s, %(metric)s, "
    "%(value)s, %(confidence)s, %(model_version)s, %(run_id)s, %(metadata)s)"
)


# ---------------------------------------------------------------------------
# Writer
# ---------------------------------------------------------------------------


class TimeseriesWriter:
    """Bulk writer for TimescaleDB hypertables.

    Parameters
    ----------
    dsn : str, optional
        PostgreSQL connection string.  Falls back to the ``DATABASE_URL``
        environment variable.
    batch_size : int
        Maximum rows per ``execute_values`` call (default 1000).
    """

    def __init__(
        self,
        dsn: Optional[str] = None,
        batch_size: int = 1000,
    ) -> None:
        if not _HAS_PSYCOPG2:
            raise RuntimeError(
                "psycopg2 is required for TimeseriesWriter. "
                "Install with: pip install psycopg2-binary"
            )

        self._dsn = dsn or os.environ.get("DATABASE_URL", "")
        if not self._dsn:
            raise ValueError(
                "No database connection string provided. "
                "Set DATABASE_URL or pass dsn= to TimeseriesWriter."
            )

        self.batch_size = max(1, batch_size)
        self._conn: Optional[psycopg2.extensions.connection] = None

    # -- connection helpers --------------------------------------------------

    @property
    def conn(self) -> psycopg2.extensions.connection:
        """Lazy-open a connection (auto-reconnect if closed)."""
        if self._conn is None or self._conn.closed:
            self._conn = psycopg2.connect(self._dsn)
            self._conn.autocommit = False
        return self._conn

    def close(self) -> None:
        """Close the database connection."""
        if self._conn is not None and not self._conn.closed:
            self._conn.close()
        self._conn = None

    # -- context manager -----------------------------------------------------

    def __enter__(self) -> "TimeseriesWriter":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()

    # -- public API ----------------------------------------------------------

    def write_measurements(
        self,
        plant_id: str,
        records: List[Dict[str, Any]],
        source_id: Optional[str] = None,
    ) -> int:
        """Insert or upsert rows into the ``measurements`` hypertable.

        Parameters
        ----------
        plant_id : str
            UUID of the plant.
        records : list[dict]
            Each dict must contain ``time``, ``device_id``, ``metric``,
            ``value``.  Optional keys: ``unit`` (default ``None``),
            ``quality`` (default ``0``).
        source_id : str, optional
            UUID of the data source (applied to every row).

        Returns
        -------
        int
            Number of rows upserted.
        """
        if not records:
            return 0

        rows = []
        for rec in records:
            rows.append(
                {
                    "time": rec["time"],
                    "plant_id": plant_id,
                    "device_id": rec["device_id"],
                    "metric": rec["metric"],
                    "value": rec["value"],
                    "unit": rec.get("unit"),
                    "quality": rec.get("quality", 0),
                    "source_id": source_id,
                }
            )

        return self._execute_batched(
            _MEASUREMENTS_INSERT, _MEASUREMENTS_TEMPLATE, rows
        )

    def write_analysis_results(
        self,
        plant_id: str,
        domain: str,
        records: List[Dict[str, Any]],
        model_version: Optional[str] = None,
        run_id: Optional[str] = None,
    ) -> int:
        """Insert or upsert rows into the ``analysis_results`` hypertable.

        Parameters
        ----------
        plant_id : str
            UUID of the plant.
        domain : str
            Analysis domain, e.g. ``"soiling"``, ``"fault"``,
            ``"digitaltwin"``.
        records : list[dict]
            Each dict must contain ``time``, ``metric``, ``value``.
            Optional keys: ``device_id``, ``confidence``, ``metadata``
            (a dict serialised to JSONB).
        model_version : str, optional
            Model version tag applied to every row.
        run_id : str, optional
            UUID of the analysis run applied to every row.

        Returns
        -------
        int
            Number of rows upserted.
        """
        if not records:
            return 0

        rows = []
        for rec in records:
            meta = rec.get("metadata")
            rows.append(
                {
                    "time": rec["time"],
                    "plant_id": plant_id,
                    "device_id": rec.get("device_id"),
                    "domain": domain,
                    "metric": rec["metric"],
                    "value": rec["value"],
                    "confidence": rec.get("confidence"),
                    "model_version": model_version,
                    "run_id": run_id,
                    "metadata": json.dumps(meta) if meta is not None else None,
                }
            )

        return self._execute_batched(
            _ANALYSIS_INSERT, _ANALYSIS_TEMPLATE, rows
        )

    # -- internals -----------------------------------------------------------

    def _execute_batched(
        self, sql: str, template: str, rows: List[Dict[str, Any]]
    ) -> int:
        """Run execute_values in batch_size chunks and commit."""
        total = 0
        cur = self.conn.cursor()
        try:
            for start in range(0, len(rows), self.batch_size):
                batch = rows[start : start + self.batch_size]
                psycopg2.extras.execute_values(
                    cur,
                    sql,
                    batch,
                    template=template,
                    page_size=self.batch_size,
                )
                total += len(batch)
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise
        finally:
            cur.close()

        logger.info("Upserted %d rows", total)
        return total


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def get_plant_id(slug: str, dsn: Optional[str] = None) -> Optional[str]:
    """Look up a plant UUID by its slug.

    Parameters
    ----------
    slug : str
        Human-readable plant identifier, e.g. ``"alpha"``.
    dsn : str, optional
        Connection string.  Falls back to ``DATABASE_URL``.

    Returns
    -------
    str or None
        The plant UUID if found, else ``None``.
    """
    if not _HAS_PSYCOPG2:
        logger.warning("psycopg2 not installed -- cannot look up plant id")
        return None

    dsn = dsn or os.environ.get("DATABASE_URL", "")
    if not dsn:
        logger.warning("DATABASE_URL not set -- cannot look up plant id")
        return None

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT id FROM "Plant" WHERE slug = %s LIMIT 1', (slug,)
            )
            row = cur.fetchone()
            return str(row[0]) if row else None
    finally:
        conn.close()


def write_artifact(
    plant_id: str,
    kind: str,
    payload: Any,
    source: str = "synthetic",
    model_version: Optional[str] = None,
    dsn: Optional[str] = None,
    conn: Optional["psycopg2.extensions.connection"] = None,
) -> None:
    """Upsert one nested-JSON artifact into ``AnalysisArtifact`` (one row per
    ``(plant_id, kind)``). Used by the synthesis modules for payloads that don't
    fit the timeseries tables (soiling streams, enhanced faults). Read DB-first
    by the dashboard section routes; ``source`` labels provenance so the UI can
    mark synthetic data provisional.

    Pass an existing ``conn`` to enlist in the caller's transaction; otherwise a
    short-lived connection is opened and committed.
    """
    if not _HAS_PSYCOPG2:
        logger.warning("psycopg2 not installed -- cannot write artifact")
        return
    own = conn is None
    if own:
        dsn = dsn or os.environ.get("DATABASE_URL", "")
        if not dsn:
            logger.warning("DATABASE_URL not set -- cannot write artifact")
            return
        conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO "AnalysisArtifact" '
                '(id, plant_id, kind, payload, source, model_version, generated_at, updated_at) '
                "VALUES (gen_random_uuid(), %s, %s, %s::jsonb, %s, %s, NOW(), NOW()) "
                'ON CONFLICT (plant_id, kind) DO UPDATE SET '
                "payload = EXCLUDED.payload, source = EXCLUDED.source, "
                "model_version = EXCLUDED.model_version, generated_at = NOW(), updated_at = NOW()",
                (plant_id, kind, json.dumps(payload), source, model_version),
            )
        if own:
            conn.commit()
    finally:
        if own:
            conn.close()
