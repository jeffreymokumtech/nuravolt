"""NuraVolt lakehouse helpers — Iceberg catalog + register/read over parquet.

Phase 1 of the lakehouse migration (``docs/DATA_ARCHITECTURE_GUIDE.md``). Wraps the
existing ``backenddata/`` parquet stage as Iceberg tables with **zero data movement**
(pyiceberg ``add_files`` records footer metadata + stats; it does not rewrite data),
and reads them back through DuckDB — the same embedded engine that serves production.

No AWS required in dev: ``get_catalog()`` defaults to a local filesystem warehouse.

Typical use::

    from nuravolt import lake
    lake.register_parquet("bronze.twin_power_ribera", "backenddata/twins/<uuid>/power_hourly.parquet")
    df = lake.read_table("bronze.twin_power_ribera", where="metric = 'ac_power_kw'")
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import List, Optional, Sequence, Union

from .catalog import get_catalog

__all__ = [
    "get_catalog",
    "register_parquet",
    "append_parquet",
    "read_table",
    "table_exists",
    "list_tables",
    "scan_arrow",
    "NanosecondTimestampError",
    "TableAlreadyRegisteredError",
]

DEFAULT_NAMESPACE = "bronze"

PathLike = Union[str, Path]


def table_exists(table_id: str) -> bool:
    """True if ``namespace.table`` is registered in the catalog."""
    try:
        get_catalog().load_table(table_id)
        return True
    except Exception:
        return False


def list_tables(namespace: str = DEFAULT_NAMESPACE) -> List[str]:
    """List ``namespace.table`` identifiers under ``namespace`` (empty if none)."""
    cat = get_catalog()
    try:
        return [".".join(t) for t in cat.list_tables(namespace)]
    except Exception:
        return []


class TableAlreadyRegisteredError(RuntimeError):
    """Raised when a table already exists and ``replace`` was not requested.

    Re-registering would duplicate rows (zero-copy ``add_files`` re-adds the same
    files) or error (``create_table``). Pass ``replace=True`` to rebuild.
    """


class NanosecondTimestampError(TypeError):
    """Raised when a parquet has timestamp[ns] columns Iceberg can't carry zero-copy.

    Iceberg timestamps are microsecond-precision, so ``add_files`` (which never
    rewrites data) cannot register a nanosecond-precision parquet. Either re-export
    the parquet at microsecond precision upstream (keeps the zero-copy path) or pass
    ``cast_ns_to_us=True`` to rewrite-on-ingest.
    """


def _ns_timestamp_fields(schema) -> List[str]:
    """Names of timestamp[ns] columns in a pyarrow schema."""
    import pyarrow as pa

    return [
        f.name for f in schema
        if pa.types.is_timestamp(f.type) and f.type.unit == "ns"
    ]


def _to_us_schema(schema):
    """Copy a pyarrow schema with every timestamp[ns] field narrowed to us."""
    import pyarrow as pa

    fields = []
    for f in schema:
        if pa.types.is_timestamp(f.type) and f.type.unit == "ns":
            fields.append(f.with_type(pa.timestamp("us", tz=f.type.tz)))
        else:
            fields.append(f)
    return pa.schema(fields)


_REMOTE_SCHEMES = ("s3://", "s3a://", "gs://", "abfs://", "abfss://")


def _is_remote_uri(p: PathLike) -> bool:
    return isinstance(p, str) and p.startswith(_REMOTE_SCHEMES)


def _resolve_sources(parquet_paths: Sequence[PathLike]):
    """Normalize source paths to ``(paths, filesystem, remote)``.

    Local paths keep the historical behaviour exactly: absolute strings, no
    pyarrow filesystem, existence checked up front. Object-store URIs resolve
    through pyarrow's filesystem registry instead, so schema and footer reads
    stream the metadata rather than downloading the object.
    """
    remote = [p for p in parquet_paths if _is_remote_uri(p)]
    if remote and len(remote) != len(parquet_paths):
        raise ValueError(
            "register_parquet: mixing local paths and object-store URIs in one "
            "call is not supported; register them separately."
        )
    if not remote:
        abs_paths = [str(Path(p).resolve()) for p in parquet_paths]
        for p in abs_paths:
            if not Path(p).exists():
                raise FileNotFoundError(p)
        return abs_paths, None, False

    from pyarrow.fs import FileSystem

    fs, _ = FileSystem.from_uri(str(parquet_paths[0]))
    # from_uri strips the scheme + bucket into the filesystem; keep the
    # bucket-relative key for every path so one filesystem serves them all.
    keys = [FileSystem.from_uri(str(p))[1] for p in parquet_paths]
    return keys, fs, True


def append_parquet(
    table_id: str,
    parquet_paths: Union[PathLike, Sequence[PathLike]],
    *,
    cast_ns_to_us: bool = False,
    batch_rows: int = 1_000_000,
) -> int:
    """Append parquet file(s) to an existing Iceberg table (creating it if new).

    The daily-partition counterpart to :func:`register_parquet`: registration
    builds the table once, this adds one more day without rewriting the rest.
    Callers own idempotency — appending the same files twice duplicates rows.
    """
    return register_parquet(
        table_id,
        parquet_paths,
        append=True,
        cast_ns_to_us=cast_ns_to_us,
        batch_rows=batch_rows,
    )


def register_parquet(
    table_id: str,
    parquet_paths: Union[PathLike, Sequence[PathLike]],
    *,
    replace: bool = False,
    append: bool = False,
    cast_ns_to_us: bool = False,
    batch_rows: int = 1_000_000,
) -> int:
    """Register existing parquet file(s) as an Iceberg table.

    Default path is zero-copy ``add_files`` (records footer metadata + stats; no
    data is rewritten). Files with ``timestamp[ns]`` columns can't go through
    ``add_files`` (Iceberg is microsecond-precision) and raise
    :class:`NanosecondTimestampError` unless ``cast_ns_to_us=True``, which streams
    the parquet in batches, casts ns→us, and appends — a one-time rewrite into the
    warehouse, bounded to ``batch_rows`` rows in memory at a time.

    Args:
        table_id: ``namespace.table`` (e.g. ``bronze.twin_power_ribera``).
        parquet_paths: a single path or a list; all files must share one schema.
            Object-store URIs (``s3://...``) are accepted and always take the
            append path (the warehouse must be able to reach the data).
        replace: drop + recreate the table metadata first (source parquet untouched).
        append: add these files to the table if it already exists instead of
            raising. Creates the table when it does not exist yet. Mutually
            exclusive with ``replace``. Idempotency is the caller's job — the
            same file appended twice duplicates its rows.
        cast_ns_to_us: enable the rewrite path for nanosecond-timestamp parquets.
        batch_rows: streaming batch size for the cast path (memory bound).

    Returns:
        Number of rows registered (summed from the parquet footers).
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    if replace and append:
        raise ValueError(
            "register_parquet: replace and append are mutually exclusive "
            "(replace rebuilds the table, append adds to it)."
        )

    if isinstance(parquet_paths, (str, Path)):
        parquet_paths = [parquet_paths]
    parquet_paths = list(parquet_paths)
    if not parquet_paths:
        raise ValueError("register_parquet: no parquet paths given")
    abs_paths, source_fs, remote_sources = _resolve_sources(parquet_paths)

    # Inspect the schema and decide the ingest path BEFORE any destructive action,
    # so an unsupported file can't drop an existing registration on the way to
    # raising.
    arrow_schema = pq.read_schema(abs_paths[0], filesystem=source_fs)
    ns_cols = _ns_timestamp_fields(arrow_schema)
    total_rows = sum(
        pq.read_metadata(p, filesystem=source_fs).num_rows for p in abs_paths
    )

    if ns_cols and not cast_ns_to_us:
        raise NanosecondTimestampError(
            f"{table_id}: columns {ns_cols} are timestamp[ns]; Iceberg is "
            "microsecond-precision. Re-export the parquet at us precision (keeps "
            "the zero-copy add_files path) or pass cast_ns_to_us=True to rewrite."
        )

    cat = get_catalog()
    warehouse = str(cat.properties.get("warehouse", ""))
    is_s3 = (
        warehouse.startswith("s3://")
        or warehouse.startswith("s3a://")
        or os.getenv("LAKE_ENV", "dev") != "dev"  # non-dev = S3 warehouse
    )
    namespace = table_id.split(".")[0]
    cat.create_namespace_if_not_exists(namespace)

    # Idempotency: re-registering would either duplicate rows (add_files) or fail
    # (create_table). Require an explicit replace to rebuild from scratch, or an
    # explicit append to add a new partition to an existing table.
    try:
        existing_table = cat.load_table(table_id)
        exists = True
    except Exception:
        existing_table = None
        exists = False
    if exists and not (replace or append):
        raise TableAlreadyRegisteredError(
            f"{table_id} is already registered. Pass replace=True to rebuild "
            "(or append=True to add a partition) — re-running would duplicate "
            "rows (add_files) or error (create)."
        )
    if exists and replace:
        cat.drop_table(table_id)
        existing_table = None
        exists = False

    # Zero-copy add_files only works for a LOCAL filesystem warehouse with µs
    # timestamps — the registered file paths must be reachable by every reader.
    # For an S3 warehouse (or ns timestamps needing a cast, or remote sources)
    # we append: pyiceberg writes fresh parquet into the warehouse (uploading to
    # S3), streamed in batches to bound memory. safe=False truncates any sub-µs
    # ns (none in this pipeline's hour/day-floored data; guards against stray
    # precision).
    if not is_s3 and not ns_cols and not remote_sources:
        tbl = existing_table if exists else cat.create_table(table_id, schema=arrow_schema)
        tbl.add_files(abs_paths)
        return total_rows

    us_schema = _to_us_schema(arrow_schema)  # == arrow_schema when no ns columns
    tbl = existing_table if exists else cat.create_table(table_id, schema=us_schema)
    # Append into the table's own schema, not the file's: a day-2 file whose
    # DuckDB-inferred types differ cosmetically must still land in the same table.
    target_schema = tbl.schema().as_arrow() if exists else us_schema
    for path in abs_paths:
        pf = pq.ParquetFile(path, filesystem=source_fs)
        for batch in pf.iter_batches(batch_size=batch_rows):
            tbl.append(pa.Table.from_batches([batch]).cast(target_schema, safe=False))
    return total_rows


def _duckdb_iceberg_connection(*, s3: bool = False):
    """A DuckDB connection with the iceberg extension loaded.

    When ``s3=True`` also loads ``httpfs`` and registers an S3 secret that resolves
    credentials from the standard AWS chain (env vars / shared profile / instance
    role), so the identical read path works against an S3 warehouse in staging/prod.
    """
    import duckdb

    con = duckdb.connect()
    try:
        con.execute("INSTALL iceberg;")
        con.execute("LOAD iceberg;")
        # Unsafe version-guessing lets DuckDB resolve the latest metadata without a
        # version-hint file (pyiceberg doesn't write one).
        con.execute("SET unsafe_enable_version_guessing = true;")
        if s3:
            con.execute("INSTALL httpfs;")
            con.execute("LOAD httpfs;")
            region = os.environ.get("AWS_REGION", "eu-west-1")
            con.execute(
                "CREATE SECRET IF NOT EXISTS nuravolt_s3 "
                f"(TYPE s3, PROVIDER credential_chain, REGION '{region}');"
            )
    except Exception:
        con.close()
        raise
    return con


def _build_query(source: str, columns: str, where: Optional[str], limit: Optional[int]) -> str:
    q = f"SELECT {columns} FROM iceberg_scan('{source}')"
    if where:
        q += f" WHERE {where}"
    if limit is not None:
        q += f" LIMIT {int(limit)}"
    return q


def scan_arrow(
    table_id: str,
    *,
    columns: str = "*",
    where: Optional[str] = None,
    limit: Optional[int] = None,
):
    """Read an Iceberg table through DuckDB and return a ``pyarrow.Table``.

    This is the production read path (DuckDB-over-Iceberg). In dev it reads the
    local filesystem warehouse; in prod the identical call reads S3.
    """
    tbl = get_catalog().load_table(table_id)
    source = tbl.metadata_location
    is_s3 = source.startswith("s3://")
    if source.startswith("file://"):
        source = source[len("file://"):]
    con = _duckdb_iceberg_connection(s3=is_s3)
    try:
        # fetch_arrow_table() materializes a pyarrow.Table (vs .arrow() which can
        # hand back a streaming RecordBatchReader depending on the DuckDB build).
        return con.execute(_build_query(source, columns, where, limit)).fetch_arrow_table()
    finally:
        con.close()


def read_table(
    table_id: str,
    *,
    columns: str = "*",
    where: Optional[str] = None,
    limit: Optional[int] = None,
):
    """Read an Iceberg table through DuckDB and return a ``pandas.DataFrame``.

    Pandas is the lingua franca of the existing ``nuravolt/`` ML scripts, so this
    is the drop-in replacement for ``pd.read_parquet(...)``.
    """
    return scan_arrow(table_id, columns=columns, where=where, limit=limit).to_pandas()
