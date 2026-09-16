"""
SmartHelio-style visualizations for 365-day soiling forecasts.

Creates professional operator-facing dashboards with:
- Energy loss heatmaps for cleaning optimization
- Timeline plots with optimal cleaning markers
- ROI comparison charts
- Monthly/quarterly breakdown tables
- Interactive HTML dashboards
"""

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
from typing import Dict, List, Optional, Tuple
from pathlib import Path


class Forecast365Visualizer:
    """
    Create SmartHelio-style visualizations for 365-day forecasts.

    Produces professional operator-facing dashboards with:
    - Heatmaps showing cleaning timing optimization
    - Timeline charts with SR predictions and cleanings
    - ROI comparison across strategies
    - Monthly summaries and financial breakdowns
    """

    # SmartHelio-inspired color scheme
    COLORS = {
        'primary': '#2E86AB',      # Deep blue
        'secondary': '#A23B72',    # Magenta
        'success': '#28A745',      # Green
        'warning': '#FFC107',      # Yellow
        'danger': '#DC3545',       # Red
        'info': '#17A2B8',         # Cyan
        'dark': '#343A40',         # Dark gray
        'light': '#F8F9FA',        # Light gray
        'soiling_clean': '#28A745',    # Green (high SR)
        'soiling_dirty': '#DC3545',    # Red (low SR)
        'cleaning_event': '#FF6B35',   # Orange
        'forecast_band': 'rgba(46, 134, 171, 0.2)',  # Transparent blue
    }

    def __init__(self, site_name: str = "Solar Plant"):
        self.site_name = site_name

    def create_cleaning_heatmap(self,
                               all_scenarios: pd.DataFrame,
                               save_path: Optional[str] = None) -> go.Figure:
        """
        Create heatmap showing energy loss for different 2-cleaning combinations.

        X-axis: First cleaning date
        Y-axis: Second cleaning date
        Color: Total energy loss (MWh)

        Inspired by SmartHelio's optimization heatmaps.
        """
        # Filter to 2-cleaning scenarios
        df_2clean = all_scenarios[all_scenarios['n_cleanings'] == 2].copy()

        if len(df_2clean) == 0:
            print("⚠️ No 2-cleaning scenarios found for heatmap")
            return None

        # Extract dates
        df_2clean['date1'] = df_2clean['cleaning_dates'].apply(lambda x: x[0] if len(x) > 0 else None)
        df_2clean['date2'] = df_2clean['cleaning_dates'].apply(lambda x: x[1] if len(x) > 1 else None)

        # Get unique dates
        dates1 = sorted(df_2clean['date1'].unique())
        dates2 = sorted(df_2clean['date2'].unique())

        # Create matrix for heatmap
        # Use net benefit (higher is better)
        pivot_data = df_2clean.pivot_table(
            values='net_benefit_EUR',
            index='date2',
            columns='date1',
            aggfunc='first'
        )

        # Create heatmap
        fig = go.Figure(data=go.Heatmap(
            z=pivot_data.values,
            x=pivot_data.columns,
            y=pivot_data.index,
            colorscale='RdYlGn',  # Red (low) to Green (high)
            colorbar=dict(
                title=dict(text='Net Benefit (€)', side='right')
            ),
            hovertemplate=(
                'First Cleaning: %{x}<br>'
                'Second Cleaning: %{y}<br>'
                'Net Benefit: €%{z:,.0f}<extra></extra>'
            )
        ))

        # Find optimal point
        best_idx = df_2clean['net_benefit_EUR'].idxmax()
        best_row = df_2clean.loc[best_idx]

        # Add marker for optimal
        fig.add_trace(go.Scatter(
            x=[best_row['date1']],
            y=[best_row['date2']],
            mode='markers',
            marker=dict(
                size=20,
                color='white',
                symbol='star',
                line=dict(color='black', width=2)
            ),
            name='Optimal',
            hovertemplate=(
                f"OPTIMAL<br>"
                f"First: {best_row['date1']}<br>"
                f"Second: {best_row['date2']}<br>"
                f"Net Benefit: €{best_row['net_benefit_EUR']:,.0f}<extra></extra>"
            )
        ))

        fig.update_layout(
            title=dict(
                text=f"<b>{self.site_name}</b><br>Cleaning Schedule Optimization (2 Cleanings)",
                font=dict(size=18)
            ),
            xaxis_title="First Cleaning Date",
            yaxis_title="Second Cleaning Date",
            template='plotly_white',
            height=600,
            width=900,
            font=dict(family="Arial, sans-serif", size=12),
        )

        # Rotate x-axis labels
        fig.update_xaxes(tickangle=45)

        if save_path:
            fig.write_html(save_path)
            print(f"💾 Saved heatmap to {save_path}")

        return fig

    def create_forecast_timeline(self,
                                df_forecast: pd.DataFrame,
                                optimal_dates: List[str],
                                df_energy: Optional[pd.DataFrame] = None,
                                save_path: Optional[str] = None) -> go.Figure:
        """
        Create timeline showing 365-day SR forecast with optimal cleaning markers.

        Features:
        - SR prediction with uncertainty bands
        - Optimal cleaning dates marked
        - Seasonal background coloring
        - Energy production overlay (optional)
        """
        fig = make_subplots(
            rows=2, cols=1,
            shared_xaxes=True,
            vertical_spacing=0.08,
            subplot_titles=('Soiling Ratio Forecast', 'Daily Energy Production'),
            row_heights=[0.6, 0.4]
        )

        dates = df_forecast.index

        # Add uncertainty band
        if 'sr_lower_bound' in df_forecast.columns and 'sr_upper_bound' in df_forecast.columns:
            fig.add_trace(go.Scatter(
                x=list(dates) + list(dates)[::-1],
                y=list(df_forecast['sr_upper_bound']) + list(df_forecast['sr_lower_bound'])[::-1],
                fill='toself',
                fillcolor=self.COLORS['forecast_band'],
                line=dict(color='rgba(0,0,0,0)'),
                name='Uncertainty Band',
                showlegend=True,
                hoverinfo='skip'
            ), row=1, col=1)

        # Add SR prediction
        fig.add_trace(go.Scatter(
            x=dates,
            y=df_forecast['sr_predicted'],
            mode='lines',
            name='Predicted SR',
            line=dict(color=self.COLORS['primary'], width=2),
            hovertemplate='%{x}<br>SR: %{y:.3f}<extra></extra>'
        ), row=1, col=1)

        # Add cleaning threshold line
        fig.add_hline(
            y=0.97,
            line_dash="dash",
            line_color=self.COLORS['warning'],
            annotation_text="Cleaning Threshold (97%)",
            annotation_position="right",
            row=1, col=1
        )

        # Add optimal cleaning markers
        for i, date_str in enumerate(optimal_dates):
            date = pd.Timestamp(date_str)
            if date in df_forecast.index:
                sr_val = df_forecast.loc[date, 'sr_predicted']
            else:
                sr_val = 0.95  # Default

            fig.add_trace(go.Scatter(
                x=[date],
                y=[sr_val],
                mode='markers+text',
                marker=dict(
                    size=15,
                    color=self.COLORS['cleaning_event'],
                    symbol='triangle-up',
                    line=dict(color='white', width=2)
                ),
                text=[f'Clean #{i+1}'],
                textposition='top center',
                name=f'Cleaning #{i+1}',
                hovertemplate=f'Cleaning #{i+1}<br>{date_str}<br>SR before: {sr_val:.3f}<extra></extra>'
            ), row=1, col=1)

        # Add energy production if available
        if df_energy is not None and 'energy_with_soiling_MWh' in df_energy.columns:
            fig.add_trace(go.Bar(
                x=df_energy.index,
                y=df_energy['energy_with_soiling_MWh'],
                name='Energy (MWh)',
                marker_color=self.COLORS['info'],
                opacity=0.7,
                hovertemplate='%{x}<br>Energy: %{y:.1f} MWh<extra></extra>'
            ), row=2, col=1)

            # Add potential energy line
            if 'energy_if_clean_MWh' in df_energy.columns:
                fig.add_trace(go.Scatter(
                    x=df_energy.index,
                    y=df_energy['energy_if_clean_MWh'],
                    mode='lines',
                    name='Potential (Clean)',
                    line=dict(color=self.COLORS['success'], width=1, dash='dot'),
                    hovertemplate='%{x}<br>Potential: %{y:.1f} MWh<extra></extra>'
                ), row=2, col=1)

        # Add summer season highlighting
        for year in df_forecast.index.year.unique():
            summer_start = pd.Timestamp(f'{year}-06-01')
            summer_end = pd.Timestamp(f'{year}-08-31')

            if summer_start >= df_forecast.index[0] and summer_start <= df_forecast.index[-1]:
                fig.add_vrect(
                    x0=summer_start, x1=summer_end,
                    fillcolor='rgba(255, 193, 7, 0.1)',
                    line_width=0,
                    annotation_text="Summer Peak",
                    annotation_position="top left",
                    row=1, col=1
                )

        fig.update_layout(
            title=dict(
                text=f"<b>{self.site_name}</b><br>365-Day Soiling Forecast with Optimal Cleaning Schedule",
                font=dict(size=18)
            ),
            template='plotly_white',
            height=700,
            width=1200,
            legend=dict(
                orientation='h',
                yanchor='bottom',
                y=1.02,
                xanchor='right',
                x=1
            ),
            font=dict(family="Arial, sans-serif", size=12),
        )

        fig.update_yaxes(title_text="Soiling Ratio", range=[0.85, 1.01], row=1, col=1)
        fig.update_yaxes(title_text="Energy (MWh)", row=2, col=1)

        if save_path:
            fig.write_html(save_path)
            print(f"💾 Saved timeline to {save_path}")

        return fig

    def create_roi_comparison(self,
                             comparison_table: pd.DataFrame,
                             save_path: Optional[str] = None) -> go.Figure:
        """
        Create bar chart comparing ROI across 1-5 cleaning strategies.
        """
        fig = make_subplots(
            rows=1, cols=2,
            subplot_titles=('Net Benefit by Strategy', 'ROI by Strategy'),
            horizontal_spacing=0.12
        )

        strategies = [f"{int(row['n_cleanings'])} Cleaning(s)" for _, row in comparison_table.iterrows()]

        # Net Benefit bars
        fig.add_trace(go.Bar(
            x=strategies,
            y=comparison_table['net_benefit_EUR'],
            name='Net Benefit (€)',
            marker_color=self.COLORS['primary'],
            text=[f'€{v:,.0f}' for v in comparison_table['net_benefit_EUR']],
            textposition='outside',
            hovertemplate='%{x}<br>Net Benefit: €%{y:,.0f}<extra></extra>'
        ), row=1, col=1)

        # ROI bars
        colors = [self.COLORS['success'] if v > 500 else self.COLORS['warning'] if v > 200 else self.COLORS['danger']
                  for v in comparison_table['roi_pct']]

        fig.add_trace(go.Bar(
            x=strategies,
            y=comparison_table['roi_pct'],
            name='ROI (%)',
            marker_color=colors,
            text=[f'{v:.0f}%' for v in comparison_table['roi_pct']],
            textposition='outside',
            hovertemplate='%{x}<br>ROI: %{y:.0f}%<extra></extra>'
        ), row=1, col=2)

        # Find best strategy
        best_idx = comparison_table['net_benefit_EUR'].idxmax()
        best_strategy = f"{int(comparison_table.loc[best_idx, 'n_cleanings'])} Cleaning(s)"

        fig.update_layout(
            title=dict(
                text=f"<b>{self.site_name}</b><br>Cleaning Strategy Comparison",
                font=dict(size=18)
            ),
            template='plotly_white',
            height=450,
            width=1000,
            showlegend=False,
            font=dict(family="Arial, sans-serif", size=12),
            annotations=[
                dict(
                    text=f"✓ Recommended: {best_strategy}",
                    xref="paper", yref="paper",
                    x=0.5, y=-0.15,
                    showarrow=False,
                    font=dict(size=14, color=self.COLORS['success'])
                )
            ]
        )

        fig.update_yaxes(title_text="Net Benefit (€)", row=1, col=1)
        fig.update_yaxes(title_text="ROI (%)", row=1, col=2)

        if save_path:
            fig.write_html(save_path)
            print(f"💾 Saved ROI comparison to {save_path}")

        return fig

    def create_monthly_breakdown(self,
                                df_monthly: pd.DataFrame,
                                save_path: Optional[str] = None) -> go.Figure:
        """
        Create monthly breakdown chart showing energy and revenue patterns.
        """
        fig = make_subplots(
            rows=2, cols=1,
            shared_xaxes=True,
            vertical_spacing=0.1,
            subplot_titles=('Monthly Energy Production', 'Monthly Revenue Impact')
        )

        months = df_monthly['month'].astype(str) if 'month' in df_monthly.columns else df_monthly.index.astype(str)

        # Energy chart
        if 'energy_if_clean_MWh' in df_monthly.columns:
            fig.add_trace(go.Bar(
                x=months,
                y=df_monthly['energy_if_clean_MWh'],
                name='Potential Energy',
                marker_color=self.COLORS['light'],
                opacity=0.5
            ), row=1, col=1)

        if 'energy_with_soiling_MWh' in df_monthly.columns:
            fig.add_trace(go.Bar(
                x=months,
                y=df_monthly['energy_with_soiling_MWh'],
                name='Actual Energy',
                marker_color=self.COLORS['primary']
            ), row=1, col=1)

        # Revenue chart
        if 'revenue_if_clean_EUR' in df_monthly.columns:
            fig.add_trace(go.Bar(
                x=months,
                y=df_monthly['revenue_if_clean_EUR'],
                name='Potential Revenue',
                marker_color=self.COLORS['light'],
                opacity=0.5,
                showlegend=False
            ), row=2, col=1)

        if 'revenue_with_soiling_EUR' in df_monthly.columns:
            fig.add_trace(go.Bar(
                x=months,
                y=df_monthly['revenue_with_soiling_EUR'],
                name='Actual Revenue',
                marker_color=self.COLORS['success'],
                showlegend=False
            ), row=2, col=1)

        fig.update_layout(
            title=dict(
                text=f"<b>{self.site_name}</b><br>Monthly Energy & Revenue Breakdown",
                font=dict(size=18)
            ),
            template='plotly_white',
            height=600,
            width=1000,
            barmode='overlay',
            legend=dict(
                orientation='h',
                yanchor='bottom',
                y=1.02,
                xanchor='right',
                x=1
            ),
            font=dict(family="Arial, sans-serif", size=12),
        )

        fig.update_yaxes(title_text="Energy (MWh)", row=1, col=1)
        fig.update_yaxes(title_text="Revenue (€)", row=2, col=1)

        if save_path:
            fig.write_html(save_path)
            print(f"💾 Saved monthly breakdown to {save_path}")

        return fig

    def create_operator_dashboard(self,
                                 df_forecast: pd.DataFrame,
                                 df_energy: pd.DataFrame,
                                 df_monthly: pd.DataFrame,
                                 optimization_results: Dict,
                                 proposal: Dict,
                                 save_path: Optional[str] = None) -> str:
        """
        Create comprehensive HTML dashboard for plant operators.

        Combines all visualizations into a single professional dashboard
        with SmartHelio-style layout and branding.
        """
        best = optimization_results['optimal_schedule']
        comparison = optimization_results['comparison_table']

        # Generate individual plots
        fig_timeline = self.create_forecast_timeline(
            df_forecast,
            best['cleaning_dates'],
            df_energy
        )

        fig_roi = self.create_roi_comparison(comparison)

        fig_heatmap = self.create_cleaning_heatmap(
            optimization_results['all_scenarios']
        )

        fig_monthly = self.create_monthly_breakdown(df_monthly)

        # Convert to HTML divs
        timeline_html = fig_timeline.to_html(full_html=False, include_plotlyjs=False)
        roi_html = fig_roi.to_html(full_html=False, include_plotlyjs=False)
        heatmap_html = fig_heatmap.to_html(full_html=False, include_plotlyjs=False) if fig_heatmap else "<p>No heatmap data available</p>"
        monthly_html = fig_monthly.to_html(full_html=False, include_plotlyjs=False)

        # Executive summary data
        exec_sum = proposal['executive_summary']
        financial = proposal['financial_analysis']
        technical = proposal['technical_details']
        recommendations = proposal['recommendations']

        # Build HTML
        html_content = f"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{self.site_name} - 365-Day Soiling Forecast Dashboard</title>
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <style>
        :root {{
            --primary: #2E86AB;
            --secondary: #A23B72;
            --success: #28A745;
            --warning: #FFC107;
            --danger: #DC3545;
            --dark: #343A40;
            --light: #F8F9FA;
        }}

        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}

        body {{
            font-family: 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            min-height: 100vh;
            padding: 20px;
        }}

        .dashboard {{
            max-width: 1400px;
            margin: 0 auto;
        }}

        .header {{
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            color: white;
            padding: 30px;
            border-radius: 15px;
            margin-bottom: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }}

        .header h1 {{
            font-size: 2.5em;
            margin-bottom: 10px;
        }}

        .header .subtitle {{
            font-size: 1.2em;
            opacity: 0.9;
        }}

        .kpi-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }}

        .kpi-card {{
            background: white;
            border-radius: 15px;
            padding: 25px;
            text-align: center;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            transition: transform 0.3s ease;
        }}

        .kpi-card:hover {{
            transform: translateY(-5px);
        }}

        .kpi-card .value {{
            font-size: 2.5em;
            font-weight: bold;
            color: var(--primary);
        }}

        .kpi-card .label {{
            font-size: 0.9em;
            color: #666;
            margin-top: 5px;
        }}

        .kpi-card.success .value {{ color: var(--success); }}
        .kpi-card.warning .value {{ color: var(--warning); }}

        .section {{
            background: white;
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 20px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }}

        .section h2 {{
            color: var(--dark);
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid var(--primary);
        }}

        .recommendations {{
            background: linear-gradient(135deg, #fff9e6 0%, #fff3cd 100%);
            border-left: 4px solid var(--warning);
        }}

        .recommendations ul {{
            list-style: none;
            padding: 0;
        }}

        .recommendations li {{
            padding: 10px 0;
            padding-left: 30px;
            position: relative;
        }}

        .recommendations li::before {{
            content: "💡";
            position: absolute;
            left: 0;
        }}

        .optimal-schedule {{
            background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%);
            border-left: 4px solid var(--success);
        }}

        .schedule-dates {{
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 15px;
        }}

        .schedule-date {{
            background: var(--success);
            color: white;
            padding: 10px 20px;
            border-radius: 25px;
            font-weight: bold;
        }}

        .chart-container {{
            margin: 20px 0;
        }}

        .two-column {{
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
        }}

        @media (max-width: 900px) {{
            .two-column {{
                grid-template-columns: 1fr;
            }}
        }}

        .footer {{
            text-align: center;
            padding: 20px;
            color: #666;
            font-size: 0.9em;
        }}

        .table-container {{
            overflow-x: auto;
        }}

        table {{
            width: 100%;
            border-collapse: collapse;
            margin: 15px 0;
        }}

        th, td {{
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }}

        th {{
            background: var(--primary);
            color: white;
        }}

        tr:hover {{
            background: #f5f5f5;
        }}
    </style>
