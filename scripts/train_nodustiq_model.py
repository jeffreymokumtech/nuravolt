#!/usr/bin/env python3
"""
Train No-DustIQ Per-Inverter Soiling Ratio Model

This script trains a soiling ratio model using only:
- Rain data (Open-Meteo)
- AOD/Dust data (CAMS)
- PR data (per-inverter)

No DustIQ sensor required - uses pseudo-labels derived from rain patterns.

Author: NuraVolt Team
"""

import sys
import json
import logging
from pathlib import Path
from datetime import datetime
import numpy as np
import pandas as pd
import polars as pl
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Check for catboost
try:
    from catboost import CatBoostRegressor, Pool
    CATBOOST_AVAILABLE = True
except ImportError:
    CATBOOST_AVAILABLE = False
    logger.warning("CatBoost not installed. Install with: pip install catboost")


def load_rain_data(data_dir: Path) -> pd.DataFrame:
    """Load rain history from JSON."""
    rain_path = data_dir / 'rain_history.json'

    with open(rain_path) as f:
        rain_data = json.load(f)

    daily_data = rain_data.get('daily_data', [])
    df = pd.DataFrame(daily_data)
    df['date'] = pd.to_datetime(df['date'])

    # Rename columns for consistency
    if 'precipitation_sum' in df.columns:
        df['precipitation_mm'] = df['precipitation_sum']

    logger.info(f"Loaded rain data: {len(df)} days")
    return df


def load_dust_data(data_dir: Path) -> pd.DataFrame:
    """Load dust/AOD history from JSON."""
    dust_path = data_dir / 'dust_history.json'

    if not dust_path.exists():
        logger.warning("Dust data not found, using defaults")
        return None

    with open(dust_path) as f:
        dust_data = json.load(f)

    daily_data = dust_data.get('daily_data', [])
    df = pd.DataFrame(daily_data)
    df['date'] = pd.to_datetime(df['date'])

    # Use dust or pm10 as proxy for AOD
    if 'dust' in df.columns:
        # Convert dust concentration to pseudo-AOD (normalize to 0-1 range)
        df['aod_550'] = df['dust'] / 100.0  # Approximate conversion
    elif 'pm10' in df.columns:
        df['aod_550'] = df['pm10'] / 200.0  # Approximate conversion
    elif 'aod_550nm' in df.columns:
        df['aod_550'] = df['aod_550nm']
    elif 'aod' in df.columns:
        df['aod_550'] = df['aod']
    else:
        df['aod_550'] = 0.3  # Default value

    logger.info(f"Loaded dust data: {len(df)} days")
    return df


def load_inverter_data(data_dir: Path) -> tuple:
    """Load per-inverter data from JSON files."""
    # Load all_inverters.json for metadata
    all_inv_path = data_dir / 'all_inverters.json'
    with open(all_inv_path) as f:
        all_inverters = json.load(f)

    inverters_list = all_inverters.get('inverters', [])

    # Build metadata dataframe
    metadata = []
    for inv in inverters_list:
        inv_id = inv.get('inverterId', inv.get('inverter_id', inv.get('id')))
        group_id = inv.get('groupId', inv.get('group', inv_id[:6] if inv_id else 'INV 01'))

        # Handle nested soiling_ratio - use 'mean' from the actual JSON structure
        sr_data = inv.get('soilingRatio', inv.get('soiling_ratio', {}))
        if isinstance(sr_data, dict):
            sr_baseline = sr_data.get('mean', sr_data.get('current', 0.98))
        else:
            sr_baseline = sr_data if sr_data else 0.98

        # Use fleet comparison deviation as anomaly indicator
        fleet_data = inv.get('fleetComparison', {})
        if isinstance(fleet_data, dict):
            # Use z-score as anomaly rate indicator (normalized)
            z_score = abs(fleet_data.get('zScore', 0))
            anomaly_rate = min(z_score / 10.0, 1.0)  # Normalize to 0-1
        else:
            anomaly_rate = 0.05

        # Performance ratio - direct value in the JSON
        pr_mean = inv.get('performanceRatio', inv.get('performance_ratio', 0.85))
        if isinstance(pr_mean, dict):
            pr_mean = pr_mean.get('mean', pr_mean.get('current', 0.85))

        metadata.append({
            'inverter_id': inv_id,
            'group_id': group_id,
            'sr_baseline': sr_baseline,
            'anomaly_rate': anomaly_rate,
            'pr_mean': pr_mean
        })

    df_metadata = pd.DataFrame(metadata)

    # Load daily PR data from time_series/daily_pr.json
    pr_path = data_dir / 'time_series' / 'daily_pr.json'
    pr_data = []

    if pr_path.exists():
        with open(pr_path) as f:
            pr_json = json.load(f)

        for record in pr_json.get('data', []):
            pr_data.append({
                'date': record.get('date'),
                'inverter_id': record.get('inverterId', record.get('inverter_id')),
                'pr': record.get('pr', 0.85),
            })

    df_pr = pd.DataFrame(pr_data) if pr_data else pd.DataFrame(columns=['date', 'inverter_id', 'pr'])
    if len(df_pr) > 0:
        df_pr['date'] = pd.to_datetime(df_pr['date'])

    logger.info(f"Loaded {len(df_metadata)} inverters, {len(df_pr)} PR records")
    return df_metadata, df_pr


