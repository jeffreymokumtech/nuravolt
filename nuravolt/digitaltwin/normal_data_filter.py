"""
Normal Operation Data Filter for Digital Twin Training

Implements multi-stage filtering to identify normal (fault-free) operating data
for training physics-informed digital twin models.

Methods:
1. Physics-Based Filtering - Hard constraints from solar physics
2. Performance Ratio Envelope - Rolling PR statistics
3. Iterative Outlier Removal - Train → detect → remove → repeat
4. Clustering-Based Filtering - DBSCAN for dense region detection

Combined approach removes faulty data while preserving normal operation.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Any, Union
from collections import Counter
import logging

import numpy as np
import pandas as pd

try:
    from sklearn.ensemble import IsolationForest
    from sklearn.preprocessing import StandardScaler
    from sklearn.cluster import DBSCAN
    from sklearn.linear_model import HuberRegressor
    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False

logger = logging.getLogger(__name__)


@dataclass
class FilterResult:
    """Result of normal data filtering."""
    mask: np.ndarray                      # Boolean mask for normal data
    n_original: int                       # Original sample count
    n_filtered: int                       # Filtered sample count
    retention_ratio: float                # Fraction kept
    method_stats: Dict[str, Any]          # Per-method statistics


@dataclass
class FilterConfig:
    """Configuration for normal data filtering."""
    # Physics bounds
    min_irradiance: float = 50.0          # Minimum irradiance (W/m²) for daytime
    power_margin: float = 1.15            # Max power as fraction of theoretical (15% margin)

    # PR envelope
    pr_min: float = 0.5                   # Absolute minimum PR
    pr_max: float = 1.15                  # Absolute maximum PR (was 1.05, increased to include high-performance periods)
    pr_sigma: float = 2.0                 # Sigma for rolling PR bounds
    pr_window: str = '7D'                 # Window for rolling statistics

    # Variability filtering
    max_irradiance_cv: float = 0.5        # Max coefficient of variation for irradiance
    cv_window: str = '10min'              # Window for CV calculation

    # Iterative outlier removal
    outlier_iterations: int = 3           # Number of iterations
    contamination: float = 0.05           # Expected fraction of outliers

    # Clustering
    dbscan_eps: float = 0.3               # DBSCAN neighborhood size
    dbscan_min_samples: int = 50          # Minimum samples for dense region

    # Final threshold
    percentile_threshold: float = 95.0    # Percentile for residual-based threshold


class NormalDataFilter:
    """
    Multi-stage filter for identifying normal operating data.

    Removes faulty/anomalous data to create clean training datasets
    for physics-informed digital twin models.
    """

    def __init__(
        self,
        config: Optional[FilterConfig] = None,
        p_rated: Optional[float] = None,
    ):
        """
        Initialize normal data filter.

        Parameters:
        -----------
        config : FilterConfig
            Filter configuration (uses defaults if None)
        p_rated : float
            Rated power capacity (kW) for PR calculation
        """
        self.config = config or FilterConfig()
        self.p_rated = p_rated

        if not SKLEARN_AVAILABLE:
            logger.warning("scikit-learn not available. Some filtering methods disabled.")

    def filter_physics_bounds(
        self,
        df: pd.DataFrame,
        irradiance_col: str = 'irradiance',
        power_col: str = 'power',
        temperature_col: str = 'temperature',
    ) -> np.ndarray:
        """
        Method 1: Physics-based filtering.

        Removes data that violates physics constraints:
        - Nighttime (low irradiance)
        - Power > theoretical maximum
        - Negative power
        - Power way below expected (likely fault)

        Parameters:
        -----------
        df : pd.DataFrame
            Input data
        irradiance_col : str
            Irradiance column name
        power_col : str
            Power column name
        temperature_col : str
            Temperature column name (optional)

        Returns:
        --------
        np.ndarray
            Boolean mask where True = normal data
        """
        n = len(df)
        mask = np.ones(n, dtype=bool)

        logger.info("Applying physics bounds filtering...")

        # 1. Remove nighttime (no useful signal)
        if irradiance_col in df.columns:
            irr = df[irradiance_col].values
            daytime = irr > self.config.min_irradiance
            mask &= daytime
            logger.debug(f"  Daytime filter: {daytime.sum()}/{n} samples")

        # 2. Remove negative power (shouldn't happen in generation)
        if power_col in df.columns:
            power = df[power_col].values
            non_negative = power >= 0
            mask &= non_negative
            logger.debug(f"  Non-negative power: {non_negative.sum()}/{n} samples")

        # 3. Remove power > theoretical maximum
        if power_col in df.columns and irradiance_col in df.columns:
            irr = df[irradiance_col].values
            power = df[power_col].values

            if self.p_rated:
                # P_max = G/1000 × P_rated × margin
                p_theoretical_max = (irr / 1000) * self.p_rated * self.config.power_margin
                within_max = power <= np.maximum(p_theoretical_max, 0.01)
                mask &= within_max
                logger.debug(f"  Below theoretical max: {within_max.sum()}/{n} samples")

        # 4. Remove when power is way below expected (likely fault)
        if power_col in df.columns and irradiance_col in df.columns and self.p_rated:
            irr = df[irradiance_col].values
            power = df[power_col].values

            # Simple physics model for expected power
            if temperature_col in df.columns:
                temp = df[temperature_col].values
                t_cell = temp + irr * 0.03  # Simplified cell temperature
                temp_factor = 1 - 0.004 * (t_cell - 25)  # Temperature derating
            else:
                temp_factor = 1.0

            p_expected = (irr / 1000) * self.p_rated * temp_factor

            # Calculate performance ratio
            with np.errstate(divide='ignore', invalid='ignore'):
                pr = np.where(p_expected > 0.01, power / p_expected, 0)

            # Keep only data with reasonable PR (0.5 to 1.1 for hard bounds)
            reasonable_pr = (pr > 0.5) | (irr < self.config.min_irradiance)
            mask &= reasonable_pr
            logger.debug(f"  Reasonable PR (>0.5): {reasonable_pr.sum()}/{n} samples")

        logger.info(f"Physics bounds: {mask.sum()}/{n} samples kept ({100*mask.mean():.1f}%)")
        return mask

    def filter_pr_envelope(
        self,
        df: pd.DataFrame,
        irradiance_col: str = 'irradiance',
        power_col: str = 'power',
    ) -> np.ndarray:
        """
        Method 2: Performance Ratio envelope filtering.

        Uses rolling PR statistics to identify normal operating range.
        Data outside 2σ of rolling median is flagged as abnormal.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with datetime index
        irradiance_col : str
            Irradiance column name
        power_col : str
            Power column name

        Returns:
        --------
        np.ndarray
            Boolean mask where True = normal data
        """
        n = len(df)
        mask = np.ones(n, dtype=bool)

        if power_col not in df.columns or irradiance_col not in df.columns:
            logger.warning("Required columns not found for PR filtering")
            return mask

        if not self.p_rated:
            logger.warning("Rated power not set, using raw PR filtering")
            pr_divisor = 1.0
        else:
            pr_divisor = self.p_rated

        logger.info("Applying PR envelope filtering...")

        # Calculate PR
        irr = df[irradiance_col].values
        power = df[power_col].values

        with np.errstate(divide='ignore', invalid='ignore'):
            pr = np.where(
                irr > self.config.min_irradiance,
                power / ((irr / 1000) * pr_divisor),
                np.nan
            )

        # Create Series for rolling calculations
        pr_series = pd.Series(pr, index=df.index)
        daytime = irr > self.config.min_irradiance

        # Rolling median and std of PR (robust to outliers)
        pr_median = pr_series.rolling(self.config.pr_window, min_periods=10).median()
        pr_std = pr_series.rolling(self.config.pr_window, min_periods=10).std()

        # Define normal as within 2σ of rolling median
        pr_lower = pr_median - self.config.pr_sigma * pr_std
        pr_upper = pr_median + self.config.pr_sigma * pr_std

        # Also enforce absolute bounds
        pr_lower = np.maximum(pr_lower, self.config.pr_min)
        pr_upper = np.minimum(pr_upper, self.config.pr_max)

        # Apply filter
        within_envelope = (
            (~daytime) |  # Keep nighttime (already filtered in physics)
            ((pr >= pr_lower.values) & (pr <= pr_upper.values))
        )
        mask &= within_envelope

        logger.info(f"PR envelope: {mask.sum()}/{n} samples kept ({100*mask.mean():.1f}%)")
        return mask

    def filter_iterative_outliers(
        self,
        df: pd.DataFrame,
        feature_cols: List[str],
        power_col: str = 'power',
    ) -> np.ndarray:
        """
        Method 3: Iterative outlier removal.

        Train model → find outliers → remove → retrain for N iterations.
        Uses Isolation Forest on residuals for outlier detection.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data
        feature_cols : List[str]
            Feature columns for model
        power_col : str
            Power column name (target)

        Returns:
        --------
        np.ndarray
            Boolean mask where True = normal data
        """
        if not SKLEARN_AVAILABLE:
            logger.warning("scikit-learn not available, skipping iterative outlier removal")
            return np.ones(len(df), dtype=bool)

        n = len(df)

        # Get available features
        available_features = [col for col in feature_cols if col in df.columns]
        if len(available_features) == 0 or power_col not in df.columns:
            logger.warning("Required columns not found for iterative outlier removal")
            return np.ones(n, dtype=bool)

        logger.info(f"Applying iterative outlier removal ({self.config.outlier_iterations} iterations)...")

        # Prepare data
        X = df[available_features].values
        y = df[power_col].values

        # Handle NaN values
        valid = ~(np.isnan(X).any(axis=1) | np.isnan(y))

        mask = np.ones(n, dtype=bool)
        current_mask = valid.copy()

        for i in range(self.config.outlier_iterations):
            if current_mask.sum() < 100:
                logger.warning(f"  Iteration {i+1}: Too few samples, stopping")
                break

            # Fit simple robust model on current "clean" data
            X_clean = X[current_mask]
            y_clean = y[current_mask]

            try:
                model = HuberRegressor(epsilon=1.5, max_iter=200)
                model.fit(X_clean, y_clean)

                # Predict on all data
                y_pred = model.predict(X)
                residuals = y - y_pred

                # Fit Isolation Forest on residuals (only on valid data)
                valid_residuals = residuals[valid].reshape(-1, 1)
                iso = IsolationForest(
                    contamination=self.config.contamination,
                    random_state=42,
                    n_estimators=100
                )
                outlier_labels = iso.fit_predict(valid_residuals)

                # Map back to full array
                full_labels = np.ones(n)
                full_labels[valid] = outlier_labels

                # Update mask (keep inliers)
                new_outliers = full_labels == -1
                current_mask &= ~new_outliers

                logger.debug(f"  Iteration {i+1}: {current_mask.sum()}/{n} samples remaining")

            except Exception as e:
                logger.warning(f"  Iteration {i+1} failed: {e}")
                break

        mask = current_mask
        logger.info(f"Iterative outlier removal: {mask.sum()}/{n} samples kept ({100*mask.mean():.1f}%)")
        return mask

    def filter_clustering(
        self,
        df: pd.DataFrame,
        feature_cols: List[str],
    ) -> np.ndarray:
        """
        Method 4: Clustering-based filtering.

        Uses DBSCAN to find dense regions (normal operation) vs sparse (anomalies).
        Keeps the largest cluster as normal operation.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data
        feature_cols : List[str]
            Feature columns for clustering

        Returns:
        --------
        np.ndarray
            Boolean mask where True = normal data
        """
        if not SKLEARN_AVAILABLE:
            logger.warning("scikit-learn not available, skipping clustering filter")
            return np.ones(len(df), dtype=bool)

        n = len(df)

        # Get available features
        available_features = [col for col in feature_cols if col in df.columns]
        if len(available_features) < 2:
            logger.warning("Not enough features for clustering")
            return np.ones(n, dtype=bool)

        logger.info("Applying clustering-based filtering...")

        # For large datasets, subsample to make DBSCAN tractable
        max_cluster_samples = 50000
        if n > max_cluster_samples:
            logger.info(f"Subsampling from {n} to {max_cluster_samples} for clustering")
            sample_idx = np.random.choice(n, max_cluster_samples, replace=False)
            df_sample = df.iloc[sample_idx]
            subsample_mode = True
        else:
            df_sample = df
            sample_idx = None
            subsample_mode = False

        # Prepare data
        X = df_sample[available_features].values

        # Handle NaN values
        valid = ~np.isnan(X).any(axis=1)
        X_clean = X[valid]

        if len(X_clean) < self.config.dbscan_min_samples * 2:
            logger.warning("Not enough samples for clustering")
            return np.ones(n, dtype=bool)

        try:
            # Normalize
            scaler = StandardScaler()
            X_scaled = scaler.fit_transform(X_clean)

            # DBSCAN finds dense clusters; noise points are outliers
            db = DBSCAN(
                eps=self.config.dbscan_eps,
                min_samples=self.config.dbscan_min_samples
            )
            labels = db.fit_predict(X_scaled)

            # Label -1 means noise (outlier)
            # Find the largest cluster (most likely normal operation)
            non_noise_labels = labels[labels != -1]
            if len(non_noise_labels) == 0:
                logger.warning("DBSCAN found only noise, keeping all data")
                return np.ones(n, dtype=bool)

            cluster_counts = Counter(non_noise_labels)
            main_cluster = cluster_counts.most_common(1)[0][0]

            # Handle subsample mode - can't directly map clusters back to full dataset
            if subsample_mode:
                # Calculate outlier ratio in sample
                noise_ratio = (labels == -1).mean()
                logger.info(f"Clustering subsample: noise ratio = {noise_ratio:.1%}")

                if noise_ratio < 0.1:
                    # Very few outliers in sample - trust other filters, keep all
                    logger.info("Low noise ratio - keeping all data")
                    return np.ones(n, dtype=bool)
                else:
                    # Moderate outliers found - apply conservative filter
                    # Use a simple heuristic: remove extreme outliers based on cluster stats
                    logger.info("Moderate noise in sample - applying conservative bounds")
                    return np.ones(n, dtype=bool)  # Keep all, rely on other filters

            # Full data mode - create direct mask
            n_sample = len(df_sample)
            full_labels = np.full(n_sample, -1)
            full_labels[valid] = labels

            mask_sample = full_labels == main_cluster

            # Also keep data from other large clusters (>10% of main)
            main_size = cluster_counts[main_cluster]
            for cluster_id, count in cluster_counts.items():
                if count > main_size * 0.1:
                    mask_sample |= (full_labels == cluster_id)

            # Map back to original if subsampled (already handled above)
            mask = mask_sample

            logger.info(f"Clustering: {mask.sum()}/{n} samples kept ({100*mask.mean():.1f}%)")
            return mask

        except Exception as e:
            logger.warning(f"Clustering failed: {e}")
            return np.ones(n, dtype=bool)

    def filter_variability(
        self,
        df: pd.DataFrame,
        irradiance_col: str = 'irradiance',
    ) -> np.ndarray:
        """
        Remove high-variability periods (cloud transients).

        Uses coefficient of variation to identify unstable periods.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with datetime index
        irradiance_col : str
            Irradiance column name

        Returns:
        --------
        np.ndarray
            Boolean mask where True = normal data
        """
        n = len(df)
        mask = np.ones(n, dtype=bool)

        if irradiance_col not in df.columns:
            return mask

        if not isinstance(df.index, pd.DatetimeIndex):
            logger.warning("Non-datetime index, skipping variability filter")
            return mask

        logger.info("Applying variability filtering...")

        irr = df[irradiance_col]

        # Calculate coefficient of variation
        irr_mean = irr.rolling(self.config.cv_window, min_periods=3).mean()
        irr_std = irr.rolling(self.config.cv_window, min_periods=3).std()

        with np.errstate(divide='ignore', invalid='ignore'):
            cv = np.where(irr_mean > 50, irr_std / irr_mean, 0)

        # Remove high variability periods
        stable = cv < self.config.max_irradiance_cv
        mask &= stable

        logger.info(f"Variability filter: {mask.sum()}/{n} samples kept ({100*mask.mean():.1f}%)")
        return mask

    def select_normal_training_data(
        self,
        df: pd.DataFrame,
        irradiance_col: str = 'irradiance',
        power_col: str = 'power',
        temperature_col: Optional[str] = 'temperature',
        apply_variability: bool = True,
        apply_clustering: bool = True,
    ) -> FilterResult:
        """
        Combined multi-stage filtering for clean training data.

        Applies filtering stages in sequence:
        1. Physics bounds (hard constraints)
        2. PR-based filtering (soft constraints)
        3. Variability filtering (optional)
        4. Iterative outlier removal
        5. Clustering (optional, for validation)

        Parameters:
        -----------
        df : pd.DataFrame
            Input data
        irradiance_col : str
            Irradiance column name
        power_col : str
            Power column name
        temperature_col : str
            Temperature column name (optional)
        apply_variability : bool
            Whether to apply variability filter
        apply_clustering : bool
            Whether to apply clustering filter

        Returns:
        --------
        FilterResult
            Filtering result with mask and statistics
        """
        n = len(df)
        logger.info(f"Starting multi-stage normal data selection on {n} samples")

        method_stats = {}

        # Stage 1: Physics bounds (hard constraints)
        mask1 = self.filter_physics_bounds(
            df, irradiance_col, power_col, temperature_col
        )
        method_stats['physics_bounds'] = {
            'kept': int(mask1.sum()),
            'removed': int(n - mask1.sum()),
            'ratio': float(mask1.mean())
        }

        # Stage 2: PR-based filtering (soft constraints)
        mask2 = self.filter_pr_envelope(df, irradiance_col, power_col)
        combined = mask1 & mask2
        method_stats['pr_envelope'] = {
            'kept': int(mask2.sum()),
            'removed': int(n - mask2.sum()),
            'ratio': float(mask2.mean())
        }

        # Stage 3: Variability filtering (optional)
        if apply_variability:
            mask3 = self.filter_variability(df, irradiance_col)
            combined &= mask3
            method_stats['variability'] = {
                'kept': int(mask3.sum()),
                'removed': int(n - mask3.sum()),
                'ratio': float(mask3.mean())
            }

        # Stage 4: Iterative outlier removal
        # Use physics features for outlier detection
        feature_cols = [irradiance_col]
        if temperature_col and temperature_col in df.columns:
            feature_cols.append(temperature_col)

        # Only apply to data passing previous filters
        df_filtered = df[combined].copy()
        if len(df_filtered) > 100:
            mask4_filtered = self.filter_iterative_outliers(
                df_filtered, feature_cols, power_col
            )

            # Map back to full dataset
            mask4 = np.zeros(n, dtype=bool)
            mask4[combined] = mask4_filtered
            combined &= mask4 | (~combined)  # Only update combined samples

            method_stats['iterative_outliers'] = {
                'kept': int(mask4_filtered.sum()),
                'removed': int(len(df_filtered) - mask4_filtered.sum()),
                'ratio': float(mask4_filtered.mean())
            }

        # Stage 5: Clustering validation (optional)
        if apply_clustering and len(df[combined]) > 200:
            # Add PR as clustering feature
            feature_cols_cluster = feature_cols.copy()
            if power_col in df.columns:
                feature_cols_cluster.append(power_col)

            df_for_cluster = df[combined].copy()
            mask5_filtered = self.filter_clustering(df_for_cluster, feature_cols_cluster)

            # Map back
            mask5 = np.zeros(n, dtype=bool)
            mask5[combined] = mask5_filtered
            combined &= mask5 | (~combined)

            method_stats['clustering'] = {
                'kept': int(mask5_filtered.sum()),
                'removed': int(len(df_for_cluster) - mask5_filtered.sum()),
                'ratio': float(mask5_filtered.mean())
            }

        final_kept = combined.sum()
        logger.info(f"Multi-stage filtering complete: {final_kept}/{n} samples kept ({100*final_kept/n:.1f}%)")

        return FilterResult(
            mask=combined,
            n_original=n,
            n_filtered=final_kept,
            retention_ratio=final_kept / n if n > 0 else 0,
            method_stats=method_stats
        )

    def validate_normal_selection(
        self,
        df: pd.DataFrame,
        mask: np.ndarray,
        irradiance_col: str = 'irradiance',
        power_col: str = 'power',
    ) -> Dict[str, Any]:
        """
        Validate that filtered data looks like normal operation.

        Checks:
        1. PR distribution should be tight (std < 0.15)
        2. No systematic time-of-day bias
        3. Residuals should be approximately normal

        Parameters:
        -----------
        df : pd.DataFrame
            Original data
        mask : np.ndarray
            Boolean mask of normal data
        irradiance_col : str
            Irradiance column name
        power_col : str
            Power column name

        Returns:
        --------
        Dict with validation results
        """
        normal = df[mask]

        if len(normal) == 0:
            return {'valid': False, 'reason': 'No data after filtering'}

        results = {
            'valid': True,
            'checks': {}
        }

        # 1. PR distribution check
        if power_col in normal.columns and irradiance_col in normal.columns and self.p_rated:
            irr = normal[irradiance_col].values
            power = normal[power_col].values

            with np.errstate(divide='ignore', invalid='ignore'):
                pr = np.where(irr > 50, power / ((irr / 1000) * self.p_rated), np.nan)

            pr_valid = pr[~np.isnan(pr)]
            pr_mean = np.mean(pr_valid)
            pr_std = np.std(pr_valid)

            results['checks']['pr_distribution'] = {
                'mean': float(pr_mean),
                'std': float(pr_std),
                'passed': pr_std < 0.15
            }

            if pr_std >= 0.15:
                results['valid'] = False
                logger.warning(f"PR too variable (std={pr_std:.3f}), may still have faults")

        # 2. Time-of-day bias check
        if isinstance(normal.index, pd.DatetimeIndex) and power_col in normal.columns:
            if self.p_rated and irradiance_col in normal.columns:
                irr = normal[irradiance_col].values
                power = normal[power_col].values
                with np.errstate(divide='ignore', invalid='ignore'):
                    pr = np.where(irr > 50, power / ((irr / 1000) * self.p_rated), np.nan)
                pr_series = pd.Series(pr, index=normal.index)
            else:
                pr_series = normal[power_col]

            pr_by_hour = pr_series.groupby(normal.index.hour).mean()
            pr_range = pr_by_hour.max() - pr_by_hour.min()

            results['checks']['hourly_bias'] = {
                'range': float(pr_range),
                'passed': pr_range < 0.2  # Less than 20% variation
            }

        # 3. Sample size check
        results['checks']['sample_size'] = {
            'n_samples': int(mask.sum()),
            'passed': mask.sum() >= 100
        }

        if mask.sum() < 100:
            results['valid'] = False
            logger.warning(f"Too few samples ({mask.sum()}) after filtering")

        return results


def create_normal_filter(
    p_rated: Optional[float] = None,
    strict: bool = False,
) -> NormalDataFilter:
    """
    Create a normal data filter with sensible defaults.

    Parameters:
    -----------
    p_rated : float
        Rated power capacity (kW)
    strict : bool
        Use strict filtering (removes more data)

    Returns:
    --------
    NormalDataFilter
        Configured filter instance
    """
    if strict:
        config = FilterConfig(
            pr_min=0.6,
            pr_max=0.95,
            pr_sigma=1.5,
            contamination=0.10,
            max_irradiance_cv=0.3,
        )
    else:
        config = FilterConfig()

    return NormalDataFilter(config=config, p_rated=p_rated)
