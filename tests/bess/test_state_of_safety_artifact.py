"""The state-of-safety artifact envelope: what actually gets persisted and served.

The composite itself is tested in tests/bess/test_state_of_safety.py. These
tests pin the publisher, because the publisher is where the honesty can be lost:
a payload can compute worst-of correctly and still ship a modelled number
dressed as a measurement, or coerce "we cannot see this" into a zero.

Three properties are load bearing:

  1. The disclosure is the canonical sentence, byte for byte. If anyone
     paraphrases it in the publisher, the console, the alert email and the PDF
     stop agreeing about what this number is.
  2. A sub index that needs rack level telemetry stays unavailable with its
     reason. Never 0, which an operator reads as "perfectly unsafe", and never
     100, which claims evidence nobody collected.
  3. The artifact is marked provisional at every grain, because every input
     came off a MODELLED dispatch profile and none of it was measured.

No database and no network: the sub indices are built from the real index
functions with the inputs this asset class actually has, which is exactly the
"no BMS connected" case.
"""

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import numpy as np  # noqa: E402

from nuravolt.bess.imbalance import (  # noqa: E402
    SUB_ASSET_UNAVAILABLE,
    analyze_imbalance,
    imbalance_index,
)
from nuravolt.bess.thermal_monitor import (  # noqa: E402
    combine_state_of_safety,
    dwell_exposure_index,
    protection_status_index,
    safety_disclosure,
    thermal_margin_index,
)
from nuravolt.pipeline.bess_intelligence import (  # noqa: E402
    SAFETY_ARTIFACT_KIND,
    SAFETY_BASIS,
    SAFETY_MODEL_VERSION,
    state_of_safety_payload,
)

ASSET_DB_ID = "8f1d0c6e-0000-4000-8000-00000000ribera"
EXTERNAL_ID = "bess-ribera-001"
WINDOW = (date(2025, 7, 1), date(2026, 7, 31))


def build_sos(interval_minutes=60.0, max_temp_c=24.6, exposed_hours=0.0):
    """The four sub indices exactly as a cloud-only, no-BMS asset yields them."""
    t0 = datetime(2026, 1, 1)
    events = []
    if exposed_hours:
        events.append(("SOC_HIGH_DWELL", t0, t0 + timedelta(hours=exposed_hours)))
    return combine_state_of_safety(
        [
            thermal_margin_index(max_temp_c, None),
            # No rack samples: this is the "connect your BMS" path.
            imbalance_index(analyze_imbalance(EXTERNAL_ID, [])),
            dwell_exposure_index(events, window_hours=24.0),
            # No HVAC status channel and no alarm code channel.
            protection_status_index(hvac_channel_present=False, alarm_channel_present=False),
        ],
        interval_minutes=interval_minutes,
        computed_at=datetime(2026, 7, 31, 6, 0, 0),
    )


def build_payload(**kwargs):
    return state_of_safety_payload(
        build_sos(**kwargs),
        asset_db_id=ASSET_DB_ID,
        external_asset_id=EXTERNAL_ID,
        asset_name="Ribera Storage",
        interval_minutes=kwargs.get("interval_minutes", 60.0),
        window=WINDOW,
        zone="ES",
        price_src="omie",
    )


def sub_by_name(payload, name):
    (reading,) = payload["readings"]
    return next(s for s in reading["sub_indices"] if s["name"] == name)


# --- Honesty --------------------------------------------------------------


def test_disclosure_is_the_canonical_sentence_verbatim():
    payload = build_payload()
    assert payload["disclosure"] == safety_disclosure(60.0)
    assert "not a protection system" in payload["disclosure"]
    assert "must not be relied on for emergency response" in payload["disclosure"]
    # House style, and a cheap guard against someone "improving" the wording.
    for bad in ("—", "–", " - "):
        assert bad not in payload["disclosure"]


def test_sub_asset_indices_are_unavailable_not_zero():
    payload = build_payload()

    for name in ("imbalance", "protection_status"):
        sub = sub_by_name(payload, name)
        assert sub["available"] is False, name
        # The distinction the whole panel rests on: absent is not zero.
        assert sub["score"] is None, name
        assert sub["score"] != 0, name
        assert sub["reason"], name

    assert sub_by_name(payload, "imbalance")["reason"] == SUB_ASSET_UNAVAILABLE
    assert "rack level telemetry" in sub_by_name(payload, "imbalance")["reason"]
    assert set(payload["readings"][0]["unavailable"]) == {"imbalance", "protection_status"}


def test_unavailable_sub_index_cannot_raise_the_composite():
    """Two of four sub indices are blind, so the composite is worst-of the other
    two. A publisher that scored the blind ones 100 would be indistinguishable
    from this on the headline number, so pin the sub index that set it."""
    payload = build_payload(max_temp_c=52.5, exposed_hours=0.0)
    reading = payload["readings"][0]
    assert reading["score"] == 50  # thermal margin midway warning to critical
    assert reading["limiting_index"] == "thermal_margin"
    assert reading["band"] == "HIGH"


