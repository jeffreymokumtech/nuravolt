"""Three modules publish `bess_state_of_safety`, and AnalysisArtifact holds one
row per (plant, kind). Without a precedence rule the last writer of the night
owns the headline, and the thinnest publisher is the one the nightly sweep runs.

These tests pin the rule: a publisher standing on less evidence must not
overwrite one standing on more, and real telemetry always wins.
"""

from datetime import datetime, timedelta, timezone

from nuravolt.bess.safety_artifact import (
    SAFETY_BASIS_RANK,
    SAFETY_INCUMBENT_MAX_AGE_HOURS,
    safety_basis_rank,
    should_publish_safety,
)

MEASURED = "measured_rack_telemetry"
SPECIMEN = "modelled_rack_specimen"
TWIN = "modelled_dispatch_twin"


def _incumbent(basis, *, age_hours=0.0):
    stamped = datetime.now(timezone.utc) - timedelta(hours=age_hours)
    return {
        "evaluated_at": stamped.isoformat(),
        "provenance": {"telemetry_source": basis},
    }


def test_rank_orders_by_how_much_evidence_the_score_stands_on():
    assert safety_basis_rank(MEASURED) > safety_basis_rank(SPECIMEN)
    assert safety_basis_rank(SPECIMEN) > safety_basis_rank(TWIN)
    assert safety_basis_rank(TWIN) > safety_basis_rank(None)


def test_unknown_basis_ranks_lowest_rather_than_raising():
    # A future publisher that forgets to register itself should lose to an
    # established one, not overwrite it and not crash the nightly run.
    assert safety_basis_rank("something_new_and_unregistered") == 0
    publish, _ = should_publish_safety(_incumbent(TWIN), "something_new_and_unregistered")
    assert publish is False


def test_the_nightly_twin_cannot_revert_a_specimen_headline():
    # The regression this file exists for. The twin runs every night; before the
    # precedence rule it silently reverted Ribera's rack headline to a score
    # computed with no rack channels at all.
    publish, reason = should_publish_safety(_incumbent(SPECIMEN), TWIN)
    assert publish is False
    assert "less evidence" in reason


def test_the_nightly_twin_cannot_revert_measured_telemetry():
    publish, _ = should_publish_safety(_incumbent(MEASURED), TWIN)
    assert publish is False


def test_a_specimen_cannot_displace_real_telemetry():
    publish, _ = should_publish_safety(_incumbent(MEASURED), SPECIMEN)
    assert publish is False


def test_measured_telemetry_always_wins_immediately():
    for held in (TWIN, SPECIMEN):
        publish, _ = should_publish_safety(_incumbent(held), MEASURED)
        assert publish is True, f"measured should outrank {held}"


def test_a_specimen_may_replace_the_twin():
    publish, _ = should_publish_safety(_incumbent(TWIN), SPECIMEN)
    assert publish is True


def test_a_publisher_always_refreshes_its_own_reading():
    # Equal rank publishes: this is the common case, the same publisher running
    # again tomorrow. A precedence rule that blocked it would freeze the console.
    for basis in (TWIN, SPECIMEN, MEASURED):
        publish, _ = should_publish_safety(_incumbent(basis), basis)
        assert publish is True, f"{basis} should refresh itself"


def test_no_incumbent_publishes():
    publish, reason = should_publish_safety(None, TWIN)
    assert publish is True
    assert "no incumbent" in reason


def test_a_stale_incumbent_stops_holding_the_slot():
    # Without an escape hatch a specimen generated once would outrank the
    # nightly twin forever and the console would show a frozen score.
    fresh = _incumbent(SPECIMEN, age_hours=1)
    stale = _incumbent(SPECIMEN, age_hours=SAFETY_INCUMBENT_MAX_AGE_HOURS + 1)
    assert should_publish_safety(fresh, TWIN)[0] is False
    publish, reason = should_publish_safety(stale, TWIN)
    assert publish is True
    assert "past the" in reason


def test_an_unreadable_timestamp_does_not_hold_the_slot_forever():
    broken = {"evaluated_at": "not a date", "provenance": {"telemetry_source": SPECIMEN}}
    publish, reason = should_publish_safety(broken, TWIN)
    assert publish is True
    assert "evaluated_at" in reason


def test_every_registered_basis_is_a_string_the_payload_actually_writes():
    # The rank table keys must match the `telemetry_source` values
    # state_of_safety_payload puts in provenance, or precedence silently
    # degrades to "everything ranks 0" and last-writer-wins comes back.
    from nuravolt.bess import safety_artifact as sa

    assert sa.MODELLED_BASIS in SAFETY_BASIS_RANK
    assert sa.MEASURED_RACK_BASIS in SAFETY_BASIS_RANK
