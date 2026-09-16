#!/usr/bin/env python
"""
Generate the specimen Data Room Red-Flag Report (M&A / advisor sales asset).

Assembles real, anonymized data-quality findings from the ribera plant
(public/data quality outputs) into the report format a data-room
standardization engagement delivers, watermarked SPECIMEN.

Output: sales-assets/dataroom-specimen/dataroom_redflag_specimen.pdf
"""

import csv
import json
import sys
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from reportlab.lib.units import inch
from reportlab.platypus import PageBreak, Paragraph, Spacer

from nuravolt.bess.report_generator import _BessReportBase

QUALITY_CSV = PROJECT_ROOT / "public/data/digitaltwin/ribera/quality_report.csv"
IRR_JSON = PROJECT_ROOT / "public/data/soiling/ribera/quality/irradiance_comparison.json"
SPATIAL_JSON = PROJECT_ROOT / "public/data/soiling/ribera/quality/spatial_uniformity.json"
OUT_PDF = PROJECT_ROOT / "sales-assets/dataroom-specimen/dataroom_redflag_specimen.pdf"


def load_findings():
    rows = list(csv.DictReader(open(QUALITY_CSV)))
    ok = [r for r in rows if r["success"] == "True"]
    r2s = sorted(float(r["r2"]) for r in ok)
    median_r2 = r2s[len(r2s) // 2]
    low = sorted(
        [(r["inverter_id"], float(r["r2"])) for r in ok if float(r["r2"]) < 0.9],
        key=lambda x: x[1],
    )
    irr = json.load(open(IRR_JSON))["overallMetrics"]
    spatial = json.load(open(SPATIAL_JSON))["summary"]
    return {
        "n_inverters": len(rows),
        "n_fitted": len(ok),
        "median_r2": median_r2,
        "min_r2": r2s[0],
        "max_r2": r2s[-1],
        "low_fit": low,
        "irr_bias_pct": irr["biasPct"],
        "irr_corr": irr["correlation"],
        "spatial_uniformity_pct": spatial["uniformityRate"],
    }


def main() -> None:
    f = load_findings()
    base = _BessReportBase(specimen=True, specimen_note=(
        "SPECIMEN REPORT: real, anonymized findings from an operating Iberian plant, "
        "for illustration of scope and format only."
    ))
    styles = base.styles
    story = []

    story.extend(base._cover(
        "Data Room Red-Flag Report",
        "Project Region A (anonymized)",
        "Specimen deliverable: data room standardization for a solar transaction",
        [
            ["Plant under diligence", "9 MW single-axis, southeastern Spain"],
            ["Devices normalized", f"{f['n_inverters']} inverters, 2 met stations"],
            ["Twin fit coverage", f"{f['n_fitted']} of {f['n_inverters']} inverters"],
            ["Median model fit (r squared)", f"{f['median_r2']:.3f}"],
            ["Red flags raised", "3 (2 high, 1 medium)"],
            ["Turnaround", "9 working days from data access"],
        ],
    ))
    story.append(PageBreak())

    story.append(Paragraph("1. Scope and Inputs", styles["SectionHeader"]))
    story.append(Paragraph(
        "The seller's data room contained a vendor SCADA export (CSV, mixed naming "
        "conventions), two met station feeds, monthly production statements and the EPC "
        "as-built register list. All device time series were mapped to a standard schema "
        "by the NuraVolt ingestion engine and human-reviewed before sign off. The "
        "deliverable dataset covers 15-minute resolution for the full diligence window "
        "with per-column lineage back to the source files (SHA-256 hashed).",
        styles["Body"]))

    story.append(Paragraph("2. Normalization Summary", styles["SectionHeader"]))
    story.append(Paragraph(
        f"All {f['n_inverters']} inverters were identified and normalized. A physics "
        f"model (digital twin) was fitted per inverter to validate the data against "
        f"expected behavior: median fit r squared {f['median_r2']:.3f}, range "
        f"{f['min_r2']:.3f} to {f['max_r2']:.3f}. String level spatial uniformity checks "
        f"passed on {f['spatial_uniformity_pct']:.1f}% of measurements. Two devices fall "
        "materially below fleet fit and are flagged below.", styles["Body"]))

    story.append(Paragraph("3. Red-Flag Register", styles["SectionHeader"]))

    story.append(Paragraph("RF-1 (HIGH): Reference irradiance sensor overreads by 10.3%",
                           styles["SubHeader"]))
    story.append(Paragraph(
        f"The plant's reference pyranometer reads {f['irr_bias_pct']:.1f}% above an "
        f"independent satellite irradiance reference, with correlation of only "
        f"{f['irr_corr']:.2f} where 0.9 or better is expected for a healthy sensor. "
        "Every performance ratio and availability figure in the seller's monthly reports "
        "is computed against this sensor. An overreading reference deflates reported PR, "
        "but more importantly it means the historical performance record cannot be taken "
        "at face value in the valuation model. Recommendation: recompute the performance "
        "history against the satellite reference before finalizing the production "
        "assumptions, and price a sensor recalibration into the first operating year.",
        styles["Body"]))

    story.append(Paragraph("RF-2 (HIGH): SCADA logger clock offset of 105 minutes",
                           styles["SubHeader"]))
    story.append(Paragraph(
        "Cross-correlating fleet power output against satellite irradiance places the "
        "SCADA timestamps 105 minutes behind true local time (a fixed winter-time logger "
        "clock plus drift). Uncorrected, this misallocates energy across tariff periods "
        "and breaks any hourly PPA or curtailment reconciliation built on this export. "
        "The normalized dataset delivered with this report has the offset corrected; the "
        "seller's own hourly revenue allocations should be treated as unreliable.",
        styles["Body"]))

    low_list = ", ".join(f"{name} (r squared {r2:.2f})" for name, r2 in f["low_fit"])
    story.append(Paragraph("RF-3 (MEDIUM): Two inverters with unexplained behavior",
                           styles["SubHeader"]))
    story.append(Paragraph(
        f"Fleet median model fit is {f['median_r2']:.3f}, but {low_list} sit well below "
        "it. The physics model cannot explain their output from irradiance and "
        "temperature, which typically indicates intermittent tripping, string faults or "
        "meter wiring issues. Recommendation: targeted inspection of both units before "
        "closing, and a holdback if the inspection cannot be completed in time.",
        styles["Body"]))

    story.append(Paragraph("4. What the Full Engagement Delivers", styles["SectionHeader"]))
    story.append(Paragraph(
        "Alongside this report the deal team receives the normalized parquet and CSV "
        "dataset (one clean series per device), the column lineage record, the data "
        "integrity census (gaps, coverage, clock offsets, sensor drift) and the per "
        "inverter model fit table. The dataset is ready for any downstream yield or "
        "valuation model without further cleaning.", styles["Body"]))
    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph(
        "This specimen uses real, anonymized findings from an operating Iberian plant "
        "analyzed by the NuraVolt engine. Names, transaction context and commercial "
        "details are illustrative.", styles["Small"]))

    OUT_PDF.parent.mkdir(parents=True, exist_ok=True)
    base._build(story, str(OUT_PDF))
    print(f"wrote {OUT_PDF}")


if __name__ == "__main__":
    main()
