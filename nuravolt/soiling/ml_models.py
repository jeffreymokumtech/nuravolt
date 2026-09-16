"""Unified ML model interface for soiling forecasting.

Supports both LightGBM and CatBoost with easy switching and comparison.
"""

import numpy as np
import pandas as pd
from typing import Dict, Optional, Tuple, List, Union
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from abc import ABC, abstractmethod
import warnings

# Try to import ML libraries
try:
    import lightgbm as lgb
    LIGHTGBM_AVAILABLE = True
except ImportError:
    LIGHTGBM_AVAILABLE = False
    warnings.warn("LightGBM not installed. Install with: pip install lightgbm")

try:
    from catboost import CatBoostRegressor, Pool
    CATBOOST_AVAILABLE = True
except ImportError:
    CATBOOST_AVAILABLE = False
    warnings.warn("CatBoost not installed. Install with: pip install catboost")


class BaseSoilingModel(ABC):
    """Abstract base class for soiling prediction models."""

    @abstractmethod
    def fit(self, X_train: pd.DataFrame, y_train: pd.Series,
            X_val: pd.DataFrame = None, y_val: pd.Series = None) -> 'BaseSoilingModel':
        """Fit the model to training data."""
        pass

    @abstractmethod
    def predict(self, X: pd.DataFrame) -> np.ndarray:
        """Make predictions."""
        pass

    @abstractmethod
    def get_feature_importance(self) -> pd.DataFrame:
        """Get feature importance scores."""
        pass


class LightGBMSoilingModel(BaseSoilingModel):
    """LightGBM model for soiling forecasting."""

    def __init__(self, params: Dict = None, num_boost_round: int = 1000,
                 early_stopping_rounds: int = 50, verbose: bool = True):
        """
        Initialize LightGBM soiling model.

        Parameters:
        -----------
        params : dict, optional
            LightGBM parameters. Uses optimized defaults if None.
        num_boost_round : int
            Maximum number of boosting rounds
        early_stopping_rounds : int
            Early stopping patience
        verbose : bool
            Whether to print training progress
        """
        if not LIGHTGBM_AVAILABLE:
            raise ImportError("LightGBM not installed. Install with: pip install lightgbm")

        self.params = params or {
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
            'min_data_in_leaf': 20,
            'lambda_l1': 0.1,
            'lambda_l2': 0.1,
        }
        self.num_boost_round = num_boost_round
        self.early_stopping_rounds = early_stopping_rounds
        self.verbose = verbose
        self.model = None
        self.feature_names = None
        self.best_iteration = None

    def fit(self, X_train: pd.DataFrame, y_train: pd.Series,
            X_val: pd.DataFrame = None, y_val: pd.Series = None) -> 'LightGBMSoilingModel':
        """
        Fit LightGBM model.

        Parameters:
        -----------
        X_train : pd.DataFrame
            Training features
        y_train : pd.Series
            Training target
        X_val : pd.DataFrame, optional
            Validation features (uses X_train if None)
        y_val : pd.Series, optional
            Validation target

        Returns:
        --------
        self : LightGBMSoilingModel
        """
        if self.verbose:
            print("⚙️ Training LightGBM model...")

        self.feature_names = X_train.columns.tolist()

        # Create datasets
        train_data = lgb.Dataset(X_train, label=y_train)
        valid_sets = [train_data]
        valid_names = ['train']

        if X_val is not None and y_val is not None:
            val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)
            valid_sets.append(val_data)
            valid_names.append('valid')

        # Setup callbacks
        callbacks = [
            lgb.early_stopping(stopping_rounds=self.early_stopping_rounds),
        ]
        if self.verbose:
            callbacks.append(lgb.log_evaluation(period=100))

        # Train
        self.model = lgb.train(
            self.params,
            train_data,
            num_boost_round=self.num_boost_round,
            valid_sets=valid_sets,
            valid_names=valid_names,
            callbacks=callbacks
        )

        self.best_iteration = self.model.best_iteration

        if self.verbose:
            print(f"✅ LightGBM trained (best iteration: {self.best_iteration})")
            if 'valid' in self.model.best_score:
                print(f"   Validation MAE: {self.model.best_score['valid']['l1']:.4f}")

        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        """Make predictions."""
        if self.model is None:
            raise ValueError("Model not trained. Call fit() first.")
        return self.model.predict(X)

    def get_feature_importance(self) -> pd.DataFrame:
        """Get feature importance (gain-based)."""
        if self.model is None:
            raise ValueError("Model not trained. Call fit() first.")

        importance = self.model.feature_importance(importance_type='gain')
        return pd.DataFrame({
            'feature': self.feature_names,
            'importance': importance
        }).sort_values('importance', ascending=False)


