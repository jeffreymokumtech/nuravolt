"""
Claim-grade BESS report PDFs.

Two templates rendered from analysis bundles (reportlab, structure and
branding cloned from nuravolt/soiling/pdf_generator.py):

- Optimizer Performance Audit  (nuravolt.bess.optimizer_audit result dict)
- Warranty & Degradation Dossier (nuravolt.bess.dossier bundle dict)

Charts are matplotlib figures embedded as PNGs. Passing ``specimen=True``
stamps every page with a diagonal SPECIMEN watermark so synthetic-data
examples can circulate in outreach without being mistaken for client work.

Copy style: plain text, no em or en dashes, no emoji (sales asset rules).
"""

from __future__ import annotations

import io
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm, inch
from reportlab.lib.enums import TA_CENTER
from reportlab.platypus import (
    Image as RLImage,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

BRAND = {
    "primary": colors.HexColor("#2E86AB"),
    "secondary": colors.HexColor("#A23B72"),
    "success": colors.HexColor("#28A745"),
    "warning": colors.HexColor("#FFC107"),
    "danger": colors.HexColor("#C0392B"),
    "dark": colors.HexColor("#343A40"),
    "light": colors.HexColor("#F8F9FA"),
}

MPL_PRIMARY = "#2E86AB"
MPL_SECONDARY = "#A23B72"
MPL_SUCCESS = "#28A745"
MPL_DANGER = "#C0392B"
MPL_GRAY = "#8A9199"


#: Used only when a bundle carries no settlement currency of its own. The money
#: keys in the audit dict still spell _eur for legacy reasons, so the currency
#: has to be read from the bundle rather than inferred from the key names.
DEFAULT_CURRENCY = "EUR"


def _money(value: Optional[float], currency: str = DEFAULT_CURRENCY) -> str:
    if value is None:
        return "n/a"
    return f"{currency} {value:,.0f}"


def _pct(value: Optional[float], digits: int = 1) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.{digits}f}%"


def _fig_to_image(fig, width_cm: float = 16.5) -> RLImage:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    img = RLImage(buf)
    scale = (width_cm * cm) / img.imageWidth
    img.drawWidth = width_cm * cm
    img.drawHeight = img.imageHeight * scale
    return img


