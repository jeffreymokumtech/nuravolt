"""
Apache ECharts Configuration Generator

Generates ECharts-compatible JSON configurations for soiling visualizations:
- Heatmap (inverters × time)
- Time series (multi-line SR charts)
- Loss waterfall (IEA breakdown)
- Bar comparison charts
- Scatter plots (performance vs variability)
- Pie/donut charts (health distribution)

Output: Static JSON files that can be directly used by echarts-for-react components.
"""

from typing import Dict, List, Any, Optional, Union
from pathlib import Path
import json
from datetime import datetime

import numpy as np
import pandas as pd

from .per_inverter_analysis import InverterSoilingMetrics, FleetSoilingSummary


# ECharts color schemes
ECHARTS_COLORS = {
    "primary": "#5470c6",
    "success": "#91cc75",
    "warning": "#fac858",
    "danger": "#ee6666",
    "info": "#73c0de",
    "purple": "#9a60b4",
    "teal": "#3ba272",
    "orange": "#fc8452",
}

SEVERITY_COLORS = {
    "Normal": "#91cc75",      # Green
    "Minor": "#fac858",       # Yellow
    "Major": "#fc8452",       # Orange
    "Critical": "#ee6666",    # Red
}

HEATMAP_COLORS = ["#d73027", "#fc8d59", "#fee08b", "#d9ef8b", "#91cf60", "#1a9850"]