class CatBoostSoilingModel(BaseSoilingModel):
    """CatBoost model for soiling forecasting."""

    def __init__(self, params: Dict = None, iterations: int = 1000,
                 early_stopping_rounds: int = 50, verbose: bool = True):
        """
        Initialize CatBoost soiling model.

        Parameters:
        -----------
        params : dict, optional
            CatBoost parameters. Uses optimized defaults if None.
        iterations : int
            Maximum number of boosting iterations
        early_stopping_rounds : int
            Early stopping patience
        verbose : bool
            Whether to print training progress
        """
        if not CATBOOST_AVAILABLE:
            raise ImportError("CatBoost not installed. Install with: pip install catboost")

        self.params = params or {
            'loss_function': 'MAE',
            'eval_metric': 'MAE',
            'learning_rate': 0.05,
            'depth': 6,
            'l2_leaf_reg': 3,
            'random_seed': 42,
            'thread_count': 4,
            'bootstrap_type': 'Bayesian',
            'bagging_temperature': 1,
        }
        self.iterations = iterations
        self.early_stopping_rounds = early_stopping_rounds
        self.verbose = verbose
        self.model = None
        self.feature_names = None
        self.best_iteration = None

    def fit(self, X_train: pd.DataFrame, y_train: pd.Series,
            X_val: pd.DataFrame = None, y_val: pd.Series = None) -> 'CatBoostSoilingModel':
        """
        Fit CatBoost model.

        Parameters:
        -----------
        X_train : pd.DataFrame
            Training features
        y_train : pd.Series
            Training target
        X_val : pd.DataFrame, optional
            Validation features
        y_val : pd.Series, optional
            Validation target

        Returns:
        --------
        self : CatBoostSoilingModel
        """
        if self.verbose:
            print("⚙️ Training CatBoost model...")

        self.feature_names = X_train.columns.tolist()

        # Create model
        self.model = CatBoostRegressor(
            iterations=self.iterations,
            early_stopping_rounds=self.early_stopping_rounds,
            verbose=100 if self.verbose else 0,
            **self.params
        )

        # Create evaluation set
        eval_set = None
        if X_val is not None and y_val is not None:
            eval_set = Pool(X_val, y_val)

        # Train
        self.model.fit(
            X_train, y_train,
            eval_set=eval_set,
            use_best_model=True
        )

        self.best_iteration = self.model.get_best_iteration() if eval_set is not None else self.iterations

        if self.verbose:
            print(f"✅ CatBoost trained (best iteration: {self.best_iteration})")
            if eval_set is not None:
                val_pred = self.model.predict(X_val)
                val_mae = mean_absolute_error(y_val, val_pred)
                print(f"   Validation MAE: {val_mae:.4f}")

        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        """Make predictions."""
        if self.model is None:
            raise ValueError("Model not trained. Call fit() first.")
        return self.model.predict(X)

    def get_feature_importance(self) -> pd.DataFrame:
        """Get feature importance."""
        if self.model is None:
            raise ValueError("Model not trained. Call fit() first.")

        importance = self.model.get_feature_importance()
        return pd.DataFrame({
            'feature': self.feature_names,
            'importance': importance
        }).sort_values('importance', ascending=False)


class ModelFactory:
    """Factory for creating soiling prediction models."""

    @staticmethod
    def create(model_type: str = 'lightgbm', **kwargs) -> BaseSoilingModel:
        """
        Create a soiling prediction model.

        Parameters:
        -----------
        model_type : str
            Model type: 'lightgbm' or 'catboost'
        **kwargs
            Additional arguments passed to model constructor

        Returns:
        --------
        BaseSoilingModel
            Configured model instance
        """
        model_type = model_type.lower()

        if model_type == 'lightgbm':
            return LightGBMSoilingModel(**kwargs)
        elif model_type == 'catboost':
            return CatBoostSoilingModel(**kwargs)
        else:
            raise ValueError(f"Unknown model type: {model_type}. Use 'lightgbm' or 'catboost'")

    @staticmethod
    def available_models() -> List[str]:
        """Get list of available model types."""
        available = []
        if LIGHTGBM_AVAILABLE:
            available.append('lightgbm')
        if CATBOOST_AVAILABLE:
            available.append('catboost')
        return available


