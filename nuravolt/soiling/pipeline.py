"""End-to-end soiling intelligence pipeline orchestration."""

import pandas as pd
import polars as pl
from pvlib.location import Location
from typing import Optional, Dict, Any, Tuple

from nuravolt.soiling.config import SITE_CONFIG, SoilingConfig
from nuravolt.soiling.data_acquisition import download_cams_aerosol_data, download_nasa_power_weather
from nuravolt.soiling.clearsky import calculate_clearsky_poa
from nuravolt.soiling.soiling_ratio import calculate_soiling_ratio
from nuravolt.soiling.event_detection import (
    detect_cleaning_events,
    detect_cleaning_events_hybrid,
    print_cleaning_summary
)
from nuravolt.soiling.features import create_all_features
from nuravolt.soiling.forecasting import (
    prepare_training_data,
    train_lightgbm_model,
    evaluate_model,
    get_feature_importance,
)
from nuravolt.soiling.forecasting_longterm import PhysicsMLHybridForecaster
from nuravolt.soiling.chronos2_forecaster import (
    Chronos2SoilingForecaster,
    Chronos2Config,
    ChronosDependenciesMissing,
    is_chronos_available,
)
from nuravolt.soiling.economics import (
    print_breakeven_analysis,
    optimize_cleaning_schedule,
    print_cleaning_schedule,
    calculate_roi_analysis,
)
from nuravolt.soiling.visualization import (
    plot_soiling_detection,
    plot_cleaning_events,
    plot_forecast,
    plot_dashboard,
    create_interactive_schedule_html,
)

# Cold-start threshold — minimum days of DustIQ ground truth required before
# the standard LightGBM/CatBoost forecasters are reliable. Mirrors the
# `MIN_TRAINING_DAYS` constant in `estimation/layer2_same_plant_ml.py`.
MIN_TRAINING_DAYS = 90


