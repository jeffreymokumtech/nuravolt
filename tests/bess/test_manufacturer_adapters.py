"""
Tests for the OEM manufacturer adapters.

The point of these tests is one specific failure mode: a violation threshold
that can never trip. An NMC 4.2 V cell ceiling applied to an LFP pack means the
overvoltage detector runs, reports clean, and is structurally incapable of
reporting anything else. That is worse than no detector, because it looks like
coverage. Megapack 2 and 2 XL are LFP, so the ceiling must sit near 3.65 V.
"""

import pytest

from nuravolt.bess.config import BessChemistry
from nuravolt.bess.manufacturer_adapters.tesla_megapack import (
    DEFAULT_MEGAPACK_GENERATION,
    MEGAPACK_GENERATIONS,
    TESLA_POWERHUB_SUB_ASSET_SIGNALS,
    TeslaMegapackAdapter,
    TeslaMegapackConfig,
)


# --- chemistry by generation -------------------------------------------------


def test_default_generation_is_megapack_2():
    assert DEFAULT_MEGAPACK_GENERATION == "megapack_2"
    assert DEFAULT_MEGAPACK_GENERATION in MEGAPACK_GENERATIONS


def test_megapack_2_ceiling_is_crossable_by_a_real_lfp_overvoltage():
    """An LFP cell tops out near 3.65 V, so the ceiling must be in reach."""
    terms = TeslaMegapackAdapter.get_default_warranty_terms("megapack_2")

    assert terms["chemistry"] == "lfp"
    ceiling = terms["cell_voltage_max_v"]
    assert 3.4 < ceiling < 4.0, (
        f"cell_voltage_max_v={ceiling} cannot be crossed by a real LFP "
        "overvoltage: the detector would report clean forever"
    )


def test_megapack_2_xl_matches_megapack_2_chemistry():
    xl = TeslaMegapackAdapter.get_default_warranty_terms("megapack_2_xl")
    two = TeslaMegapackAdapter.get_default_warranty_terms("megapack_2")

    assert xl["chemistry"] == two["chemistry"] == "lfp"
    assert xl["cell_voltage_max_v"] == two["cell_voltage_max_v"]


def test_megapack_1_keeps_the_nmc_window():
    """The original 2019 Megapack really was NMC. Do not over-correct it."""
    terms = TeslaMegapackAdapter.get_default_warranty_terms("megapack_1")

    assert terms["chemistry"] == "nmc"
    assert terms["cell_voltage_max_v"] == 4.2
    assert terms["cell_voltage_min_v"] == 3.0


@pytest.mark.parametrize("generation", sorted(MEGAPACK_GENERATIONS))
def test_every_generation_has_a_sane_window_and_valid_chemistry(generation):
    terms = TeslaMegapackAdapter.get_default_warranty_terms(generation)

    assert terms["cell_voltage_max_v"] > terms["cell_voltage_min_v"]
    assert terms["cell_voltage_min_v"] > 0
    # chemistry must round-trip through the enum the rest of the package uses
    assert BessChemistry(terms["chemistry"]) in BessChemistry


def test_cell_windows_agree_with_add_bess_to_plant_ts():
    """
    scripts/add_bess_to_plant.ts onboards assets with LFP 2.8/3.65 and
    NMC 3.0/4.2. An asset onboarded there and scored here must not silently
    use two different ceilings.
    """
    expected = {"lfp": (2.8, 3.65), "nmc": (3.0, 4.2)}

    for generation, gen in MEGAPACK_GENERATIONS.items():
        assert (gen.cell_voltage_min_v, gen.cell_voltage_max_v) == expected[
            gen.chemistry
        ], f"{generation} disagrees with scripts/add_bess_to_plant.ts"


# --- provenance --------------------------------------------------------------


@pytest.mark.parametrize("generation", sorted(MEGAPACK_GENERATIONS))
def test_no_generation_claims_to_be_verified(generation):
    """
    Every row is unverified against Tesla documentation. If someone verifies
    one, they change the row AND this test, deliberately.
    """
    assert MEGAPACK_GENERATIONS[generation].verified is False


@pytest.mark.parametrize(
    "accessor",
    [
        TeslaMegapackAdapter.get_default_warranty_terms,
        TeslaMegapackAdapter.get_degradation_parameters,
    ],
)
@pytest.mark.parametrize("generation", sorted(MEGAPACK_GENERATIONS))
def test_accessors_carry_provenance(accessor, generation):
    result = accessor(generation)

    assert result["generation"] == generation
    assert result["chemistry"] == MEGAPACK_GENERATIONS[generation].chemistry
    assert result["verified"] is False
    assert result["source"].strip()


@pytest.mark.parametrize(
    "accessor",
    [
        TeslaMegapackAdapter.get_default_warranty_terms,
        TeslaMegapackAdapter.get_degradation_parameters,
    ],
)
def test_unknown_generation_fails_loudly(accessor):
    with pytest.raises(ValueError, match="Unknown Megapack generation"):
        accessor("megapack_9000")


def test_degradation_chemistry_follows_the_generation():
    assert TeslaMegapackAdapter.get_degradation_parameters("megapack_1")[
        "chemistry"
    ] == "nmc"
    assert TeslaMegapackAdapter.get_degradation_parameters("megapack_2")[
        "chemistry"
    ] == "lfp"


def test_powerhub_publishes_no_sub_asset_signals():
    """
    Tesla's published Powerhub device-level catalogue has zero cell, module or
    rack signals. That emptiness is evidence for the rack-grain product
    boundary, so it is asserted rather than assumed.
    """
    assert TESLA_POWERHUB_SUB_ASSET_SIGNALS == ()


# --- silent empties ----------------------------------------------------------


def _adapter() -> TeslaMegapackAdapter:
    return TeslaMegapackAdapter(TeslaMegapackConfig(site_id="test-site"))


def test_fetch_historical_raises_instead_of_returning_empty():
    from datetime import datetime

    with pytest.raises(NotImplementedError) as exc:
        _adapter().fetch_historical(datetime(2024, 1, 1), datetime(2024, 1, 31))

    # the error must say what DOES work, not just what does not
    assert "parse_csv_export" in str(exc.value)


def test_fetch_realtime_raises_instead_of_returning_none():
    with pytest.raises(NotImplementedError) as exc:
        _adapter().fetch_realtime()

    assert "parse_csv_export" in str(exc.value)


def test_test_connection_does_not_claim_an_untested_connection():
    assert _adapter().test_connection() is False