class ModelComparator:
    """Compare performance of different ML models for soiling forecasting."""

    def __init__(self, X_train: pd.DataFrame, y_train: pd.Series,
                 X_test: pd.DataFrame, y_test: pd.Series):
        """
        Initialize model comparator.

        Parameters:
        -----------
        X_train, y_train : pd.DataFrame, pd.Series
            Training data
        X_test, y_test : pd.DataFrame, pd.Series
            Test data
        """
        self.X_train = X_train
        self.y_train = y_train
        self.X_test = X_test
        self.y_test = y_test
        self.results = {}
        self.models = {}

    def add_model(self, name: str, model: BaseSoilingModel) -> 'ModelComparator':
        """
        Add a model to compare.

        Parameters:
        -----------
        name : str
            Model name/identifier
        model : BaseSoilingModel
            Model instance (unfitted)

        Returns:
        --------
        self : ModelComparator
        """
        self.models[name] = model
        return self

    def run_comparison(self, verbose: bool = True) -> pd.DataFrame:
        """
        Train and evaluate all models.

        Parameters:
        -----------
        verbose : bool
            Print progress and results

        Returns:
        --------
        pd.DataFrame
            Comparison results with metrics for each model
        """
        if verbose:
            print("=" * 60)
            print("🔬 MODEL COMPARISON - Soiling Forecasting")
            print("=" * 60)

        results = []

        for name, model in self.models.items():
            if verbose:
                print(f"\n📊 Training: {name}")
                print("-" * 40)

            try:
                # Train model
                model.fit(self.X_train, self.y_train, self.X_test, self.y_test)

                # Predict
                y_pred_train = model.predict(self.X_train)
                y_pred_test = model.predict(self.X_test)

                # Calculate metrics
                metrics = {
                    'model': name,
                    'mae_train': mean_absolute_error(self.y_train, y_pred_train),
                    'mae_test': mean_absolute_error(self.y_test, y_pred_test),
                    'rmse_train': np.sqrt(mean_squared_error(self.y_train, y_pred_train)),
                    'rmse_test': np.sqrt(mean_squared_error(self.y_test, y_pred_test)),
                    'r2_train': r2_score(self.y_train, y_pred_train),
                    'r2_test': r2_score(self.y_test, y_pred_test),
                    'best_iteration': getattr(model, 'best_iteration', None),
                }

                results.append(metrics)
                self.results[name] = {
                    'metrics': metrics,
                    'y_pred_train': y_pred_train,
                    'y_pred_test': y_pred_test,
                    'feature_importance': model.get_feature_importance()
                }

                if verbose:
                    print(f"   Test MAE: {metrics['mae_test']:.4f}")
                    print(f"   Test RMSE: {metrics['rmse_test']:.4f}")
                    print(f"   Test R²: {metrics['r2_test']:.4f}")

            except Exception as e:
                print(f"   ❌ Error training {name}: {e}")
                results.append({
                    'model': name,
                    'mae_test': np.nan,
                    'rmse_test': np.nan,
                    'r2_test': np.nan,
                    'error': str(e)
                })

        df_results = pd.DataFrame(results)

        if verbose:
            print("\n" + "=" * 60)
            print("📊 COMPARISON SUMMARY")
            print("=" * 60)
            print(df_results[['model', 'mae_test', 'rmse_test', 'r2_test']].to_string(index=False))

            # Find best model
            best_idx = df_results['mae_test'].idxmin()
            best_model = df_results.loc[best_idx, 'model']
            best_mae = df_results.loc[best_idx, 'mae_test']
            print(f"\n🏆 Best Model: {best_model} (MAE: {best_mae:.4f})")

            # Calculate improvement percentage
            if len(df_results) > 1:
                worst_mae = df_results['mae_test'].max()
                improvement = (worst_mae - best_mae) / worst_mae * 100
                print(f"   Improvement over worst: {improvement:.1f}%")

        return df_results

    def get_best_model(self) -> Tuple[str, BaseSoilingModel]:
        """
        Get the best performing model.

        Returns:
        --------
        Tuple[str, BaseSoilingModel]
            Best model name and instance
        """
        if not self.results:
            raise ValueError("Run comparison first using run_comparison()")

        best_name = min(self.results.keys(),
                       key=lambda k: self.results[k]['metrics']['mae_test'])
        return best_name, self.models[best_name]

    def plot_comparison(self, save_path: str = None):
        """
        Create comparison visualization.

        Parameters:
        -----------
        save_path : str, optional
            Path to save HTML plot
        """
        try:
            import plotly.graph_objects as go
            from plotly.subplots import make_subplots
        except ImportError:
            print("Plotly not available for visualization")
            return None

        if not self.results:
            raise ValueError("Run comparison first using run_comparison()")

        # Create subplots
        fig = make_subplots(
            rows=2, cols=2,
            subplot_titles=[
                'MAE Comparison', 'R² Comparison',
                'Actual vs Predicted', 'Residual Distribution'
            ]
        )

        colors = {'lightgbm': '#3366cc', 'catboost': '#dc3912'}
        model_names = list(self.results.keys())

        # MAE comparison
        mae_values = [self.results[m]['metrics']['mae_test'] for m in model_names]
        fig.add_trace(
            go.Bar(
                x=model_names, y=mae_values,
                marker_color=[colors.get(m.lower(), '#999') for m in model_names],
                name='Test MAE'
            ),
            row=1, col=1
        )

        # R² comparison
        r2_values = [self.results[m]['metrics']['r2_test'] for m in model_names]
        fig.add_trace(
            go.Bar(
                x=model_names, y=r2_values,
                marker_color=[colors.get(m.lower(), '#999') for m in model_names],
                name='Test R²'
            ),
            row=1, col=2
        )

        # Actual vs Predicted for each model
        for i, name in enumerate(model_names):
            y_pred = self.results[name]['y_pred_test']
            fig.add_trace(
                go.Scatter(
                    x=self.y_test.values[:200],  # Sample for visibility
                    y=y_pred[:200],
                    mode='markers',
                    marker=dict(
                        color=colors.get(name.lower(), '#999'),
                        opacity=0.5,
                        size=5
                    ),
                    name=name
                ),
                row=2, col=1
            )

        # Add perfect prediction line
        fig.add_trace(
            go.Scatter(
                x=[0.7, 1.0], y=[0.7, 1.0],
                mode='lines',
                line=dict(color='gray', dash='dash'),
                name='Perfect'
            ),
            row=2, col=1
        )

        # Residual distribution
        for name in model_names:
            y_pred = self.results[name]['y_pred_test']
            residuals = self.y_test.values - y_pred
            fig.add_trace(
                go.Histogram(
                    x=residuals,
                    name=f'{name} Residuals',
                    opacity=0.6,
                    marker_color=colors.get(name.lower(), '#999')
                ),
                row=2, col=2
            )

        fig.update_layout(
            height=800,
            title_text='Model Comparison: LightGBM vs CatBoost',
            showlegend=True
        )

        if save_path:
            fig.write_html(save_path)
            print(f"💾 Comparison plot saved to {save_path}")

        return fig


