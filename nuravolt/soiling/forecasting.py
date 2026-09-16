"""Machine learning forecasting for soiling ratio prediction."""

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score


def prepare_training_data(df_features_all, df_daily, forecast_horizon=7, train_split=0.8):
    """
    Prepare training and test datasets for ML forecasting.

    Parameters:
    -----------
    df_features_all : pandas.DataFrame
        Complete feature set
    df_daily : pandas.DataFrame
        Daily data with 'soiling_ratio_smooth' target variable
    forecast_horizon : int
        Number of days ahead to forecast (default: 7)
    train_split : float
        Fraction of data for training (default: 0.8)

    Returns:
    --------
    X_train, X_test, y_train, y_test : pandas DataFrames/Series
        Train/test split for features and target
    """
    print("⚙️ Preparing training data for ML forecasting...")

    # Create target variable (future SR)
    # Align the target with the feature index
    df_ml = df_features_all.copy()

    # Use reindex to align df_daily with df_features_all index, then shift
    sr_aligned = df_daily['soiling_ratio_smooth'].reindex(df_ml.index)
    df_ml['target_sr_7d'] = sr_aligned.shift(-forecast_horizon)

    # Forward fill feature NaNs (for rolling window features at the beginning)
    # But only for features, not the target
    feature_cols = [col for col in df_ml.columns if col != 'target_sr_7d']
    df_ml[feature_cols] = df_ml[feature_cols].ffill()

    # Now only drop rows where the target is NaN
    df_ml = df_ml.dropna(subset=['target_sr_7d'])

    print(f"✅ Training dataset prepared")
    print(f"   Samples: {len(df_ml):,}")
    print(f"   Features: {len(df_ml.columns) - 1}")  # Exclude target
    print(f"   Forecast horizon: {forecast_horizon} days")

    # Time-series split (preserve temporal order)
    split_idx = int(len(df_ml) * train_split)

    X = df_ml.drop('target_sr_7d', axis=1)
    y = df_ml['target_sr_7d']

    X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]

    print(f"\n📊 Train/test split (temporal):")
    print(f"   Train: {len(X_train):,} samples ({len(X_train)/len(df_ml)*100:.1f}%)")
    print(f"   Test:  {len(X_test):,} samples ({len(X_test)/len(df_ml)*100:.1f}%)")
    print(f"   Train period: {X_train.index[0].strftime('%Y-%m-%d')} to {X_train.index[-1].strftime('%Y-%m-%d')}")
    print(f"   Test period:  {X_test.index[0].strftime('%Y-%m-%d')} to {X_test.index[-1].strftime('%Y-%m-%d')}")

    return X_train, X_test, y_train, y_test


def train_lightgbm_model(X_train, y_train, X_test, y_test, params=None):
    """
    Train LightGBM model for soiling forecasting.

    Parameters:
    -----------
    X_train, y_train : pandas DataFrame/Series
        Training features and target
    X_test, y_test : pandas DataFrame/Series
        Test features and target
    params : dict, optional
        LightGBM parameters (uses defaults if None)

    Returns:
    --------
    model : lgb.Booster
        Trained LightGBM model

    Notes:
    ------
    Default parameters are optimized for soiling forecasting:
    - MAE objective (symmetric loss)
    - Early stopping to prevent overfitting
    - Moderate learning rate and regularization
    """
    print("⚙️ Training LightGBM model...")

    # Default parameters if not provided
    if params is None:
        params = {
            'objective': 'regression',
            'metric': 'mae',
            'boosting_type': 'gbdt',
            'num_leaves': 31,
            'learning_rate': 0.05,
            'feature_fraction': 0.8,
            'bagging_fraction': 0.8,
            'bagging_freq': 5,
            'verbose': -1,
            'num_threads': 4,
        }

    # Create LightGBM datasets
    train_data = lgb.Dataset(X_train, label=y_train)
    test_data = lgb.Dataset(X_test, label=y_test, reference=train_data)

    # Train model with early stopping
    print("🚀 Training...")
    model = lgb.train(
        params,
        train_data,
        num_boost_round=1000,
        valid_sets=[train_data, test_data],
        valid_names=['train', 'test'],
        callbacks=[
            lgb.early_stopping(stopping_rounds=50),
            lgb.log_evaluation(period=100),
        ]
    )

    print(f"\n✅ Model trained")
    print(f"   Best iteration: {model.best_iteration}")
    print(f"   Training MAE: {model.best_score['train']['l1']:.4f}")
    print(f"   Test MAE: {model.best_score['test']['l1']:.4f}")

    return model