class _BessReportBase:
    """Shared styles, tables and page furniture for both report types."""

    def __init__(self, specimen: bool = False, specimen_note: Optional[str] = None,
                 currency: str = DEFAULT_CURRENCY):
        self.specimen = specimen
        #: Settlement currency every amount in this report is denominated in.
        #: Overridden per bundle in generate(); never assumed from key names.
        self.currency = currency or DEFAULT_CURRENCY
        self.specimen_note = specimen_note or (
            "SPECIMEN REPORT: generated from synthetic asset data on real market prices, "
            "for illustration of scope and format only."
        )
        self.styles = getSampleStyleSheet()
        self._setup_styles()

    def _setup_styles(self):
        def add(name, **kwargs):
            if name not in self.styles.byName:
                self.styles.add(ParagraphStyle(name, **kwargs))

        add("CustomTitle", parent=self.styles["Title"], fontSize=26,
            textColor=BRAND["primary"], spaceAfter=26)
        add("SectionHeader", parent=self.styles["Heading1"], fontSize=15,
            textColor=BRAND["primary"], spaceBefore=18, spaceAfter=8)
        add("SubHeader", parent=self.styles["Heading2"], fontSize=12,
            textColor=BRAND["dark"], spaceBefore=10, spaceAfter=5)
        add("Body", parent=self.styles["Normal"], fontSize=10, leading=14, spaceAfter=8)
        add("Small", parent=self.styles["Normal"], fontSize=8, leading=11,
            textColor=colors.HexColor("#555555"))
        add("FooterText", parent=self.styles["Normal"], fontSize=8, textColor=colors.gray)
        add("CoverSubtitle", parent=self.styles["Normal"], fontSize=14,
            textColor=BRAND["dark"], alignment=TA_CENTER, spaceAfter=36)
        add("CoverAsset", parent=self.styles["Normal"], fontSize=20,
            textColor=BRAND["secondary"], alignment=TA_CENTER, spaceAfter=18)

    def _cur(self, value: Optional[float]) -> str:
        """Format an amount in this report's settlement currency."""
        return _money(value, self.currency)

    def _page_furniture(self, canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(colors.gray)
        canvas.drawString(1.5 * cm, 1.1 * cm, "NuraVolt Audit | www.nuravolt.com")
        canvas.drawRightString(A4[0] - 1.5 * cm, 1.1 * cm, f"Page {doc.page}")
        if self.specimen:
            canvas.setFont("Helvetica-Bold", 64)
            canvas.setFillColor(colors.Color(0.85, 0.35, 0.35, alpha=0.16))
            canvas.translate(A4[0] / 2, A4[1] / 2)
            canvas.rotate(38)
            canvas.drawCentredString(0, 0, "SPECIMEN")
            canvas.setFont("Helvetica", 12)
            canvas.drawCentredString(0, -1.0 * cm, "synthetic data, for illustration only")
        canvas.restoreState()

    def _key_table(self, rows) -> Table:
        table = Table(rows, colWidths=[3.1 * inch, 2.4 * inch])
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), BRAND["light"]),
            ("TEXTCOLOR", (0, 0), (0, -1), BRAND["dark"]),
            ("TEXTCOLOR", (1, 0), (1, -1), BRAND["primary"]),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("FONTNAME", (1, 0), (1, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 11),
            ("PADDING", (0, 0), (-1, -1), 10),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.white),
        ]))
        return table

    def _data_table(self, rows, col_widths, align_right_from: int = 1,
                    header_color=None) -> Table:
        table = Table(rows, colWidths=col_widths, repeatRows=1)
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), header_color or BRAND["primary"]),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("ALIGN", (align_right_from, 1), (-1, -1), "RIGHT"),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
            ("PADDING", (0, 0), (-1, -1), 6),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.gray),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, BRAND["light"]]),
        ]))
        return table

    def _cover(self, title: str, asset_name: str, subtitle: str, key_rows) -> list:
        elements = [Spacer(1, 1.6 * inch)]
        elements.append(Paragraph(title, self.styles["CustomTitle"]))
        elements.append(Paragraph(f"<b>{asset_name}</b>", self.styles["CoverAsset"]))
        elements.append(Paragraph(subtitle, self.styles["CoverSubtitle"]))
        elements.append(self._key_table(key_rows))
        elements.append(Spacer(1, 1.4 * inch))
        elements.append(Paragraph(
            f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}", self.styles["FooterText"]))
        if self.specimen:
            elements.append(Paragraph(self.specimen_note, self.styles["FooterText"]))
        return elements

    def _build(self, story, output_path: str) -> str:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        doc = SimpleDocTemplate(
            str(output_path), pagesize=A4,
            rightMargin=1.5 * cm, leftMargin=1.5 * cm,
            topMargin=2 * cm, bottomMargin=2 * cm,
        )
        doc.build(story, onFirstPage=self._page_furniture, onLaterPages=self._page_furniture)
        return str(output_path)


class OptimizerAuditReport(_BessReportBase):
    """Render nuravolt.bess.optimizer_audit.OptimizerAuditResult.to_dict()."""

    def generate(self, audit: dict, output_path: str) -> str:
        summary = audit["summary"]
        # The bundle is the authority on the settlement currency: a GB audit
        # clears in GBP and its amounts must never be printed under EUR.
        self.currency = str(summary.get("currency") or DEFAULT_CURRENCY)
        daily = [d for d in audit["daily"] if d["status"] in ("ok", "ok_relaxed")]
        story = []

        period = f"{daily[0]['day']} to {daily[-1]['day']}" if daily else "n/a"
        capture = summary.get("capture_ratio")
        story.extend(self._cover(
            "BESS Optimizer Performance Audit",
            summary.get("asset_name", "BESS"),
            "Realized dispatch revenue vs the perfect-foresight day-ahead benchmark",
            [
                ["Audit period", period],
                ["Days analyzed", str(summary.get("days_analyzed", 0))],
                ["Realized net revenue", self._cur(summary.get("realized_net_eur"))],
                ["Benchmark net revenue", self._cur(summary.get("optimal_net_eur"))],
                ["Capture ratio", _pct(capture)],
                ["Annualized revenue gap", self._cur(summary.get("annualized_gap_eur"))],
            ],
        ))
        story.append(PageBreak())

        # 1. Executive summary
        story.append(Paragraph("1. Executive Summary", self.styles["SectionHeader"]))
        gap = summary.get("revenue_gap_eur", 0.0)
        capture_txt = _pct(capture) if capture is not None else "n/a"
        story.append(Paragraph(
            f"Over {summary.get('days_analyzed', 0)} delivery days the battery realized "
            f"{self._cur(summary.get('realized_net_eur'))} net of degradation cost, against a "
            f"degradation-aware perfect-foresight benchmark of "
            f"{self._cur(summary.get('optimal_net_eur'))} "
            f"computed from published day-ahead prices ({summary.get('zone', 'n/a')}, source: "
            f"{summary.get('price_source', 'n/a')}). The capture ratio is <b>{capture_txt}</b>, "
            f"leaving {self._cur(gap)} on the table in the audit window, "
            f"{self._cur(summary.get('annualized_gap_eur'))} annualized. All amounts in this "
            f"report are stated in {self.currency}.", self.styles["Body"]))
        story.append(Paragraph(
            "Perfect foresight is a theoretical ceiling, not an attainable target: it assumes exact "
            "knowledge of every price before it clears. Well-run commercial optimizers typically "
            "capture 70 to 90 percent of this ceiling on day-ahead arbitrage. Capture ratios below "
            "that band indicate systematic issues (mistimed cycles, idle capacity in high-spread "
            "hours, excessive conservatism); ratios inside it indicate healthy operation.",
            self.styles["Body"]))

        # 2. Methodology
        story.append(Paragraph("2. Methodology", self.styles["SectionHeader"]))
        story.append(Paragraph(
            "For each delivery day, a linear program computes the revenue-maximal dispatch "
            "schedule under the battery's physical parameters (capacity "
            f"{summary.get('capacity_kwh', 0):,.0f} kWh, power {summary.get('max_power_kw', 0):,.0f} kW, "
            f"round-trip efficiency {_pct(summary.get('round_trip_efficiency'), 0)}), charged with the "
            f"same degradation cost per kWh throughput "
            f"({summary.get('degradation_cost_per_kwh', 0)} {self.currency}/kWh) "
            "as the realized accounting. The benchmark is anchored to the same start-of-day state of "
            "charge and must end the day with the energy the realized dispatch left in the battery, "
            "so both schedules work with an identical daily energy budget. Realized dispatch is by "
            "construction a feasible solution of this program, which guarantees the benchmark is a "
            "true upper bound.", self.styles["Body"]))
        if summary.get("power_sign_flipped"):
            story.append(Paragraph(
                "Note: the telemetry power sign convention was detected as charge-positive and "
                "flipped to discharge-positive for the analysis.", self.styles["Small"]))

        # 3. Daily results
        story.append(Paragraph("3. Daily Results", self.styles["SectionHeader"]))
        if daily:
            story.append(_fig_to_image(self._daily_chart(daily)))
            story.append(Spacer(1, 0.15 * inch))
            rows = [["Day", "Realized", "Benchmark", "Capture", "EFC real", "EFC bench"]]
            step = max(1, len(daily) // 28)
            for d in daily[::step]:
                capture_cell = "n/a"
                if d.get("capture_ratio") is not None:
                    capture_cell = "loss" if d["capture_ratio"] < 0 else _pct(d["capture_ratio"])
                rows.append([
                    d["day"], self._cur(d["realized_net_eur"]), self._cur(d["optimal_net_eur"]),
                    capture_cell,
                    f"{d['realized_efc']:.2f}", f"{d['optimal_efc']:.2f}",
                ])
            story.append(self._data_table(
                rows, [1.1 * inch, 1.0 * inch, 1.0 * inch, 0.9 * inch, 0.9 * inch, 0.9 * inch]))
            if step > 1:
                story.append(Paragraph(
                    f"Table sampled at one row per {step} days; the chart covers all days. "
                    "Capture is not stated for days where the benchmark itself is immaterial.",
                    self.styles["Small"]))

        # 4. Dispatch detail for the worst day
        sample = (audit.get("sample_days") or {}).get("largest_gap")
        if sample:
            story.append(Paragraph("4. Where Revenue Was Lost: Largest-Gap Day", self.styles["SectionHeader"]))
            story.append(Paragraph(
                f"On {sample['day']} the gap between realized and optimal dispatch was "
                f"{self._cur(sample.get('gap_eur'))}. The chart overlays the day-ahead price curve with "
                "the realized and benchmark power schedules (positive = discharge).",
                self.styles["Body"]))
            story.append(_fig_to_image(self._sample_day_chart(sample)))

        # 5. Cycling comparison
        story.append(Paragraph("5. Cycling and Degradation", self.styles["SectionHeader"]))
        story.append(Paragraph(
            f"The realized schedule used {summary.get('realized_efc_total', 0)} equivalent full cycles "
            f"in the window against {summary.get('optimal_efc_total', 0)} for the benchmark. Both "
            "revenue figures are net of the same per-kWh degradation charge, so extra benchmark "
            "cycling is already paid for in its number: the gap is not explained by the benchmark "
            "simply cycling harder for free.", self.styles["Body"]))

        # 6. Data quality
        story.append(Paragraph("6. Data Quality", self.styles["SectionHeader"]))
        skipped = summary.get("days_skipped", 0)
        mismatch = summary.get("soc_ledger_mismatch_mean_abs_kwh")
        dq_lines = [f"Days excluded for insufficient telemetry or price coverage: {skipped}."]
        if mismatch is not None:
            dq_lines.append(
                f"Mean absolute daily gap between measured state of charge and the power-ledger "
                f"implied state: {mismatch} kWh. Persistent large values indicate BMS SoC "
                f"calibration drift or unmetered auxiliary consumption; the benchmark uses the "
                f"power ledger and is unaffected."
            )
        for line in dq_lines:
            story.append(Paragraph(line, self.styles["Body"]))

        story.append(Paragraph(
            "This audit benchmarks day-ahead arbitrage only. Revenues from ancillary services, "
            "capacity markets or intraday and imbalance trading are outside its scope and should "
            "be assessed separately.", self.styles["Small"]))

        return self._build(story, output_path)

    def _daily_chart(self, daily):
        days = [d["day"][5:] for d in daily]
        realized = [d["realized_net_eur"] for d in daily]
        optimal = [d["optimal_net_eur"] for d in daily]
        fig, ax = plt.subplots(figsize=(10, 3.6))
        x = np.arange(len(days))
        ax.bar(x - 0.2, realized, width=0.4, label="Realized net", color=MPL_PRIMARY)
        ax.bar(x + 0.2, optimal, width=0.4, label="Benchmark net", color=MPL_GRAY)
        ax.set_ylabel(f"{self.currency}/day")
        ax.set_title("Realized vs perfect-foresight net revenue per delivery day")
        tick_step = max(1, len(days) // 14)
        ax.set_xticks(x[::tick_step])
        ax.set_xticklabels(days[::tick_step], rotation=45, ha="right", fontsize=8)
        ax.legend(loc="upper left", fontsize=8)
        ax.grid(axis="y", alpha=0.3)
        return fig

    def _sample_day_chart(self, sample):
        # Key name is legacy; the values are in the audit's settlement currency.
        prices = sample["price_eur_mwh"]
        realized = sample["realized_net_kw"]
        optimal = sample["optimal_net_kw"]
        n = len(prices)
        x = np.arange(n)
        fig, ax = plt.subplots(figsize=(10, 3.8))
        ax2 = ax.twinx()
        ax2.plot(x, prices, color=MPL_DANGER, lw=1.4, label="Day-ahead price")
        ax2.set_ylabel(f"{self.currency}/MWh", color=MPL_DANGER)
        ax.step(x, realized, where="post", color=MPL_PRIMARY, lw=1.2, label="Realized power")
        ax.step(x, optimal, where="post", color=MPL_SUCCESS, lw=1.2, alpha=0.85, label="Benchmark power")
        ax.axhline(0, color="black", lw=0.6)
        ax.set_ylabel("kW (positive = discharge)")
        ax.set_xlabel(f"Timestep within {sample['day']}")
        lines1, labels1 = ax.get_legend_handles_labels()
        lines2, labels2 = ax2.get_legend_handles_labels()
        ax.legend(lines1 + lines2, labels1 + labels2, loc="upper left", fontsize=8)
        ax.set_title("Dispatch vs price, largest-gap day")
        ax.grid(alpha=0.3)
        return fig


class WarrantyDossierReport(_BessReportBase):
    """Render nuravolt.bess.dossier.build_warranty_dossier() bundles."""

    def generate(self, bundle: dict, output_path: str) -> str:
        asset = bundle["asset"]
        terms = bundle["warranty_terms"]
        health = bundle["health_score"]
        cycling = bundle["cycling"]
        # Same rule as the optimizer report: the bundle is the authority on the
        # settlement currency, so a GB dossier never prints under EUR.
        self.currency = str(bundle.get("currency") or DEFAULT_CURRENCY)
        violations = bundle.get("violations", [])
        critical = [v for v in violations if v.get("severity") == "critical"]
        story = []

        story.extend(self._cover(
            "BESS Warranty and Degradation Dossier",
            asset.get("name") or asset.get("asset_id", "BESS"),
            "State-of-health forensics, cycle reconstruction and warranty compliance evidence",
            [
                ["Chemistry / capacity", f"{(asset.get('chemistry') or 'n/a').upper()} / {asset.get('nominal_capacity_kwh', 0):,.0f} kWh"],
                ["Current SoH", _pct(health.get("current_soh"))],
                ["Warranty threshold", _pct(terms.get("capacity_guarantee_pct"))],
                ["Equivalent full cycles used", f"{cycling.get('total_equivalent_cycles', 0):,.0f} of {terms.get('max_cycles', 0):,}"],
                ["Violations detected", f"{len(violations)} ({len(critical)} critical)"],
                ["Warranty health score", f"{health.get('score', 0)}/100 ({health.get('risk_level', 'n/a')})"],
            ],
        ))
        story.append(PageBreak())

        # 1. Executive summary
        story.append(Paragraph("1. Executive Summary", self.styles["SectionHeader"]))
        story.append(Paragraph(
            f"This dossier reconstructs the operating history of {asset.get('name') or asset.get('asset_id')} "
            f"from raw telemetry and assesses it against the warranty terms in section 2. Current state "
            f"of health is {_pct(health.get('current_soh'))} against a guarantee of "
            f"{_pct(terms.get('capacity_guarantee_pct'))}, a margin of {_pct(health.get('soh_margin'))}. "
            f"Cycle reconstruction (ASTM E1049 rainflow) counts "
            f"{cycling.get('total_equivalent_cycles', 0):,.0f} equivalent full cycles and "
            f"{cycling.get('total_throughput_mwh', 0):,.0f} MWh of throughput. "
            f"{len(violations)} warranty-relevant operating events were detected, of which "
            f"{len(critical)} are critical.", self.styles["Body"]))
        recommendation = health.get("recommendation", "")
        if critical:
            recommendation = (
                f"{recommendation} Note that this assessment reflects the SoH and cycle budget "
                f"only: the {len(critical)} critical operating events in section 5 are separate "
                "warranty exposure and should be addressed with the O&M and HVAC providers."
            )
        story.append(Paragraph(recommendation, self.styles["Body"]))

        # 2. Warranty terms
        story.append(Paragraph("2. Warranty Terms Applied", self.styles["SectionHeader"]))
        rows = [["Term", "Value"]]
        rows.append(["Capacity guarantee", _pct(terms.get("capacity_guarantee_pct"))])
        rows.append(["Warranty period", f"{terms.get('warranty_years')} years"])
        rows.append(["Cycle limit", f"{terms.get('max_cycles'):,}"])
        if terms.get("max_throughput_mwh"):
            rows.append(["Throughput limit", f"{terms['max_throughput_mwh']:,.0f} MWh"])
        rows.append(["Minimum round-trip efficiency", _pct(terms.get("min_rte"))])
        rows.append(["Maximum operating temperature", f"{terms.get('operating_temp_max_c')} C"])
        story.append(self._data_table(rows, [3.2 * inch, 2.2 * inch]))

        extraction = bundle.get("contract_extraction")
        if extraction:
            story.append(Paragraph("Contract extraction provenance", self.styles["SubHeader"]))
            story.append(Paragraph(
                f"Terms were extracted from {Path(extraction.get('source_file', '')).name} "
                f"(sha256 {str(extraction.get('source_sha256'))[:16]}...) using a closed-schema "
                f"language-model extraction; values with confidence at or above "
                f"{extraction.get('apply_confidence_threshold')} were applied and each carries its "
                "source clause below.", self.styles["Small"]))
            ext_rows = [["Field", "Value", "Conf.", "Applied", "Source excerpt"]]
            for term in extraction.get("terms", []):
                ext_rows.append([
                    term.get("field", ""), str(term.get("value", "")),
                    f"{term.get('confidence', 0):.2f}",
                    "yes" if term.get("applied") else "no",
                    Paragraph((term.get("source_excerpt") or "")[:160], self.styles["Small"]),
                ])
            story.append(self._data_table(
                ext_rows, [1.6 * inch, 0.7 * inch, 0.5 * inch, 0.6 * inch, 3.0 * inch]))

        # 3. State of health
        story.append(Paragraph("3. State of Health", self.styles["SectionHeader"]))
        trajectory = bundle.get("soh_trajectory") or {}
        if trajectory.get("points"):
            story.append(_fig_to_image(self._soh_chart(trajectory)))
            assumptions = trajectory.get("assumptions", {})
            crossing = trajectory.get("projected_threshold_crossing")
            story.append(Paragraph(
                f"Modelled fade assumes {assumptions.get('cycles_per_year', 'n/a')} cycles per year at "
                f"an average {assumptions.get('avg_dod', 'n/a')} depth of discharge and "
                f"{assumptions.get('avg_temp_c', 'n/a')} C, calibrated from the telemetry itself. "
                + (f"The warranty threshold is projected to be reached around {crossing}. "
                   if crossing else "The warranty threshold is not reached inside the warranty period "
                   "under these assumptions. ")
                + "Measured capacity tests, where available, override the model.",
                self.styles["Body"]))
        tests = trajectory.get("capacity_tests") or []
        if tests:
            rows = [["Test date", "Measured capacity (kWh)", "SoH", "Type"]]
            for t in tests:
                rows.append([str(t.get("date", ""))[:10],
                             f"{t.get('measured_capacity_kwh', 0):,.0f}",
                             _pct(t.get("soh")), t.get("test_type", "")])
            story.append(self._data_table(rows, [1.3 * inch, 1.8 * inch, 1.0 * inch, 1.4 * inch]))

        # 4. Cycling history
        story.append(Paragraph("4. Cycling History", self.styles["SectionHeader"]))
        story.append(Paragraph(
            f"Total reconstructed cycling: {cycling.get('total_equivalent_cycles', 0):,.0f} equivalent "
            f"full cycles, {cycling.get('total_throughput_mwh', 0):,.0f} MWh throughput, average "
            f"round-trip efficiency {_pct(cycling.get('avg_round_trip_efficiency'))}. The histogram "
            "shows how deep the battery is habitually cycled; shallow cycling ages cells far less "
            "than the same throughput at full depth, which is why the equivalent-cycle count, not "
            "raw cycle count, is the contractually relevant number.", self.styles["Body"]))
        hist = cycling.get("rainflow_histogram") or []
        if hist:
            story.append(_fig_to_image(self._rainflow_chart(hist), width_cm=13.0))

        # 5. Violation register
        story.append(Paragraph("5. Warranty-Relevant Operating Events", self.styles["SectionHeader"]))
        if violations:
            rows = [["Type", "Severity", "Start", "Duration", "Measured", "Threshold"]]
            def fmt_value(value, unit):
                # SoC checks emit fractions labelled '%'; render them as percent.
                if unit == "%" and value is not None and abs(value) <= 1.5:
                    return f"{value * 100:.0f} %"
                return f"{value:.2f} {unit}" if value is not None else "n/a"

            for v in violations[:40]:
                dur = v.get("duration_minutes")
                rows.append([
                    Paragraph(str(v.get("type", "")).replace("_", " ").title(), self.styles["Small"]),
                    v.get("severity", ""),
                    str(v.get("started_at", ""))[:16].replace("T", " "),
                    f"{dur:.0f} min" if dur is not None else "n/a",
                    fmt_value(v.get("measured_value"), v.get("unit", "")),
                    fmt_value(v.get("threshold_value"), v.get("unit", "")),
                ])
            story.append(self._data_table(
                rows, [1.5 * inch, 0.7 * inch, 1.2 * inch, 0.8 * inch, 1.1 * inch, 1.1 * inch]))
            if len(violations) > 40:
                story.append(Paragraph(
                    f"Showing the first 40 of {len(violations)} events; the full register is in the "
                    "accompanying JSON bundle.", self.styles["Small"]))
        else:
            story.append(Paragraph(
                "No warranty-relevant operating events were detected in the analyzed window.",
                self.styles["Body"]))

        # 6. Evidence and lineage
        story.append(PageBreak())
        story.append(Paragraph("6. Evidence and Data Lineage", self.styles["SectionHeader"]))
        evidence = bundle.get("evidence", {})
        profile = evidence.get("telemetry_profile", {})
        rows = [["Property", "Value"]]
        rows.append(["Telemetry rows", f"{profile.get('rows', 0):,}"])
        rows.append(["Window", f"{str(profile.get('start', ''))[:10]} to {str(profile.get('end', ''))[:10]}"])
        rows.append(["Sampling interval", f"{profile.get('median_interval_seconds', 0)} s"])
        rows.append(["Coverage", _pct(profile.get("coverage"))])
        rows.append(["Gaps (over 3x interval)", str(profile.get("gap_count", 0))])
        story.append(self._data_table(rows, [3.0 * inch, 2.4 * inch]))

        files = evidence.get("source_files") or []
        if files:
            story.append(Paragraph("Source files", self.styles["SubHeader"]))
            rows = [["File", "SHA-256"]]
            for f in files:
                rows.append([f.get("file", ""), Paragraph(str(f.get("sha256", "")), self.styles["Small"])])
            story.append(self._data_table(rows, [2.0 * inch, 4.2 * inch]))

        story.append(Paragraph("Methodology", self.styles["SubHeader"]))
        story.append(Paragraph(evidence.get("methodology", ""), self.styles["Small"]))
        story.append(Paragraph(
            "This dossier presents technical evidence derived from the listed source data. It is "
            "prepared to support warranty discussions and claims and does not by itself constitute "
            "legal advice.", self.styles["Small"]))

        return self._build(story, output_path)

    def _soh_chart(self, trajectory):
        points = trajectory["points"]
        dates = [p["date"] for p in points]
        soh = [p["soh"] for p in points]
        x = np.arange(len(dates))
        fig, ax = plt.subplots(figsize=(10, 3.6))
        ax.plot(x, soh, color=MPL_PRIMARY, lw=1.8, label="Modelled SoH")
        threshold = trajectory.get("warranty_threshold")
        if threshold:
            ax.axhline(threshold, color=MPL_DANGER, lw=1.2, ls="--",
                       label=f"Warranty threshold ({threshold:.0%})")
        tests = trajectory.get("capacity_tests") or []
        test_x, test_y = [], []
        for t in tests:
            if t.get("soh") is None or not t.get("date"):
                continue
            d = str(t["date"])[:10]
            nearest = min(range(len(dates)), key=lambda i: abs(
                (np.datetime64(dates[i]) - np.datetime64(d)).astype(int)))
            test_x.append(nearest)
            test_y.append(t["soh"])
        if test_x:
            ax.scatter(test_x, test_y, color=MPL_SECONDARY, zorder=5, s=40,
                       label="Capacity tests")
        tick_step = max(1, len(dates) // 10)
        ax.set_xticks(x[::tick_step])
        ax.set_xticklabels([d[:7] for d in dates[::tick_step]], rotation=45, ha="right", fontsize=8)
        ax.set_ylabel("State of health")
        ax.set_ylim(min(0.6, (threshold or 0.7) - 0.05), 1.02)
        ax.legend(fontsize=8)
        ax.grid(alpha=0.3)
        ax.set_title("State of health vs warranty guarantee")
        return fig

    def _rainflow_chart(self, hist):
        labels = [h["dod_bin"] for h in hist]
        counts = [h["cycles"] for h in hist]
        fig, ax = plt.subplots(figsize=(7.5, 3.2))
        ax.bar(labels, counts, color=MPL_PRIMARY)
        ax.set_ylabel("Cycle count")
        ax.set_xlabel("Depth of discharge")
        ax.set_title("Rainflow cycle distribution by depth")
        plt.setp(ax.get_xticklabels(), rotation=45, ha="right", fontsize=8)
        ax.grid(axis="y", alpha=0.3)
        return fig


def generate_optimizer_audit_pdf(audit: dict, output_path: str, specimen: bool = False) -> str:
    """Render an optimizer audit dict (OptimizerAuditResult.to_dict()) to PDF."""
    return OptimizerAuditReport(specimen=specimen).generate(audit, output_path)


def generate_warranty_dossier_pdf(bundle: dict, output_path: str, specimen: bool = False) -> str:
    """Render a warranty dossier bundle (build_warranty_dossier()) to PDF."""
    return WarrantyDossierReport(specimen=specimen).generate(bundle, output_path)
