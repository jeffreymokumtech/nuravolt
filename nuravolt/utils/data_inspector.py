"""Utilities for inspecting plant SCADA data."""
import polars as pl
from pathlib import Path
from typing import Tuple
from datetime import datetime


def get_scada_date_range(parquet_path: Path, timestamp_column: str = 'timestamp') -> Tuple[str, str]:
    """
    Extract actual SCADA data date range from parquet file.

    Args:
        parquet_path: Path to SCADA parquet file
        timestamp_column: Name of timestamp column (default: 'timestamp')

    Returns:
        Tuple of (start_date, end_date) as 'YYYY-MM-DD' strings

    Example:
        >>> get_scada_date_range(Path('data/eta.parquet'))
        ('2020-01-15', '2024-12-10')
    """
    # Use lazy scan for memory efficiency
    df = pl.scan_parquet(parquet_path).select(timestamp_column).collect()

    min_date = df.select(pl.col(timestamp_column).min()).item()
    max_date = df.select(pl.col(timestamp_column).max()).item()

    # Convert to ISO date strings
    if hasattr(min_date, 'date'):
        # Python datetime object
        return (min_date.date().isoformat(), max_date.date().isoformat())
    elif hasattr(min_date, 'isoformat'):
        # Python date object or datetime
        return (min_date.isoformat()[:10], max_date.isoformat()[:10])
    elif isinstance(min_date, str):
        # String timestamps - try common formats
        for fmt in ['%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y.%m.%d %H:%M', '%Y-%m-%d']:
            try:
                min_dt = datetime.strptime(min_date, fmt)
                max_dt = datetime.strptime(max_date, fmt)
                return (min_dt.strftime('%Y-%m-%d'), max_dt.strftime('%Y-%m-%d'))
            except ValueError:
                continue

        # If no format worked, try ISO format as last resort
        try:
            min_dt = datetime.fromisoformat(min_date)
            max_dt = datetime.fromisoformat(max_date)
            return (min_dt.strftime('%Y-%m-%d'), max_dt.strftime('%Y-%m-%d'))
        except ValueError:
            raise ValueError(f"Unable to parse timestamp format: {min_date}")
    else:
        raise TypeError(f"Unsupported timestamp type: {type(min_date)}")
