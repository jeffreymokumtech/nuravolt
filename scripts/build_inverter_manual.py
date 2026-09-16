#!/usr/bin/env python3
"""Build structured inverter manual JSON from parsed Huawei PDF text.

Inputs:
  - backenddata/manuals/SUN2000-60KTL-M0-user-manual.pdf

Output:
  - public/data/manuals/SUN2000-60KTL-M0.json

The output contains:
  - specs: electrical + mechanical + environmental
  - fault_codes: list of {code, name, severity, cause, action}
  - derating: temperature-based power reduction info
  - source: traceability
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pypdf

ROOT = Path(__file__).resolve().parents[1]
PDF_PATH = ROOT / "backenddata" / "manuals" / "SUN2000-60KTL-M0-user-manual.pdf"
OUT_PATH = ROOT / "public" / "data" / "manuals" / "SUN2000-60KTL-M0.json"


def extract_pdf_text(pdf_path: Path) -> str:
    reader = pypdf.PdfReader(str(pdf_path))
    return "\n".join(p.extract_text() or "" for p in reader.pages)


def parse_alarms(all_text: str) -> list[dict]:
    """Extract alarm entries (codes 2001-2066) from troubleshooting section."""
    # TOC lists "Troubleshooting" near top; actual section body appears later.
    # Find the "Table 8-2 Common alarms" marker which only appears in the body.
    start = all_text.find("Table 8-2 Common alarms")
    end = all_text.rfind("10 Technical Specifications")
    if start < 0:
        start = 0
    if end < 0 or end <= start:
        end = len(all_text)
    block = all_text[start:end]

    entries = re.split(r"\n(\d{4})\s+", block)
    alarms: list[dict] = []
    for i in range(1, len(entries), 2):
        code = entries[i]
        body = entries[i + 1] if i + 1 < len(entries) else ""
        sev_match = re.search(r"\b(Major|Minor|Warning|Critical)\b", body)
        severity = sev_match.group(1).lower() if sev_match else "unknown"
        if sev_match:
            name = body[: sev_match.start()].strip()
            rest = body[sev_match.end():].strip()
        else:
            parts = body.split("\n", 3)
            name = parts[0] if parts else ""
            rest = "\n".join(parts[1:]) if len(parts) > 1 else ""
        name = re.sub(r"\s+", " ", name)[:80].strip()
        rest_clean = re.sub(r"\s+", " ", rest).strip()
        # Split on "Measures" header
        if "Measures" in rest_clean:
            cause, measures = rest_clean.split("Measures", 1)
        else:
            cause = rest_clean
            measures = ""
        # Filter: only keep alarms in the 2xxx range with a real severity
        if not code.startswith("2") or severity == "unknown":
            continue
        # Clean up broken word-splits from PDF extraction ("Connect ion" → "Connection")
        name = re.sub(r"(\w) (\w{1,3})\b", lambda m: m.group(1) + m.group(2) if len(m.group(2)) <= 3 else m.group(0), name)
        alarms.append({
            "code": code,
            "name": name,
            "severity": severity,
            "cause": cause.strip()[:400],
            "action": measures.strip()[:400],
        })
    return alarms


def build_manual() -> dict:
    text = extract_pdf_text(PDF_PATH)
    alarms = parse_alarms(text)

    return {
        "model": "SUN2000-60KTL-M0",
        "manufacturer": "Huawei",
        "family": "SUN2000 M0 commercial series (50/60/65 KTL)",
        "source": "https://solar.huawei.com/-/media/Solar/attachment/pdf/au/service/commercial/SUN200050KTL%2060KTL%2065KTLM0%20User%20Manual%2025%2008%2021.pdf",
        "source_date": "2021-06-08",
        "specs": {
            # Electrical — from manual page 101-102
            "nominal_power_ac_kw": 60,
            "max_apparent_power_kva": 66,
            "max_active_power_kw": 66,
            "max_dc_input_power_w": 67400,
            "max_dc_input_voltage_v": 1100,
            "operating_voltage_range_v": [200, 1000],
            "startup_voltage_v": 200,
            "full_power_mppt_voltage_range_v": [520, 800],  # at 380/400V AC
            "rated_input_voltage_v": 600,
            "max_input_current_per_mppt_a": 22,
            "max_short_circuit_current_per_mppt_a": 30,
            "mppt_count": 6,
            "inputs_count": 12,  # 2 strings per MPPT × 6 MPPTs
            "strings_per_mppt": 2,
            "max_efficiency_pct": 98.70,
            "euro_efficiency_pct": 98.50,
        },
        "environmental": {
            "operating_temp_c": [-25, 60],
            "derating_start_temp_c": 45,  # typical for this family
            "ingress_protection": "IP66",
            "relative_humidity_pct": [0, 100],
            "max_altitude_m": 4000,
        },
        "fault_codes": alarms,
        "severity_definitions": {
            "major": "Inverter is faulty. Output power decreases or grid-tied power generation stops.",
            "minor": "Some components are faulty without affecting grid-tied power generation.",
            "warning": "Inverter works properly. Output power decreases or some authorization functions fail due to external factors.",
        },
        "common_patterns": [
            {
                "pattern": "Low string current vs neighbors",
                "likely_causes": ["Soiling", "Shading", "Module degradation", "String mismatch"],
                "related_alarms": ["2011", "2012", "2061", "2062"],
            },
            {
                "pattern": "High inverter temperature",
                "likely_causes": ["Blocked vents", "Ambient heat", "Fan failure", "Internal component fault"],
                "related_alarms": ["2033", "2034", "2035"],
            },
            {
                "pattern": "DC voltage outside MPPT range",
                "likely_causes": ["Incorrect string sizing", "Cold climate (too high voc)", "String damage (too low)"],
                "related_alarms": ["2001"],
            },
            {
                "pattern": "Power production below prediction",
                "likely_causes": ["Soiling", "Thermal derating", "String/module issues", "Inverter derating"],
                "related_alarms": ["2011", "2012", "2033", "2061"],
            },
        ],
    }


def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    manual = build_manual()
    OUT_PATH.write_text(json.dumps(manual, indent=2, ensure_ascii=False))
    print(f"Wrote {OUT_PATH}")
    print(f"  {len(manual['fault_codes'])} fault codes")
    print(f"  {len(manual['common_patterns'])} diagnostic patterns")


if __name__ == "__main__":
    main()
