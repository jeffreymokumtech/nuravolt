"""LLM-driven BESS warranty PDF extractor.

Per Phase K Pillar 2 Option E: client uploads BESS contract or warranty
PDF, LLM extracts a structured set of thresholds (SoH cutoff, cycle cap,
temp dwell limit, C-rate ceiling, throughput cap, RTE minimum) that
feed the per-asset config of ``BessFaultDetector``.

This is the **extractor** — the PDF parsing front-end belongs in
TypeScript (Next.js API route uploading + storing the PDF). This module
takes the raw extracted text (any method — pdf-parse on TS side, or
copy-paste from the user) and asks Bedrock to structure it.

Cost: one Bedrock call per warranty PDF, ~€0.001. Negligible.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_MODEL_ID = os.environ.get(
    "BEDROCK_WARRANTY_MODEL_ID",
    os.environ.get("BEDROCK_FAULT_MODEL_ID", "qwen.qwen3-next-80b-a3b"),
)
DEFAULT_REGION = os.environ.get("AWS_REGION", "eu-west-1")


# Closed schema of warranty fields the extractor is allowed to output.
# Each entry: (field, type_str, default_or_None, physics_min, physics_max, "description")
WARRANTY_FIELDS = [
    ("soh_eol_threshold_pct", "float", 80.0, 50.0, 95.0,
     "End-of-life State-of-Health threshold (% of rated capacity)."),
    ("cycle_count_warranty", "int", 6000, 1000, 15000,
     "Maximum guaranteed cycle count under warranty."),
    ("max_temp_dwell_c", "float", 45.0, 25.0, 65.0,
     "Maximum allowed dwell temperature (°C) above which warranty is voided."),
    ("max_c_rate_charge", "float", 1.0, 0.1, 4.0,
     "Maximum charge C-rate allowed by warranty."),
    ("max_c_rate_discharge", "float", 1.0, 0.1, 4.0,
     "Maximum discharge C-rate allowed by warranty."),
    ("min_rte_pct", "float", 85.0, 60.0, 99.0,
     "Minimum round-trip efficiency guaranteed (%)."),
    ("max_throughput_mwh_per_year", "float", None, 0.0, 1e9,
     "Annual energy throughput cap (MWh). None = no cap stated."),
    ("warranty_years", "int", 10, 1, 30,
     "Total warranty period in years."),
    ("max_soc_high_dwell_hours_year", "float", None, 0.0, 8760.0,
     "Max hours per year cell may dwell at high SoC (>90% typically)."),
    ("max_soc_low_dwell_hours_year", "float", None, 0.0, 8760.0,
     "Max hours per year cell may dwell at low SoC (<10% typically)."),
]


@dataclass
class WarrantyTerm:
    field: str
    value: Any
    unit: str = ""
    confidence: float = 0.0
    source_excerpt: str = ""
    is_explicit: bool = True   # False if extractor inferred from a related clause


@dataclass
class WarrantyExtractResult:
    asset_id: str
    chemistry: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    terms: List[WarrantyTerm] = field(default_factory=list)
    terms_dict: Dict[str, Any] = field(default_factory=dict)
    rejected_count: int = 0
    invocations: int = 0
    raw_response: str = ""
    model_id: str = ""
    generated_at: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "asset_id": self.asset_id,
            "chemistry": self.chemistry,
            "manufacturer": self.manufacturer,
            "model": self.model,
            "terms": [asdict(t) for t in self.terms],
            "terms_dict": self.terms_dict,
            "rejected_count": self.rejected_count,
            "invocations": self.invocations,
            "model_id": self.model_id,
            "generated_at": self.generated_at,
        }


def _build_system_prompt() -> str:
    rows = []
    for fld, typ, default, lo, hi, desc in WARRANTY_FIELDS:
        default_str = "no default" if default is None else f"default {default}"
        rows.append(f'  - "{fld}" ({typ}, range [{lo}, {hi}], {default_str}): {desc}')

    return (
        "You are a BESS (battery energy storage) warranty specialist. You read "
        "manufacturer warranty contracts and extract structured threshold terms "
        "into a closed schema. Common manufacturers: Tesla Megapack, Fluence "
        "Cube, BYD Cube/Battery Box, CATL EnerC, LG Chem, Samsung SDI, Sungrow.\n\n"
        "You will receive raw warranty PDF text (sometimes messy OCR). Extract "
        "ONLY the terms listed below; omit any field you cannot find or infer "
        "with reasonable confidence (omitting = keep default).\n\n"
        "Closed schema (use these EXACT field names):\n" + "\n".join(rows) + "\n\n"
        "Output strict JSON (no markdown, no preamble):\n"
        '{\n'
        '  "chemistry": "<LFP|NMC|NCA|LTO|UNKNOWN>",\n'
        '  "manufacturer": "<name from contract or null>",\n'
        '  "model": "<product model or null>",\n'
        '  "terms": [\n'
        '    {\n'
        '      "field": "<one of the schema field names>",\n'
        '      "value": <number, type matching schema>,\n'
        '      "unit": "<°C|%|cycles|years|...>",\n'
        '      "confidence": <0.0-1.0>,\n'
        '      "source_excerpt": "<≤200 char snippet from PDF showing the clause>",\n'
        '      "is_explicit": <true|false — false if inferred from related text>\n'
        '    },\n'
        '    ...\n'
        '  ]\n'
        '}\n\n'
        "Rules:\n"
        "- Values MUST be inside their stated range. Out-of-range will be silently rejected.\n"
        "- source_excerpt MUST quote actual PDF text — do not invent.\n"
        "- If the PDF doesn't mention a field, omit it. Don't fill defaults.\n"
        "- For multi-year warranty (e.g. SoH 100% year 1, 80% year 10), pick the EOL value (80%)."
    )


def _build_user_prompt(pdf_text: str, asset_id: str, manufacturer_hint: Optional[str] = None) -> str:
    lines = [f"Asset ID: {asset_id}"]
    if manufacturer_hint:
        lines.append(f"Manufacturer hint: {manufacturer_hint}")
    lines.append("\nWarranty PDF text:")
    lines.append("=" * 60)
    # Truncate if very long — most warranties have the relevant section in the first 8K chars
    snippet = pdf_text[:8000]
    if len(pdf_text) > 8000:
        snippet += "\n\n[...truncated, " + str(len(pdf_text)) + " chars total]"
    lines.append(snippet)
    lines.append("=" * 60)
    lines.append("\nExtract the warranty terms.")
    return "\n".join(lines)


def extract_warranty_terms(
    pdf_text: str,
    asset_id: str,
    manufacturer_hint: Optional[str] = None,
    model_id: str = DEFAULT_MODEL_ID,
    region: str = DEFAULT_REGION,
) -> WarrantyExtractResult:
    """Extract warranty thresholds from raw PDF text via Bedrock.

    PDF parsing (turning a .pdf binary into text) is the caller's job —
    use ``pdf-parse`` on the Next.js side or any Python PDF lib. This
    function takes the text and structures it.
    """
    result = WarrantyExtractResult(
        asset_id=asset_id,
        model_id=model_id,
        generated_at=datetime.utcnow().isoformat() + "Z",
    )

    try:
        import boto3
    except ImportError:
        print("[warranty_extractor] boto3 not installed")
        return result

    try:
        client = boto3.client("bedrock-runtime", region_name=region)
        resp = client.converse(
            modelId=model_id,
            system=[{"text": _build_system_prompt()}],
            messages=[{"role": "user", "content": [{"text": _build_user_prompt(pdf_text, asset_id, manufacturer_hint)}]}],
            inferenceConfig={"maxTokens": 1500, "temperature": 0.1},
        )
        result.invocations = 1
        raw = resp["output"]["message"]["content"][0]["text"]
        result.raw_response = raw[:2000]
    except Exception as e:
        print(f"[warranty_extractor] Bedrock error: {type(e).__name__}: {e}")
        return result

    # Parse
    raw_clean = raw.strip()
    if raw_clean.startswith("```"):
        lines = [l for l in raw_clean.splitlines() if not l.strip().startswith("```")]
        raw_clean = "\n".join(lines)
    try:
        parsed = json.loads(raw_clean)
    except json.JSONDecodeError:
        s, e = raw_clean.find("{"), raw_clean.rfind("}")
        if s < 0 or e <= s:
            print(f"[warranty_extractor] non-JSON: {raw[:200]}")
            return result
        try:
            parsed = json.loads(raw_clean[s:e + 1])
        except json.JSONDecodeError:
            return result

    result.chemistry = parsed.get("chemistry")
    result.manufacturer = parsed.get("manufacturer")
    result.model = parsed.get("model")

    bounds = {fld: (typ, lo, hi) for fld, typ, _d, lo, hi, _desc in WARRANTY_FIELDS}
    for entry in parsed.get("terms", []) or []:
        fld = entry.get("field", "")
        if fld not in bounds:
            result.rejected_count += 1
            continue
        typ, lo, hi = bounds[fld]
        try:
            v = float(entry.get("value"))
        except (TypeError, ValueError):
            result.rejected_count += 1
            continue
        if v < lo or v > hi:
            print(f"[warranty_extractor] rejected {fld}={v} (out of [{lo}, {hi}])")
            result.rejected_count += 1
            continue
        coerced = int(v) if typ == "int" else v
        result.terms.append(WarrantyTerm(
            field=fld,
            value=coerced,
            unit=entry.get("unit", ""),
            confidence=max(0.0, min(1.0, float(entry.get("confidence", 0.7)))),
            source_excerpt=str(entry.get("source_excerpt", ""))[:300],
            is_explicit=bool(entry.get("is_explicit", True)),
        ))
        result.terms_dict[fld] = coerced

    return result
