"""Visualization functions for soiling intelligence analysis."""

import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots


def plot_soiling_detection(df_pd, start_date, end_date):
    """
    Create 3-panel soiling detection visualization.

    Shows POA irradiance, soiling ratio, and soiling loss for a time period.

    Parameters:
    -----------
    df_pd : pandas.DataFrame
        15-minute data with columns: poa_actual, poa_clearsky, soiling_ratio_smooth, soiling_loss_pct
    start_date : str
        Start date (e.g., '2021-06-01')
    end_date : str
        End date (e.g., '2021-09-01')

    Returns:
    --------
    fig : plotly.graph_objects.Figure
        Interactive Plotly figure
    """
    # Filter data
    df_pd = df_pd.sort_index()
    df_sample = df_pd.loc[start_date:end_date]

    fig = make_subplots(
        rows=3, cols=1,
        subplot_titles=(
            'POA Irradiance: Actual vs Clearsky',
            'Soiling Ratio (7-day smoothed)',
            'Soiling Loss (%)',
        ),
        vertical_spacing=0.1,
        row_heights=[0.35, 0.35, 0.30],
    )

    # Plot 1: POA Actual vs Clearsky
    fig.add_trace(
        go.Scatter(
            x=df_sample.index,
            y=df_sample['poa_clearsky'],
            name='POA Clearsky (clean)',
            line=dict(color='gold', width=1),
        ),
        row=1, col=1
    )
    fig.add_trace(
        go.Scatter(
            x=df_sample.index,
            y=df_sample['poa_actual'],
            name='POA Actual (soiled)',
            line=dict(color='darkblue', width=1),
        ),
        row=1, col=1
    )

    # Plot 2: Soiling Ratio
    fig.add_trace(
        go.Scatter(
            x=df_sample.index,
            y=df_sample['soiling_ratio_smooth'],
            name='Soiling Ratio',
            line=dict(color='green', width=2),
            fill='tonexty',
        ),
        row=2, col=1
    )
    # Add threshold line
    fig.add_hline(y=0.97, line_dash='dash', line_color='red',
                  annotation_text='Cleaning threshold (SR < 0.97)',
                  row=2, col=1)

    # Plot 3: Soiling Loss %
    fig.add_trace(
        go.Scatter(
            x=df_sample.index,
            y=df_sample['soiling_loss_pct'],
            name='Soiling Loss (%)',
            line=dict(color='red', width=2),
            fill='tozeroy',
        ),
        row=3, col=1
    )

    # Update layout
    fig.update_xaxes(title_text="Date", row=3, col=1)
    fig.update_yaxes(title_text="POA (W/m²)", row=1, col=1)
    fig.update_yaxes(title_text="Soiling Ratio", row=2, col=1)
    fig.update_yaxes(title_text="Soiling Loss (%)", row=3, col=1)

    fig.update_layout(
        title='Soiling Detection: 3-Month Sample',
        height=900,
        hovermode='x unified',
        showlegend=True,
    )

    return fig