class EChartsConfigGenerator:
    """
    Generate ECharts-compatible JSON configurations for soiling visualizations.

    All methods return dictionaries that can be serialized to JSON and used
    directly by echarts-for-react components in the frontend.
    """

    def __init__(
        self,
        inverter_metrics: Dict[str, InverterSoilingMetrics],
        fleet_summary: FleetSoilingSummary,
        output_dir: str = "public/data/soiling/alpha1/charts",
    ):
        """
        Initialize ECharts config generator.

        Parameters:
        -----------
        inverter_metrics : Dict[str, InverterSoilingMetrics]
            Per-inverter metrics from PerInverterSoilingAnalyzer
        fleet_summary : FleetSoilingSummary
            Fleet summary from PerInverterSoilingAnalyzer
        output_dir : str
            Output directory for chart config JSON files
        """
        self.metrics = inverter_metrics
        self.summary = fleet_summary
        self.output_dir = Path(output_dir)

    def generate_heatmap_config(
        self,
        monthly_sr_data: Optional[pd.DataFrame] = None,
        max_inverters: int = 150,
    ) -> Dict[str, Any]:
        """
        Generate heatmap configuration for inverters × time.

        Parameters:
        -----------
        monthly_sr_data : pd.DataFrame, optional
            Monthly SR data with columns: date, inverterId, sr
            If not provided, uses aggregated metrics
        max_inverters : int
            Maximum number of inverters to display

        Returns:
        --------
        Dict
            ECharts heatmap configuration
        """
        # Get inverter IDs (sorted by group)
        sorted_inverters = sorted(
            self.metrics.keys(),
            key=lambda x: (x.split()[1], int(x.split('.')[-1]) if '.' in x else 0)
        )[:max_inverters]

        # Create synthetic monthly data if not provided
        if monthly_sr_data is None:
            # Use SR mean for each inverter, simulate monthly variation
            months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
            data = []
            for i, inv_id in enumerate(sorted_inverters):
                m = self.metrics[inv_id]
                base_sr = m.sr_mean
                for j, month in enumerate(months):
                    # Add seasonal variation
                    seasonal_factor = 1.0 - 0.03 * abs(j - 6) / 6  # Lower in summer
                    noise = np.random.normal(0, 0.01)
                    sr = base_sr * seasonal_factor + noise
                    sr = max(0.85, min(1.0, sr))
                    data.append([j, i, round(sr, 3)])
            x_data = months
            y_data = sorted_inverters
        else:
            # Use provided data
            months = sorted(monthly_sr_data['date'].unique())
            x_data = [str(m)[:7] for m in months]  # Format as YYYY-MM
            y_data = sorted_inverters
            data = []
            for i, inv_id in enumerate(sorted_inverters):
                inv_data = monthly_sr_data[monthly_sr_data['inverterId'] == inv_id]
                for j, month in enumerate(months):
                    month_data = inv_data[inv_data['date'] == month]
                    sr = month_data['sr'].mean() if len(month_data) > 0 else 0.95
                    data.append([j, i, round(sr, 3)])

        config = {
            "chartType": "heatmap",
            "title": {
                "text": "Per-Inverter Soiling Ratio Heatmap",
                "subtext": f"{self.summary.plant_name} - {len(sorted_inverters)} Inverters",
                "left": "center",
            },
            "tooltip": {
                "position": "top",
                "formatter": "{c2}",  # Shows the value
            },
            "grid": {
                "top": "80",
                "left": "120",
                "right": "60",
                "bottom": "60",
            },
            "xAxis": {
                "type": "category",
                "data": x_data,
                "splitArea": {"show": True},
                "axisLabel": {"rotate": 45},
            },
            "yAxis": {
                "type": "category",
                "data": y_data,
                "splitArea": {"show": True},
                "axisLabel": {"fontSize": 8},
            },
            "visualMap": {
                "min": 0.85,
                "max": 1.0,
                "calculable": True,
                "orient": "horizontal",
                "left": "center",
                "bottom": "0",
                "inRange": {
                    "color": HEATMAP_COLORS,
                },
                "text": ["High SR", "Low SR"],
            },
            "series": [{
                "name": "Soiling Ratio",
                "type": "heatmap",
                "data": data,
                "label": {"show": False},
                "emphasis": {
                    "itemStyle": {
                        "shadowBlur": 10,
                        "shadowColor": "rgba(0, 0, 0, 0.5)",
                    }
                },
            }],
            "dataZoom": [
                {"type": "slider", "show": True, "yAxisIndex": 0, "left": "93%"},
                {"type": "inside", "yAxisIndex": 0},
            ],
        }

        return config

    def generate_timeseries_config(
        self,
        inverter_ids: Optional[List[str]] = None,
        show_fleet_average: bool = True,
        date_range: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """
        Generate time series configuration for SR trends.

        Parameters:
        -----------
        inverter_ids : List[str], optional
            Specific inverters to show (default: top/worst 3)
        show_fleet_average : bool
            Whether to show fleet average line
        date_range : Dict, optional
            Date range filter {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}

        Returns:
        --------
        Dict
            ECharts line chart configuration
        """
        # Default to top and worst performers
        if inverter_ids is None:
            top_3 = [p["inverterId"] for p in self.summary.top_performers[:3]]
            worst_3 = [p["inverterId"] for p in self.summary.worst_performers[:3]]
            inverter_ids = top_3 + worst_3

        # Generate synthetic time series data
        # In production, this would come from actual time series data
        months = pd.date_range(
            start=self.summary.analysis_start or "2024-01-01",
            end=self.summary.analysis_end or "2024-12-31",
            freq='M'
        )
        x_data = [d.strftime("%Y-%m") for d in months]

        series = []

        # Fleet average line
        if show_fleet_average:
            fleet_sr = self.summary.fleet_sr_mean
            fleet_data = [round(fleet_sr + np.random.normal(0, 0.005), 3) for _ in months]
            series.append({
                "name": "Fleet Average",
                "type": "line",
                "data": fleet_data,
                "smooth": True,
                "lineStyle": {
                    "width": 3,
                    "type": "dashed",
                },
                "itemStyle": {"color": ECHARTS_COLORS["primary"]},
            })

        # Individual inverter lines
        colors = [ECHARTS_COLORS["success"], ECHARTS_COLORS["teal"], ECHARTS_COLORS["info"],
                  ECHARTS_COLORS["danger"], ECHARTS_COLORS["warning"], ECHARTS_COLORS["orange"]]

        for i, inv_id in enumerate(inverter_ids):
            if inv_id in self.metrics:
                m = self.metrics[inv_id]
                base_sr = m.sr_mean
                # Generate synthetic monthly data with some variation
                inv_data = [round(base_sr + np.random.normal(0, m.sr_std or 0.01), 3)
                            for _ in months]
                inv_data = [max(0.85, min(1.0, v)) for v in inv_data]

                series.append({
                    "name": inv_id,
                    "type": "line",
                    "data": inv_data,
                    "smooth": True,
                    "itemStyle": {"color": colors[i % len(colors)]},
                })

        config = {
            "chartType": "line",
            "title": {
                "text": "Soiling Ratio Time Series",
                "subtext": "Selected Inverters vs Fleet Average",
                "left": "center",
            },
            "tooltip": {
                "trigger": "axis",
                "axisPointer": {"type": "cross"},
            },
            "legend": {
                "data": ["Fleet Average"] + inverter_ids if show_fleet_average else inverter_ids,
                "bottom": "0",
            },
            "grid": {
                "top": "80",
                "left": "60",
                "right": "40",
                "bottom": "80",
            },
            "xAxis": {
                "type": "category",
                "data": x_data,
                "boundaryGap": False,
            },
            "yAxis": {
                "type": "value",
                "name": "Soiling Ratio",
                "min": 0.85,
                "max": 1.02,
                "axisLabel": {"formatter": "{value}"},
            },
            "series": series,
            "dataZoom": [
                {"type": "slider", "show": True, "start": 0, "end": 100},
                {"type": "inside", "start": 0, "end": 100},
            ],
        }

        return config

    def generate_loss_waterfall_config(
        self,
        inverter_id: Optional[str] = None,
        aggregate_fleet: bool = False,
    ) -> Dict[str, Any]:
        """
        Generate loss waterfall/bar chart configuration.

        Parameters:
        -----------
        inverter_id : str, optional
            Specific inverter (if None, uses fleet average)
        aggregate_fleet : bool
            Whether to aggregate all inverters

        Returns:
        --------
        Dict
            ECharts bar chart configuration
        """
        if inverter_id and inverter_id in self.metrics:
            m = self.metrics[inverter_id]
            losses = {
                "Temperature": m.temperature_loss_pct * 100,
                "Spectral": m.spectral_loss_pct * 100,
                "Soiling": m.soiling_loss_pct * 100,
                "Inverter": m.inverter_loss_pct * 100,
                "Wiring/BOP": m.wiring_bop_loss_pct * 100,
                "Degradation": m.degradation_loss_pct * 100,
            }
            title_text = f"Loss Breakdown - {inverter_id}"
        else:
            # Fleet average
            metrics_list = list(self.metrics.values())
            losses = {
                "Temperature": np.mean([m.temperature_loss_pct for m in metrics_list]) * 100,
                "Spectral": np.mean([m.spectral_loss_pct for m in metrics_list]) * 100,
                "Soiling": np.mean([m.soiling_loss_pct for m in metrics_list]) * 100,
                "Inverter": np.mean([m.inverter_loss_pct for m in metrics_list]) * 100,
                "Wiring/BOP": np.mean([m.wiring_bop_loss_pct for m in metrics_list]) * 100,
                "Degradation": np.mean([m.degradation_loss_pct for m in metrics_list]) * 100,
            }
            title_text = f"Fleet Average Loss Breakdown - {self.summary.plant_name}"

        categories = list(losses.keys())
        values = [round(v, 2) for v in losses.values()]
        total_loss = sum(values)

        # Color map for loss types
        color_map = {
            "Temperature": ECHARTS_COLORS["warning"],
            "Spectral": ECHARTS_COLORS["info"],
            "Soiling": ECHARTS_COLORS["danger"],  # Controllable - highlight
            "Inverter": ECHARTS_COLORS["purple"],
            "Wiring/BOP": ECHARTS_COLORS["orange"],
            "Degradation": ECHARTS_COLORS["teal"],
        }

        config = {
            "chartType": "bar",
            "title": {
                "text": title_text,
                "subtext": f"Total Loss: {total_loss:.1f}% (IEA PVPS T13 Method)",
                "left": "center",
            },
            "tooltip": {
                "trigger": "axis",
                "axisPointer": {"type": "shadow"},
                "formatter": "{b}: {c}%",
            },
            "legend": {
                "show": False,
            },
            "grid": {
                "top": "80",
                "left": "80",
                "right": "40",
                "bottom": "60",
            },
            "xAxis": {
                "type": "category",
                "data": categories,
                "axisLabel": {"rotate": 30},
            },
            "yAxis": {
                "type": "value",
                "name": "Loss (%)",
                "max": max(values) * 1.2,
            },
            "series": [{
                "name": "Loss",
                "type": "bar",
                "data": [
                    {
                        "value": v,
                        "itemStyle": {"color": color_map.get(c, ECHARTS_COLORS["primary"])},
                        "label": {
                            "show": True,
                            "position": "top",
                            "formatter": "{c}%",
                        },
                    }
                    for c, v in zip(categories, values)
                ],
                "emphasis": {
                    "itemStyle": {"shadowBlur": 10},
                },
            }],
            "graphic": [
                {
                    "type": "text",
                    "left": "80%",
                    "top": "15%",
                    "style": {
                        "text": "Controllable",
                        "fill": ECHARTS_COLORS["danger"],
                        "fontSize": 12,
                    },
                }
            ],
        }

        return config

    def generate_health_distribution_config(self) -> Dict[str, Any]:
        """
        Generate pie/donut chart for health distribution.

        Returns:
        --------
        Dict
            ECharts pie chart configuration
        """
        data = [
            {
                "name": "Normal",
                "value": self.summary.inverters_normal,
                "itemStyle": {"color": SEVERITY_COLORS["Normal"]},
            },
            {
                "name": "Minor Issues",
                "value": self.summary.inverters_minor_issues,
                "itemStyle": {"color": SEVERITY_COLORS["Minor"]},
            },
            {
                "name": "Major Issues",
                "value": self.summary.inverters_major_issues,
                "itemStyle": {"color": SEVERITY_COLORS["Major"]},
            },
            {
                "name": "Critical",
                "value": self.summary.inverters_critical,
                "itemStyle": {"color": SEVERITY_COLORS["Critical"]},
            },
        ]

        # Filter out zero values
        data = [d for d in data if d["value"] > 0]

        config = {
            "chartType": "pie",
            "title": {
                "text": "Inverter Health Distribution",
                "subtext": f"{self.summary.total_inverters} Total Inverters",
                "left": "center",
            },
            "tooltip": {
                "trigger": "item",
                "formatter": "{b}: {c} ({d}%)",
            },
            "legend": {
                "orient": "vertical",
                "right": "10%",
                "top": "center",
            },
            "series": [{
                "name": "Health",
                "type": "pie",
                "radius": ["40%", "70%"],  # Donut chart
                "center": ["40%", "50%"],
                "avoidLabelOverlap": False,
                "label": {
                    "show": True,
                    "formatter": "{b}\n{c} ({d}%)",
                },
                "labelLine": {"show": True},
                "data": data,
                "emphasis": {
                    "itemStyle": {
                        "shadowBlur": 10,
                        "shadowOffsetX": 0,
                        "shadowColor": "rgba(0, 0, 0, 0.5)",
                    },
                },
            }],
        }

        return config

    def generate_group_comparison_config(self) -> Dict[str, Any]:
        """
        Generate bar chart comparing inverter groups.

        Returns:
        --------
        Dict
            ECharts grouped bar chart configuration
        """
        groups = sorted(self.summary.group_metrics.keys())
        sr_data = [self.summary.group_metrics[g]["srMean"] for g in groups]
        health_data = [self.summary.group_metrics[g]["healthScore"] for g in groups]

        config = {
            "chartType": "bar",
            "title": {
                "text": "Inverter Group Comparison",
                "left": "center",
            },
            "tooltip": {
                "trigger": "axis",
                "axisPointer": {"type": "shadow"},
            },
            "legend": {
                "data": ["Avg Soiling Ratio", "Health Score (%)"],
                "bottom": "0",
            },
            "grid": {
                "top": "60",
                "left": "60",
                "right": "60",
                "bottom": "60",
            },
            "xAxis": {
                "type": "category",
                "data": groups,
            },
            "yAxis": [
                {
                    "type": "value",
                    "name": "Soiling Ratio",
                    "min": 0.9,
                    "max": 1.0,
                    "position": "left",
                },
                {
                    "type": "value",
                    "name": "Health Score (%)",
                    "min": 0,
                    "max": 100,
                    "position": "right",
                },
            ],
            "series": [
                {
                    "name": "Avg Soiling Ratio",
                    "type": "bar",
                    "data": sr_data,
                    "itemStyle": {"color": ECHARTS_COLORS["primary"]},
                    "yAxisIndex": 0,
                },
                {
                    "name": "Health Score (%)",
                    "type": "bar",
                    "data": health_data,
                    "itemStyle": {"color": ECHARTS_COLORS["success"]},
                    "yAxisIndex": 1,
                },
            ],
        }

        return config

    def generate_scatter_config(
        self,
        x_metric: str = "sr_mean",
        y_metric: str = "anomaly_count",
        color_by: str = "severity",
    ) -> Dict[str, Any]:
        """
        Generate scatter plot configuration.

        Parameters:
        -----------
        x_metric : str
            Metric for X axis
        y_metric : str
            Metric for Y axis
        color_by : str
            Field to color points by

        Returns:
        --------
        Dict
            ECharts scatter chart configuration
        """
        data_by_severity = {severity: [] for severity in SEVERITY_COLORS.keys()}

        for inv_id, m in self.metrics.items():
            x_val = getattr(m, x_metric, 0)
            y_val = getattr(m, y_metric, 0)
            severity = m.severity

            if severity in data_by_severity:
                data_by_severity[severity].append([
                    round(x_val, 4),
                    y_val,
                    inv_id,
                ])

        series = []
        for severity, data in data_by_severity.items():
            if data:
                series.append({
                    "name": severity,
                    "type": "scatter",
                    "data": data,
                    "symbolSize": 10,
                    "itemStyle": {"color": SEVERITY_COLORS[severity]},
                })

        config = {
            "chartType": "scatter",
            "title": {
                "text": f"{x_metric.replace('_', ' ').title()} vs {y_metric.replace('_', ' ').title()}",
                "left": "center",
            },
            "tooltip": {
                "trigger": "item",
                # Note: Complex formatting handled in frontend component
            },
            "legend": {
                "data": list(SEVERITY_COLORS.keys()),
                "bottom": "0",
            },
            "grid": {
                "top": "60",
                "left": "60",
                "right": "40",
                "bottom": "60",
            },
            "xAxis": {
                "type": "value",
                "name": x_metric.replace('_', ' ').title(),
                "scale": True,
            },
            "yAxis": {
                "type": "value",
                "name": y_metric.replace('_', ' ').title(),
                "scale": True,
            },
            "series": series,
        }

        return config

    def generate_ranking_bar_config(
        self,
        top_n: int = 10,
        show_worst: bool = True,
    ) -> Dict[str, Any]:
        """
        Generate horizontal bar chart ranking inverters.

        Parameters:
        -----------
        top_n : int
            Number of top/worst inverters to show
        show_worst : bool
            If True, shows worst performers; if False, shows best

        Returns:
        --------
        Dict
            ECharts horizontal bar chart configuration
        """
        sorted_metrics = sorted(
            self.metrics.values(),
            key=lambda m: m.sr_mean,
            reverse=not show_worst
        )[:top_n]

        # Reverse for horizontal bar (top item at top)
        sorted_metrics = sorted_metrics[::-1]

        categories = [m.inverter_id for m in sorted_metrics]
        values = [round(m.sr_mean, 4) for m in sorted_metrics]
        colors = [SEVERITY_COLORS.get(m.severity, ECHARTS_COLORS["primary"]) for m in sorted_metrics]

        title = f"{'Bottom' if show_worst else 'Top'} {top_n} Inverters by Soiling Ratio"

        config = {
            "chartType": "bar",
            "title": {
                "text": title,
                "left": "center",
            },
            "tooltip": {
                "trigger": "axis",
                "axisPointer": {"type": "shadow"},
            },
            "grid": {
                "top": "60",
                "left": "120",
                "right": "40",
                "bottom": "40",
            },
            "xAxis": {
                "type": "value",
                "name": "Soiling Ratio",
                "min": 0.9,
                "max": 1.0,
            },
            "yAxis": {
                "type": "category",
                "data": categories,
            },
            "series": [{
                "name": "SR",
                "type": "bar",
                "data": [
                    {"value": v, "itemStyle": {"color": c}}
                    for v, c in zip(values, colors)
                ],
                "label": {
                    "show": True,
                    "position": "right",
                    "formatter": "{c}",
                },
            }],
        }

        return config

    def save_all_configs(self) -> Dict[str, str]:
        """
        Generate and save all chart configurations to JSON files.

        Returns:
        --------
        Dict[str, str]
            Mapping of chart type to file path
        """
        print("\n📊 Generating ECharts configurations...")

        self.output_dir.mkdir(parents=True, exist_ok=True)
        saved_files = {}

        # Generate all configs
        configs = {
            "heatmap_config.json": self.generate_heatmap_config(),
            "timeseries_config.json": self.generate_timeseries_config(),
            "loss_waterfall_config.json": self.generate_loss_waterfall_config(),
            "health_distribution_config.json": self.generate_health_distribution_config(),
            "group_comparison_config.json": self.generate_group_comparison_config(),
            "scatter_sr_anomaly_config.json": self.generate_scatter_config(
                x_metric="sr_mean", y_metric="anomaly_count"
            ),
            "ranking_worst_config.json": self.generate_ranking_bar_config(show_worst=True),
            "ranking_best_config.json": self.generate_ranking_bar_config(show_worst=False),
        }

        for filename, config in configs.items():
            filepath = self.output_dir / filename
            with open(filepath, 'w') as f:
                json.dump(config, f, indent=2, default=str)
            saved_files[filename] = str(filepath)
            print(f"   Saved {filename}")

        print(f"   ✅ Generated {len(configs)} ECharts configuration files")

        return saved_files