def test_exactly_one_sub_index_is_named_as_binding():
    payload = build_payload(max_temp_c=24.6, exposed_hours=18.0)
    reading = payload["readings"][0]
    scored = [s for s in reading["sub_indices"] if s["available"] and s["score"] is not None]
    assert reading["limiting_index"] == "dwell_exposure"
    assert reading["score"] == min(s["score"] for s in scored)
    assert sum(1 for s in scored if s["name"] == reading["limiting_index"]) == 1


def test_every_grain_is_marked_provisional_and_modelled():
    payload = build_payload()
    reading = payload["readings"][0]
    prov = payload["provenance"]

    assert payload["provisional"] is True
    assert reading["provisional"] is True
    assert reading["basis"] == SAFETY_BASIS
    assert prov["measured"] is False
    assert prov["telemetry_source"] == SAFETY_BASIS
    assert prov["sub_asset_telemetry"] == "absent"
    assert prov["generated_by"] == SAFETY_MODEL_VERSION
    assert prov["modelled_window"] == ["2025-07-01", "2026-07-31"]
    assert "modelled dispatch" in prov["note"]

    # The label an operator meets in the console footer and the alert email.
    assert "modelled dispatch twin" in reading["device_label"]

    # A scored sub index carries the basis of its own inputs.
    thermal = sub_by_name(payload, "thermal_margin")
    assert thermal["inputs"]["basis"] == SAFETY_BASIS
    assert "Not a measured pack" in thermal["inputs"]["basis_note"]


def test_nothing_measurable_publishes_unknown_rather_than_a_number():
    sos = combine_state_of_safety(
        [
            thermal_margin_index(None),
            imbalance_index(analyze_imbalance(EXTERNAL_ID, [])),
            dwell_exposure_index([], window_hours=None),
            protection_status_index(),
        ],
        interval_minutes=None,
    )
    payload = state_of_safety_payload(
        sos,
        asset_db_id=ASSET_DB_ID,
        external_asset_id=EXTERNAL_ID,
        asset_name=None,
        interval_minutes=None,
        window=WINDOW,
    )
    reading = payload["readings"][0]
    assert reading["score"] is None
    assert reading["band"] == "UNKNOWN"
    assert reading["limiting_index"] is None
    # Publishing UNKNOWN is not the same as publishing nothing: the console
    # distinguishes "not published" from "published, nothing measurable".
    assert payload["disclosure"] == safety_disclosure(None)


# --- Serving contract -----------------------------------------------------


def test_envelope_matches_what_the_console_and_alerts_read():
    payload = build_payload()
    assert set(payload) >= {
        "evaluated_at", "interval_minutes", "disclosure", "rubric", "readings"
    }
    reading = payload["readings"][0]
    assert set(reading) >= {
        "asset_id", "device_id", "device_label", "score", "band",
        "limiting_index", "unavailable", "sub_indices", "rubric", "computed_at",
    }
    assert reading["asset_id"] == ASSET_DB_ID
    assert payload["interval_minutes"] == 60.0
    assert payload["rubric"]["combination"] == "worst_of"


def test_device_id_is_asset_grain_for_the_panel_resolver():
    """StateOfSafety.tsx treats /^BESS [^.]+$/ as whole-asset grain and a dotted
    id as one rack. This twin can only speak for the whole asset."""
    reading = build_payload()["readings"][0]
    assert reading["device_id"] == f"BESS {EXTERNAL_ID}"
    assert "." not in reading["device_id"].split(" ", 1)[1]


def test_payload_survives_jsonb_with_numpy_inputs():
    """The engine is numpy internal, and psycopg2 would str() a np.int64 into
    the column as "5". Round trip the way write_artifact does."""
    sos = build_sos(max_temp_c=float(np.float64(31.25)))
    sos.sub_indices[0].inputs["n_samples"] = np.int64(96)
    sos.sub_indices[0].inputs["ratio"] = np.float64(0.5)
    sos.sub_indices[0].inputs["nan_guard"] = float("nan")
    payload = state_of_safety_payload(
        sos,
        asset_db_id=ASSET_DB_ID,
        external_asset_id=EXTERNAL_ID,
        window=WINDOW,
    )
    encoded = json.dumps(payload)  # must not raise
    assert "NaN" not in encoded and "Infinity" not in encoded
    inputs = payload["readings"][0]["sub_indices"][0]["inputs"]
    assert inputs["n_samples"] == 96 and isinstance(inputs["n_samples"], int)
    assert inputs["ratio"] == 0.5
    assert inputs["nan_guard"] is None


def test_artifact_kind_matches_the_serving_route_and_the_alert_evaluator():
    """Pinned literally: src/app/api/bess/plants/[plantId]/audit/route.ts maps
    ?file=safety onto this string, and src/lib/alerts/evaluate.ts reads it as
    BESS_SAFETY_ARTIFACT_KIND. A rename on one side has to fail here."""
    assert SAFETY_ARTIFACT_KIND == "bess_state_of_safety"

    route = (
        Path(__file__).parent.parent.parent
        / "src/app/api/bess/plants/[plantId]/audit/route.ts"
    ).read_text()
    assert f"safety: '{SAFETY_ARTIFACT_KIND}'" in route

    evaluate = (
        Path(__file__).parent.parent.parent / "src/lib/alerts/evaluate.ts"
    ).read_text()
    assert f"BESS_SAFETY_ARTIFACT_KIND = '{SAFETY_ARTIFACT_KIND}'" in evaluate
