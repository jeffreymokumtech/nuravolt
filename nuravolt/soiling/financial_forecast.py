"""Financial forecasting for 365-day soiling analysis."""

import numpy as np
import pandas as pd
from typing import Dict, List, Tuple


class FinancialForecaster:
    """
    365-day energy production and financial impact forecasting.

    Calculates:
    - Monthly energy production with soiling losses
    - Revenue impact of soiling
    - Seasonal patterns in sun hours and irradiance
    - Financial metrics for operator proposals
    """

    def __init__(self, site_config):
        """
        Initialize financial forecaster.

        Parameters:
        -----------
        site_config : SoilingConfig
            Site configuration with economic parameters
        """
        self.config = site_config
        self.capacity_MW = site_config.capacity_MW
        self.ppa_rate = site_config.electricity_rate_per_MWh  # €/MWh

    def calculate_monthly_sun_hours(self, df_pd: pd.DataFrame) -> Dict[int, float]:
        """
        Calculate typical sun hours per day for each month from historical data.

        Uses clearsky POA irradiance to determine typical monthly patterns.

        Parameters:
        -----------
        df_pd : pd.DataFrame
            Historical 15-min data with poa_clearsky

        Returns:
        --------
        dict
            Monthly sun hours: {month: avg_sun_hours_per_day}
        """
        print("⚙️ Calculating monthly sun hour patterns...")

        monthly_sun_hours = {}

        # Find the poa_clearsky column (may have different names)
        poa_col = None
        for col in ['poa_clearsky', 'poa_clearsky_daily']:
            if col in df_pd.columns:
                poa_col = col
                break

        if poa_col is None:
            print("   ⚠️ No POA clearsky column found - using default sun hours")
            # Use seasonal defaults for Spain
            default_hours = {
                1: 4.5, 2: 5.5, 3: 6.5, 4: 7.5, 5: 8.5, 6: 9.0,
                7: 9.0, 8: 8.5, 9: 7.5, 10: 6.0, 11: 5.0, 12: 4.5
            }
            return default_hours

        for month in range(1, 13):
            # Filter data for this month
            month_data = df_pd[df_pd.index.month == month]

            if len(month_data) > 0:
                # Check if data is daily or sub-daily
                if len(month_data) > 31:  # Sub-daily data
                    # Calculate daily clearsky energy (POA irradiance sum)
                    # POA in W/m² × 0.25 hours (15-min intervals) = Wh/m²/day
                    daily_clearsky = month_data.groupby(month_data.index.date)[poa_col].sum() * 0.25 / 1000
                else:
                    # Already daily data (poa_clearsky_daily is sum per day)
                    daily_clearsky = month_data[poa_col] / 1000  # Convert to kWh/m²

                # Equivalent sun hours = daily energy / 1000 W/m²
                sun_hours_per_day = daily_clearsky.mean()
                monthly_sun_hours[month] = max(sun_hours_per_day, 3.0)  # Minimum 3 hours
            else:
                # Default to seasonal average if no data
                monthly_sun_hours[month] = self.config.avg_sun_hours_per_day

        print(f"✅ Monthly sun hours calculated")
        print(f"   Summer peak (June): {monthly_sun_hours.get(6, 0):.1f} hours/day")
        print(f"   Winter low (December): {monthly_sun_hours.get(12, 0):.1f} hours/day")

        return monthly_sun_hours

    def forecast_energy_production(self,
                                   df_forecast: pd.DataFrame,
                                   monthly_sun_hours: Dict[int, float]) -> pd.DataFrame:
        """
        Calculate daily energy production with soiling losses.

        Parameters:
        -----------
        df_forecast : pd.DataFrame
            365-day soiling forecast with sr_predicted
        monthly_sun_hours : dict
            Monthly sun hours from calculate_monthly_sun_hours()

        Returns:
        --------
        df_energy : pd.DataFrame
            Daily energy forecast with columns:
            - energy_if_clean_MWh: Energy without soiling
            - energy_with_soiling_MWh: Actual energy with soiling
            - energy_loss_MWh: Soiling loss
            - energy_loss_pct: Loss percentage
        """
        print("\n⚙️ Forecasting energy production...")

        # Extract sun hours for each forecast day (convert to numpy array)
        sun_hours = np.array([monthly_sun_hours.get(d.month, 6.5) for d in df_forecast.index])

        # Energy if clean (no soiling)
        energy_if_clean = self.capacity_MW * sun_hours

        # Energy with soiling
        sr_predicted = df_forecast['sr_predicted'].values
        energy_with_soiling = energy_if_clean * sr_predicted

        # Energy loss
        energy_loss = energy_if_clean - energy_with_soiling

        # Create result DataFrame
        df_energy = pd.DataFrame({
            'sun_hours': sun_hours,
            'energy_if_clean_MWh': energy_if_clean,
            'energy_with_soiling_MWh': energy_with_soiling,
            'energy_loss_MWh': energy_loss,
            'energy_loss_pct': df_forecast['soiling_loss_pct'].values,
        }, index=df_forecast.index)

        # Summary
        total_clean = np.sum(energy_if_clean)
        total_with_soiling = np.nansum(energy_with_soiling)
        total_loss = np.nansum(energy_loss)
        loss_pct = (total_loss / total_clean) * 100

        print(f"✅ Energy forecast completed")
        print(f"   Annual energy (clean): {total_clean:,.0f} MWh")
        print(f"   Annual energy (with soiling): {total_with_soiling:,.0f} MWh")
        print(f"   Annual loss: {total_loss:,.0f} MWh ({loss_pct:.1f}%)")

        return df_energy

    def forecast_revenue_impact(self, df_energy: pd.DataFrame) -> pd.DataFrame:
        """
        Calculate financial impact of soiling losses.

        Parameters:
        -----------
        df_energy : pd.DataFrame
            Daily energy forecast from forecast_energy_production()

        Returns:
        --------
        df_revenue : pd.DataFrame
            Daily revenue forecast with columns:
            - revenue_if_clean_EUR: Revenue without soiling
            - revenue_with_soiling_EUR: Actual revenue with soiling
            - revenue_loss_EUR: Lost revenue due to soiling
        """
        print("\n⚙️ Calculating revenue impact...")

        # Revenue calculations
        revenue_if_clean = df_energy['energy_if_clean_MWh'] * self.ppa_rate
        revenue_with_soiling = df_energy['energy_with_soiling_MWh'] * self.ppa_rate
        revenue_loss = df_energy['energy_loss_MWh'] * self.ppa_rate

        df_revenue = pd.DataFrame({
            'revenue_if_clean_EUR': revenue_if_clean,
            'revenue_with_soiling_EUR': revenue_with_soiling,
            'revenue_loss_EUR': revenue_loss,
        }, index=df_energy.index)

        # Summary
        total_revenue_clean = revenue_if_clean.sum()
        total_revenue_actual = revenue_with_soiling.sum()
        total_revenue_loss = revenue_loss.sum()

        print(f"✅ Revenue impact calculated")
        print(f"   Annual revenue (clean): €{total_revenue_clean:,.0f}")
        print(f"   Annual revenue (with soiling): €{total_revenue_actual:,.0f}")
        print(f"   Annual revenue loss: €{total_revenue_loss:,.0f}")

        return df_revenue

    def generate_monthly_summary(self,
                                df_energy: pd.DataFrame,
                                df_revenue: pd.DataFrame) -> pd.DataFrame:
        """
        Generate monthly summary of energy and financial impacts.

        Parameters:
        -----------
        df_energy : pd.DataFrame
            Daily energy forecast
        df_revenue : pd.DataFrame
            Daily revenue forecast

        Returns:
        --------
        df_monthly : pd.DataFrame
            Monthly summary with aggregated metrics
        """
        print("\n⚙️ Generating monthly summary...")

        # Combine energy and revenue
        df_combined = pd.concat([df_energy, df_revenue], axis=1)

        # Group by month
        df_monthly = df_combined.resample('M').agg({
            'sun_hours': 'mean',
            'energy_if_clean_MWh': 'sum',
            'energy_with_soiling_MWh': 'sum',
            'energy_loss_MWh': 'sum',
            'energy_loss_pct': 'mean',
            'revenue_if_clean_EUR': 'sum',
            'revenue_with_soiling_EUR': 'sum',
            'revenue_loss_EUR': 'sum',
        })

        # Rename index to month names
        df_monthly.index = df_monthly.index.strftime('%Y-%m')

        # Add cumulative columns
        df_monthly['cumulative_energy_loss_MWh'] = df_monthly['energy_loss_MWh'].cumsum()
        df_monthly['cumulative_revenue_loss_EUR'] = df_monthly['revenue_loss_EUR'].cumsum()

        print(f"✅ Monthly summary generated for {len(df_monthly)} months")

        return df_monthly

    def calculate_cleaning_value(self,
                                 df_energy: pd.DataFrame,
                                 df_forecast: pd.DataFrame,
                                 cleaning_date: str,
                                 cleaning_cost: float) -> Dict:
        """
        Calculate financial value of cleaning on a specific date.

        Parameters:
        -----------
        df_energy : pd.DataFrame
            Daily energy forecast without cleaning
        df_forecast : pd.DataFrame
            Soiling forecast without cleaning
        cleaning_date : str
            Date of proposed cleaning (e.g., '2025-05-15')
        cleaning_cost : float
            Cost of cleaning (€)

        Returns:
        --------
        dict
            Cleaning value metrics:
            - sr_before: SR before cleaning
            - sr_after: SR after cleaning (assuming 95% restoration)
            - energy_recovered_30d: Energy recovered in next 30 days (MWh)
            - revenue_recovered_30d: Revenue recovered in next 30 days (€)
            - net_benefit_30d: Net benefit (revenue - cost)
            - roi_pct: Return on investment (%)
            - payback_days: Days to recover cleaning cost
        """
        clean_date_ts = pd.Timestamp(cleaning_date)

        # SR before cleaning
        sr_before = df_forecast.loc[clean_date_ts, 'sr_predicted']

        # SR after cleaning (95% restoration)
        sr_after = sr_before + (1.0 - sr_before) * 0.95

        # Energy recovery calculation (30 days)
        end_date = clean_date_ts + pd.Timedelta(days=30)
        period_energy = df_energy.loc[clean_date_ts:end_date]

        # Energy recovered = energy_if_clean × (SR_improvement)
        sr_improvement = sr_after - sr_before
        energy_recovered = period_energy['energy_if_clean_MWh'].sum() * sr_improvement

        # Revenue recovered
        revenue_recovered = energy_recovered * self.ppa_rate

        # Net benefit
        net_benefit = revenue_recovered - cleaning_cost

        # ROI
        roi_pct = (net_benefit / cleaning_cost) * 100 if cleaning_cost > 0 else 0

        # Payback days
        daily_benefit = revenue_recovered / 30
        payback_days = cleaning_cost / daily_benefit if daily_benefit > 0 else 999

        return {
            'cleaning_date': cleaning_date,
            'sr_before': sr_before,
            'sr_after': sr_after,
            'energy_recovered_30d_MWh': energy_recovered,
            'revenue_recovered_30d_EUR': revenue_recovered,
            'cleaning_cost_EUR': cleaning_cost,
            'net_benefit_30d_EUR': net_benefit,
            'roi_pct': roi_pct,
            'payback_days': payback_days,
        }

    def generate_quarterly_summary(self, df_monthly: pd.DataFrame) -> pd.DataFrame:
        """Generate quarterly financial summary."""
        # Extract year-quarter from index
        df_monthly_copy = df_monthly.copy()
        df_monthly_copy.index = pd.to_datetime(df_monthly_copy.index)

        df_quarterly = df_monthly_copy.resample('Q').agg({
            'sun_hours': 'mean',
            'energy_if_clean_MWh': 'sum',
            'energy_with_soiling_MWh': 'sum',
            'energy_loss_MWh': 'sum',
            'energy_loss_pct': 'mean',
            'revenue_if_clean_EUR': 'sum',
            'revenue_with_soiling_EUR': 'sum',
            'revenue_loss_EUR': 'sum',
        })

        df_quarterly.index = df_quarterly.index.to_period('Q').astype(str)

        return df_quarterly
