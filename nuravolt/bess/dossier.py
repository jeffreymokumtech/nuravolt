"""
Warranty & degradation dossier assembly.

Builds a claim-grade evidence bundle for a BESS warranty position from raw
telemetry, composing the existing analytics:

- rainflow cycle reconstruction        (nuravolt.bess.cycling_analysis)
- warranty KPI tracking + projections  (nuravolt.bess.warranty_tracker)
- rule-based violation detection       (nuravolt.bess.warranty_violation_detector)
- composite health score               (nuravolt.bess.pipeline)
- warranty-contract term extraction    (nuravolt.llm.warranty_extractor, Bedrock)

What makes the bundle "claim-grade" is the evidence chain: every source file
is hashed (sha256) and profiled (rows, range, sampling interval, gaps), every
contract term applied carries its source excerpt and confidence, and every
violation lists timestamps, measured values and thresholds. The bundle is a
plain dict; nuravolt.bess.report_generator renders it to PDF and the Audit UI
consumes the same JSON.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

try:
    import polars as pl
except ImportError:  # pragma: no cover
    pl = None

from nuravolt.bess.config import (
    BESSPipelineConfig,
    BessAssetConfig,
    WarrantyTermsConfig,
)
from nuravolt.bess.pipeline import BESSIntelligencePipeline
from nuravolt.bess.warranty_tracker import EmpiricalDegradationModel

# Extracted contract fields (nuravolt.llm.warranty_extractor closed schema)
# -> WarrantyTermsConfig attributes. Value transforms applied where units differ.
_EXTRACTED_TERM_MAP = {
    "soh_eol_threshold_pct": ("capacity_guarantee_pct", lambda v: v / 100.0),
    "cycle_count_warranty": ("max_cycles", int),
    "warranty_years": ("warranty_years", int),
    "min_rte_pct": ("min_rte", lambda v: v / 100.0),
    "max_temp_dwell_c": ("operating_temp_max_c", float),
}
_APPLY_CONFIDENCE = 0.6


def sha256_file(path: Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def profile_telemetry(df: pd.DataFrame, timestamp_col: str) -> dict:
    """Data-quality profile used in the evidence appendix."""
    ts = pd.to_datetime(df[timestamp_col])
    ts = ts.sort_values()
    diffs = ts.diff().dropna()
    median_interval = diffs.median() if len(diffs) else pd.Timedelta(0)
    gaps = int((diffs > 3 * median_interval).sum()) if median_interval > pd.Timedelta(0) else 0
    span = ts.max() - ts.min()
    expected = (span / median_interval + 1) if median_interval > pd.Timedelta(0) else len(ts)
    return {
        "rows": int(len(df)),
        "start": ts.min().isoformat(),
        "end": ts.max().isoformat(),
        "median_interval_seconds": int(median_interval.total_seconds()),
        "gap_count": gaps,
        "coverage": round(float(min(1.0, len(ts) / float(expected))), 4),
    }


def _auto_columns(df: pd.DataFrame) -> dict:
    """Best-effort mapping of raw column names onto the pipeline contract."""
    mapping: dict[str, Optional[str]] = {
        "timestamp": None, "soc": None, "power": None,
        "temp": None, "voltage": None, "hvac_status": None, "c_rate": None,
    }
    for col in df.columns:
        low = col.lower()
        if mapping["timestamp"] is None and any(k in low for k in ("timestamp", "datetime", "time", "date", "ts")):
            mapping["timestamp"] = col
        elif mapping["soc"] is None and "soc" in low:
            mapping["soc"] = col
        elif mapping["power"] is None and "power" in low:
            mapping["power"] = col
        elif mapping["temp"] is None and "temp" in low:
            mapping["temp"] = col
        elif mapping["voltage"] is None and "volt" in low:
            mapping["voltage"] = col
        elif mapping["hvac_status"] is None and "hvac" in low:
            mapping["hvac_status"] = col
        elif mapping["c_rate"] is None and ("c_rate" in low or "crate" in low):
            mapping["c_rate"] = col
    return mapping


def extract_terms_from_contract(
    warranty_pdf: Path,
    asset_id: str,
    manufacturer_hint: Optional[str] = None,
) -> tuple[dict, dict]:
    """
    Parse a warranty contract PDF and extract structured terms via Bedrock.

    Returns (applied_overrides, extraction_record). Terms below the apply
    confidence are recorded but not applied.
    """
    from pypdf import PdfReader
    from nuravolt.llm.warranty_extractor import extract_warranty_terms

    reader = PdfReader(str(warranty_pdf))
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    if len(text.strip()) < 100:
        raise ValueError(
            f"Extracted almost no text from {warranty_pdf} (scanned/image PDF?); "
            "supply terms manually or provide a text layer."
        )

    result = extract_warranty_terms(text, asset_id=asset_id, manufacturer_hint=manufacturer_hint)

    overrides: dict = {}
    applied: list[dict] = []
    for term in result.terms:
        entry = asdict(term)
        entry["applied"] = False
        if term.field in _EXTRACTED_TERM_MAP and term.confidence >= _APPLY_CONFIDENCE:
            attr, transform = _EXTRACTED_TERM_MAP[term.field]
            try:
                overrides[attr] = transform(term.value)
                entry["applied"] = True
            except (TypeError, ValueError):
                pass
        applied.append(entry)

    record = {
        "source_file": str(warranty_pdf),
        "source_sha256": sha256_file(warranty_pdf),
        "chemistry": result.chemistry,
        "manufacturer": result.manufacturer,
        "model": result.model,
        "llm_model_id": result.model_id,
        "terms": applied,
        "apply_confidence_threshold": _APPLY_CONFIDENCE,
    }
    return overrides, record


def _soh_trajectory(
    pipeline: BESSIntelligencePipeline,
    asset: BessAssetConfig,
    terms: WarrantyTermsConfig,
    capacity_tests: Optional[list[dict]],
) -> dict:
    """Monthly modelled SoH from installation through warranty end."""
    records = pipeline.cycle_records
    if records:
        daily = pd.DataFrame(
            {"date": [r.date for r in records],
             "efc": [r.equivalent_cycles for r in records],
             "temp": [r.avg_temp_c for r in records],
             "dod": [r.avg_dod for r in records]}
        )
        daily["date"] = pd.to_datetime(daily["date"])
        cycles_per_year = float(daily["efc"].mean() * 365)
        avg_temp = float(np.nanmean(daily["temp"]))
        avg_dod = float(np.clip(np.nanmean(daily["dod"]), 0.05, 1.0))
    else:
        cycles_per_year, avg_temp, avg_dod = 365.0, 25.0, 0.8

    install = asset.installation_date or datetime.now()
    chemistry = asset.chemistry.value if hasattr(asset.chemistry, "value") else str(asset.chemistry)
    model = EmpiricalDegradationModel(chemistry=chemistry)

    months = terms.warranty_years * 12
    points = []
    crossing = None
    for m in range(0, months + 1, 1):
        years = m / 12.0
        cycles = cycles_per_year * years
        soh = model.predict_soh(cycles, years, avg_temp=avg_temp, avg_dod=avg_dod)
        date = (pd.Timestamp(install) + pd.DateOffset(months=m)).date().isoformat()
        points.append({"date": date, "soh": round(float(soh), 4)})
        if crossing is None and soh <= terms.capacity_guarantee_pct:
            crossing = date

    tests = []
    for test in capacity_tests or []:
        test_date = test.get("test_date")
        if hasattr(test_date, "isoformat"):
            test_date = test_date.isoformat()
        tests.append({
            "date": test_date,
            "measured_capacity_kwh": test.get("measured_capacity_kwh"),
            "soh": test.get("soh_result"),
            "test_type": test.get("test_type", "capacity_test"),
        })

    return {
        "model": "empirical_degradation",
        "chemistry": chemistry,
        "assumptions": {
            "cycles_per_year": round(cycles_per_year, 1),
            "avg_temp_c": round(avg_temp, 1),
            "avg_dod": round(avg_dod, 3),
        },
        "warranty_threshold": terms.capacity_guarantee_pct,
        "projected_threshold_crossing": crossing,
        "points": points,
        "capacity_tests": tests,
    }


def _rainflow_histogram(pipeline: BESSIntelligencePipeline) -> list[dict]:
    """Aggregate rainflow cycles into DoD-depth bins for the report chart."""
    edges = np.arange(0.0, 1.01, 0.1)
    counts = np.zeros(len(edges) - 1)
    for record in pipeline.cycle_records:
        for cyc in record.rainflow_cycles or []:
            rng = cyc.get("range") if isinstance(cyc, dict) else getattr(cyc, "range", None)
            cnt = cyc.get("count", 1.0) if isinstance(cyc, dict) else getattr(cyc, "count", 1.0)
            if rng is None:
                continue
            idx = int(min(np.clip(rng, 0, 0.999) * 10, 9))
            counts[idx] += cnt
    return [
        {"dod_bin": f"{int(edges[i]*100)}-{int(edges[i+1]*100)}%", "cycles": round(float(counts[i]), 1)}
        for i in range(len(counts))
    ]


def build_warranty_dossier(
    telemetry: pd.DataFrame,
    asset: BessAssetConfig,
    terms: Optional[WarrantyTermsConfig] = None,
    capacity_tests: Optional[list[dict]] = None,
    warranty_pdf: Optional[Path] = None,
    source_files: Optional[list[Path]] = None,
    column_mapping: Optional[dict] = None,
) -> dict:
    """
    Assemble the warranty & degradation evidence bundle.

    Args:
        telemetry: BESS time series (pandas). Power sign: positive = discharge.
        asset: Asset identity and physical parameters.
        terms: Warranty terms; contract-extracted values override these.
        capacity_tests: Optional list of capacity test dicts (see pipeline).
        warranty_pdf: Optional contract PDF; terms are extracted via Bedrock
            and applied when confidence >= 0.6, with full provenance recorded.
        source_files: Raw client files to hash into the evidence appendix.
        column_mapping: Pipeline column mapping override (auto-detected if None).

    Returns:
        JSON-serializable dict bundle.
    """
    if pl is None:
        raise ImportError("Polars is required for the BESS pipeline")

    terms = terms or WarrantyTermsConfig()
    mapping = column_mapping or _auto_columns(telemetry)
    ts_col = mapping.get("timestamp")
    if not ts_col or mapping.get("power") is None:
        raise ValueError(f"Could not identify timestamp/power columns (got mapping {mapping})")

    extraction_record = None
    if warranty_pdf is not None:
        overrides, extraction_record = extract_terms_from_contract(
            Path(warranty_pdf), asset_id=asset.asset_id, manufacturer_hint=asset.manufacturer
        )
        for attr, value in overrides.items():
            setattr(terms, attr, value)

    telemetry = telemetry.copy()
    telemetry[ts_col] = pd.to_datetime(telemetry[ts_col])
    if getattr(telemetry[ts_col].dt, "tz", None) is not None:
        telemetry[ts_col] = telemetry[ts_col].dt.tz_localize(None)
    telemetry = telemetry.sort_values(ts_col)
    profile = profile_telemetry(telemetry, ts_col)

    config = BESSPipelineConfig(asset=asset, warranty_terms=terms)
    pipeline = BESSIntelligencePipeline(config)
    pipeline.load_data(
        pl.from_pandas(telemetry),
        column_mapping={k: v for k, v in mapping.items() if v},
    )
    if capacity_tests:
        pipeline.load_capacity_tests(capacity_tests)

    pipeline.run_warranty_analysis()
    pipeline.run_violation_detection()
    pipeline.run_cycling_analysis()
    # Cycling analysis refines throughput/cycle metrics; refresh KPI snapshot.
    pipeline.warranty_status = pipeline.warranty_tracker.get_kpi_summary()
    health = pipeline.calculate_health_score()

    lineage = []
    for path in source_files or []:
        path = Path(path)
        entry = {"file": path.name, "path": str(path)}
        if path.exists():
            entry["sha256"] = sha256_file(path)
            entry["size_bytes"] = path.stat().st_size
        else:
            entry["sha256"] = None
            entry["note"] = "file not found at assembly time"
        lineage.append(entry)

    # round_trip_efficiency is None on a day with no round trip to measure
    # (discharge-only or charge-only; see cycling_analysis.py). Absent is not
    # zero and not implausible, it is simply not evidence, so those days stay
    # out of the average rather than crashing the comparison.
    rte_values = [r.round_trip_efficiency for r in pipeline.cycle_records
                  if r.round_trip_efficiency is not None
                  and 0 < r.round_trip_efficiency <= 1.2]
    daily_cycles = [
        {
            "date": r.date.isoformat(),
            "equivalent_cycles": round(r.equivalent_cycles, 3),
            "energy_in_kwh": round(r.energy_in_kwh, 1),
            "energy_out_kwh": round(r.energy_out_kwh, 1),
            "avg_dod": round(r.avg_dod, 3),
            "avg_c_rate": round(r.avg_c_rate, 3),
            # None survives into the dossier as null: a day with no round trip
            # has no efficiency, and a stand-in number here would end up quoted
            # in a warranty claim.
            "round_trip_efficiency": (
                round(r.round_trip_efficiency, 4)
                if r.round_trip_efficiency is not None
                else None
            ),
        }
        for r in pipeline.cycle_records
    ]

    violations = [
        {
            "type": v.violation_type,
            "severity": v.severity,
            "started_at": v.started_at.isoformat() if v.started_at else None,
            "ended_at": v.ended_at.isoformat() if v.ended_at else None,
            "duration_minutes": v.duration_minutes,
            "measured_value": v.measured_value,
            "threshold_value": v.threshold_value,
            "unit": v.unit,
            "description": v.description,
        }
        for v in pipeline.violations
    ]

    bundle = {
        "report_type": "warranty_dossier",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "asset": {
            "asset_id": asset.asset_id,
            "name": asset.name,
            "chemistry": asset.chemistry.value if hasattr(asset.chemistry, "value") else str(asset.chemistry),
            "nominal_capacity_kwh": asset.nominal_capacity_kwh,
            "nominal_power_kw": asset.nominal_power_kw,
            "manufacturer": asset.manufacturer,
            "model": asset.model,
            "installation_date": asset.installation_date.isoformat() if asset.installation_date else None,
        },
        "warranty_terms": {
            "capacity_guarantee_pct": terms.capacity_guarantee_pct,
            "warranty_years": terms.warranty_years,
            "max_cycles": terms.max_cycles,
            "max_throughput_mwh": terms.max_throughput_mwh,
            "min_rte": terms.min_rte,
            "operating_temp_max_c": terms.operating_temp_max_c,
            "max_c_rate_continuous": terms.max_c_rate_continuous,
        },
        "contract_extraction": extraction_record,
        "health_score": {
            "score": health.score,
            "risk_level": health.risk_level,
            "component_scores": {
                "soh": health.soh_score,
                "cycles": health.cycle_score,
                "time": health.time_score,
                "efficiency": health.efficiency_score,
                "violations": health.violations_score,
            },
            "current_soh": health.current_soh,
            "soh_margin": health.soh_margin,
            "cycles_used": round(health.cycles_used, 1),
            "cycles_remaining": round(health.cycles_remaining, 1),
            "years_remaining": round(health.years_remaining, 2),
            "projected_eol_date": health.projected_eol_date.isoformat() if health.projected_eol_date else None,
            "risk_factors": health.risk_factors,
            "recommendation": health.recommendation,
        },
        "violations": violations,
        "cycling": {
            "total_equivalent_cycles": round(pipeline.warranty_tracker.metrics["equivalent_full_cycles"], 1),
            "total_throughput_mwh": round(pipeline.warranty_tracker.metrics["total_throughput_kwh"] / 1000, 1),
            "avg_round_trip_efficiency": round(float(np.mean(rte_values)), 4) if rte_values else None,
            "daily": daily_cycles,
            "rainflow_histogram": _rainflow_histogram(pipeline),
        },
        "soh_trajectory": _soh_trajectory(pipeline, asset, terms, capacity_tests),
        "evidence": {
            "telemetry_profile": profile,
            "column_mapping": {k: v for k, v in mapping.items() if v},
            "source_files": lineage,
            "methodology": (
                "Cycle counts reconstructed with ASTM E1049 four-point rainflow counting on "
                "state-of-charge; equivalent full cycles normalized to 100% depth of discharge. "
                "Violations detected rule-based against the warranty terms listed above. "
                "SoH trajectory from a semi-empirical calendar-plus-cyclic fade model "
                "calibrated per chemistry; capacity test measurements override model values "
                "where available."
            ),
        },
    }
    return bundle


def save_bundle(bundle: dict, output_path: Path) -> Path:
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(bundle, indent=2, default=str))
    return output_path
