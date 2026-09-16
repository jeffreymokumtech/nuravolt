"""Transfer learning for Soiling Ratio models.

Enables transferring a foundation model trained on plants with DustIQ
to plants without DustIQ sensors using pseudo-labels.

Pseudo-labels are generated from:
1. Rain cleaning events (SR reset to ~1.0)
2. Manual cleaning events (SR jump without rain)
3. Foundation model predictions for inter-event periods
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass

from .sr_ml_model import SoilingRatioModel
from .sr_ml_features import SoilingRatioFeatureEngineer, PlantLocation


@dataclass
class CleaningEvent:
    """Detected cleaning event."""
    date: str
    event_type: str  # 'rain', 'manual', 'inferred'
    confidence: float
    sr_after: float  # SR immediately after cleaning
    rain_mm: float = 0.0


class PseudoLabelGenerator:
    """Generate pseudo-labels for plants without DustIQ.

    Uses cleaning event detection and foundation model predictions
    to create training labels for transfer learning.
    """

    # Thresholds
    RAIN_CLEANING_THRESHOLD = 5.0  # mm (moderate rain)
    HEAVY_RAIN_THRESHOLD = 10.0  # mm (heavy rain, full cleaning)
    SR_JUMP_THRESHOLD = 0.005  # 0.5% SR increase indicates cleaning
    SR_POST_CLEANING = 1.0  # SR value after cleaning

    def __init__(
        self,
        foundation_model: SoilingRatioModel,
        feature_engineer: SoilingRatioFeatureEngineer
    ):
        """
        Initialize pseudo-label generator.

        Parameters
        ----------
        foundation_model : SoilingRatioModel
            Pre-trained foundation model
        feature_engineer : SoilingRatioFeatureEngineer
            Feature engineer for the target plant
        """
        self.foundation_model = foundation_model
        self.feature_engineer = feature_engineer

    def detect_cleaning_events(
        self,
        df_weather: pd.DataFrame,
        df_pi: Optional[pd.DataFrame] = None
    ) -> List[CleaningEvent]:
        """
        Detect cleaning events from weather and performance data.

        Parameters
        ----------
        df_weather : pd.DataFrame
            Weather data with precipitation_mm column
        df_pi : pd.DataFrame, optional
            Performance Index data for detecting manual cleanings

        Returns
        -------
        list of CleaningEvent
            Detected cleaning events
        """
        events = []

        # Ensure date index
        if 'date' in df_weather.columns:
            df_weather = df_weather.set_index('date')
        df_weather.index = pd.to_datetime(df_weather.index)

        precip = df_weather['precipitation_mm'].fillna(0)

        # Detect rain cleaning events
        for i in range(len(df_weather)):
            date = df_weather.index[i]

            # Check 3-day rolling rain
            start_idx = max(0, i - 2)
            rain_3d = precip.iloc[start_idx:i+1].sum()

            if rain_3d >= self.HEAVY_RAIN_THRESHOLD:
                events.append(CleaningEvent(
                    date=str(date.date()),
                    event_type='rain',
                    confidence=0.95,
                    sr_after=self.SR_POST_CLEANING,
                    rain_mm=float(rain_3d)
                ))
            elif rain_3d >= self.RAIN_CLEANING_THRESHOLD:
                events.append(CleaningEvent(
                    date=str(date.date()),
                    event_type='rain',
                    confidence=0.85,
                    sr_after=0.995,  # Partial cleaning
                    rain_mm=float(rain_3d)
                ))

        # Detect manual cleaning events from PI jumps (if available)
        if df_pi is not None:
            manual_events = self._detect_manual_cleanings(df_weather, df_pi)
            events.extend(manual_events)

        # Sort by date
        events.sort(key=lambda e: e.date)

        # Remove duplicate dates (keep highest confidence)
        seen_dates = {}
        unique_events = []
        for e in events:
            if e.date not in seen_dates or e.confidence > seen_dates[e.date].confidence:
                seen_dates[e.date] = e
        unique_events = list(seen_dates.values())
        unique_events.sort(key=lambda e: e.date)

        return unique_events

    def _detect_manual_cleanings(
        self,
        df_weather: pd.DataFrame,
        df_pi: pd.DataFrame
    ) -> List[CleaningEvent]:
        """
        Detect manual cleaning events from PI jumps without rain.

        Parameters
        ----------
        df_weather : pd.DataFrame
            Weather data
        df_pi : pd.DataFrame
            Performance Index data with 'pi' or 'performance_index' column

        Returns
        -------
        list of CleaningEvent
            Detected manual cleaning events
        """
        events = []

        # Ensure date index
        if 'date' in df_pi.columns:
            df_pi = df_pi.set_index('date')
        df_pi.index = pd.to_datetime(df_pi.index)

        # Get PI column
        pi_col = 'pi' if 'pi' in df_pi.columns else 'performance_index'
        if pi_col not in df_pi.columns:
            return events

        pi = df_pi[pi_col].fillna(method='ffill')

        # Calculate PI change
        pi_diff = pi.diff()

        # Find significant PI jumps (>0.5%)
        jump_threshold = 0.005
        jumps = pi_diff[pi_diff > jump_threshold]

        # Check if jumps are NOT explained by rain
        precip = df_weather['precipitation_mm'].fillna(0)

        for date, jump in jumps.items():
            # Check rain in the 3 days before this date
            date_idx = df_weather.index.get_loc(date, method='nearest')
            start_idx = max(0, date_idx - 2)
            rain_3d = precip.iloc[start_idx:date_idx+1].sum()

            if rain_3d < self.RAIN_CLEANING_THRESHOLD:
                # PI jumped without rain -> manual cleaning
                events.append(CleaningEvent(
                    date=str(date.date()),
                    event_type='manual',
                    confidence=0.90,
                    sr_after=self.SR_POST_CLEANING,
                    rain_mm=float(rain_3d)
                ))

        return events

    def generate_pseudo_labels(
        self,
        df_weather: pd.DataFrame,
        df_aod: Optional[pd.DataFrame] = None,
        df_pi: Optional[pd.DataFrame] = None
    ) -> Tuple[pd.DataFrame, pd.Series, pd.Series]:
        """
        Generate pseudo-labels for transfer learning.

        Parameters
        ----------
        df_weather : pd.DataFrame
            Weather data
        df_aod : pd.DataFrame, optional
            AOD data
        df_pi : pd.DataFrame, optional
            Performance Index data

        Returns
        -------
        X : pd.DataFrame
            Features
        y_pseudo : pd.Series
            Pseudo-labels (SR estimates)
        confidence : pd.Series
            Label confidence (0-1)
        """
        # Generate features
        X = self.feature_engineer.generate_features(df_weather, df_aod)

        # Detect cleaning events
        events = self.detect_cleaning_events(df_weather, df_pi)
        print(f"Detected {len(events)} cleaning events")

        # Get foundation model predictions
        sr_pred = self.foundation_model.predict(X)

        # Initialize pseudo-labels from model predictions
        y_pseudo = pd.Series(sr_pred, index=X.index)
        confidence = pd.Series(0.5, index=X.index)  # Base confidence from model

        # Override with high-confidence cleaning event labels
        event_dict = {pd.to_datetime(e.date): e for e in events}

        for date in X.index:
            if date in event_dict:
                event = event_dict[date]
                y_pseudo.loc[date] = event.sr_after
                confidence.loc[date] = event.confidence

        # Propagate confidence: days right after cleaning have higher confidence
        # (SR is known to be high immediately after cleaning)
        for i, date in enumerate(X.index):
            if i == 0:
                continue

            prev_date = X.index[i-1]
            if prev_date in event_dict:
                # Day after cleaning: confidence decays
                days_after = 1
                y_pseudo.loc[date] = max(
                    y_pseudo.loc[date],
                    event_dict[prev_date].sr_after - 0.001 * days_after  # Decay
                )
                confidence.loc[date] = max(
                    confidence.loc[date],
                    event_dict[prev_date].confidence * 0.9  # Decay confidence
                )

        return X, y_pseudo, confidence


class SemiSupervisedSRTrainer:
    """Self-training with pseudo-labels for transfer learning."""

    def __init__(
        self,
        foundation_model: SoilingRatioModel,
        confidence_threshold: float = 0.8
    ):
        """
        Initialize semi-supervised trainer.

        Parameters
        ----------
        foundation_model : SoilingRatioModel
            Pre-trained foundation model
        confidence_threshold : float
            Minimum confidence to use a pseudo-label (0-1)
        """
        self.foundation_model = foundation_model
        self.confidence_threshold = confidence_threshold

    def fine_tune(
        self,
        X: pd.DataFrame,
        y_pseudo: pd.Series,
        confidence: pd.Series,
        plant_id: str,
        iterations: int = 3,
        verbose: bool = True
    ) -> SoilingRatioModel:
        """
        Fine-tune foundation model using pseudo-labels.

        Uses iterative self-training:
        1. Start with high-confidence labels only
        2. Train model
        3. Update pseudo-labels with new predictions
        4. Repeat

        Parameters
        ----------
        X : pd.DataFrame
            Features
        y_pseudo : pd.Series
            Pseudo-labels
        confidence : pd.Series
            Label confidence
        plant_id : str
            Target plant identifier
        iterations : int
            Number of self-training iterations
        verbose : bool
            Print progress

        Returns
        -------
        SoilingRatioModel
            Fine-tuned model
        """
        if verbose:
            print(f"\nSemi-supervised fine-tuning for {plant_id}")
            print(f"Samples: {len(X)}, Initial high-confidence: {(confidence >= self.confidence_threshold).sum()}")

        current_model = self.foundation_model
        current_pseudo = y_pseudo.copy()
        current_conf = confidence.copy()

        for iteration in range(iterations):
            if verbose:
                print(f"\n--- Iteration {iteration + 1}/{iterations} ---")

            # Select high-confidence samples
            high_conf_mask = current_conf >= self.confidence_threshold
            n_high_conf = high_conf_mask.sum()

            if n_high_conf < 10:
                print(f"Warning: Only {n_high_conf} high-confidence samples. Using all samples.")
                high_conf_mask = pd.Series(True, index=X.index)

            X_train = X.loc[high_conf_mask]
            y_train = current_pseudo.loc[high_conf_mask]

            if verbose:
                print(f"Training on {len(X_train)} high-confidence samples")

            # Split for validation
            n_val = max(10, int(len(X_train) * 0.1))
            X_val = X_train.iloc[-n_val:]
            y_val = y_train.iloc[-n_val:]
            X_train = X_train.iloc[:-n_val]
            y_train = y_train.iloc[:-n_val]

            # Fine-tune
            current_model = current_model.fine_tune(
                X_train, y_train,
                X_val, y_val,
                plant_id=plant_id,
                verbose=verbose
            )

            # Update pseudo-labels with new predictions
            new_pred = current_model.predict(X)

            # Only update low-confidence labels
            low_conf_mask = current_conf < self.confidence_threshold
            current_pseudo.loc[low_conf_mask] = new_pred[low_conf_mask]

            # Increase confidence for predictions that match events
            # (self-consistency check)
            for i, date in enumerate(X.index):
                if not high_conf_mask.iloc[i]:
                    # Check if prediction is consistent with cleaning pattern
                    if i > 0 and current_pseudo.iloc[i] > current_pseudo.iloc[i-1] + 0.003:
                        # SR increasing without cause - might be cleaning
                        current_conf.iloc[i] = min(current_conf.iloc[i] + 0.1, 0.85)

        return current_model


def transfer_model_to_plant(
    foundation_model: SoilingRatioModel,
    plant_id: str,
    latitude: float,
    longitude: float,
    weather_path: str,
    aod_path: Optional[str] = None,
    pi_path: Optional[str] = None,
    output_dir: str = "models/soiling"
) -> Tuple[SoilingRatioModel, Dict]:
    """
    Transfer foundation model to a new plant.

    Parameters
    ----------
    foundation_model : SoilingRatioModel
        Pre-trained foundation model
    plant_id : str
        Target plant identifier
    latitude, longitude : float
        Plant location
    weather_path : str
        Path to weather data
    aod_path : str, optional
        Path to AOD data
    pi_path : str, optional
        Path to Performance Index data
    output_dir : str
        Output directory for model

    Returns
    -------
    model : SoilingRatioModel
        Fine-tuned model
    report : dict
        Transfer learning report
    """
    import json
    from pathlib import Path
    from datetime import datetime

    print(f"\nTransfer Learning: {foundation_model.metadata.plant_id} -> {plant_id}")

    # Load weather data
    with open(weather_path, 'r') as f:
        weather_data = json.load(f)
    df_weather = pd.DataFrame(weather_data['daily_data'])
    df_weather['date'] = pd.to_datetime(df_weather['date'])
    df_weather = df_weather.set_index('date')

    if 'precipitation_mm' not in df_weather.columns:
        df_weather['precipitation_mm'] = df_weather.get('precipitation', 0)

    # Load AOD if available
    df_aod = None
    if aod_path and Path(aod_path).exists():
        with open(aod_path, 'r') as f:
            aod_data = json.load(f)
        df_aod = pd.DataFrame(aod_data['daily_data'])
        df_aod['date'] = pd.to_datetime(df_aod['date'])
        df_aod = df_aod.set_index('date')

    # Load PI if available
    df_pi = None
    if pi_path and Path(pi_path).exists():
        with open(pi_path, 'r') as f:
            pi_data = json.load(f)
        df_pi = pd.DataFrame(pi_data['daily_data'])
        df_pi['date'] = pd.to_datetime(df_pi['date'])
        df_pi = df_pi.set_index('date')

    # Create feature engineer for target plant
    location = PlantLocation(latitude=latitude, longitude=longitude)
    feature_engineer = SoilingRatioFeatureEngineer(location)

    # Generate pseudo-labels
    label_generator = PseudoLabelGenerator(foundation_model, feature_engineer)
    X, y_pseudo, confidence = label_generator.generate_pseudo_labels(
        df_weather, df_aod, df_pi
    )

    # Detect events for report
    events = label_generator.detect_cleaning_events(df_weather, df_pi)

    # Fine-tune
    trainer = SemiSupervisedSRTrainer(foundation_model)
    fine_tuned_model = trainer.fine_tune(
        X, y_pseudo, confidence,
        plant_id=plant_id
    )

    # Save model
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    model_path = output_path / f"sr_model_{plant_id}.pkl"
    fine_tuned_model.save(model_path)

    # Compile report
    report = {
        'plant_id': plant_id,
        'foundation_plant': foundation_model.metadata.plant_id,
        'timestamp': datetime.now().isoformat(),
        'n_samples': len(X),
        'n_cleaning_events': len(events),
        'cleaning_events': [
            {'date': e.date, 'type': e.event_type, 'confidence': e.confidence}
            for e in events[:20]  # First 20
        ],
        'high_confidence_samples': int((confidence >= 0.8).sum()),
        'model_path': str(model_path)
    }

    print(f"\nTransfer complete. Model saved to: {model_path}")

    return fine_tuned_model, report
