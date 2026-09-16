"""An asset's commissioning date must not contradict its own history.

The regression these pin: `BessAsset.installation_date` for the local ribera
battery read 2026-08-04, the day the row was typed, while the asset carried 396
days of dispatch, cycling and warranty history running back to 2025-07-05. The
console rendered "Calendar age 1.1 / 10 yr" beside a commissioning date of
today, so the same screen said the battery had operated for more than a year
before it was installed.

Three things keep that from coming back:

  1. `resolve_installation_date` never answers "today". It answers with the
     best evidence on file and says which evidence it used.
  2. `clamp_window_start` stops the twin modelling dispatch for days before the
     asset was installed, which is the same contradiction from the other end.
  3. The modelled asset update leaves `current_soc` NULL. No BMS is connected,
     so there is no live state of charge to serve, and the console's SoC tile
     is captioned "state of charge" with no timestamp.

No database and no network: every case here is pure.
"""

import inspect
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from nuravolt.pipeline import bess_intelligence as bi
from nuravolt.pipeline.bess_intelligence import (
    SOURCE_EXISTING_UNATTRIBUTED,
    SOURCE_MODELLED_WINDOW,
    SOURCE_PLANT_COMMISSIONING,
    clamp_window_start,
    resolve_installation_date,
    synthesize_bess_history,
)

TODAY = date(2026, 8, 4)
WINDOW_START = date(2025, 7, 5)  # today - 395 days, the ribera window


def asset(**kw):
    base = {"id": "asset-1", "installation_date": None, "metadata": {}}
    base.update(kw)
    return base


def plant(**kw):
    base = {"id": "plant-1", "slug": "ribera", "commissioning_date": None}
    base.update(kw)
    return base


# --- resolve_installation_date ---------------------------------------------


def test_replaces_a_date_that_postdates_the_assets_own_history():
    """The ribera case, exactly: installed today, a year of history on file."""
    resolved, source = resolve_installation_date(
        plant(), asset(installation_date=TODAY), WINDOW_START
    )
    assert resolved == WINDOW_START
    assert source == SOURCE_MODELLED_WINDOW
    assert resolved != TODAY


def test_prefers_the_plant_commissioning_date_over_the_window():
    """One date on the screen, not two: the plant header shows this one."""
    cod = date(2023, 11, 15)
    resolved, source = resolve_installation_date(
        plant(commissioning_date=cod), asset(installation_date=TODAY), WINDOW_START
    )
    assert resolved == cod
    assert source == SOURCE_PLANT_COMMISSIONING


@pytest.mark.parametrize("declared", ["operator_declared", "contract", "oem_api", "measured"])
def test_never_overwrites_a_declared_date(declared):
    """Evidence beats inference, even when the plant carries a date too."""
    claimed = date(2024, 2, 1)
    resolved, source = resolve_installation_date(
        plant(commissioning_date=date(2023, 11, 15)),
        asset(
            installation_date=claimed,
            metadata={"installation_date_source": declared},
        ),
        WINDOW_START,
    )
    assert resolved == claimed
    assert source == declared


def test_keeps_an_unattributed_date_that_is_possible():
    """The seed scripts leave dates with no source. Those are still a claim."""
    seeded = date(2024, 6, 15)
    resolved, source = resolve_installation_date(
        plant(commissioning_date=date(2023, 1, 1)),
        asset(installation_date=seeded),
        WINDOW_START,
    )
    assert resolved == seeded
    assert source == SOURCE_EXISTING_UNATTRIBUTED


def test_reads_metadata_that_arrives_as_json_text():
    """psycopg2 hands back jsonb as a dict, but not every call site does."""
    claimed = date(2024, 2, 1)
    resolved, source = resolve_installation_date(
        plant(),
        asset(
            installation_date=claimed,
            metadata='{"installation_date_source": "contract"}',
        ),
        WINDOW_START,
    )
    assert (resolved, source) == (claimed, "contract")


def test_accepts_datetimes_and_iso_strings_alike():
    resolved, _ = resolve_installation_date(
        plant(commissioning_date=datetime(2023, 11, 15, 9, 30)), asset(), WINDOW_START
    )
    assert resolved == date(2023, 11, 15)
    resolved, _ = resolve_installation_date(
        plant(commissioning_date="2023-11-15"), asset(), WINDOW_START
    )
    assert resolved == date(2023, 11, 15)


def test_falls_back_to_the_window_start_when_nothing_is_known():
    resolved, source = resolve_installation_date(plant(), asset(), WINDOW_START)
    assert (resolved, source) == (WINDOW_START, SOURCE_MODELLED_WINDOW)


