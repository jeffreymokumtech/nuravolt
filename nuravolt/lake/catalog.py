"""Iceberg catalog factory for the NuraVolt lakehouse.

Local dev uses a SQLite catalog + a filesystem warehouse under ``./lake`` — zero
infrastructure, no AWS, no network. Staging/prod use the **AWS Glue Data Catalog**
(shared across the laptop, GitHub Actions, and the app) over an S3 warehouse
(``s3://$LAKE_BUCKET/``), with credentials from the standard AWS environment chain
(the same chain Bedrock already uses).

See ``docs/DATA_ARCHITECTURE_GUIDE.md`` for the full design. The catalog choice is
non-destructive: swapping Glue for a SQLite-on-S3 or REST catalog later only changes
this factory; the Iceberg metadata and data files are untouched.

Environment variables
---------------------
LAKE_ENV        dev (default) | staging | prod
LAKE_WAREHOUSE  override the local warehouse dir (dev only; default ``<repo>/lake``)
LAKE_BUCKET     S3 bucket name (required when LAKE_ENV != dev)
LAKE_CATALOG    non-dev catalog backend: ``glue`` (default) | ``sql`` (SQLite-on-S3)
LAKE_CATALOG_DB override the SQLite catalog path (only when LAKE_CATALOG=sql)
AWS_REGION      S3 region (non-dev; default ``eu-west-1`` — matches the lake bucket)
"""
from __future__ import annotations

import os
from pathlib import Path

from pyiceberg.catalog import Catalog

# SqlCatalog is imported lazily inside the branches that use it. pyiceberg's
# sql module needs sqlalchemy at import time, which is a dev-only extra: CI
# installs pyiceberg[glue] and talks to the Glue catalog, and a top-level
# import here took the whole bronze registration down with
# ModuleNotFoundError before the Glue branch was even reached.

# nuravolt/lake/catalog.py -> repo root is two parents up.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_LOCAL_WAREHOUSE = _REPO_ROOT / "lake"


def get_catalog(name: str = "nuravolt") -> Catalog:
    """Return the configured Iceberg catalog for the current ``LAKE_ENV``."""
    env = os.getenv("LAKE_ENV", "dev")

    if env == "dev":
        from pyiceberg.catalog.sql import SqlCatalog

        warehouse = Path(os.getenv("LAKE_WAREHOUSE", str(_DEFAULT_LOCAL_WAREHOUSE)))
        warehouse.mkdir(parents=True, exist_ok=True)
        return SqlCatalog(
            name,
            uri=f"sqlite:///{warehouse / 'catalog.db'}",
            warehouse=warehouse.as_uri(),  # file:// URI
        )

    bucket = os.environ.get("LAKE_BUCKET")
    if not bucket:
        raise RuntimeError(
            f"LAKE_ENV={env} requires LAKE_BUCKET (the S3 bucket name). "
            "Set it, or use LAKE_ENV=dev for the local filesystem lake."
        )
    region = os.environ.get("AWS_REGION", "eu-west-1")
    backend = os.getenv("LAKE_CATALOG", "glue").lower()

    if backend == "glue":
        # AWS Glue Data Catalog — the shared, AWS-native table registry. The laptop,
        # GitHub Actions, and the app all resolve the same tables from Glue; data +
        # metadata live under the S3 warehouse. boto3 resolves credentials from the
        # standard AWS chain (env keys / AWS_PROFILE / instance role).
        from pyiceberg.catalog.glue import GlueCatalog

        return GlueCatalog(
            name,
            **{
                "warehouse": f"s3://{bucket}/",
                "glue.region": region,
                "s3.region": region,
            },
        )

    # Fallback: a SQLite catalog file (local) over the same S3 warehouse. Single-writer
    # only — the catalog file isn't shared. Set LAKE_CATALOG=sql to use it.
    from pyiceberg.catalog.sql import SqlCatalog

    catalog_db = os.getenv("LAKE_CATALOG_DB", f"/tmp/nuravolt-iceberg-{env}.db")
    return SqlCatalog(
        name,
        uri=f"sqlite:///{catalog_db}",
        warehouse=f"s3://{bucket}/",
        **{"s3.region": region},
    )