</head>
<body>
    <div class="dashboard">
        <div class="header">
            <h1>☀️ {self.site_name}</h1>
            <div class="subtitle">365-Day Soiling Forecast & Cleaning Optimization</div>
            <div class="subtitle">Forecast Period: {exec_sum['forecast_period']}</div>
        </div>

        <div class="kpi-grid">
            <div class="kpi-card">
                <div class="value">{exec_sum['plant_capacity_MW']:.1f} MW</div>
                <div class="label">Plant Capacity</div>
            </div>
            <div class="kpi-card success">
                <div class="value">{exec_sum['recommended_cleanings']}</div>
                <div class="label">Recommended Cleanings</div>
            </div>
            <div class="kpi-card success">
                <div class="value">€{exec_sum['expected_net_benefit_EUR']:,.0f}</div>
                <div class="label">Expected Net Benefit</div>
            </div>
            <div class="kpi-card success">
                <div class="value">{exec_sum['expected_roi_pct']:.0f}%</div>
                <div class="label">Expected ROI</div>
            </div>
        </div>

        <div class="section optimal-schedule">
            <h2>✓ Optimal Cleaning Schedule</h2>
            <p>Based on analysis of {len(optimization_results['all_scenarios']):,} scenarios, the following cleaning dates maximize your return:</p>
            <div class="schedule-dates">
                {''.join([f'<div class="schedule-date">🧹 {date}</div>' for date in best['cleaning_dates']])}
            </div>
        </div>

        <div class="section recommendations">
            <h2>💡 Recommendations</h2>
            <ul>
                {''.join([f'<li>{rec}</li>' for rec in recommendations])}
            </ul>
        </div>

        <div class="section">
            <h2>📈 365-Day Forecast Timeline</h2>
            <div class="chart-container">
                {timeline_html}
            </div>
        </div>

        <div class="two-column">
            <div class="section">
                <h2>📊 Strategy Comparison</h2>
                <div class="chart-container">
                    {roi_html}
                </div>
            </div>

            <div class="section">
                <h2>🎯 Cleaning Optimization Heatmap</h2>
                <div class="chart-container">
                    {heatmap_html}
                </div>
            </div>
        </div>

        <div class="section">
            <h2>📅 Monthly Breakdown</h2>
            <div class="chart-container">
                {monthly_html}
            </div>
        </div>

        <div class="section">
            <h2>💰 Financial Summary</h2>
            <div class="table-container">
                <table>
                    <tr>
                        <th>Metric</th>
                        <th>Baseline (No Cleaning)</th>
                        <th>Optimized</th>
                        <th>Improvement</th>
                    </tr>
                    <tr>
                        <td>Annual Revenue</td>
                        <td>€{financial['baseline_revenue_EUR']:,.0f}</td>
                        <td>€{financial['baseline_revenue_EUR'] + financial['net_benefit_EUR']:,.0f}</td>
                        <td style="color: green;">+€{financial['net_benefit_EUR']:,.0f}</td>
                    </tr>
                    <tr>
                        <td>Cleaning Investment</td>
                        <td>€0</td>
                        <td>€{financial['cleaning_investment_EUR']:,.0f}</td>
                        <td>-</td>
                    </tr>
                    <tr>
                        <td>Net Benefit</td>
                        <td>-</td>
                        <td>€{financial['net_benefit_EUR']:,.0f}</td>
                        <td style="color: green; font-weight: bold;">+{exec_sum['expected_roi_pct']:.0f}% ROI</td>
                    </tr>
                    <tr>
                        <td>Average Soiling Ratio</td>
                        <td>{technical['avg_soiling_ratio_baseline']:.1%}</td>
                        <td>{technical['avg_soiling_ratio_optimized']:.1%}</td>
                        <td style="color: green;">+{(technical['avg_soiling_ratio_optimized'] - technical['avg_soiling_ratio_baseline'])*100:.1f}%</td>
                    </tr>
                    <tr>
                        <td>Energy Recovery</td>
                        <td>-</td>
                        <td>{technical['energy_recovered_MWh']:,.0f} MWh</td>
                        <td>-</td>
                    </tr>
                </table>
            </div>
        </div>

        <div class="footer">
            <p>Generated by NuraVolt Soiling Intelligence | {pd.Timestamp.now().strftime('%Y-%m-%d %H:%M')}</p>
            <p>© 2025 NuraVolt - Advanced Solar Analytics</p>
        </div>
    </div>