def create_rainfall_features(df_rain: pd.DataFrame) -> pd.DataFrame:
    """Create rainfall-based features."""
    df = df_rain.copy()

    # Rolling sums
    for window in [7, 14, 30]:
        df[f'rainfall_sum_{window}d'] = df['precipitation_mm'].rolling(window, min_periods=1).sum()

    # Days since significant rain
    df['is_rain_day'] = (df['precipitation_mm'] >= 0.5).astype(int)
    df['is_cleaning_rain'] = (df['precipitation_mm'] >= 5.0).astype(int)
    df['is_heavy_rain'] = (df['precipitation_mm'] >= 10.0).astype(int)

    # Days since rain
    df['days_since_rain'] = 0
    days_counter = 0
    for i in range(len(df)):
        if df.iloc[i]['is_rain_day'] == 1:
            days_counter = 0
        else:
            days_counter += 1
        df.iloc[i, df.columns.get_loc('days_since_rain')] = days_counter

    # Rain events count
    for window in [30, 90]:
        df[f'rain_events_{window}d'] = df['is_cleaning_rain'].rolling(window, min_periods=1).sum()

    return df


def create_temporal_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add temporal features."""
    df = df.copy()

    df['day_of_year'] = df['date'].dt.dayofyear
    df['month'] = df['date'].dt.month
    df['day_of_year_sin'] = np.sin(2 * np.pi * df['day_of_year'] / 365)
    df['day_of_year_cos'] = np.cos(2 * np.pi * df['day_of_year'] / 365)
    df['month_sin'] = np.sin(2 * np.pi * df['month'] / 12)
    df['month_cos'] = np.cos(2 * np.pi * df['month'] / 12)

    # Dry season indicator (Spain: May-Sept)
    df['is_dry_season'] = df['month'].isin([5, 6, 7, 8, 9]).astype(int)

    return df


def generate_pseudo_labels(df: pd.DataFrame) -> pd.DataFrame:
    """Generate plant-level pseudo-labels for SR based on rain patterns."""
    df = df.copy()

    # Initialize SR at 1.0
    sr_values = np.ones(len(df))

    # Base soiling rate (%/day)
    base_soiling_rate = 0.002

    # Get AOD factor if available
    aod_col = 'aod_550' if 'aod_550' in df.columns else None

    for i in range(1, len(df)):
        precip = df.iloc[i]['precipitation_mm']

        # Rain resets SR
        if precip >= 10.0:  # Heavy rain
            sr_values[i] = 1.0
        elif precip >= 5.0:  # Cleaning rain
            sr_values[i] = 0.995
        elif precip >= 3.0:  # Light rain
            sr_values[i] = max(sr_values[i-1], 0.98)
        else:
            # Apply soiling decay
            aod_factor = 1.0
            if aod_col and pd.notna(df.iloc[i].get(aod_col)):
                aod = df.iloc[i][aod_col]
                aod_factor = 1.0 + (aod / 0.3) * 0.5  # AOD increases soiling

            daily_soiling = base_soiling_rate * aod_factor
            sr_values[i] = max(0.75, sr_values[i-1] - daily_soiling)

    df['sr_pseudo_plant'] = sr_values

    # Confidence based on rain proximity
    df['confidence'] = 0.6  # Base confidence
    df.loc[df['is_heavy_rain'] == 1, 'confidence'] = 0.99
    df.loc[df['is_cleaning_rain'] == 1, 'confidence'] = 0.90
    df.loc[df['days_since_rain'] <= 2, 'confidence'] = 0.85

    return df


def generate_per_inverter_pseudo_labels(df_expanded: pd.DataFrame) -> pd.DataFrame:
    """
    Generate per-inverter pseudo-labels that vary based on:
    1. Plant-level rain/dust patterns (baseline)
    2. Per-inverter PR deviation (lower PR → likely more soiled)
    3. Curtailment detection (extremely low PR with no pattern → likely curtailed)
    """
    df = df_expanded.copy()

    # Start with plant-level SR as baseline
    df['sr_pseudo'] = df['sr_pseudo_plant'].copy()

    # Detect curtailment: sudden PR drops not explained by fleet pattern
    # Curtailed inverters have PR << fleet average but are not actually soiled
    # We'll mark these and exclude from soiling impact
    pr_threshold = 0.3  # PR below 30% is likely curtailment
    df['is_curtailed'] = (df['inverter_pr'] < pr_threshold) & (df['fleet_pr_mean'] > 0.5)

    # Calculate "soiling signal" from PR deviation
    # Negative PR deviation → underperforming → likely more soiled
    # But only if not curtailed
    soiling_from_pr = np.where(
        ~df['is_curtailed'],
        # Non-curtailed: PR deviation indicates soiling
        # Scale: -0.1 PR deviation → +0.02 soiling loss (2% more soiled)
        -df['inverter_pr_deviation'] * 0.2,
        0  # Curtailed: no soiling signal
    )

    # Add per-inverter soiling component (bounded)
    # More negative PR deviation = more soiling loss from baseline
    soiling_from_pr = np.clip(soiling_from_pr, -0.03, 0.05)

    # Apply to plant-level SR
    df['sr_pseudo'] = df['sr_pseudo_plant'] - soiling_from_pr
    df['sr_pseudo'] = df['sr_pseudo'].clip(0.75, 1.0)

    # Also incorporate baseline SR characteristic
    # Inverters with historically lower SR baseline are more prone to soiling
    sr_baseline_factor = (1.0 - df['inverter_sr_baseline']) * 0.3  # Small factor
    df['sr_pseudo'] = df['sr_pseudo'] - sr_baseline_factor
    df['sr_pseudo'] = df['sr_pseudo'].clip(0.75, 1.0)

    # Reduce confidence for curtailed samples
    df.loc[df['is_curtailed'], 'confidence'] *= 0.5

    logger.info(f"Per-inverter pseudo-labels: SR range {df['sr_pseudo'].min():.4f} - {df['sr_pseudo'].max():.4f}")
    logger.info(f"Curtailed samples: {df['is_curtailed'].sum()} ({100*df['is_curtailed'].mean():.1f}%)")

    return df


def expand_to_per_inverter(
    df_plant: pd.DataFrame,
    df_metadata: pd.DataFrame,
    df_pr: pd.DataFrame
) -> pd.DataFrame:
    """Expand plant-level features to per-inverter rows using Polars for performance."""

    logger.info("Converting to Polars for optimized cross-join...")

    # Convert to Polars LazyFrames for maximum performance
    pl_plant = pl.from_pandas(df_plant).lazy()
    pl_metadata = pl.from_pandas(df_metadata).lazy()

    # Pre-process inverter metadata: extract group number
    pl_metadata = pl_metadata.with_columns([
        pl.col('group_id').cast(pl.Utf8)
        .str.replace_all('INV', '')
        .str.replace_all('_', '')
        .str.replace_all(' ', '')
        .str.strip_chars()
        .cast(pl.Int32, strict=False)
        .fill_null(1)
        .alias('inverter_group_encoded')
    ])

    # Perform cross-join: every date × every inverter (vectorized!)
    logger.info("Performing vectorized cross-join...")
    pl_expanded = pl_plant.join(
        pl_metadata,
        how='cross'
    )

    # Convert PR data to Polars if we have any
    if len(df_pr) > 0:
        pl_pr = pl.from_pandas(df_pr).lazy()

        # Left join with PR data on (date, inverter_id)
        logger.info("Joining with PR data...")
        pl_expanded = pl_expanded.join(
            pl_pr.select(['date', 'inverter_id', 'pr']),
            on=['date', 'inverter_id'],
            how='left'
        )

        # Fill missing PR with inverter's mean PR
        pl_expanded = pl_expanded.with_columns([
            pl.coalesce(['pr', 'pr_mean']).alias('inverter_pr')
        ]).drop(['pr', 'pr_mean'])
    else:
        # No PR data - use metadata pr_mean
        pl_expanded = pl_expanded.with_columns([
            pl.col('pr_mean').alias('inverter_pr')
        ]).drop('pr_mean')

    # Rename metadata columns
    pl_expanded = pl_expanded.rename({
        'sr_baseline': 'inverter_sr_baseline',
        'anomaly_rate': 'inverter_anomaly_rate'
    })

    # Calculate fleet average PR per date and join back
    logger.info("Computing fleet PR statistics...")
    fleet_pr = pl_expanded.group_by('date').agg([
        pl.col('inverter_pr').mean().alias('fleet_pr_mean')
    ])

    pl_expanded = pl_expanded.join(
        fleet_pr,
        on='date',
        how='left'
    )

    # Compute PR deviation from fleet
    pl_expanded = pl_expanded.with_columns([
        (pl.col('inverter_pr') - pl.col('fleet_pr_mean')).alias('inverter_pr_deviation')
    ])

    # Drop columns we don't need in final output
    cols_to_drop = ['group_id']
    existing_cols = pl_expanded.collect_schema().names()
    cols_to_drop = [c for c in cols_to_drop if c in existing_cols]
    if cols_to_drop:
        pl_expanded = pl_expanded.drop(cols_to_drop)

    # Collect and convert back to pandas
    logger.info("Collecting results...")
    df_result = pl_expanded.collect().to_pandas()

    logger.info(f"Expanded to {len(df_result)} per-inverter rows")
    return df_result


def train_model(X_train, y_train, X_val=None, y_val=None, verbose=True):
    """Train CatBoost model."""
    if not CATBOOST_AVAILABLE:
        raise ImportError("CatBoost not installed")

    # Sample weights - emphasize soiling events
    soiling_loss = 1.0 - np.array(y_train)
    weights = np.exp(soiling_loss * 100)
    weights = np.clip(weights, 1.0, 100.0)
    weights = weights / weights.mean()

    model = CatBoostRegressor(
        iterations=1500,
        learning_rate=0.03,
        depth=6,
        l2_leaf_reg=3.0,
        random_seed=42,
        loss_function='Quantile:alpha=0.35',
        verbose=100 if verbose else 0
    )

    train_pool = Pool(X_train, y_train, weight=weights)

    eval_set = None
    if X_val is not None and y_val is not None:
        eval_set = Pool(X_val, y_val)

    model.fit(train_pool, eval_set=eval_set)

    return model


def evaluate_model(model, X_test, y_test):
    """Evaluate model performance."""
    y_pred = model.predict(X_test)
    y_pred = np.clip(y_pred, 0.75, 1.0)

    mae = np.mean(np.abs(y_test - y_pred))
    rmse = np.sqrt(np.mean((y_test - y_pred) ** 2))
    r2 = 1 - np.sum((y_test - y_pred) ** 2) / np.sum((y_test - y_test.mean()) ** 2)
    bias = np.mean(y_pred - y_test)

    return {
        'mae': mae,
        'rmse': rmse,
        'r2': r2,
        'bias': bias,
        'y_pred': y_pred
    }


def plot_results(df_results, output_dir, plant_id='alpha1'):
    """Create visualization plots."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Plot 1: SR predictions over time (fleet average)
    fig, ax = plt.subplots(figsize=(14, 6))

    df_daily = df_results.groupby('date').agg({
        'sr_predicted': ['mean', 'std'],
        'sr_pseudo_plant': 'mean',
        'precipitation_mm': 'sum'
    }).reset_index()
    df_daily.columns = ['date', 'sr_pred_mean', 'sr_pred_std', 'sr_actual', 'precip']

    ax.fill_between(
        df_daily['date'],
        df_daily['sr_pred_mean'] - df_daily['sr_pred_std'],
        df_daily['sr_pred_mean'] + df_daily['sr_pred_std'],
        alpha=0.3, color='blue', label='Prediction ±1σ'
    )
    ax.plot(df_daily['date'], df_daily['sr_pred_mean'], 'b-', linewidth=2, label='Predicted SR')
    ax.plot(df_daily['date'], df_daily['sr_actual'], 'g--', alpha=0.7, label='Pseudo-label SR')

    # Rain events
    rain_days = df_daily[df_daily['precip'] > 5]
    ax.scatter(rain_days['date'], [1.01] * len(rain_days), marker='v', c='cyan', s=50, alpha=0.7, label='Rain >5mm')

    ax.set_xlabel('Date')
    ax.set_ylabel('Soiling Ratio')
    ax.set_title(f'No-DustIQ Model: Fleet Average SR Prediction ({plant_id.upper()})')
    ax.legend(loc='lower left')
    ax.set_ylim(0.9, 1.02)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
    ax.xaxis.set_major_locator(mdates.MonthLocator(interval=2))
    plt.xticks(rotation=45)
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(output_dir / f'{plant_id}_nodustiq_fleet_sr.png', dpi=150)
    plt.close()
    logger.info(f"Saved: {output_dir / f'{plant_id}_nodustiq_fleet_sr.png'}")

    # Plot 2: Per-inverter SR heatmap (last 30 days)
    fig, ax = plt.subplots(figsize=(16, 10))

    last_30_days = df_results['date'].max() - pd.Timedelta(days=30)
    df_recent = df_results[df_results['date'] >= last_30_days]

    pivot = df_recent.pivot_table(
        index='inverter_id',
        columns='date',
        values='sr_predicted',
        aggfunc='mean'
    )

    # Sort inverters
    pivot = pivot.sort_index()

    im = ax.imshow(pivot.values, aspect='auto', cmap='RdYlGn', vmin=0.9, vmax=1.0)

    ax.set_yticks(range(0, len(pivot), 10))
    ax.set_yticklabels(pivot.index[::10], fontsize=8)
    ax.set_xticks(range(0, len(pivot.columns), 5))
    ax.set_xticklabels([d.strftime('%m-%d') for d in pivot.columns[::5]], rotation=45, fontsize=8)

    ax.set_xlabel('Date')
    ax.set_ylabel('Inverter')
    ax.set_title(f'No-DustIQ Model: Per-Inverter SR (Last 30 Days) - {plant_id.upper()}')

    cbar = plt.colorbar(im, ax=ax)
    cbar.set_label('Soiling Ratio')

    plt.tight_layout()
    plt.savefig(output_dir / f'{plant_id}_nodustiq_heatmap.png', dpi=150)
    plt.close()
    logger.info(f"Saved: {output_dir / f'{plant_id}_nodustiq_heatmap.png'}")

    # Plot 3: Prediction vs Actual scatter
    fig, ax = plt.subplots(figsize=(8, 8))

    # Sample for visibility
    sample = df_results.sample(min(5000, len(df_results)))

    ax.scatter(sample['sr_pseudo'], sample['sr_predicted'], alpha=0.3, s=10)
    ax.plot([0.75, 1.0], [0.75, 1.0], 'r--', linewidth=2, label='Perfect prediction')

    ax.set_xlabel('Pseudo-label SR')
    ax.set_ylabel('Predicted SR')
    ax.set_title(f'No-DustIQ Model: Prediction vs Target ({plant_id.upper()})')
    ax.legend()
    ax.set_xlim(0.9, 1.01)
    ax.set_ylim(0.9, 1.01)
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(output_dir / f'{plant_id}_nodustiq_scatter.png', dpi=150)
    plt.close()
    logger.info(f"Saved: {output_dir / f'{plant_id}_nodustiq_scatter.png'}")

    # Plot 4: Feature importance
    return pivot  # Return for further analysis