def evaluate_model(model, X_train, y_train, X_test, y_test, forecast_horizon=7):
    """
    Evaluate model performance on train and test sets.

    Parameters:
    -----------
    model : lgb.Booster
        Trained LightGBM model
    X_train, y_train : pandas DataFrame/Series
        Training data
    X_test, y_test : pandas DataFrame/Series
        Test data
    forecast_horizon : int
        Forecast horizon in days

    Returns:
    --------
    dict
        Dictionary with performance metrics and predictions
    """
    # Make predictions
    y_pred_train = model.predict(X_train)
    y_pred_test = model.predict(X_test)

    # Calculate metrics
    mae_train = mean_absolute_error(y_train, y_pred_train)
    mae_test = mean_absolute_error(y_test, y_pred_test)
    rmse_train = np.sqrt(mean_squared_error(y_train, y_pred_train))
    rmse_test = np.sqrt(mean_squared_error(y_test, y_pred_test))
    r2_train = r2_score(y_train, y_pred_train)
    r2_test = r2_score(y_test, y_pred_test)

    print(f"\n📊 Model Performance ({forecast_horizon}-day soiling forecast):")
    print("\nTrain set:")
    print(f"   MAE:  {mae_train:.4f} (mean error in SR)")
    print(f"   RMSE: {rmse_train:.4f}")
    print(f"   R²:   {r2_train:.4f}")
    print("\nTest set:")
    print(f"   MAE:  {mae_test:.4f} (mean error in SR)")
    print(f"   RMSE: {rmse_test:.4f}")
    print(f"   R²:   {r2_test:.4f}")

    # Convert MAE to soiling loss percentage error
    mae_pct = mae_test * 100
    print(f"\n💡 Interpretation:")
    print(f"   {forecast_horizon}-day forecast error: ±{mae_pct:.2f}% soiling loss")
    print(f"   Example: If actual SR = 0.95 (5% loss), predicted SR = 0.95 ± {mae_test:.3f}")

    print("\n✅ Model evaluation complete")

    return {
        'mae_train': mae_train,
        'mae_test': mae_test,
        'rmse_train': rmse_train,
        'rmse_test': rmse_test,
        'r2_train': r2_train,
        'r2_test': r2_test,
        'y_pred_train': y_pred_train,
        'y_pred_test': y_pred_test,
    }


def get_feature_importance(model, X_train, top_n=20):
    """
    Get feature importance from trained model.

    Parameters:
    -----------
    model : lgb.Booster
        Trained LightGBM model
    X_train : pandas DataFrame
        Training features (for column names)
    top_n : int
        Number of top features to return

    Returns:
    --------
    pandas.DataFrame
        Feature importance sorted by gain
    """
    importance = model.feature_importance(importance_type='gain')
    feature_names = X_train.columns

    df_importance = pd.DataFrame({
        'feature': feature_names,
        'importance': importance
    }).sort_values('importance', ascending=False)

    print(f"\n🔍 Top {top_n} Most Important Features:")
    for i, row in df_importance.head(top_n).iterrows():
        print(f"   {row['feature']}: {row['importance']:.0f}")

    return df_importance


def predict_soiling(model, features):
    """
    Make soiling ratio predictions using trained model.

    Parameters:
    -----------
    model : lgb.Booster
        Trained LightGBM model
    features : pandas.DataFrame
        Feature matrix for prediction

    Returns:
    --------
    numpy.ndarray
        Predicted soiling ratios
    """
    return model.predict(features)