def compare_models(X_train: pd.DataFrame, y_train: pd.Series,
                   X_test: pd.DataFrame, y_test: pd.Series,
                   models_to_compare: List[str] = None,
                   save_path: str = None) -> Dict:
    """
    Convenience function to compare available models.

    Parameters:
    -----------
    X_train, y_train : Training data
    X_test, y_test : Test data
    models_to_compare : List of model types to compare (default: all available)
    save_path : Optional path for comparison plot

    Returns:
    --------
    dict
        Comparison results with best model info
    """
    if models_to_compare is None:
        models_to_compare = ModelFactory.available_models()

    if not models_to_compare:
        raise ImportError("No ML libraries available. Install lightgbm or catboost.")

    print(f"📊 Comparing models: {', '.join(models_to_compare)}")

    comparator = ModelComparator(X_train, y_train, X_test, y_test)

    for model_type in models_to_compare:
        try:
            model = ModelFactory.create(model_type, verbose=True)
            comparator.add_model(model_type.upper(), model)
        except ImportError as e:
            print(f"⚠️ Skipping {model_type}: {e}")

    df_results = comparator.run_comparison()

    if save_path:
        comparator.plot_comparison(save_path)

    best_name, best_model = comparator.get_best_model()

    return {
        'results': df_results,
        'best_model_name': best_name,
        'best_model': best_model,
        'all_results': comparator.results
    }
