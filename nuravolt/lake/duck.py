"""One DuckDB connection idiom for reading the lake, in one place.

Every lake read path needs the same three lines before it can touch an
``s3://`` object: install httpfs, load it, and register a secret that resolves
credentials from the standard AWS chain. That block was copied into
``nuravolt/lake/publish.py`` and, in a different spelling, into
``scripts/lake_compact_bronze.py``. A copy is where a region default drifts, or
where one reader learns to use a shared profile and the other does not, and the
symptom is an empty result rather than an error.

``duckdb`` is an optional extra of this project (the lake readers need it, the
app does not), so it is imported inside the functions and its absence raises a
message that names the package rather than a bare ModuleNotFoundError from
three frames down.
"""

from __future__ import annotations

import os
from typing import Optional

#: The lake's home region, matching nuravolt/lake/catalog.py.
DEFAULT_REGION = "eu-west-1"

DUCKDB_MISSING = (
    "duckdb is not installed, so the lake cannot be read from Python. "
    "It is an optional extra of this project: pip install duckdb"
)


def _duckdb():
    try:
        import duckdb  # noqa: PLC0415 - optional extra, imported at call time
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise ImportError(DUCKDB_MISSING) from exc
    return duckdb


def duckdb_connection():
    """A bare in-process DuckDB connection, no extensions loaded.

    Enough for a local parquet path. Loading httpfs costs a network round trip
    on first use, so a reader that only touches the filesystem should not pay
    it, and offline it would fail outright.
    """
    return _duckdb().connect()


def duckdb_s3(*, secret_name: str = "nuravolt_lake", region: Optional[str] = None):
    """A DuckDB connection that can read ``s3://`` paths.

    Credentials come from ``PROVIDER credential_chain``: env keys, a shared
    profile, or an instance role, the same chain boto3 and pyiceberg already
    use, so nothing here holds a key.

    ``secret_name`` only names the secret inside this connection. It exists so a
    caller that already registered a differently named secret on a shared
    connection keeps its own name.
    """
    con = duckdb_connection()
    try:
        con.execute("INSTALL httpfs;")
        con.execute("LOAD httpfs;")
        resolved = region or os.environ.get("AWS_REGION", DEFAULT_REGION)
        con.execute(
            f"CREATE SECRET IF NOT EXISTS {secret_name} "
            f"(TYPE s3, PROVIDER credential_chain, REGION '{resolved}');"
        )
    except Exception:
        # A half-configured connection reads s3 paths as "no files found",
        # which is indistinguishable from an empty day. Close it instead.
        con.close()
        raise
    return con


def duckdb_for_path(path: str, **kwargs):
    """Whichever of the two the target needs, chosen by its scheme."""
    return duckdb_s3(**kwargs) if str(path).startswith("s3://") else duckdb_connection()