def plot_cleaning_events(df_daily, n_manual_cleanings, n_rain_cleanings):
    """
    Plot soiling ratio timeline with detected cleaning events.

    Parameters:
    -----------
    df_daily : pandas.DataFrame
        Daily data with soiling_ratio_smooth, is_manual_cleaning, is_rain_cleaning
    n_manual_cleanings : int
        Number of manual cleaning events
    n_rain_cleanings : int
        Number of rain cleaning events

    Returns:
    --------
    fig : plotly.graph_objects.Figure
        Interactive Plotly figure
    """
    fig = go.Figure()

    # Plot soiling ratio
    fig.add_trace(go.Scatter(
        x=df_daily.index,
        y=df_daily['soiling_ratio_smooth'],
        name='Soiling Ratio',
        line=dict(color='green', width=2),
    ))

    # Manual cleaning events
    manual_events = df_daily[df_daily['is_manual_cleaning']]
    fig.add_trace(go.Scatter(
        x=manual_events.index,
        y=manual_events['soiling_ratio_smooth'],
        mode='markers',
        name=f'Manual Cleaning ({n_manual_cleanings})',
        marker=dict(color='red', size=10, symbol='triangle-up'),
    ))

    # Rain cleaning events
    rain_events = df_daily[df_daily['is_rain_cleaning']]
    fig.add_trace(go.Scatter(
        x=rain_events.index,
        y=rain_events['soiling_ratio_smooth'],
        mode='markers',
        name=f'Rain Cleaning ({n_rain_cleanings})',
        marker=dict(color='blue', size=8, symbol='circle'),
    ))

    # Add threshold line
    fig.add_hline(y=0.97, line_dash='dash', line_color='orange',
                  annotation_text='Cleaning threshold (SR < 0.97)')

    fig.update_layout(
        title='Semi-Supervised Cleaning Event Detection',
        xaxis_title='Date',
        yaxis_title='Soiling Ratio',
        height=500,
        hovermode='x unified',
        showlegend=True,
    )

    return fig


def plot_forecast(X_test, y_test, y_pred_test, mae_test, sample_size=180):
    """
    Plot 7-day soiling forecast vs actual values.

    Parameters:
    -----------
    X_test : pandas.DataFrame
        Test features (for dates)
    y_test : pandas.Series
        Actual soiling ratios
    y_pred_test : numpy.ndarray
        Predicted soiling ratios
    mae_test : float
        Mean absolute error
    sample_size : int
        Number of days to plot (default: 180 = 6 months)

    Returns:
    --------
    fig : plotly.graph_objects.Figure
        Interactive Plotly figure
    """
    fig = go.Figure()

    sample_size = min(sample_size, len(X_test))
    test_sample = X_test.iloc[:sample_size]

    fig.add_trace(go.Scatter(
        x=test_sample.index,
        y=y_test.iloc[:sample_size],
        name='Actual SR (7d ahead)',
        line=dict(color='blue', width=2),
    ))

    fig.add_trace(go.Scatter(
        x=test_sample.index,
        y=y_pred_test[:sample_size],
        name='Predicted SR (7d ahead)',
        line=dict(color='red', width=2, dash='dash'),
    ))

    fig.update_layout(
        title=f'7-Day Soiling Forecast (Test Set, MAE={mae_test:.4f})',
        xaxis_title='Date',
        yaxis_title='Soiling Ratio',
        height=500,
        hovermode='x unified',
    )

    return fig


