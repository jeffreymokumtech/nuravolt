"""Training pipeline for Soiling Ratio ML models.

Provides complete workflow for:
1. Loading and preparing data
2. Temporal train/validation split
3. Feature engineering
4. Model training with cross-validation
5. Model evaluation and export
"""

import json
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from datetime import datetime

from .sr_ml_features import (
    SoilingRatioFeatureEngineer,
    PlantLocation,
    create_sr_features_from_json
)
from .sr_ml_model import (
    SoilingRatioModel,
    SoilingRatioModelConfig,
    evaluate_model
)


class SoilingRatioTrainer:
    """Training pipeline for SR prediction models."""

    def __init__(
        self,
        plant_id: str,
        latitude: float,
        longitude: float,
        config: Optional[SoilingRatioModelConfig] = None,
        output_dir: str = "models/soiling"
    ):
        """
        Initialize trainer.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        latitude : float
            Plant latitude
        longitude : float
            Plant longitude
        config : SoilingRatioModelConfig, optional
            Model configuration
        output_dir : str
            Output directory for models
        """
        self.plant_id = plant_id
        self.location = PlantLocation(latitude=latitude, longitude=longitude)
        self.config = config or SoilingRatioModelConfig()
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.feature_engineer = SoilingRatioFeatureEngineer(self.location)
        self.model: Optional[SoilingRatioModel] = None
        self.training_report: Dict = {}

    def load_data(
        self,
        dustiq_path: str,
        weather_path: str,
        aod_path: Optional[str] = None,
        pr_path: Optional[str] = None
    ) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Load training data from JSON files.

        Parameters
        ----------
        dustiq_path : str
            Path to dustiq_history.json
        weather_path : str
            Path to rain_history.json
        aod_path : str, optional
            Path to AOD data JSON
        pr_path : str, optional
            Path to Performance Ratio JSON (lagging soiling indicator)

        Returns
        -------
        X : pd.DataFrame
            Features
        y : pd.Series
            Target (sr_dustiq)
        """
        print(f"Loading data for {self.plant_id}...")

        # Load DustIQ (target)
        with open(dustiq_path, 'r') as f:
            dustiq_data = json.load(f)
        df_dustiq = pd.DataFrame(dustiq_data['daily_data'])
        df_dustiq['date'] = pd.to_datetime(df_dustiq['date'])
        df_dustiq = df_dustiq.set_index('date')

        # Load weather
        with open(weather_path, 'r') as f:
            weather_data = json.load(f)
        df_weather = pd.DataFrame(weather_data['daily_data'])
        df_weather['date'] = pd.to_datetime(df_weather['date'])
        df_weather = df_weather.set_index('date')

        # Rename columns if needed
        if 'precipitation_mm' not in df_weather.columns:
            if 'precipitation' in df_weather.columns:
                df_weather['precipitation_mm'] = df_weather['precipitation']

        # Load AOD if available
        df_aod = None
        if aod_path and Path(aod_path).exists():
            with open(aod_path, 'r') as f:
                aod_data = json.load(f)
            df_aod = pd.DataFrame(aod_data['daily_data'])
            df_aod['date'] = pd.to_datetime(df_aod['date'])
            df_aod = df_aod.set_index('date')
            print(f"  Loaded AOD data: {len(df_aod)} days")

        # Load PR data if available (lagging soiling indicator)
        df_pr = None
        if pr_path and Path(pr_path).exists():
            with open(pr_path, 'r') as f:
                pr_data = json.load(f)

            # Handle different PR data formats
            if 'daily_data' in pr_data:
                # Plant-level daily PR already aggregated
                df_pr = pd.DataFrame(pr_data['daily_data'])
            elif 'data' in pr_data:
                # Per-inverter data - need to aggregate to plant level
                df_pr_raw = pd.DataFrame(pr_data['data'])
                # Group by date and compute mean PR across all inverters
                df_pr = df_pr_raw.groupby('date').agg({
                    'pr': 'mean'
                }).reset_index()
            else:
                print(f"  Warning: Unknown PR data format in {pr_path}")

            if df_pr is not None:
                df_pr['date'] = pd.to_datetime(df_pr['date'])
                df_pr = df_pr.set_index('date')
                print(f"  Loaded PR data: {len(df_pr)} days (mean PR: {df_pr['pr'].mean():.3f})")

        # Find common dates
        common_dates = df_dustiq.index.intersection(df_weather.index)
        if df_aod is not None:
            common_dates = common_dates.intersection(df_aod.index)
        # Note: PR doesn't need to be in common_dates as it will be reindexed in feature engineering

        print(f"  DustIQ samples: {len(df_dustiq)}")
        print(f"  Weather samples: {len(df_weather)}")
        print(f"  Common dates: {len(common_dates)}")

        # Align data
        df_weather_aligned = df_weather.loc[common_dates]
        df_dustiq_aligned = df_dustiq.loc[common_dates]
        if df_aod is not None:
            df_aod = df_aod.loc[common_dates]

        # Generate features (now with PR support)
        print("Generating features...")
        X = self.feature_engineer.generate_features(
            df_weather_aligned,
            df_aod=df_aod,
            df_pr=df_pr  # NEW: Pass PR data for feature engineering
        )

        # Target
        y = df_dustiq_aligned['sr_dustiq']

        # Final alignment
        common_idx = X.index.intersection(y.index)
        X = X.loc[common_idx]
        y = y.loc[common_idx]

        # Remove NaN targets
        valid_mask = ~y.isna()
        X = X.loc[valid_mask]
        y = y.loc[valid_mask]

        print(f"Final dataset: {len(X)} samples, {len(X.columns)} features")

        return X, y

    def temporal_split(
        self,
        X: pd.DataFrame,
        y: pd.Series,
        test_ratio: float = 0.2
    ) -> Tuple[pd.DataFrame, pd.DataFrame, pd.Series, pd.Series]:
        """
        Split data temporally (no random shuffling).

        Parameters
        ----------
        X : pd.DataFrame
            Features
        y : pd.Series
            Target
        test_ratio : float
            Fraction for test set (from end of time series)

        Returns
        -------
        X_train, X_test, y_train, y_test
        """
        n_test = int(len(X) * test_ratio)
        n_train = len(X) - n_test

        X_train = X.iloc[:n_train]
        X_test = X.iloc[n_train:]
        y_train = y.iloc[:n_train]
        y_test = y.iloc[n_train:]

        print(f"Temporal split:")
        print(f"  Train: {len(X_train)} samples ({X_train.index.min()} to {X_train.index.max()})")
        print(f"  Test: {len(X_test)} samples ({X_test.index.min()} to {X_test.index.max()})")

        return X_train, X_test, y_train, y_test

    def train(
        self,
        X_train: pd.DataFrame,
        y_train: pd.Series,
        X_val: pd.DataFrame,
        y_val: pd.Series,
        verbose: bool = True
    ) -> SoilingRatioModel:
        """
        Train the model.

        Parameters
        ----------
        X_train : pd.DataFrame
            Training features
        y_train : pd.Series
            Training target
        X_val : pd.DataFrame
            Validation features
        y_val : pd.Series
            Validation target
        verbose : bool
            Print progress

        Returns
        -------
        SoilingRatioModel
            Trained model
        """
        self.model = SoilingRatioModel(self.config)
        self.model.fit(
            X_train, y_train,
            X_val, y_val,
            plant_id=self.plant_id,
            verbose=verbose
        )

        return self.model

    def evaluate(
        self,
        X_test: pd.DataFrame,
        y_test: pd.Series
    ) -> Dict[str, float]:
        """
        Evaluate model on test set.

        Parameters
        ----------
        X_test : pd.DataFrame
            Test features
        y_test : pd.Series
            Test target

        Returns
        -------
        dict
            Evaluation metrics
        """
        if self.model is None:
            raise ValueError("Model not trained. Call train() first.")

        metrics = evaluate_model(self.model, X_test, y_test)

        print("\nTest Set Evaluation:")
        print(f"  MAE: {metrics['mae']:.4f} ({metrics['mae']*100:.2f}%)")
        print(f"  RMSE: {metrics['rmse']:.4f}")
        print(f"  R2: {metrics['r2']:.4f}")
        print(f"  Bias: {metrics['bias']:.4f}")
        print(f"  Correlation: {metrics['correlation']:.4f}")

        return metrics

    def save_model(self, suffix: str = "") -> Path:
        """
        Save trained model.

        Parameters
        ----------
        suffix : str
            Optional suffix for model filename

        Returns
        -------
        Path
            Path to saved model
        """
        if self.model is None:
            raise ValueError("Model not trained.")

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"sr_model_{self.plant_id}{suffix}_{timestamp}.pkl"
        model_path = self.output_dir / filename

        self.model.save(model_path)

        return model_path

    def run_full_pipeline(
        self,
        dustiq_path: str,
        weather_path: str,
        aod_path: Optional[str] = None,
        pr_path: Optional[str] = None,
        test_ratio: float = 0.2,
        save: bool = True
    ) -> Dict:
        """
        Run complete training pipeline.

        Parameters
        ----------
        dustiq_path : str
            Path to DustIQ data
        weather_path : str
            Path to weather data
        aod_path : str, optional
            Path to AOD data
        pr_path : str, optional
            Path to Performance Ratio data (lagging soiling indicator)
        test_ratio : float
            Test set ratio
        save : bool
            Save model to disk

        Returns
        -------
        dict
            Training report
        """
        print("=" * 60)
        print(f"SR Model Training Pipeline - {self.plant_id}")
        print("=" * 60)

        # Load data (now with PR support)
        X, y = self.load_data(dustiq_path, weather_path, aod_path, pr_path)

        # Split
        X_train, X_test, y_train, y_test = self.temporal_split(X, y, test_ratio)

        # Further split train into train/val
        n_val = int(len(X_train) * 0.1)
        X_val = X_train.iloc[-n_val:]
        y_val = y_train.iloc[-n_val:]
        X_train = X_train.iloc[:-n_val]
        y_train = y_train.iloc[:-n_val]

        # Train
        print("\n" + "-" * 40)
        print("Training Model")
        print("-" * 40)
        self.train(X_train, y_train, X_val, y_val)

        # Evaluate
        print("\n" + "-" * 40)
        print("Evaluation")
        print("-" * 40)
        test_metrics = self.evaluate(X_test, y_test)

        # Feature importance
        importance = self.model.get_feature_importance()
        print("\nTop 10 Important Features:")
        for _, row in importance.head(10).iterrows():
            print(f"  {row['feature']}: {row['importance']:.2f}")

        # Save
        model_path = None
        if save:
            model_path = self.save_model()

        # Compile report
        self.training_report = {
            'plant_id': self.plant_id,
            'timestamp': datetime.now().isoformat(),
            'n_samples': len(X),
            'n_features': len(X.columns),
            'train_samples': len(X_train),
            'val_samples': len(X_val),
            'test_samples': len(X_test),
            'train_period': {
                'start': str(X_train.index.min()),
                'end': str(X_train.index.max())
            },
            'test_period': {
                'start': str(X_test.index.min()),
                'end': str(X_test.index.max())
            },
            'metrics': test_metrics,
            'model_path': str(model_path) if model_path else None,
            'feature_importance': importance.head(20).to_dict('records')
        }

        # Save report
        report_path = self.output_dir / f"training_report_{self.plant_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(report_path, 'w') as f:
            json.dump(self.training_report, f, indent=2, default=str)
        print(f"\nReport saved to: {report_path}")

        print("\n" + "=" * 60)
        print("Training Complete")
        print("=" * 60)

        return self.training_report


def train_foundation_model(
    plant_id: str,
    dustiq_path: str,
    weather_path: str,
    latitude: float,
    longitude: float,
    aod_path: Optional[str] = None,
    pr_path: Optional[str] = None,
    output_dir: str = "models/soiling"
) -> Tuple[SoilingRatioModel, Dict]:
    """
    Convenience function to train a foundation model.

    Parameters
    ----------
    plant_id : str
        Plant identifier
    dustiq_path : str
        Path to DustIQ JSON
    weather_path : str
        Path to weather JSON
    latitude : float
        Plant latitude
    longitude : float
        Plant longitude
    aod_path : str, optional
        Path to AOD JSON
    pr_path : str, optional
        Path to Performance Ratio JSON (lagging soiling indicator)
    output_dir : str
        Output directory

    Returns
    -------
    model : SoilingRatioModel
        Trained model
    report : dict
        Training report
    """
    trainer = SoilingRatioTrainer(
        plant_id=plant_id,
        latitude=latitude,
        longitude=longitude,
        output_dir=output_dir
    )

    report = trainer.run_full_pipeline(
        dustiq_path=dustiq_path,
        weather_path=weather_path,
        aod_path=aod_path,
        pr_path=pr_path
    )

    return trainer.model, report
