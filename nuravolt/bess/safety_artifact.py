"""The published state of safety envelope, shared by every publisher of it.

The composite itself is ``nuravolt.bess.pipeline.calculate_state_of_safety``
(worst of four sub indices). This module is only its envelope: the shape the
console's panel, ``src/lib/alerts/evaluate.ts`` and the PDF all read.

ONE ENVELOPE, TWO BASES
-----------------------

There are two publishers of this artifact and there must never be a third
shape. The modelled dispatch twin (``nuravolt/pipeline/bess_intelligence.py``)
publishes for an asset with no BMS connected; the measured rack materializer
(``nuravolt/pipeline/bess_measured.py``) publishes for an asset whose rack
telemetry reaches the lake. They differ in exactly one thing: what the numbers
were computed from. So that is a parameter, not a second copy of the envelope.

A forked envelope is not a style problem. The disclosure sentence, the
provisional flag and the per sub index basis note are the three things that stop
a modelled score being read as a measured one, and a second copy is where one of
them silently stops being written.

Three honesty rules are enforced here and pinned by
tests/bess/test_state_of_safety_artifact.py:

  1. The disclosure is ``sos.disclosure``, the canonical sentence from
     ``nuravolt.bess.thermal_monitor.safety_disclosure``, published verbatim.
  2. A sub index that could not be measured keeps its unavailable state and its
     reason. Never 0, which reads as "perfectly unsafe"; never 100, which claims
     evidence nobody collected.
  3. Every grain says what it was computed from: ``basis`` on the reading, a
     ``basis_note`` on each scored sub index, and a provenance block on the
     payload.

The defaults under claim on purpose. A caller that forgets to say it measured
something publishes a provisional, modelled looking artifact, which is the
recoverable mistake; the unrecoverable one is a modelled number wearing a
measured label.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from typing import Any, Dict, Mapping, Optional

import numpy as np

from nuravolt.bess.thermal_monitor import StateOfSafety

#: The engine that computed the composite. The same on both paths: what differs
#: is the telemetry it was fed, which is `basis`.
ENGINE = "nuravolt.bess"

# Kind, source and model_version follow scripts/generate_bess_audit_artifacts.py
# exactly, so the three BESS artifacts read as one family:
# bess_warranty_dossier, bess_optimizer_audit, bess_state_of_safety.
SAFETY_ARTIFACT_KIND = "bess_state_of_safety"
SAFETY_MODEL_VERSION = "bess-state-of-safety-v1"

#: Provenance key for the window on each path. A measured payload must not carry
#: a key called "modelled_window": the key name is itself a claim.
WINDOW_KEY_MODELLED = "modelled_window"
WINDOW_KEY_MEASURED = "measured_window"


# --- The modelled dispatch twin's basis ------------------------------------

MODELLED_BASIS = "modelled_dispatch_twin"
MODELLED_BASIS_LABEL = "modelled dispatch twin"

#: Per sub index, what its inputs really were. A score never travels without the
#: basis of the number travelling with it.
MODELLED_BASIS_NOTES: Dict[str, str] = {
    "thermal_margin": (
        "Modelled HVAC cabinet temperature from the dispatch twin. Not a "
        "measured pack, module or cell sensor."
    ),
    "dwell_exposure": (
        "Warranty violation events detected on the modelled dispatch profile, "
        "not on measured telemetry."
    ),
}
MODELLED_BASIS_NOTE_DEFAULT = (
    "Computed from the modelled dispatch profile, not from measured telemetry."
)
MODELLED_PROVENANCE_NOTE = (
    "Every sub index here is computed from the platform's modelled dispatch "
    "profile. No BMS is connected, so the sub indices that need rack level "
    "channels report unavailable with their reason instead of a score. Absent "
    "is not zero."
)


# --- The measured rack telemetry basis --------------------------------------

MEASURED_RACK_BASIS = "measured_rack_telemetry"
MEASURED_RACK_BASIS_LABEL = "measured rack telemetry"

MEASURED_RACK_BASIS_NOTES: Dict[str, str] = {
    "imbalance": (
        "Measured per rack telemetry, pivoted from silver_bess_telemetry at the "
        "grain the battery management system actually reported. Read it with "
        "the spread basis in these inputs: two members on the extremes basis "
        "are a rack's reported edges, not a rack with two modules."
    ),
}
MEASURED_RACK_BASIS_NOTE_DEFAULT = (
    "Computed from measured telemetry in the lake, not from a modelled profile."
)
MEASURED_RACK_PROVENANCE_NOTE = (
    "The imbalance sub index here is computed from measured per rack telemetry. "
    "The sub indices that need asset grain channels this run did not load "
    "report unavailable with their reason instead of a score. Absent is not "
    "zero, and a sub index nobody could measure is not a passing one."
)


def jsonable(obj: Any) -> Any:
    """Round trip through json so numpy scalars, dates and NaN survive jsonb.

    ``default=str`` alone is not enough: np.int64 is not an int subclass, so it
    would land in Postgres as the string "5". NaN and Infinity become null
    because Python emits bare literals that jsonb rejects.
    """

    def enc(value: Any) -> Any:
        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, (datetime, date)):
            return value.isoformat()
        return str(value)

    return json.loads(json.dumps(obj, default=enc), parse_constant=lambda _: None)


def state_of_safety_payload(
    sos: StateOfSafety,
    *,
    asset_db_id: str,
    external_asset_id: str,
    basis: str,
    basis_label: str,
    asset_name: Any = None,
    interval_minutes: Any = None,
    window: Any = None,
    window_key: str = WINDOW_KEY_MODELLED,
    basis_notes: Optional[Mapping[str, str]] = None,
    basis_note_default: Optional[str] = None,
    provenance_note: Optional[str] = None,
    provisional: bool = True,
    measured: bool = False,
    sub_asset_telemetry: str = "absent",
    engine: str = ENGINE,
    zone: Any = None,
    price_src: Any = None,
) -> Dict[str, Any]:
    """Wrap one computed StateOfSafety in the published artifact envelope.

    Shape is the contract src/lib/alerts/evaluate.ts and the console's
    StateOfSafety panel already read: a `readings` array of per device rows, each
    with its score, band, limiting index and full sub index breakdown, under a
    payload level disclosure and rubric.

    `device_id` is written at whole asset grain ("BESS <external id>", no dot)
    because that is the grain a worst of composite can honestly speak at. A
    dotted id is reserved for real per rack rows.

    `provisional` and `measured` are separate claims and neither implies the
    other. A measured feed can still be provisional (one week of telemetry, a
    trial connection), and a modelled profile is never measured. Both default to
    the under claiming answer.
    """
    reading: Dict[str, Any] = sos.to_dict()
    notes = dict(basis_notes or {})

    # Carry the basis down to each scored sub index. An unavailable sub index
    # gets nothing added: its `reason` is already the whole story.
    for sub in reading.get("sub_indices") or []:
        inputs = dict(sub.get("inputs") or {})
        if sub.get("available") and sub.get("score") is not None:
            inputs["basis"] = basis
            note = notes.get(sub.get("name"), basis_note_default)
            if note:
                inputs["basis_note"] = note
        sub["inputs"] = inputs

    label = str(asset_name).strip() if asset_name else external_asset_id
    reading.update({
        "asset_id": asset_db_id,
        "device_id": f"BESS {external_asset_id}",
        # The console footer and the alert email both render this label, and
        # they are the two places an operator meets the number. The basis rides
        # along so neither can present a modelled score as a measured one.
        "device_label": f"{label} ({basis_label})",
        "provisional": provisional,
        "basis": basis,
    })

    win = list(window) if window else []
    provenance: Dict[str, Any] = {
        "telemetry_source": basis,
        "measured": measured,
        "provisional": provisional,
        "engine": engine,
        "zone": zone,
        "price_source": price_src,
        window_key: [str(w) for w in win],
        "asset_id": external_asset_id,
        "asset_db_id": asset_db_id,
        "sub_asset_telemetry": sub_asset_telemetry,
        "generated_by": SAFETY_MODEL_VERSION,
    }
    if provenance_note:
        provenance["note"] = provenance_note

    return jsonable({
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "interval_minutes": interval_minutes,
        # Canonical, from safety_disclosure() via combine_state_of_safety.
        "disclosure": sos.disclosure,
        "rubric": sos.rubric,
        "provisional": provisional,
        "provenance": provenance,
        "readings": [reading],
    })


# --- Publisher precedence --------------------------------------------------
#
# Three modules publish this artifact, and AnalysisArtifact holds one row per
# (plant, kind), so without a rule the last writer of the night owns the
# headline. That is not a tie to break arbitrarily: the three carry genuinely
# different amounts of evidence, and the nightly sweep runs the thinnest one.
#
# Ranked by how much the score is standing on:
#   measured rack telemetry  a real BMS reported sub-asset channels
#   modelled rack specimen   sub-asset channels derived from the dispatch twin
#   modelled dispatch twin   no sub-asset channels at all, so the imbalance
#                            sub index cannot score and the worst-of composite
#                            runs on whatever is left
#
# A thinner publisher must not overwrite a richer one. The reverse always may:
# real telemetry outranks everything, immediately.
SAFETY_BASIS_RANK: Dict[str, int] = {
    "modelled_dispatch_twin": 1,
    "modelled_rack_specimen": 2,
    "measured_rack_telemetry": 3,
}

#: An incumbent this old stops holding the slot. Without an escape hatch a
#: specimen generated once would outrank the nightly twin forever, and the
#: console would quietly show a frozen score. Matches the 48 hour staleness
#: guard the alert evaluator already applies.
SAFETY_INCUMBENT_MAX_AGE_HOURS = 48


def safety_basis_rank(basis: Optional[str]) -> int:
    """Evidence rank for a basis string. Unknown bases rank lowest.

    Unknown ranks 0 rather than raising: a future publisher that forgets to
    register itself should lose to an established one, not overwrite it.
    """
    return SAFETY_BASIS_RANK.get(str(basis or ""), 0)


def should_publish_safety(
    incumbent: Optional[Dict[str, Any]],
    basis: str,
    *,
    now: Optional[datetime] = None,
    max_age_hours: int = SAFETY_INCUMBENT_MAX_AGE_HOURS,
) -> tuple:
    """Decide whether ``basis`` may replace the artifact already stored.

    Returns ``(publish: bool, reason: str)``. The reason is carried into the
    caller's summary so a skipped publish is legible rather than silent.

    Equal rank always publishes: that is the same publisher refreshing its own
    reading, which is the common case.
    """
    if not incumbent:
        return True, "no incumbent"

    held = incumbent.get("provenance", {}).get("telemetry_source")
    held_rank = safety_basis_rank(held)
    mine = safety_basis_rank(basis)

    if mine >= held_rank:
        return True, f"rank {mine} >= incumbent {held_rank} ({held or 'unknown'})"

    stamped = incumbent.get("evaluated_at")
    if stamped:
        try:
            when = datetime.fromisoformat(str(stamped))
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            age_h = ((now or datetime.now(timezone.utc)) - when).total_seconds() / 3600.0
            if age_h > max_age_hours:
                return True, (
                    f"incumbent {held} outranks {basis} but is {age_h:.0f}h old, "
                    f"past the {max_age_hours}h limit"
                )
        except (TypeError, ValueError):
            # An unparseable stamp is not a reason to hold the slot forever.
            return True, "incumbent has no readable evaluated_at"

    return False, (
        f"{basis} carries less evidence than the stored {held}; "
        "leaving the richer reading in place"
    )


def read_safety_incumbent(conn, plant_id: str) -> Optional[Dict[str, Any]]:
    """The state-of-safety payload currently stored for a plant, or None."""
    with conn.cursor() as cur:
        # AnalysisArtifact.plant_id is TEXT, not uuid, unlike analysis_results.
        # Casting the parameter to uuid here raises "operator does not exist:
        # text = uuid" at runtime, which py_compile cannot catch.
        cur.execute(
            'SELECT payload FROM "AnalysisArtifact" WHERE plant_id = %s AND kind = %s',
            (str(plant_id), SAFETY_ARTIFACT_KIND),
        )
        row = cur.fetchone()
    if not row or not row[0]:
        return None
    payload = row[0]
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            return None
    return payload if isinstance(payload, dict) else None


def publish_safety_artifact(conn, plant_id: str, payload: Dict[str, Any], basis: str) -> tuple:
    """Write the artifact only if ``basis`` is at least as well evidenced as the
    one already stored.

    Returns ``(published: bool, reason: str)`` so a caller can put the reason in
    its summary. Every publisher of this artifact must go through here: the
    table holds one row per (plant, kind), and the nightly sweep runs the
    thinnest publisher, so a raw upsert silently downgrades the console.
    """
    # Imported here rather than at module scope: this module is pure payload
    # construction everywhere else, and importing the DB writer at the top would
    # make the engine depend on psycopg2 to build a dict.
    from nuravolt.db.writer import write_artifact

    incumbent = read_safety_incumbent(conn, plant_id)
    ok, reason = should_publish_safety(incumbent, basis)
    if not ok:
        return False, reason
    write_artifact(
        plant_id=str(plant_id),
        kind=SAFETY_ARTIFACT_KIND,
        payload=payload,
        source="computed",
        model_version=SAFETY_MODEL_VERSION,
        conn=conn,
    )
    return True, reason