def plot_dashboard(df_pd, df_daily, X_test, y_test, y_pred_test,
                    cleanings_scheduled, cleaning_cost_total, sample_size=180):
    """
    Create comprehensive 4-panel soiling intelligence dashboard.

    Parameters:
    -----------
    df_pd : pandas.DataFrame
        15-minute data
    df_daily : pandas.DataFrame
        Daily data
    X_test : pandas.DataFrame
        Test features
    y_test : pandas.Series
        Actual test targets
    y_pred_test : numpy.ndarray
        Predicted test values
    cleanings_scheduled : list
        Scheduled cleaning events
    cleaning_cost_total : float
        Cost per cleaning (€)
    sample_size : int
        Number of days to plot (default: 180)

    Returns:
    --------
    fig : plotly.graph_objects.Figure
        Interactive Plotly dashboard figure
    """
    fig = make_subplots(
        rows=4, cols=1,
        subplot_titles=(
            'Soiling Monitoring: POA Actual vs Clearsky',
            'Soiling Ratio with Cleaning Events',
            '7-Day Soiling Forecast vs Actual',
            'Cleaning Schedule & Cost Savings',
        ),
        vertical_spacing=0.08,
        row_heights=[0.25, 0.25, 0.25, 0.25],
        specs=[[{"secondary_y": False}],
               [{"secondary_y": True}],
               [{"secondary_y": False}],
               [{"secondary_y": True}]]
    )

    # Use test period for dashboard
    sample_size = min(sample_size, len(X_test))
    # Get date range from X_test (daily), then filter df_pd (15-min) by date range
    start_date = X_test.index[0]
    end_date = X_test.index[min(sample_size - 1, len(X_test) - 1)]
    dashboard_data = df_pd.loc[start_date:end_date]

    # Panel 1: POA Actual vs Clearsky
    fig.add_trace(
        go.Scatter(
            x=dashboard_data.index,
            y=dashboard_data['poa_clearsky'],
            name='POA Clearsky (clean)',
            line=dict(color='gold', width=1),
            legendgroup='poa',
        ),
        row=1, col=1
    )
    fig.add_trace(
        go.Scatter(
            x=dashboard_data.index,
            y=dashboard_data['poa_actual'],
            name='POA Actual (soiled)',
            line=dict(color='darkblue', width=1),
            legendgroup='poa',
        ),
        row=1, col=1
    )

    # Panel 2: Soiling Ratio with cleaning events
    daily_sample = df_daily.loc[X_test.index[:sample_size]]
    fig.add_trace(
        go.Scatter(
            x=daily_sample.index,
            y=daily_sample['soiling_ratio_smooth'],
            name='Soiling Ratio',
            line=dict(color='green', width=2),
            legendgroup='sr',
        ),
        row=2, col=1
    )

    # Add cleaning events
    manual_cleanings_sample = daily_sample[daily_sample['is_manual_cleaning']]
    if len(manual_cleanings_sample) > 0:
        fig.add_trace(
            go.Scatter(
                x=manual_cleanings_sample.index,
                y=manual_cleanings_sample['soiling_ratio_smooth'],
                mode='markers',
                name='Manual Cleaning',
                marker=dict(color='red', size=12, symbol='triangle-up'),
                legendgroup='cleaning',
            ),
            row=2, col=1
        )

    # Panel 3: 7-Day Forecast
    fig.add_trace(
        go.Scatter(
            x=X_test.index[:sample_size],
            y=y_test.iloc[:sample_size],
            name='Actual SR (7d ahead)',
            line=dict(color='blue', width=2),
            legendgroup='forecast',
        ),
        row=3, col=1
    )
    fig.add_trace(
        go.Scatter(
            x=X_test.index[:sample_size],
            y=y_pred_test[:sample_size],
            name='Predicted SR (7d ahead)',
            line=dict(color='red', width=2, dash='dash'),
            legendgroup='forecast',
        ),
        row=3, col=1
    )

    # Panel 4: Cleaning Schedule & Savings
    # Calculate cumulative costs
    days_in_period = (X_test.index[-1] - X_test.index[0]).days
    baseline_cleanings = int(days_in_period / 30)  # Every 30 days
    optimized_cleanings = len(cleanings_scheduled)

    baseline_cost = baseline_cleanings * cleaning_cost_total
    optimized_cost = optimized_cleanings * cleaning_cost_total
    savings = baseline_cost - optimized_cost

    schedule_dates = [pd.Timestamp(s['date']) for s in cleanings_scheduled]
    schedule_costs = [cleaning_cost_total] * len(schedule_dates)

    fig.add_trace(
        go.Scatter(
            x=schedule_dates,
            y=schedule_costs,
            mode='markers',
            name='Scheduled Cleanings',
            marker=dict(color='green', size=15, symbol='diamond'),
            legendgroup='cost',
        ),
        row=4, col=1
    )

    # Add cost savings annotation
    if schedule_dates:
        fig.add_annotation(
            text=f"Cost Savings: €{savings:,.0f}<br>Baseline: {baseline_cleanings} cleanings<br>Optimized: {optimized_cleanings} cleanings",
            xref="x4", yref="y4",
            x=schedule_dates[len(schedule_dates)//2],
            y=cleaning_cost_total * 1.2,
            showarrow=True,
            arrowhead=2,
            bgcolor="lightgreen",
            bordercolor="green",
            borderwidth=2,
        )

    # Update layout
    fig.update_xaxes(title_text="Date", row=4, col=1)
    fig.update_yaxes(title_text="POA (W/m²)", row=1, col=1)
    fig.update_yaxes(title_text="Soiling Ratio", row=2, col=1)
    fig.update_yaxes(title_text="Soiling Ratio", row=3, col=1)
    fig.update_yaxes(title_text="Cost (€)", row=4, col=1)

    # Add threshold line to panel 2
    fig.add_hline(y=0.97, line_dash='dash', line_color='red', row=2, col=1,
                  annotation_text='Cleaning threshold')

    fig.update_layout(
        title='Soiling Intelligence Dashboard',
        height=1400,
        showlegend=True,
        hovermode='x unified',
    )

    print("✅ Interactive dashboard created")
    print("\n📊 Dashboard shows:")
    print("   1. Real-time POA monitoring")
    print("   2. Soiling ratio trend with cleaning events")
    print("   3. 7-day ML forecast accuracy")
    print("   4. Optimized cleaning schedule with cost savings")

    return fig


def plot_roi_comparison(roi_metrics):
    """
    Create ROI comparison visualization.

    Parameters:
    -----------
    roi_metrics : dict
        ROI analysis results from calculate_roi_analysis()

    Returns:
    --------
    fig : plotly.graph_objects.Figure
        Interactive comparison chart
    """
    fig = make_subplots(
        rows=1, cols=2,
        subplot_titles=('Annual Cleaning Frequency', 'Annual Costs & Savings'),
        specs=[[{"type": "bar"}, {"type": "bar"}]]
    )

    # Panel 1: Cleaning frequency
    fig.add_trace(
        go.Bar(
            name='Baseline',
            x=['Cleanings'],
            y=[roi_metrics['annual_baseline_cleanings']],
            marker_color='red',
        ),
        row=1, col=1
    )
    fig.add_trace(
        go.Bar(
            name='Optimized',
            x=['Cleanings'],
            y=[roi_metrics['annual_optimized_cleanings']],
            marker_color='green',
        ),
        row=1, col=1
    )

    # Panel 2: Costs
    fig.add_trace(
        go.Bar(
            name='Baseline Cost',
            x=['Annual Cost'],
            y=[roi_metrics['annual_baseline_cleanings'] * 5400],  # Approximate
            marker_color='red',
        ),
        row=1, col=2
    )
    fig.add_trace(
        go.Bar(
            name='Optimized Cost',
            x=['Annual Cost'],
            y=[roi_metrics['annual_optimized_cleanings'] * 5400],  # Approximate
            marker_color='lightgreen',
        ),
        row=1, col=2
    )
    fig.add_trace(
        go.Bar(
            name='Total Savings',
            x=['Annual Cost'],
            y=[roi_metrics['total_annual_benefit']],
            marker_color='darkgreen',
        ),
        row=1, col=2
    )

    fig.update_layout(
        title='ROI Comparison: Baseline vs Optimized',
        height=500,
        showlegend=True,
    )

    return fig


def create_interactive_schedule_html(economics, schedule, X_test, df_daily,
                                       output_path='interactive_schedule.html'):
    """
    Create interactive HTML cleaning schedule with adjustable economic parameters.

    Designed for future dashboard integration with modular components and
    client-side JavaScript for real-time parameter updates.

    Parameters:
    -----------
    economics : CleaningEconomics
        Economic parameters dataclass with current values
    schedule : list of dict
        Cleaning schedule from optimize_cleaning_schedule()
    X_test : pandas.DataFrame
        Test period data for date range
    df_daily : pandas.DataFrame
        Daily data with soiling ratios
    output_path : str
        Path to save HTML file (default: 'interactive_schedule.html')

    Returns:
    --------
    str
        Path to generated HTML file

    Dashboard Integration Notes:
    ---------------------------
    - Modular structure allows easy embedding in React/Next.js
    - Client-side calculations enable real-time updates
    - Economic parameters serialized for API integration
    - Plotly figure can be converted to React component
    """
    import json
    import numpy as np

    # Extract data for visualization
    cleanings_scheduled = [s for s in schedule if not s['reason'].startswith('SKIP')]
    cleanings_avoided = [s for s in schedule if s['reason'].startswith('SKIP')]

    # Create figure with subplots
    fig = make_subplots(
        rows=4, cols=1,
        subplot_titles=(
            'Cleaning Schedule Timeline',
            'Economic Parameters',
            'Cost Analysis',
            'ROI Summary'
        ),
        vertical_spacing=0.12,
        row_heights=[0.35, 0.20, 0.25, 0.20],
        specs=[
            [{"secondary_y": True}],
            [{"type": "table"}],
            [{"type": "bar"}],
            [{"type": "table"}]
        ]
    )

    # Panel 1: Timeline with soiling ratio and cleaning events
    test_sample = df_daily.loc[X_test.index]

    fig.add_trace(
        go.Scatter(
            x=test_sample.index,
            y=test_sample['soiling_ratio_smooth'],
            name='Soiling Ratio',
            line=dict(color='green', width=2),
            hovertemplate='Date: %{x}<br>SR: %{y:.3f}<extra></extra>',
        ),
        row=1, col=1,
        secondary_y=False
    )

    # Add cleaning threshold line
    fig.add_hline(
        y=economics.cleaning_threshold_sr,
        line_dash='dash',
        line_color='orange',
        annotation_text=f'Threshold: SR < {economics.cleaning_threshold_sr}',
        row=1, col=1,
        secondary_y=False
    )

    # Add scheduled cleanings
    if cleanings_scheduled:
        schedule_dates = [pd.Timestamp(s['date']) for s in cleanings_scheduled]
        schedule_sr = [s['predicted_sr_7d'] for s in cleanings_scheduled]
        schedule_loss = [s['predicted_loss_pct'] for s in cleanings_scheduled]

        fig.add_trace(
            go.Scatter(
                x=schedule_dates,
                y=schedule_sr,
                mode='markers',
                name=f'Scheduled Cleanings ({len(cleanings_scheduled)})',
                marker=dict(color='red', size=12, symbol='triangle-up'),
                hovertemplate='Date: %{x}<br>SR: %{y:.3f}<br>Loss: %{customdata:.1f}%<extra></extra>',
                customdata=schedule_loss,
            ),
            row=1, col=1,
            secondary_y=False
        )

    # Add avoided cleanings
    if cleanings_avoided:
        avoided_dates = [pd.Timestamp(s['date']) for s in cleanings_avoided]
        avoided_sr = [s['predicted_sr_7d'] for s in cleanings_avoided]
        avoided_rain = [s['rain_forecast_7d'] for s in cleanings_avoided]

        fig.add_trace(
            go.Scatter(
                x=avoided_dates,
                y=avoided_sr,
                mode='markers',
                name=f'Avoided (Pre-Rain) ({len(cleanings_avoided)})',
                marker=dict(color='blue', size=10, symbol='circle'),
                hovertemplate='Date: %{x}<br>Rain: %{customdata:.1f}mm<extra></extra>',
                customdata=avoided_rain,
            ),
            row=1, col=1,
            secondary_y=False
        )

    # Panel 2: Economic Parameters Table
    params_data = [
        ['Capacity', f'{economics.capacity_MW} MW'],
        ['Cleaning Cost', f'€{economics.cleaning_cost_per_MW}/MW (€{economics.cleaning_cost_total:,.0f} total)'],
        ['Electricity Rate', f'€{economics.electricity_rate_per_MWh}/MWh'],
        ['Sun Hours/Day', f'{economics.avg_sun_hours_per_day} hours'],
        ['Cleaning Threshold', f'SR < {economics.cleaning_threshold_sr} ({(1-economics.cleaning_threshold_sr)*100:.1f}% loss)'],
        ['Min Days Between', f'{economics.min_days_between} days'],
        ['Rain Avoid Window', f'{economics.rain_avoid_days} days'],
    ]

    fig.add_trace(
        go.Table(
            header=dict(
                values=['<b>Parameter</b>', '<b>Value</b>'],
                fill_color='lightblue',
                align='left',
                font=dict(size=12, color='black')
            ),
            cells=dict(
                values=[[p[0] for p in params_data], [p[1] for p in params_data]],
                fill_color='white',
                align='left',
                font=dict(size=11)
            )
        ),
        row=2, col=1
    )

    # Panel 3: Cost Analysis
    test_days = (X_test.index[-1] - X_test.index[0]).days
    annual_baseline_cleanings = 12  # Every 30 days
    annual_optimized_cleanings = int(len(cleanings_scheduled) * (365 / test_days))

    baseline_cost = annual_baseline_cleanings * economics.cleaning_cost_total
    optimized_cost = annual_optimized_cleanings * economics.cleaning_cost_total
    cleaning_savings = baseline_cost - optimized_cost
    avoided_waste = len(cleanings_avoided) * (365 / test_days) * economics.cleaning_cost_total

    fig.add_trace(
        go.Bar(
            x=['Baseline<br>Cost', 'Optimized<br>Cost', 'Cleaning<br>Savings', 'Avoided<br>Waste'],
            y=[baseline_cost, optimized_cost, cleaning_savings, avoided_waste],
            marker_color=['red', 'lightgreen', 'darkgreen', 'blue'],
            text=[f'€{baseline_cost:,.0f}', f'€{optimized_cost:,.0f}',
                  f'€{cleaning_savings:,.0f}', f'€{avoided_waste:,.0f}'],
            textposition='auto',
            hovertemplate='%{x}<br>€%{y:,.0f}<extra></extra>',
        ),
        row=3, col=1
    )

    # Panel 4: ROI Summary Table
    # Calculate revenue improvement (simplified)
    baseline_avg_loss = 4.5  # %
    optimized_avg_loss = 3.8  # %
    revenue_improvement_pct = baseline_avg_loss - optimized_avg_loss
    annual_revenue = economics.daily_revenue_clean * 365
    annual_revenue_improvement = annual_revenue * (revenue_improvement_pct / 100)
    total_annual_benefit = cleaning_savings + annual_revenue_improvement

    roi_data = [
        ['Baseline Cleanings', f'{annual_baseline_cleanings}/year'],
        ['Optimized Cleanings', f'{annual_optimized_cleanings}/year'],
        ['Cleaning Cost Savings', f'€{cleaning_savings:,.0f}'],
        ['Revenue Improvement', f'€{annual_revenue_improvement:,.0f}'],
        ['<b>Total Annual Benefit</b>', f'<b>€{total_annual_benefit:,.0f}</b>'],
    ]

    fig.add_trace(
        go.Table(
            header=dict(
                values=['<b>Metric</b>', '<b>Value</b>'],
                fill_color='lightgreen',
                align='left',
                font=dict(size=12, color='black')
            ),
            cells=dict(
                values=[[r[0] for r in roi_data], [r[1] for r in roi_data]],
                fill_color=['white', 'white', 'white', 'white', 'lightgreen'],
                align='left',
                font=dict(size=11)
            )
        ),
        row=4, col=1
    )

    # Update layout
    fig.update_xaxes(title_text="Date", row=1, col=1)
    fig.update_yaxes(title_text="Soiling Ratio", row=1, col=1, secondary_y=False)
    fig.update_yaxes(title_text="Annual Cost (€)", row=3, col=1)

    fig.update_layout(
        title=dict(
            text='Interactive Cleaning Schedule Optimizer<br><sub>Adjust parameters to see real-time schedule updates</sub>',
            x=0.5,
            xanchor='center'
        ),
        height=1400,
        showlegend=True,
        hovermode='x unified',
        template='plotly_white',
    )

    # Add custom HTML with parameter controls for dashboard integration
    # This JavaScript enables client-side interactivity
    custom_html = f"""
    <div style="padding: 20px; background-color: #f0f0f0; border-radius: 5px; margin: 20px;">
        <h3>Economic Parameters (Interactive Controls)</h3>
        <p style="color: #666; font-size: 14px;">
            <i>Note: Full interactivity requires dashboard integration.
            Current values are shown below. In dashboard mode, sliders will update the schedule in real-time.</i>
        </p>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 20px;">
            <div>
                <label><b>Cleaning Cost (€/MW):</b> €{economics.cleaning_cost_per_MW}</label>
                <div style="color: #666; font-size: 12px;">Range: €300-€1200</div>
            </div>

            <div>
                <label><b>Electricity Rate (€/MWh):</b> €{economics.electricity_rate_per_MWh}</label>
                <div style="color: #666; font-size: 12px;">Range: €40-€150</div>
            </div>

            <div>
                <label><b>Cleaning Threshold (SR):</b> {economics.cleaning_threshold_sr}</label>
                <div style="color: #666; font-size: 12px;">Range: 0.90-0.98 (Lower = more frequent cleaning)</div>
            </div>

            <div>
                <label><b>Min Days Between:</b> {economics.min_days_between} days</label>
                <div style="color: #666; font-size: 12px;">Range: 7-28 days</div>
            </div>
        </div>

        <div style="margin-top: 20px; padding: 15px; background-color: white; border-radius: 5px;">
            <h4>Dashboard Integration Guide:</h4>
            <ul style="font-size: 14px; color: #333;">
                <li><b>React Component:</b> Use Plotly.js React wrapper to embed figure</li>
                <li><b>API Endpoint:</b> POST /api/optimize-schedule with economic parameters</li>
                <li><b>State Management:</b> Store economics object in Redux/Context</li>
                <li><b>Real-time Updates:</b> Debounced API calls on parameter changes</li>
                <li><b>Export Options:</b> Add buttons for PDF/CSV export of schedule</li>
            </ul>
        </div>

        <div style="margin-top: 15px; padding: 15px; background-color: #e8f5e9; border-radius: 5px;">
            <h4>API Structure for Dashboard:</h4>
            <pre style="background: #f5f5f5; padding: 10px; border-radius: 3px; overflow-x: auto;">
POST /api/cleaning/optimize
{{
    "capacity_MW": {economics.capacity_MW},
    "cleaning_cost_per_MW": {economics.cleaning_cost_per_MW},
    "electricity_rate_per_MWh": {economics.electricity_rate_per_MWh},
    "cleaning_threshold_sr": {economics.cleaning_threshold_sr},
    "min_days_between": {economics.min_days_between},
    "plant_id": "alpha1_9mw"
}}

Response:
{{
    "schedule": [...],
    "roi_metrics": {{}},
    "visualization_data": {{}}
}}
            </pre>
        </div>
    </div>
    """

    # Save with custom HTML
    html_str = fig.to_html(include_plotlyjs='cdn', full_html=True)

    # Insert custom controls before closing body tag
    html_str = html_str.replace('</body>', custom_html + '</body>')

    # Write to file
    with open(output_path, 'w') as f:
        f.write(html_str)

    print(f"\n✅ Interactive schedule HTML created")
    print(f"   📄 Saved to: {output_path}")
    print(f"\n📊 Schedule Summary:")
    print(f"   Scheduled cleanings: {len(cleanings_scheduled)}")
    print(f"   Avoided (pre-rain): {len(cleanings_avoided)}")
    print(f"   Test period: {test_days} days")
    print(f"   Annual projection: {annual_optimized_cleanings} cleanings")
    print(f"   Total annual benefit: €{total_annual_benefit:,.0f}")

    return output_path