def run_training(plant_id: str, output_base_dir: str = 'outputs_nodustiq'):
    """Run NoDustIQ training for specified plant.

    Args:
        plant_id: Plant identifier (e.g., 'alpha1', 'eta', 'ribera')
        output_base_dir: Base directory for outputs
    """
    data_dir = Path('public/data/soiling') / plant_id
    output_dir = Path(output_base_dir) / plant_id
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n{'='*60}")
    print("No-DustIQ Per-Inverter SR Model Training")
    print(f"Plant: {plant_id.upper()}")
    print(f"{'='*60}\n")

    # Step 1: Load data
    print("Step 1: Loading data...")
    df_rain = load_rain_data(data_dir)
    df_dust = load_dust_data(data_dir)
    df_metadata, df_pr = load_inverter_data(data_dir)

    # Step 2: Create features
    print("\nStep 2: Creating features...")
    df_features = create_rainfall_features(df_rain)
    df_features = create_temporal_features(df_features)

    # Merge dust if available
    if df_dust is not None:
        df_features = df_features.merge(
            df_dust[['date', 'aod_550']],
            on='date',
            how='left'
        )
        # AOD rolling features
        for window in [7, 14, 30]:
            df_features[f'aod_mean_{window}d'] = df_features['aod_550'].rolling(window, min_periods=1).mean()

    # Step 3: Generate pseudo-labels
    print("\nStep 3: Generating pseudo-labels...")
    df_features = generate_pseudo_labels(df_features)

    # Step 4: Expand to per-inverter
    print("\nStep 4: Expanding to per-inverter features...")
    df_expanded = expand_to_per_inverter(df_features, df_metadata, df_pr)
    print(f"  Total samples: {len(df_expanded)}")

    # Step 4b: Generate per-inverter pseudo-labels (with curtailment handling)
    print("\nStep 4b: Generating per-inverter pseudo-labels...")
    df_expanded = generate_per_inverter_pseudo_labels(df_expanded)
    print(f"  Per-inverter SR variation: {df_expanded['sr_pseudo'].std():.4f}")

    # Step 5: Prepare training data
    print("\nStep 5: Preparing training data...")

    # Feature columns
    target_cols = ['date', 'inverter_id', 'sr_pseudo', 'sr_pseudo_plant', 'confidence', 'fleet_pr_mean', 'is_curtailed']
    feature_cols = [c for c in df_expanded.columns if c not in target_cols]

    # Remove non-numeric columns
    feature_cols = [c for c in feature_cols if df_expanded[c].dtype in ['int64', 'float64']]

    print(f"  Features: {len(feature_cols)}")

    # Temporal split
    df_expanded = df_expanded.sort_values('date')
    split_idx = int(len(df_expanded) * 0.8)

    X_train = df_expanded.iloc[:split_idx][feature_cols]
    y_train = df_expanded.iloc[:split_idx]['sr_pseudo']
    X_test = df_expanded.iloc[split_idx:][feature_cols]
    y_test = df_expanded.iloc[split_idx:]['sr_pseudo']

    print(f"  Training: {len(X_train)} samples")
    print(f"  Testing: {len(X_test)} samples")

    # Step 6: Train model
    print("\nStep 6: Training CatBoost model...")
    model = train_model(X_train, y_train, verbose=True)

    # Step 7: Evaluate
    print("\nStep 7: Evaluating model...")
    metrics = evaluate_model(model, X_test, y_test)

    print(f"\n  Test Metrics:")
    print(f"    MAE:  {metrics['mae']:.4f}")
    print(f"    RMSE: {metrics['rmse']:.4f}")
    print(f"    R²:   {metrics['r2']:.4f}")
    print(f"    Bias: {metrics['bias']:.4f}")

    # Step 8: Generate predictions for all data
    print("\nStep 8: Generating predictions...")
    X_all = df_expanded[feature_cols]
    y_pred_all = model.predict(X_all)
    y_pred_all = np.clip(y_pred_all, 0.75, 1.0)

    df_results = df_expanded[['date', 'inverter_id', 'sr_pseudo', 'sr_pseudo_plant', 'precipitation_mm', 'is_curtailed', 'inverter_pr']].copy()
    df_results['sr_predicted'] = y_pred_all

    # Step 9: Plot results
    print("\nStep 9: Creating plots...")
    plot_results(df_results, output_dir, plant_id)

    # Step 10: Save model and outputs
    print("\nStep 10: Saving outputs...")

    # Save model
    import pickle
    model_path = output_dir / f'{plant_id}_nodustiq_model.pkl'
    with open(model_path, 'wb') as f:
        pickle.dump({
            'model': model,
            'feature_names': feature_cols,
            'metrics': metrics,
            'config': {
                'variant': 'nodustiq',
                'plant_id': plant_id,
                'n_inverters': len(df_metadata),
                'training_samples': len(X_train)
            }
        }, f)
    logger.info(f"Saved model: {model_path}")

    # Save per-inverter JSON
    json_output = {
        'metadata': {
            'plant_id': plant_id,
            'model_variant': 'nodustiq',
            'generated_at': datetime.now().isoformat(),
            'n_inverters': len(df_metadata),
            'metrics': {k: float(v) for k, v in metrics.items() if k != 'y_pred'}
        },
        'inverters': {}
    }

    for inv_id in df_results['inverter_id'].unique():
        inv_data = df_results[df_results['inverter_id'] == inv_id].sort_values('date', ascending=False)

        json_output['inverters'][inv_id] = {
            'current_sr': float(inv_data.iloc[0]['sr_predicted']),
            'sr_7d_avg': float(inv_data.head(7)['sr_predicted'].mean()),
            'confidence': 0.85,
            'history': [
                {
                    'date': row['date'].strftime('%Y-%m-%d'),
                    'sr': float(row['sr_predicted']),
                    'confidence': 0.85
                }
                for _, row in inv_data.iterrows()  # Include all historical data
            ]
        }

    json_path = output_dir / f'{plant_id}_per_inverter_sr.json'
    with open(json_path, 'w') as f:
        json.dump(json_output, f, indent=2)
    logger.info(f"Saved JSON: {json_path}")

    # Copy to public data for API
    public_path = data_dir / 'per_inverter' / f'{plant_id}_per_inverter_sr.json'
    public_path.parent.mkdir(parents=True, exist_ok=True)
    with open(public_path, 'w') as f:
        json.dump(json_output, f, indent=2)
    logger.info(f"Saved to public: {public_path}")

    # Also generate plant-level ml_sr_predictions.json for frontend
    plant_level_sr = df_results.groupby('date')['sr_predicted'].mean().reset_index()
    plant_level_sr = plant_level_sr.sort_values('date')

    ml_predictions = {
        'plant_id': plant_id,
        'model_info': {
            'model_path': str(model_path),
            'plant_id': plant_id,
            'validation_mae': float(metrics['mae']),
            'validation_r2': float(metrics['r2'])
        },
        'generated_at': datetime.now().isoformat(),
        'n_predictions': len(plant_level_sr),
        'date_range': {
            'start': plant_level_sr['date'].min().strftime('%Y-%m-%d'),
            'end': plant_level_sr['date'].max().strftime('%Y-%m-%d')
        },
        'daily_data': [
            {
                'date': row['date'].strftime('%Y-%m-%d'),
                'sr_ml': float(row['sr_predicted'])
            }
            for _, row in plant_level_sr.iterrows()
        ]
    }

    ml_pred_path = data_dir / 'ml_sr_predictions.json'
    with open(ml_pred_path, 'w') as f:
        json.dump(ml_predictions, f, indent=2)
    logger.info(f"Saved ML predictions: {ml_pred_path}")

    print(f"\n{'='*60}")
    print("Training complete!")
    print(f"  Model: {model_path}")
    print(f"  Plots: {output_dir}")
    print(f"  Per-inverter data: {public_path}")
    print(f"  ML predictions: {ml_pred_path}")
    print(f"{'='*60}\n")

    return model, df_results, metrics


def main():
    """Main entry point with CLI argument parsing."""
    import argparse

    parser = argparse.ArgumentParser(
        description='Train No-DustIQ Per-Inverter Soiling Ratio Model',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Train NoDustIQ model for ALPHA1
  python scripts/train_nodustiq_model.py --plant-id alpha1

  # Train NoDustIQ model for Eta
  python scripts/train_nodustiq_model.py --plant-id eta

  # Use custom output directory
  python scripts/train_nodustiq_model.py --plant-id ribera --output-dir custom_outputs

Note:
  - Requires rain data (rain_history.json)
  - Requires inverter metadata (all_inverters.json)
  - Requires daily PR data (time_series/daily_pr.json)
  - Optional: dust data (dust_history.json) for AOD features
        """
    )

    parser.add_argument('--plant-id', required=True,
                       help='Plant identifier (e.g., alpha1, eta, ribera)')
    parser.add_argument('--output-dir', type=str, default='outputs_nodustiq',
                       help='Base directory for outputs (default: outputs_nodustiq)')

    args = parser.parse_args()

    try:
        model, results, metrics = run_training(args.plant_id, args.output_dir)
        return model, results, metrics
    except Exception as e:
        logger.error(f"Training failed: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