</body>
</html>
"""

        if save_path:
            with open(save_path, 'w') as f:
                f.write(html_content)
            print(f"💾 Saved operator dashboard to {save_path}")

        return html_content


    def create_loss_waterfall_sankey(
        self,
        loss_components,
        save_path: Optional[str] = None
    ) -> go.Figure:
        """
        Create Sankey diagram showing energy flow and loss categories.

        Shows flow from Reference Energy through each loss category
        to Net Energy output.

        Parameters:
        -----------
        loss_components : LossComponents
            Loss breakdown from IEALossDisaggregator
        save_path : str, optional
            Path to save HTML file

        Returns:
        --------
        go.Figure : Plotly Sankey figure
        """
        # Get values from loss_components (handle both object and dict)
        if hasattr(loss_components, 'reference_energy'):
            ref_energy = loss_components.reference_energy / 1000  # Convert to MWh
            net_energy = loss_components.net_energy / 1000
            temp_loss = loss_components.temperature_energy_loss / 1000
            spec_loss = loss_components.spectral_energy_loss / 1000
            soil_loss = loss_components.soiling_energy_loss / 1000
            inv_loss = loss_components.inverter_energy_loss / 1000
            wire_loss = loss_components.wiring_bop_energy_loss / 1000
            deg_loss = loss_components.degradation_energy_loss / 1000
            curt_loss = loss_components.curtailment_energy_loss / 1000
        else:
            # Dict format
            ref_energy = loss_components.get('reference_energy', 0) / 1000
            net_energy = loss_components.get('net_energy', 0) / 1000
            temp_loss = loss_components.get('temperature_energy_loss', 0) / 1000
            spec_loss = loss_components.get('spectral_energy_loss', 0) / 1000
            soil_loss = loss_components.get('soiling_energy_loss', 0) / 1000
            inv_loss = loss_components.get('inverter_energy_loss', 0) / 1000
            wire_loss = loss_components.get('wiring_bop_energy_loss', 0) / 1000
            deg_loss = loss_components.get('degradation_energy_loss', 0) / 1000
            curt_loss = loss_components.get('curtailment_energy_loss', 0) / 1000

        # Define nodes (in order of energy flow)
        nodes = [
            "Reference Energy",      # 0
            "After Temperature",     # 1
            "After Spectral",        # 2
            "After Soiling",         # 3
            "After Inverter",        # 4
            "After Wiring/BOP",      # 5
            "After Degradation",     # 6
            "Net Output",            # 7
            "Temperature Loss",      # 8
            "Spectral Loss",         # 9
            "Soiling Loss",          # 10
            "Inverter Loss",         # 11
            "Wiring/BOP Loss",       # 12
            "Degradation Loss",      # 13
            "Curtailment Loss",      # 14
        ]

        # Calculate intermediate values
        after_temp = ref_energy - temp_loss
        after_spec = after_temp - spec_loss
        after_soil = after_spec - soil_loss
        after_inv = after_soil - inv_loss
        after_wire = after_inv - wire_loss
        after_deg = after_wire - deg_loss

        # Define links (source, target, value)
        links = {
            'source': [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6],
            'target': [1, 8, 2, 9, 3, 10, 4, 11, 5, 12, 6, 13, 7, 14],
            'value': [
                after_temp, temp_loss,    # Reference -> After Temp, Temp Loss
                after_spec, spec_loss,    # After Temp -> After Spec, Spec Loss
                after_soil, soil_loss,    # After Spec -> After Soil, Soil Loss
                after_inv, inv_loss,      # After Soil -> After Inv, Inv Loss
                after_wire, wire_loss,    # After Inv -> After Wire, Wire Loss
                after_deg, deg_loss,      # After Wire -> After Deg, Deg Loss
                net_energy, curt_loss,    # After Deg -> Net Output, Curt Loss
            ],
        }

        # Node colors
        node_colors = [
            self.COLORS['primary'],    # Reference
            self.COLORS['info'],       # After Temp
            self.COLORS['info'],       # After Spec
            self.COLORS['info'],       # After Soil
            self.COLORS['info'],       # After Inv
            self.COLORS['info'],       # After Wire
            self.COLORS['info'],       # After Deg
            self.COLORS['success'],    # Net Output
            '#FF6B6B',                 # Temp Loss (red)
            '#4ECDC4',                 # Spec Loss (teal)
            '#45B7D1',                 # Soil Loss (blue)
            '#96CEB4',                 # Inv Loss (green)
            '#FFEAA7',                 # Wire Loss (yellow)
            '#DDA0DD',                 # Deg Loss (plum)
            '#FF7F50',                 # Curt Loss (coral)
        ]

        # Link colors (lighter versions)
        link_colors = [
            'rgba(46, 134, 171, 0.4)',   # Flow to After Temp
            'rgba(255, 107, 107, 0.6)',  # Temp Loss
            'rgba(46, 134, 171, 0.4)',   # Flow to After Spec
            'rgba(78, 205, 196, 0.6)',   # Spec Loss
            'rgba(46, 134, 171, 0.4)',   # Flow to After Soil
            'rgba(69, 183, 209, 0.6)',   # Soil Loss
            'rgba(46, 134, 171, 0.4)',   # Flow to After Inv
            'rgba(150, 206, 180, 0.6)',  # Inv Loss
            'rgba(46, 134, 171, 0.4)',   # Flow to After Wire
            'rgba(255, 234, 167, 0.6)',  # Wire Loss
            'rgba(46, 134, 171, 0.4)',   # Flow to After Deg
            'rgba(221, 160, 221, 0.6)',  # Deg Loss
            'rgba(40, 167, 69, 0.6)',    # Flow to Net Output
            'rgba(255, 127, 80, 0.6)',   # Curt Loss
        ]

        fig = go.Figure(data=[go.Sankey(
            node=dict(
                pad=20,
                thickness=30,
                line=dict(color="black", width=0.5),
                label=nodes,
                color=node_colors,
                hovertemplate='%{label}<br>%{value:.1f} MWh<extra></extra>',
            ),
            link=dict(
                source=links['source'],
                target=links['target'],
                value=links['value'],
                color=link_colors,
                hovertemplate='%{source.label} → %{target.label}<br>%{value:.1f} MWh<extra></extra>',
            )
        )])

        fig.update_layout(
            title=dict(
                text=f"<b>{self.site_name}</b><br>IEA Energy Loss Waterfall (Sankey)",
                font=dict(size=18)
            ),
            font=dict(family="Arial, sans-serif", size=12),
            height=600,
            width=1100,
        )

        if save_path:
            fig.write_html(save_path)
            print(f"💾 Saved loss Sankey to {save_path}")

        return fig

    def create_loss_waterfall_bar(
        self,
        loss_components,
        monthly_losses: Optional[pd.DataFrame] = None,
        save_path: Optional[str] = None
    ) -> go.Figure:
        """
        Create stacked bar chart showing loss breakdown.

        Parameters:
        -----------
        loss_components : LossComponents
            Annual loss breakdown
        monthly_losses : pd.DataFrame, optional
            Monthly loss breakdown for comparison
        save_path : str, optional
            Path to save HTML file

        Returns:
        --------
        go.Figure : Plotly stacked bar figure
        """
        # Get loss percentages
        if hasattr(loss_components, 'temperature_loss_pct'):
            losses = {
                'Temperature': loss_components.temperature_loss_pct * 100,
                'Spectral': loss_components.spectral_loss_pct * 100,
                'Soiling': loss_components.soiling_loss_pct * 100,
                'Inverter': loss_components.inverter_loss_pct * 100,
                'Wiring/BOP': loss_components.wiring_bop_loss_pct * 100,
                'Degradation': loss_components.degradation_loss_pct * 100,
                'Curtailment': loss_components.curtailment_loss_pct * 100,
            }
        else:
            losses = {
                'Temperature': loss_components.get('temperature_loss_pct', 0) * 100,
                'Spectral': loss_components.get('spectral_loss_pct', 0) * 100,
                'Soiling': loss_components.get('soiling_loss_pct', 0) * 100,
                'Inverter': loss_components.get('inverter_loss_pct', 0) * 100,
                'Wiring/BOP': loss_components.get('wiring_bop_loss_pct', 0) * 100,
                'Degradation': loss_components.get('degradation_loss_pct', 0) * 100,
                'Curtailment': loss_components.get('curtailment_loss_pct', 0) * 100,
            }

        # Colors for each loss category
        colors = {
            'Temperature': '#FF6B6B',
            'Spectral': '#4ECDC4',
            'Soiling': '#45B7D1',
            'Inverter': '#96CEB4',
            'Wiring/BOP': '#FFEAA7',
            'Degradation': '#DDA0DD',
            'Curtailment': '#FF7F50',
        }

        if monthly_losses is not None and len(monthly_losses) > 0:
            # Create monthly stacked bar chart
            fig = go.Figure()

            months = monthly_losses.index.tolist()

            # Calculate loss percentages for each month
            for loss_name in ['Temperature', 'Spectral', 'Soiling', 'Inverter', 'Wiring/BOP', 'Degradation', 'Curtailment']:
                col_name = f'{loss_name.lower().replace("/", "_")}_loss_kwh'
                ref_col = 'reference_energy_kwh'

                if col_name in monthly_losses.columns and ref_col in monthly_losses.columns:
                    pct_values = (monthly_losses[col_name] / monthly_losses[ref_col] * 100).fillna(0)
                else:
                    pct_values = [0] * len(months)

                fig.add_trace(go.Bar(
                    name=loss_name,
                    x=months,
                    y=pct_values,
                    marker_color=colors[loss_name],
                    hovertemplate=f'{loss_name}<br>%{{x}}: %{{y:.2f}}%<extra></extra>'
                ))

            fig.update_layout(barmode='stack')
            title_suffix = "Monthly Loss Breakdown"

        else:
            # Create single bar showing annual breakdown
            fig = go.Figure()

            categories = list(losses.keys())
            values = list(losses.values())

            # Create waterfall-style visualization
            fig.add_trace(go.Bar(
                x=categories,
                y=values,
                marker_color=[colors[c] for c in categories],
                text=[f'{v:.2f}%' for v in values],
                textposition='outside',
                hovertemplate='%{x}<br>Loss: %{y:.2f}%<extra></extra>'
            ))

            title_suffix = "Annual Loss Breakdown by Category"

        # Add net output indicator
        total_loss = sum(losses.values())
        net_output = 100 - total_loss

        fig.update_layout(
            title=dict(
                text=f"<b>{self.site_name}</b><br>IEA {title_suffix}",
                font=dict(size=18)
            ),
            xaxis_title="Loss Category" if monthly_losses is None else "Month",
            yaxis_title="Loss (%)",
            template='plotly_white',
            height=500,
            width=1000,
            font=dict(family="Arial, sans-serif", size=12),
            legend=dict(
                orientation='h',
                yanchor='bottom',
                y=1.02,
                xanchor='right',
                x=1
            ),
            annotations=[
                dict(
                    text=f"Total Loss: {total_loss:.1f}% | Net Output: {net_output:.1f}%",
                    xref="paper", yref="paper",
                    x=0.5, y=-0.15,
                    showarrow=False,
                    font=dict(size=14, color=self.COLORS['dark'])
                )
            ]
        )

        if save_path:
            fig.write_html(save_path)
            print(f"💾 Saved loss bar chart to {save_path}")

        return fig


def generate_365d_visualizations(forecast_results: Dict, output_dir: str = 'outputs_alpha1_365d') -> Dict[str, str]:
    """
    Generate all 365-day forecast visualizations.

    Parameters:
    -----------
    forecast_results : dict
        Results from run_alpha1_365d_forecast.py containing:
        - forecast: DataFrame with SR predictions
        - energy: DataFrame with energy forecast
        - monthly: DataFrame with monthly summary
        - optimization: Dict with schedule optimization results
        - proposal: Dict with operator proposal

    output_dir : str
        Output directory for HTML files

    Returns:
    --------
    dict : Paths to generated visualization files
    """
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    site_name = forecast_results.get('site_name', 'Alpha1 9MW')
    viz = Forecast365Visualizer(site_name=site_name)

    generated_files = {}

    # Generate timeline
    print("📊 Generating forecast timeline...")
    viz.create_forecast_timeline(
        df_forecast=forecast_results['forecast'],
        optimal_dates=forecast_results['optimization']['optimal_schedule']['cleaning_dates'],
        df_energy=forecast_results['energy'],
        save_path=output_path / 'plot_365d_timeline.html'
    )
    generated_files['timeline'] = str(output_path / 'plot_365d_timeline.html')

    # Generate heatmap
    print("📊 Generating optimization heatmap...")
    viz.create_cleaning_heatmap(
        all_scenarios=forecast_results['optimization']['all_scenarios'],
        save_path=output_path / 'plot_365d_heatmap.html'
    )
    generated_files['heatmap'] = str(output_path / 'plot_365d_heatmap.html')

    # Generate ROI comparison
    print("📊 Generating ROI comparison...")
    viz.create_roi_comparison(
        comparison_table=forecast_results['optimization']['comparison_table'],
        save_path=output_path / 'plot_365d_roi.html'
    )
    generated_files['roi'] = str(output_path / 'plot_365d_roi.html')

    # Generate monthly breakdown
    print("📊 Generating monthly breakdown...")
    viz.create_monthly_breakdown(
        df_monthly=forecast_results['monthly'],
        save_path=output_path / 'plot_365d_monthly.html'
    )
    generated_files['monthly'] = str(output_path / 'plot_365d_monthly.html')

    # Generate complete dashboard
    print("📊 Generating operator dashboard...")
    viz.create_operator_dashboard(
        df_forecast=forecast_results['forecast'],
        df_energy=forecast_results['energy'],
        df_monthly=forecast_results['monthly'],
        optimization_results=forecast_results['optimization'],
        proposal=forecast_results['proposal'],
        save_path=output_path / 'operator_dashboard_365d.html'
    )
    generated_files['dashboard'] = str(output_path / 'operator_dashboard_365d.html')

    print(f"\n✅ Generated {len(generated_files)} visualization files")

    return generated_files