class SoilingIntelligencePipeline:
    """
    End-to-end soiling intelligence pipeline.

    This class orchestrates the complete soiling analysis workflow:
    1. Load plant data
    2. Download external data (CAMS, NASA POWER)
    3. Calculate clearsky POA
    4. Calculate soiling ratio
    5. Detect cleaning events
    6. Engineer features
    7. Train ML forecasting model
    8. Generate cleaning schedule
    9. Calculate ROI
    10. Create visualizations

    Example:
    --------
    >>> pipeline = SoilingIntelligencePipeline(SITE_CONFIG)
    >>> pipeline.load_data('data/alpha1_9mw.parquet')
    >>> pipeline.run_full_analysis()
    >>> pipeline.show_dashboard()
    """

    def __init__(self, site_config=None):
        """
        Initialize pipeline with site configuration.

        Parameters:
        -----------
        site_config : dict or SoilingConfig, optional
            Site configuration (uses SITE_CONFIG if None)
        """
        if site_config is None:
            site_config = SITE_CONFIG

        if isinstance(site_config, dict):
            self.config = SoilingConfig.from_dict(site_config)
        else:
            self.config = site_config

        # Create pvlib Location object
        self.location = Location(
            latitude=self.config.latitude,
            longitude=self.config.longitude,
            tz=self.config.timezone,
            altitude=self.config.elevation
        )

        # Pipeline state
        self.df_pl = None  # Polars DataFrame (raw data)
        self.df_pd = None  # Pandas DataFrame (15-min data)
        self.df_daily = None  # Daily aggregated data
        self.df_features = None  # Feature matrix
        self.model = None  # Trained ML model
        self.X_train = None
        self.X_test = None
        self.y_train = None
        self.y_test = None
        self.y_pred_test = None
        self.schedule = None  # Cleaning schedule
        self.roi_metrics = None  # ROI analysis results

        # Digital twin state
        self.df_twin_outputs = None  # Twin outputs (current_cv, temp_deviation, etc.)
        self.plant_config = None  # PlantConfig for multi-signal twins

        print(f"✅ Pipeline initialized for: {self.config.name}")
        print(f"   Plant ID: {self.config.plant_id}")
        print(f"   Capacity: {self.config.capacity_MW} MW")

    def load_data(self, filepath, format='parquet'):
        """
        Load plant data from file.

        Parameters:
        -----------
        filepath : str
            Path to data file
        format : str
            File format: 'parquet' or 'csv'
        """
        print(f"\n⚙️ Loading data from {filepath}...")

        if format == 'parquet':
            self.df_pl = pl.read_parquet(filepath)
        elif format == 'csv':
            self.df_pl = pl.read_csv(filepath)
        else:
            raise ValueError(f"Unsupported format: {format}")

        # Convert to pandas for pvlib compatibility
        self.df_pd = self.df_pl.to_pandas()

        # Handle both 'datetime' and 'timestamp' column names
        if 'timestamp' in self.df_pd.columns:
            self.df_pd['timestamp'] = pd.to_datetime(self.df_pd['timestamp'])
            self.df_pd = self.df_pd.set_index('timestamp').sort_index()
        elif 'datetime' in self.df_pd.columns:
            self.df_pd['datetime'] = pd.to_datetime(self.df_pd['datetime'])
            self.df_pd = self.df_pd.set_index('datetime').sort_index()
        else:
            raise ValueError("Data must have either 'datetime' or 'timestamp' column")

        print(f"✅ Data loaded")
        print(f"   Rows: {len(self.df_pd):,}")
        print(f"   Columns: {len(self.df_pd.columns)}")
        print(f"   Period: {self.df_pd.index[0]} to {self.df_pd.index[-1]}")

    def download_external_data(self, download_cams=True, download_nasa=False):
        """
        Download external data sources (CAMS aerosol, NASA POWER weather).

        Parameters:
        -----------
        download_cams : bool
            Download CAMS aerosol data (default: True)
        download_nasa : bool
            Download NASA POWER weather data (default: False, disabled for now)
        """
        if download_cams:
            print("\n⚙️ Downloading CAMS aerosol data...")
            self.df_pd = download_cams_aerosol_data(
                self.df_pd,
                self.config.latitude,
                self.config.longitude
            )

        if download_nasa:
            print("\n⚙️ Downloading NASA POWER weather data...")
            print("   ⚠️ NASA POWER downloads are currently disabled")
            # self.df_pd = download_nasa_power_weather(
            #     self.df_pd,
            #     self.config.latitude,
            #     self.config.longitude
            # )

    def calculate_clearsky(self):
        """Calculate clearsky POA irradiance using pvlib."""
        print("\n⚙️ Calculating clearsky POA...")
        self.df_pd = calculate_clearsky_poa(
            self.df_pd,
            self.location,
            self.config.tilt,
            self.config.azimuth
        )

    def calculate_soiling(self, window_days=7):
        """
        Calculate soiling ratio with smoothing.

        Parameters:
        -----------
        window_days : int
            Rolling window size for smoothing (default: 7)
        """
        print("\n⚙️ Calculating soiling ratio...")
        self.df_pd = calculate_soiling_ratio(self.df_pd, window_days=window_days)

        # Create daily aggregation
        self.df_daily = self.df_pd.resample('1D').agg({
            'soiling_ratio_smooth': 'mean',
            'poa_actual': 'mean',
            'rainfall': 'sum',
        })

    def detect_events(self):
        """Detect cleaning events using hybrid method (SR + power)."""
        print("\n⚙️ Detecting cleaning events...")
        # Use hybrid detection for better coverage
        self.df_daily = detect_cleaning_events_hybrid(
            self.df_pd,
            self.df_daily,
            sr_threshold=0.06,
            power_threshold=8.0,
            rain_threshold=10.0
        )
        print_cleaning_summary(self.df_daily)

    def run_digital_twins(
        self,
        plant_config_path: Optional[str] = None,
        inverter_ids: Optional[list] = None
    ):
        """
        Run multi-signal digital twin inference for DC-side features.

        Generates features from DC currents, voltages, and temperatures that
        help distinguish soiling from other loss mechanisms:
        - current_cv: Uniformity metric (low = uniform soiling, high = partial shading)
        - temp_deviation: Thermal vs optical loss discrimination
        - voltage_cv: Degradation/hotspot indicator

        Parameters
        ----------
        plant_config_path : str, optional
            Path to plant YAML config file. If None, skips DC-side analysis.
        inverter_ids : list, optional
            List of inverter IDs to analyze. If None, analyzes all available.

        Returns
        -------
        pd.DataFrame
            Daily aggregated twin outputs with columns:
            - current_cv: Mean DC current coefficient of variation
            - temp_deviation: Mean inverter temperature deviation (°C)
            - voltage_cv: Mean DC voltage coefficient of variation
            - current_imbalance: Max current imbalance ratio
        """
        if plant_config_path is None:
            print("\n⚙️ Skipping digital twin inference (no plant config provided)")
            return None

        print(f"\n⚙️ Running digital twin inference...")
        print(f"   Config: {plant_config_path}")

        try:
            # Import multi-signal twin module
            from nuravolt.digitaltwin.multi_signal_twin import MultiSignalTwinFactory
            from nuravolt.digitaltwin.plant_config import PlantConfig

            # Load plant config
            self.plant_config = PlantConfig.from_yaml(plant_config_path)
            print(f"   Plant: {self.plant_config.plant_name}")

            # Initialize twin factory
            factory = MultiSignalTwinFactory(self.plant_config)

            # Determine inverters to analyze
            if inverter_ids is None:
                # Auto-detect inverters from data columns
                inverter_ids = factory.detect_inverters(self.df_pd)

            if not inverter_ids:
                print("   ⚠️ No inverters detected in data")
                return None

            print(f"   Analyzing {len(inverter_ids)} inverters...")

            # Collect twin outputs for each inverter
            all_outputs = []
            for inv_id in inverter_ids:
                try:
                    outputs = factory.get_soiling_features(self.df_pd, inv_id)
                    if outputs is not None:
                        outputs['inverter_id'] = inv_id
                        all_outputs.append(outputs)
                except Exception as e:
                    print(f"   ⚠️ Skipping {inv_id}: {e}")
                    continue

            if not all_outputs:
                print("   ⚠️ No valid twin outputs generated")
                return None

            # Combine and aggregate to daily level
            df_combined = pd.concat(all_outputs, ignore_index=True)

            # Aggregate across inverters (mean per timestamp)
            df_agg = df_combined.groupby('timestamp').agg({
                'current_cv': 'mean',
                'temp_deviation': 'mean',
                'voltage_cv': 'mean',
                'current_imbalance': 'max'  # Take max imbalance
            }).reset_index()

            # Resample to daily
            df_agg['date'] = pd.to_datetime(df_agg['timestamp']).dt.date
            self.df_twin_outputs = df_agg.groupby('date').agg({
                'current_cv': 'mean',
                'temp_deviation': 'mean',
                'voltage_cv': 'mean',
                'current_imbalance': 'max'
            })

            print(f"   ✅ Twin outputs generated: {len(self.df_twin_outputs)} days")
            print(f"   Features: current_cv, temp_deviation, voltage_cv, current_imbalance")

            return self.df_twin_outputs

        except ImportError as e:
            print(f"   ⚠️ Digital twin module not available: {e}")
            return None
        except Exception as e:
            print(f"   ⚠️ Digital twin inference failed: {e}")
            return None

    def create_features(self):
        """Engineer features for ML forecasting."""
        print("\n⚙️ Creating features...")
        self.df_features = create_all_features(
            self.df_pd,
            self.df_daily,
            self.location
        )

    def train_model(self, forecast_horizon=7, train_split=0.8):
        """
        Train ML forecasting model.

        Parameters:
        -----------
        forecast_horizon : int
            Days ahead to forecast (default: 7)
        train_split : float
            Fraction of data for training (default: 0.8)
        """
        print("\n⚙️ Training ML model...")

        # Prepare data
        self.X_train, self.X_test, self.y_train, self.y_test = prepare_training_data(
            self.df_features,
            self.df_daily,
            forecast_horizon=forecast_horizon,
            train_split=train_split
        )

        # Train model
        self.model = train_lightgbm_model(
            self.X_train, self.y_train,
            self.X_test, self.y_test
        )

        # Evaluate
        eval_results = evaluate_model(
            self.model,
            self.X_train, self.y_train,
            self.X_test, self.y_test,
            forecast_horizon=forecast_horizon
        )

        self.y_pred_test = eval_results['y_pred_test']

        # Feature importance
        get_feature_importance(self.model, self.X_train, top_n=20)

    def generate_long_term_forecast(
        self,
        sr_history: Optional[pd.Series] = None,
        last_date: Optional[pd.Timestamp] = None,
        horizon_days: int = 365,
        min_training_days: int = MIN_TRAINING_DAYS,
        force_method: Optional[str] = None,
    ) -> Tuple[pd.DataFrame, Dict[str, Any]]:
        """Generate a long-horizon (e.g. 365-day) soiling-ratio forecast.

        Branches on history length:
          * `len(sr_history) < min_training_days` → Chronos-2 zero-shot
          * otherwise → existing `PhysicsMLHybridForecaster`

        When the ml-foundation extra (torch + chronos) is not installed and
        the cold-start branch is taken, this raises `ChronosDependenciesMissing`
        unless `force_method='physics_only'` is passed — letting callers
        choose between hard-failing on the missing dep or degrading gracefully.

        Parameters
        ----------
        sr_history
            Daily SR observations. Defaults to `self.df_daily['soiling_ratio_smooth']`
            if available.
        last_date
            Last observation date. Defaults to `sr_history.index[-1]`.
        horizon_days
            Forecast horizon (default 365).
        min_training_days
            Threshold for branching. Default 90 days.
        force_method
            Optional override: `'chronos2_zeroshot'` | `'physics_ml_hybrid'`
            | `'physics_only'`.

        Returns
        -------
        (df_forecast, metadata)
            DataFrame in `PhysicsMLHybridForecaster.predict_365d_hybrid` shape,
            plus a metadata dict with `model_type`, `model_version`, training
            details, and `is_cold_start`.
        """
        if sr_history is None:
            if not hasattr(self, "df_daily") or self.df_daily is None:
                raise ValueError(
                    "generate_long_term_forecast() requires sr_history or a pre-computed df_daily"
                )
            sr_history = self.df_daily["soiling_ratio_smooth"].dropna()

        if last_date is None:
            last_date = pd.Timestamp(sr_history.index[-1])

        # Decide which path to take.
        n_history = len(sr_history)
        is_cold_start = n_history < min_training_days
        if force_method == "chronos2_zeroshot":
            method = "chronos2_zeroshot"
        elif force_method == "physics_ml_hybrid":
            method = "physics_ml_hybrid"
        elif force_method == "physics_only":
            method = "physics_only"
        elif is_cold_start:
            method = "chronos2_zeroshot"
        else:
            method = "physics_ml_hybrid"

        # -- Cold-start: Chronos-2 zero-shot ------------------------------
        if method == "chronos2_zeroshot":
            forecaster = Chronos2SoilingForecaster(
                Chronos2Config(cleaning_threshold=0.97)
            )
            df = forecaster.predict_sr_forecast(
                sr_history=sr_history.tail(min(n_history, 90)),
                last_date=last_date,
                horizon_days=horizon_days,
            )
            metadata = {
                "model_type": "chronos2_zeroshot",
                "model_version": forecaster.model_id or "chronos2",
                "is_cold_start": True,
                "input_window_days": min(n_history, 90),
                "training_data_days": n_history,
                "min_training_days_threshold": min_training_days,
            }
            return df, metadata

        # -- Standard path: PhysicsMLHybridForecaster ---------------------
        trained_model = getattr(self, "model", None) if method == "physics_ml_hybrid" else None
        forecaster = PhysicsMLHybridForecaster(
            self.config, trained_model=trained_model, model_type="lightgbm"
        )
        df = forecaster.predict_365d_hybrid(
            last_sr=float(sr_history.iloc[-1]),
            last_date=last_date,
            df_daily_historical=self.df_daily if hasattr(self, "df_daily") else pd.DataFrame(),
            include_uncertainty=True,
        )
        metadata = {
            "model_type": method,
            "model_version": "physics_ml_hybrid_v1" if trained_model else "physics_only",
            "is_cold_start": False,
            "training_data_days": n_history,
            "min_training_days_threshold": min_training_days,
        }
        return df, metadata

    def generate_schedule(self, cleaning_threshold_sr=0.97):
        """
        Generate optimal cleaning schedule.

        Parameters:
        -----------
        cleaning_threshold_sr : float
            SR threshold to trigger cleaning (default: 0.97 = 3% loss)
        """
        print("\n⚙️ Generating cleaning schedule...")

        self.schedule = optimize_cleaning_schedule(
            self.df_daily.loc[self.X_test.index],
            self.y_pred_test,
            cleaning_threshold_sr=cleaning_threshold_sr
        )

        print_cleaning_schedule(self.schedule, self.X_test)

    def calculate_roi(self):
        """Calculate ROI analysis."""
        print("\n⚙️ Calculating ROI...")

        cleanings_scheduled = [s for s in self.schedule if not s['reason'].startswith('SKIP')]
        cleanings_avoided = [s for s in self.schedule if s['reason'].startswith('SKIP')]

        self.roi_metrics = calculate_roi_analysis(
            self.config,
            cleanings_scheduled,
            cleanings_avoided,
            self.X_test
        )

    def economic_analysis(self):
        """Run economic break-even analysis."""
        print("\n⚙️ Running economic analysis...")
        print_breakeven_analysis(self.config)

    def show_soiling_detection(self, start_date='2021-06-01', end_date='2021-09-01'):
        """
        Show soiling detection visualization.

        Parameters:
        -----------
        start_date : str
            Start date for visualization
        end_date : str
            End date for visualization
        """
        fig = plot_soiling_detection(self.df_pd, start_date, end_date)
        fig.show()

    def show_cleaning_events(self):
        """Show cleaning events visualization."""
        n_manual = self.df_daily['is_manual_cleaning'].sum()
        n_rain = self.df_daily['is_rain_cleaning'].sum()
        fig = plot_cleaning_events(self.df_daily, n_manual, n_rain)
        fig.show()

    def show_forecast(self, sample_size=180):
        """
        Show forecast visualization.

        Parameters:
        -----------
        sample_size : int
            Number of days to plot (default: 180)
        """
        mae_test = evaluate_model(
            self.model,
            self.X_train, self.y_train,
            self.X_test, self.y_test
        )['mae_test']

        fig = plot_forecast(self.X_test, self.y_test, self.y_pred_test, mae_test, sample_size)
        fig.show()

    def show_dashboard(self, sample_size=180):
        """
        Show comprehensive dashboard.

        Parameters:
        -----------
        sample_size : int
            Number of days to plot (default: 180)
        """
        cleanings_scheduled = [s for s in self.schedule if not s['reason'].startswith('SKIP')]
        cleaning_cost_total = self.config.capacity_MW * self.config.cleaning_cost_per_MW

        fig = plot_dashboard(
            self.df_pd,
            self.df_daily,
            self.X_test,
            self.y_test,
            self.y_pred_test,
            cleanings_scheduled,
            cleaning_cost_total,
            sample_size=sample_size
        )
        fig.show()

    def create_interactive_schedule(self, output_path='interactive_schedule.html'):
        """
        Create interactive HTML cleaning schedule with adjustable parameters.

        Parameters:
        -----------
        output_path : str
            Path to save HTML file

        Returns:
        --------
        str
            Path to generated HTML file
        """
        from nuravolt.soiling.economics import CleaningEconomics

        # Create economics object from config
        economics = CleaningEconomics(
            capacity_MW=self.config.capacity_MW,
            cleaning_cost_per_MW=self.config.cleaning_cost_per_MW,
            electricity_rate_per_MWh=self.config.electricity_rate_per_MWh,
            avg_sun_hours_per_day=self.config.avg_sun_hours_per_day,
            cleaning_threshold_sr=self.config.cleaning_threshold_sr,
            min_days_between=self.config.min_days_between,
        )

        return create_interactive_schedule_html(
            economics,
            self.schedule,
            self.X_test,
            self.df_daily,
            output_path=output_path
        )

    def run_full_analysis(
        self,
        download_external: bool = False,
        plant_config_path: Optional[str] = None,
        use_digital_twins: bool = False
    ):
        """
        Run complete soiling intelligence analysis pipeline.

        Parameters:
        -----------
        download_external : bool
            Whether to download external data (CAMS, NASA POWER)
        plant_config_path : str, optional
            Path to plant YAML config for digital twin inference.
            Required if use_digital_twins=True.
        use_digital_twins : bool
            Whether to run multi-signal digital twin inference for
            enhanced soiling feature engineering. Adds features:
            - current_cv: DC current uniformity (soiling vs shading)
            - temp_deviation: Thermal vs optical loss discrimination
            - voltage_cv: Degradation/hotspot indicator
        """
        print("\n" + "="*70)
        print("🚀 SOILING INTELLIGENCE PIPELINE - FULL ANALYSIS")
        print("="*70)

        # Download external data if requested
        if download_external:
            self.download_external_data()

        # Core analysis steps
        self.calculate_clearsky()
        self.calculate_soiling()
        self.detect_events()

        # Optional: Run digital twins for enhanced features
        if use_digital_twins:
            self.run_digital_twins(plant_config_path)

        self.create_features()
        self.train_model()
        self.generate_schedule()
        self.economic_analysis()
        self.calculate_roi()

        print("\n" + "="*70)
        print("✅ PIPELINE COMPLETE")
        print("="*70)
        print("\nAvailable visualizations:")
        print("  - pipeline.show_soiling_detection()")
        print("  - pipeline.show_cleaning_events()")
        print("  - pipeline.show_forecast()")
        print("  - pipeline.show_dashboard()")
        if self.df_twin_outputs is not None:
            print("  - pipeline.df_twin_outputs (digital twin features)")

    def save_results(self, output_dir='outputs'):
        """
        Save pipeline results to files.

        Parameters:
        -----------
        output_dir : str
            Directory to save results
        """
        import os
        os.makedirs(output_dir, exist_ok=True)

        # Save model
        self.model.save_model(f'{output_dir}/soiling_model.txt')

        # Save schedule
        schedule_df = pd.DataFrame(self.schedule)
        schedule_df.to_csv(f'{output_dir}/cleaning_schedule.csv', index=False)

        # Save ROI metrics
        if self.roi_metrics:
            roi_df = pd.DataFrame([self.roi_metrics])
            roi_df.to_csv(f'{output_dir}/roi_analysis.csv', index=False)

        # Save digital twin outputs
        if self.df_twin_outputs is not None:
            self.df_twin_outputs.to_csv(f'{output_dir}/twin_outputs.csv')
            print(f"   Saved: twin_outputs.csv ({len(self.df_twin_outputs)} days)")

        print(f"\n✅ Results saved to {output_dir}/")

    def create_transfer_learning_features(
        self,
        df_weather: Optional[pd.DataFrame] = None,
        df_aod: Optional[pd.DataFrame] = None
    ) -> pd.DataFrame:
        """
        Create plant-agnostic features for transfer learning using sr_ml_features.py.

        This method generates features that are available at ANY plant globally,
        enabling transfer learning from plants with DustIQ sensors to plants without.

        Unlike create_features(), this method:
        1. Uses only globally available data (weather, AOD)
        2. Integrates digital twin outputs (if available)
        3. Avoids power-based features that would cause data leakage

        Parameters
        ----------
        df_weather : pd.DataFrame, optional
            Daily weather data. If None, uses internal weather data.
        df_aod : pd.DataFrame, optional
            Daily AOD data from CAMS. If None, attempts to use internal data.

        Returns
        -------
        pd.DataFrame
            Plant-agnostic feature matrix with digital twin enhancements
        """
        print("\n⚙️ Creating transfer learning features...")

        try:
            from nuravolt.soiling.sr_ml_features import (
                SoilingRatioFeatureEngineer,
                PlantLocation
            )
        except ImportError as e:
            print(f"   ⚠️ sr_ml_features module not available: {e}")
            return None

        # Create location object
        location = PlantLocation(
            latitude=self.config.latitude,
            longitude=self.config.longitude,
            elevation_m=self.config.elevation
        )

        # Initialize feature engineer
        engineer = SoilingRatioFeatureEngineer(location)

        # Prepare weather data
        if df_weather is None:
            # Extract weather from internal data
            if self.df_daily is not None:
                df_weather = self.df_daily[['rainfall']].rename(
                    columns={'rainfall': 'precipitation_mm'}
                )
            else:
                print("   ⚠️ No weather data available")
                return None

        # Generate features with digital twin integration
        df_features = engineer.generate_features(
            df_weather=df_weather,
            df_aod=df_aod,
            df_twin_outputs=self.df_twin_outputs  # Pass twin outputs
        )

        print(f"   ✅ Generated {len(df_features.columns)} transfer learning features")
        if self.df_twin_outputs is not None:
            twin_features = [c for c in df_features.columns if any(
                x in c for x in ['current_cv', 'temp_deviation', 'voltage_cv', 'soiling_signature']
            )]
            print(f"   Digital twin features: {len(twin_features)}")

        return df_features
