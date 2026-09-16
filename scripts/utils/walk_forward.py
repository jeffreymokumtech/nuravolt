"""
Walk-forward validation utilities for time series forecasting.

Provides functions for creating expanding window splits for backtesting
forecast models on time series data.
"""

import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import List, Tuple, Dict
from pathlib import Path


def create_walk_forward_splits(
    df: pd.DataFrame,
    initial_train_days: int = 730,
    test_window_days: int = 90,
    step_days: int = 30,
    date_column: str = 'date'
) -> List[Tuple[pd.DataFrame, pd.DataFrame]]:
    """
    Create walk-forward validation splits with expanding training windows.

    Strategy:
    - Start with initial_train_days for first training window
    - Test on next test_window_days
    - Slide forward by step_days, expanding training window each time
    - Continue until end of data

    Args:
        df: DataFrame with time series data
        initial_train_days: Initial training period (default 730 = 2 years)
        test_window_days: Test window size (default 90 = 1 quarter)
        step_days: Step size between windows (default 30 = 1 month)
        date_column: Name of date column

    Returns:
        List of (train_df, test_df) tuples representing each validation window

    Example:
        Window 1: Train 2020-2021 (730d) → Test Q1 2022 (90d)
        Window 2: Train 2020-2022-01 (760d) → Test Q2 2022 (90d)
        ...continuing through end of data
    """
    # Ensure date column is datetime
    if not pd.api.types.is_datetime64_any_dtype(df[date_column]):
        df = df.copy()
        df[date_column] = pd.to_datetime(df[date_column])

    # Sort by date
    df = df.sort_values(date_column).reset_index(drop=True)

    # Get date range
    min_date = df[date_column].min()
    max_date = df[date_column].max()

    splits = []
    current_offset = initial_train_days

    while True:
        # Calculate split dates
        train_end_date = min_date + timedelta(days=current_offset)
        test_start_date = train_end_date + timedelta(days=1)
        test_end_date = test_start_date + timedelta(days=test_window_days - 1)

        # Check if we've run out of data
        if test_end_date > max_date:
            break

        # Create train/test splits
        train_mask = df[date_column] <= train_end_date
        test_mask = (df[date_column] >= test_start_date) & (df[date_column] <= test_end_date)

        train_df = df[train_mask].copy()
        test_df = df[test_mask].copy()

        # Only add if we have sufficient data
        if len(train_df) > 0 and len(test_df) > 0:
            splits.append((train_df, test_df))

        # Move to next window
        current_offset += step_days

    return splits


def get_split_info(splits: List[Tuple[pd.DataFrame, pd.DataFrame]], date_column: str = 'date') -> pd.DataFrame:
    """
    Get summary information about walk-forward splits.

    Args:
        splits: List of (train_df, test_df) tuples
        date_column: Name of date column

    Returns:
        DataFrame with split information (window_id, train dates, test dates, counts)
    """
    info_rows = []

    for i, (train_df, test_df) in enumerate(splits, 1):
        info_rows.append({
            'window_id': i,
            'train_start': train_df[date_column].min().date(),
            'train_end': train_df[date_column].max().date(),
            'train_days': len(train_df[date_column].unique()),
            'test_start': test_df[date_column].min().date(),
            'test_end': test_df[date_column].max().date(),
            'test_days': len(test_df[date_column].unique()),
            'train_samples': len(train_df),
            'test_samples': len(test_df)
        })

    return pd.DataFrame(info_rows)


def validate_split_quality(
    splits: List[Tuple[pd.DataFrame, pd.DataFrame]],
    date_column: str = 'date',
    min_train_samples: int = 100,
    min_test_samples: int = 30
) -> Dict[str, any]:
    """
    Validate the quality of walk-forward splits.

    Checks:
    - No temporal overlap between train and test
    - Sufficient samples in each split
    - No date gaps within splits
    - Balanced seasonal coverage

    Args:
        splits: List of (train_df, test_df) tuples
        date_column: Name of date column
        min_train_samples: Minimum required training samples
        min_test_samples: Minimum required test samples

    Returns:
        Dictionary with validation results
    """
    validation_results = {
        'valid': True,
        'warnings': [],
        'errors': [],
        'split_count': len(splits)
    }

    for i, (train_df, test_df) in enumerate(splits, 1):
        window_id = f"Window {i}"

        # Check sample counts
        if len(train_df) < min_train_samples:
            validation_results['errors'].append(
                f"{window_id}: Insufficient training samples ({len(train_df)} < {min_train_samples})"
            )
            validation_results['valid'] = False

        if len(test_df) < min_test_samples:
            validation_results['errors'].append(
                f"{window_id}: Insufficient test samples ({len(test_df)} < {min_test_samples})"
            )
            validation_results['valid'] = False

        # Check temporal ordering
        train_max = train_df[date_column].max()
        test_min = test_df[date_column].min()

        if train_max >= test_min:
            validation_results['errors'].append(
                f"{window_id}: Temporal overlap detected (train_max >= test_min)"
            )
            validation_results['valid'] = False

        # Check for large date gaps (>7 days)
        train_dates = sorted(train_df[date_column].unique())
        if len(train_dates) > 1:
            max_gap = max((train_dates[i+1] - train_dates[i]).days for i in range(len(train_dates)-1))
            if max_gap > 7:
                validation_results['warnings'].append(
                    f"{window_id}: Large gap in training data ({max_gap} days)"
                )

        test_dates = sorted(test_df[date_column].unique())
        if len(test_dates) > 1:
            max_gap = max((test_dates[i+1] - test_dates[i]).days for i in range(len(test_dates)-1))
            if max_gap > 7:
                validation_results['warnings'].append(
                    f"{window_id}: Large gap in test data ({max_gap} days)"
                )

    return validation_results


def get_seasonal_coverage(
    df: pd.DataFrame,
    date_column: str = 'date'
) -> Dict[str, float]:
    """
    Calculate seasonal coverage in dataset.

    Args:
        df: DataFrame with date column
        date_column: Name of date column

    Returns:
        Dictionary with percentage of data in each season
    """
    df = df.copy()
    if not pd.api.types.is_datetime64_any_dtype(df[date_column]):
        df[date_column] = pd.to_datetime(df[date_column])

    # Assign seasons (Northern Hemisphere)
    month = df[date_column].dt.month
    df['season'] = pd.cut(
        month,
        bins=[0, 3, 6, 9, 12],
        labels=['Winter', 'Spring', 'Summer', 'Fall'],
        include_lowest=True
    )

    season_counts = df['season'].value_counts()
    total = len(df)

    coverage = {
        season: (count / total * 100) for season, count in season_counts.items()
    }

    return coverage