def test_is_idempotent_once_it_has_written_its_own_answer():
    """A second run must not move the date, nor relabel where it came from.

    The window start walks forward a day at a time, so the second run sees a
    stored date that is now earlier than the default window. It has to keep
    both the date and the caption: a `modelled_window_start` date relabelled
    `existing_unattributed` would lose the "not a commissioning record" note.
    """
    first, first_src = resolve_installation_date(
        plant(), asset(installation_date=TODAY), WINDOW_START
    )
    assert first_src == SOURCE_MODELLED_WINDOW
    for later_window in (WINDOW_START, WINDOW_START + timedelta(days=30)):
        second, second_src = resolve_installation_date(
            plant(),
            asset(
                installation_date=first,
                metadata={"installation_date_source": first_src},
            ),
            later_window,
        )
        assert (second, second_src) == (first, SOURCE_MODELLED_WINDOW)


def test_an_unlabelled_date_is_reported_as_unattributed():
    resolved, source = resolve_installation_date(
        plant(), asset(installation_date=date(2024, 6, 15)), WINDOW_START
    )
    assert (resolved, source) == (date(2024, 6, 15), SOURCE_EXISTING_UNATTRIBUTED)


def test_an_unrecognised_source_string_is_not_trusted():
    """A stray label must not become a claim this pipeline defers to."""
    resolved, source = resolve_installation_date(
        plant(),
        asset(
            installation_date=date(2024, 6, 15),
            metadata={"installation_date_source": "vibes"},
        ),
        WINDOW_START,
    )
    assert (resolved, source) == (date(2024, 6, 15), SOURCE_EXISTING_UNATTRIBUTED)


def test_never_answers_today_for_an_asset_with_history():
    for a in (
        asset(),
        asset(installation_date=TODAY),
        asset(installation_date=TODAY, metadata={"installation_date_source": "chemistry_default"}),
    ):
        resolved, _ = resolve_installation_date(plant(), a, WINDOW_START)
        assert resolved <= WINDOW_START, "a date after the asset's own history is impossible"


# --- clamp_window_start -----------------------------------------------------


def test_window_is_truncated_to_a_real_installation_date():
    """No dispatch for days the battery was not yet on site."""
    installed = date(2026, 3, 1)
    assert clamp_window_start(WINDOW_START, installed, SOURCE_PLANT_COMMISSIONING) == installed


def test_window_is_left_alone_when_installation_predates_it():
    installed = date(2023, 11, 15)
    assert clamp_window_start(WINDOW_START, installed, SOURCE_PLANT_COMMISSIONING) == WINDOW_START


def test_the_modelled_fallback_never_clamps_its_own_window():
    """Clamping a window to a date derived from that window is circular."""
    assert clamp_window_start(WINDOW_START, WINDOW_START, SOURCE_MODELLED_WINDOW) == WINDOW_START


# --- what the pipeline writes ----------------------------------------------


SOURCE = inspect.getsource(synthesize_bess_history)


def test_state_of_charge_is_cleared_not_placeheld():
    """A modelled asset must not publish a number as its live state of charge.

    `current_soc = 0.5` used to be written on every run and rendered in the
    console KPI row as "SoC 50%" under the caption "state of charge". There is
    no BMS, so there is no such reading. The modelled profile is kept per day
    in BessDispatchSchedule.soc_schedule instead.
    """
    # The SQL form, spaced, must only ever assign NULL. A literal or a bound
    # parameter there would land in the column the console reads as live.
    assert "current_soc = NULL" in SOURCE
    assert not re.search(r"current_soc = (?!NULL)", SOURCE), (
        "a value in the current_soc column would read as a live measurement"
    )
    # The unspaced form is the BessAssetConfig keyword, which is the simulation
    # seed the optimizer starts from. That one is a model input, not a reading,
    # and it is never persisted.
    seeds = re.findall(r"current_soc=([^,\s)]+)", SOURCE)
    assert seeds == ["0.5"], f"unexpected current_soc keyword uses: {seeds}"


def test_the_installation_date_written_is_the_resolved_one():
    """One date, two consumers: the asset row and the warranty tracker config.

    BessWarrantyStatus.years_remaining comes from the tracker, which subtracts
    BessAssetConfig.installation_date from now(); the console draws its
    "Calendar age" bar from that. The warranty route falls back to
    BessAsset.installation_date when no snapshot exists. Both have to be the
    same date or one screen shows two ages.
    """
    assert "installation_date = %s" in SOURCE
    assert "installation_date=datetime(install_date.year" in SOURCE
    assert "date.today()" not in SOURCE.split("installation_date = %s")[1][:200]


def test_calendar_usage_is_measured_from_installation():
    """time_usage_pct sits beside years_remaining in the same snapshot row."""
    assert "(last_modelled - install_date).days" in SOURCE
    assert "(last_modelled - start).days / 365.25" not in SOURCE


def test_the_source_of_the_date_is_recorded_next_to_it():
    assert bi.INSTALLATION_DATE_SOURCE_KEY == "installation_date_source"
    assert "INSTALLATION_DATE_SOURCE_KEY: install_source" in SOURCE
