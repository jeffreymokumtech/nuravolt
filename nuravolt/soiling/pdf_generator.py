"""
Professional PDF report generator for soiling intelligence proposals.

Generates operator-facing PDF reports with:
- Executive summary
- Optimal cleaning schedule
- Financial analysis
- Technical details
- Visualizations
"""

import io
from pathlib import Path
from typing import Dict, Optional
from datetime import datetime

try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch, cm
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
        Image, PageBreak, ListFlowable, ListItem
    )
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    REPORTLAB_AVAILABLE = True
except ImportError:
    REPORTLAB_AVAILABLE = False
    print("⚠️ reportlab not installed. PDF generation disabled.")
    print("   Install with: pip install reportlab")


class SoilingReportPDF:
    """
    Generate professional PDF reports for soiling intelligence analysis.

    Creates operator-facing documents with:
    - Cover page with plant info
    - Executive summary
    - Optimal cleaning schedule recommendation
    - Financial analysis with ROI
    - Monthly breakdown tables
    - Appendix with methodology
    """

    # NuraVolt brand colors - initialized lazily to handle import order
    COLORS = None

    @classmethod
    def _init_colors(cls):
        """Initialize colors lazily after reportlab is imported."""
        if cls.COLORS is None and REPORTLAB_AVAILABLE:
            from reportlab.lib import colors as rl_colors
            cls.COLORS = {
                'primary': rl_colors.HexColor('#2E86AB'),
                'secondary': rl_colors.HexColor('#A23B72'),
                'success': rl_colors.HexColor('#28A745'),
                'warning': rl_colors.HexColor('#FFC107'),
                'dark': rl_colors.HexColor('#343A40'),
                'light': rl_colors.HexColor('#F8F9FA'),
            }

    def __init__(self, site_name: str = "Solar Plant"):
        self.site_name = site_name

        if REPORTLAB_AVAILABLE:
            self._init_colors()  # Initialize colors lazily
            self.styles = getSampleStyleSheet()
            self._setup_custom_styles()

    def _setup_custom_styles(self):
        """Setup custom paragraph styles."""
        # Helper to safely add styles (skip if already exists)
        def add_style(name, **kwargs):
            if name not in self.styles.byName:
                self.styles.add(ParagraphStyle(name, **kwargs))

        add_style(
            'CustomTitle',
            parent=self.styles['Title'],
            fontSize=28,
            textColor=self.COLORS['primary'],
            spaceAfter=30
        )

        add_style(
            'SectionHeader',
            parent=self.styles['Heading1'],
            fontSize=16,
            textColor=self.COLORS['primary'],
            spaceBefore=20,
            spaceAfter=10,
            borderPadding=5,
        )

        add_style(
            'SubHeader',
            parent=self.styles['Heading2'],
            fontSize=12,
            textColor=self.COLORS['dark'],
            spaceBefore=12,
            spaceAfter=6
        )

        add_style(
            'CustomBodyText',
            parent=self.styles['Normal'],
            fontSize=10,
            leading=14,
            spaceAfter=8
        )
        # Alias for backward compatibility
        if 'BodyText' not in self.styles.byName:
            self.styles.add(ParagraphStyle(
                'BodyText',
                parent=self.styles['Normal'],
                fontSize=10,
                leading=14,
                spaceAfter=8
            ))

        add_style(
            'Highlight',
            parent=self.styles['Normal'],
            fontSize=11,
            textColor=self.COLORS['success'],
            fontName='Helvetica-Bold'
        )

        add_style(
            'Footer',
            parent=self.styles['Normal'],
            fontSize=8,
            textColor=colors.gray
        )

    def generate_report(self,
                       proposal: Dict,
                       optimization_results: Dict,
                       monthly_summary: Dict,
                       output_path: str) -> str:
        """
        Generate complete PDF report.

        Parameters:
        -----------
        proposal : dict
            Operator proposal from schedule_optimizer
        optimization_results : dict
            Full optimization results
        monthly_summary : dict or DataFrame
            Monthly breakdown data
        output_path : str
            Path to save PDF

        Returns:
        --------
        str : Path to generated PDF
        """
        if not REPORTLAB_AVAILABLE:
            print("⚠️ reportlab not available. Skipping PDF generation.")
            return None

        doc = SimpleDocTemplate(
            output_path,
            pagesize=A4,
            rightMargin=1.5*cm,
            leftMargin=1.5*cm,
            topMargin=2*cm,
            bottomMargin=2*cm
        )

        story = []

        # Cover page
        story.extend(self._create_cover_page(proposal))
        story.append(PageBreak())

        # Executive summary
        story.extend(self._create_executive_summary(proposal))

        # Optimal schedule
        story.extend(self._create_schedule_section(proposal, optimization_results))

        # Financial analysis
        story.extend(self._create_financial_section(proposal))

        # Strategy comparison
        story.extend(self._create_comparison_section(optimization_results))

        # Monthly breakdown
        story.extend(self._create_monthly_section(monthly_summary))

        # Recommendations
        story.extend(self._create_recommendations_section(proposal))

        # Methodology appendix
        story.append(PageBreak())
        story.extend(self._create_methodology_section())

        # Build PDF
        doc.build(story)
        print(f"💾 Generated PDF report: {output_path}")

        return output_path

    def _create_cover_page(self, proposal: Dict) -> list:
        """Create cover page."""
        exec_sum = proposal['executive_summary']

        elements = []

        # Logo placeholder
        elements.append(Spacer(1, 2*inch))

        # Title
        elements.append(Paragraph(
            "Soiling Intelligence Report",
            self.styles['CustomTitle']
        ))

        elements.append(Paragraph(
            f"<b>{self.site_name}</b>",
            ParagraphStyle(
                'PlantName',
                parent=self.styles['Normal'],
                fontSize=20,
                textColor=self.COLORS['secondary'],
                alignment=TA_CENTER,
                spaceAfter=20
            )
        ))

        # Subtitle
        elements.append(Paragraph(
            "365-Day Forecast & Cleaning Optimization",
            ParagraphStyle(
                'Subtitle',
                parent=self.styles['Normal'],
                fontSize=14,
                textColor=self.COLORS['dark'],
                alignment=TA_CENTER,
                spaceAfter=40
            )
        ))

        # Key metrics box
        key_data = [
            ['Plant Capacity', f"{exec_sum['plant_capacity_MW']:.1f} MW"],
            ['Forecast Period', exec_sum['forecast_period']],
            ['Recommended Cleanings', str(exec_sum['recommended_cleanings'])],
            ['Expected Net Benefit', f"€{exec_sum['expected_net_benefit_EUR']:,.0f}"],
            ['Expected ROI', f"{exec_sum['expected_roi_pct']:.0f}%"],
        ]

        key_table = Table(key_data, colWidths=[3*inch, 2*inch])
        key_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), self.COLORS['light']),
            ('TEXTCOLOR', (0, 0), (0, -1), self.COLORS['dark']),
            ('TEXTCOLOR', (1, 0), (1, -1), self.COLORS['primary']),
            ('ALIGN', (0, 0), (0, -1), 'LEFT'),
            ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
            ('FONTNAME', (1, 0), (1, -1), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 12),
            ('PADDING', (0, 0), (-1, -1), 12),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.white),
        ]))

        elements.append(key_table)

        elements.append(Spacer(1, 2*inch))

        # Footer
        elements.append(Paragraph(
            f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
            self.styles['Footer']
        ))
        elements.append(Paragraph(
            "NuraVolt Soiling Intelligence | www.nuravolt.com",
            self.styles['Footer']
        ))

        return elements

    def _create_executive_summary(self, proposal: Dict) -> list:
        """Create executive summary section."""
        exec_sum = proposal['executive_summary']
        financial = proposal['financial_analysis']
        technical = proposal['technical_details']

        elements = []

        elements.append(Paragraph("1. Executive Summary", self.styles['SectionHeader']))

        summary_text = f"""
        This report presents the optimal cleaning schedule for {self.site_name} over the next 365 days.
        Based on comprehensive analysis of soiling patterns, seasonal variations, and financial parameters,
        we recommend <b>{exec_sum['recommended_cleanings']} strategic cleanings</b> that will deliver:
        """
        elements.append(Paragraph(summary_text, self.styles['BodyText']))

        # Highlight box
        highlight_data = [
            [f"€{exec_sum['expected_net_benefit_EUR']:,.0f}", f"{exec_sum['expected_roi_pct']:.0f}%",
             f"{technical['energy_recovered_MWh']:,.0f} MWh"],
            ["Net Benefit", "Return on Investment", "Energy Recovered"],
        ]

        highlight_table = Table(highlight_data, colWidths=[2*inch, 2*inch, 2*inch])
        highlight_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), self.COLORS['success']),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('BACKGROUND', (0, 1), (-1, 1), self.COLORS['light']),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, 0), 18),
            ('FONTSIZE', (0, 1), (-1, 1), 10),
            ('PADDING', (0, 0), (-1, -1), 15),
        ]))

        elements.append(Spacer(1, 0.3*inch))
        elements.append(highlight_table)
        elements.append(Spacer(1, 0.3*inch))

        # Key findings
        elements.append(Paragraph("Key Findings:", self.styles['SubHeader']))

        findings = [
            f"Baseline annual soiling loss: {technical['avg_soiling_loss_baseline_pct']:.1f}%",
            f"Optimized annual soiling loss: {technical['avg_soiling_loss_optimized_pct']:.1f}%",
            f"Cleaning investment: €{financial['cleaning_investment_EUR']:,.0f}",
            f"Payback period: {financial['payback_days']:.0f} days",
        ]

        for finding in findings:
            elements.append(Paragraph(f"• {finding}", self.styles['BodyText']))

        return elements

    def _create_schedule_section(self, proposal: Dict, optimization_results: Dict) -> list:
        """Create optimal schedule section."""
        best = optimization_results['optimal_schedule']

        elements = []

        elements.append(Paragraph("2. Optimal Cleaning Schedule", self.styles['SectionHeader']))

        intro_text = f"""
        The recommended cleaning schedule maximizes return on investment while accounting for
        seasonal soiling patterns and energy production variations. Each cleaning date was selected
        from over {len(optimization_results['all_scenarios']):,} analyzed scenarios.
        """
        elements.append(Paragraph(intro_text, self.styles['BodyText']))

        elements.append(Paragraph("Recommended Dates:", self.styles['SubHeader']))

        # Schedule table
        schedule_data = [['#', 'Date', 'Expected Benefit']]
        total_benefit = best['net_benefit_EUR'] / len(best['cleaning_dates'])

        for i, date in enumerate(best['cleaning_dates'], 1):
            schedule_data.append([str(i), date, f"~€{total_benefit:,.0f}"])

        schedule_table = Table(schedule_data, colWidths=[0.5*inch, 2*inch, 2*inch])
        schedule_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), self.COLORS['primary']),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 11),
            ('PADDING', (0, 0), (-1, -1), 10),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.gray),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, self.COLORS['light']]),
        ]))

        elements.append(schedule_table)

        return elements

    def _create_financial_section(self, proposal: Dict) -> list:
        """Create financial analysis section."""
        financial = proposal['financial_analysis']

        elements = []

        elements.append(Paragraph("3. Financial Analysis", self.styles['SectionHeader']))

        # Financial table
        fin_data = [
            ['Metric', 'Value'],
            ['Baseline Revenue (with soiling)', f"€{financial['baseline_revenue_EUR']:,.0f}"],
            ['Revenue After Optimization', f"€{financial['baseline_revenue_EUR'] + financial['net_benefit_EUR']:,.0f}"],
            ['Cleaning Investment', f"€{financial['cleaning_investment_EUR']:,.0f}"],
            ['Net Benefit', f"€{financial['net_benefit_EUR']:,.0f}"],
            ['Return on Investment', f"{proposal['executive_summary']['expected_roi_pct']:.0f}%"],
            ['Payback Period', f"{financial['payback_days']:.0f} days"],
        ]

        fin_table = Table(fin_data, colWidths=[3*inch, 2.5*inch])
        fin_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), self.COLORS['primary']),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('ALIGN', (1, 1), (1, -1), 'RIGHT'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTNAME', (0, -2), (-1, -1), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('PADDING', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.gray),
            ('BACKGROUND', (0, -2), (-1, -1), self.COLORS['light']),
        ]))

        elements.append(fin_table)

        return elements

    def _create_comparison_section(self, optimization_results: Dict) -> list:
        """Create strategy comparison section."""
        comparison = optimization_results['comparison_table']

        elements = []

        elements.append(Paragraph("4. Strategy Comparison", self.styles['SectionHeader']))

        intro_text = """
        The following table compares different cleaning strategies (1-5 cleanings per year)
        to help you understand the trade-offs and select the approach that best fits your
        operational requirements.
        """
        elements.append(Paragraph(intro_text, self.styles['BodyText']))

        # Comparison table
        comp_data = [['Strategy', 'Net Benefit', 'ROI', 'Cleaning Cost']]

        for _, row in comparison.iterrows():
            comp_data.append([
                f"{int(row['n_cleanings'])} cleaning(s)",
                f"€{row['net_benefit_EUR']:,.0f}",
                f"{row['roi_pct']:.0f}%",
                f"€{row['cleaning_cost_EUR']:,.0f}",
            ])

        comp_table = Table(comp_data, colWidths=[1.5*inch, 1.5*inch, 1*inch, 1.5*inch])
        comp_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), self.COLORS['primary']),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('ALIGN', (1, 1), (-1, -1), 'RIGHT'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('PADDING', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.gray),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, self.COLORS['light']]),
        ]))

        elements.append(comp_table)

        return elements

    def _create_monthly_section(self, monthly_summary) -> list:
        """Create monthly breakdown section."""
        elements = []

        elements.append(Paragraph("5. Monthly Breakdown", self.styles['SectionHeader']))

        intro_text = """
        The monthly breakdown shows how energy production and soiling losses vary throughout
        the year. Summer months (June-August) typically show higher production potential
        but also higher soiling impact due to dry conditions.
        """
        elements.append(Paragraph(intro_text, self.styles['BodyText']))

        # Check if we have the DataFrame or need to handle it differently
        if hasattr(monthly_summary, 'iterrows'):
            monthly_data = [['Month', 'Energy (MWh)', 'Revenue (€)', 'Avg SR']]

            for _, row in monthly_summary.iterrows():
                month = row.get('month', row.name) if hasattr(row, 'get') else row.name
                energy = row.get('energy_with_soiling_MWh', 0)
                revenue = row.get('revenue_with_soiling_EUR', 0)
                sr = row.get('avg_sr', 0.95)

                monthly_data.append([
                    str(month),
                    f"{energy:,.0f}",
                    f"€{revenue:,.0f}",
                    f"{sr:.1%}"
                ])

            monthly_table = Table(monthly_data, colWidths=[1*inch, 1.5*inch, 1.5*inch, 1*inch])
            monthly_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), self.COLORS['primary']),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 9),
                ('PADDING', (0, 0), (-1, -1), 6),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.gray),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, self.COLORS['light']]),
            ]))

            elements.append(monthly_table)
        else:
            elements.append(Paragraph("Monthly data not available.", self.styles['BodyText']))

        return elements

    def _create_recommendations_section(self, proposal: Dict) -> list:
        """Create recommendations section."""
        recommendations = proposal.get('recommendations', [])

        elements = []

        elements.append(Paragraph("6. Recommendations", self.styles['SectionHeader']))

        if recommendations:
            for i, rec in enumerate(recommendations, 1):
                elements.append(Paragraph(f"{i}. {rec}", self.styles['BodyText']))
        else:
            elements.append(Paragraph("No specific recommendations available.", self.styles['BodyText']))

        # Additional guidance
        elements.append(Paragraph("Implementation Guidance:", self.styles['SubHeader']))

        guidance = [
            "Schedule cleanings 1-2 weeks before recommended dates to allow for weather delays",
            "Monitor soiling ratio after each cleaning to validate effectiveness",
            "Consider rain forecasts when finalizing exact cleaning dates",
            "Track actual energy recovery to refine future optimization",
        ]

        for g in guidance:
            elements.append(Paragraph(f"• {g}", self.styles['BodyText']))

        return elements

    def _create_methodology_section(self) -> list:
        """Create methodology appendix."""
        elements = []

        elements.append(Paragraph("Appendix: Methodology", self.styles['SectionHeader']))

        methodology_text = """
        <b>Soiling Ratio Calculation</b><br/>
        The soiling ratio (SR) is calculated as the ratio of actual plane-of-array (POA) irradiance
        to clearsky POA irradiance, accounting for atmospheric conditions and sensor calibration.
        <br/><br/>
        <b>365-Day Forecasting</b><br/>
        The forecast uses a physics-informed approach combining:
        <br/>• Base soiling rate degradation (site-specific)
        <br/>• Seasonal modulation (1.5x dry season, 0.5x wet season)
        <br/>• Rain cleaning effects (>10mm restores up to 95%)
        <br/>• Historical pattern analysis
        <br/><br/>
        <b>Optimization Algorithm</b><br/>
        The optimal cleaning schedule is determined through exhaustive search of all valid
        cleaning date combinations, evaluating each scenario for net financial benefit.
        Summer months are weighted 1.5x due to higher energy production potential.
        <br/><br/>
        <b>Financial Calculations</b><br/>
        • Energy Production: Capacity (MW) × Sun Hours × Soiling Ratio<br/>
        • Revenue: Energy (MWh) × PPA Rate (€/MWh)<br/>
        • Net Benefit: Revenue Recovered - Cleaning Cost<br/>
        • ROI: Net Benefit / Cleaning Cost × 100%
        """

        elements.append(Paragraph(methodology_text, self.styles['BodyText']))

        return elements


def generate_pdf_report(forecast_results: Dict,
                       output_path: str = 'outputs_alpha1_365d/soiling_report.pdf') -> Optional[str]:
    """
    Generate PDF report from forecast results.

    Parameters:
    -----------
    forecast_results : dict
        Results from run_alpha1_365d_forecast.py
    output_path : str
        Path to save PDF

    Returns:
    --------
    str or None : Path to generated PDF, or None if generation failed
    """
    if not REPORTLAB_AVAILABLE:
        print("⚠️ Cannot generate PDF - reportlab not installed")
        return None

    site_name = forecast_results.get('site_name', 'Alpha1 9MW')
    pdf_gen = SoilingReportPDF(site_name=site_name)

    return pdf_gen.generate_report(
        proposal=forecast_results['proposal'],
        optimization_results=forecast_results['optimization'],
        monthly_summary=forecast_results['monthly'],
        output_path=output_path
    )
