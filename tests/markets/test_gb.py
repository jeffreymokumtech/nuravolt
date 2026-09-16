"""Unit tests for nuravolt/markets/gb.py and the shared market plumbing.

Every HTTP response here comes from a recorded fixture in
tests/markets/fixtures/ (captured live from the public Elexon Insights and
NESO CKAN endpoints) or from a payload hand-built to exercise one trap. No test
in this file makes a network call.

The trap that matters most: Elexon publishes a row for every Market Index Data
Provider whether or not it traded, and a provider that is not trading publishes
price 0.00 at volume 0.000. Taking the wrong row yields a zero GB price curve,
which values a battery at zero.
"""

import json
import sys
from datetime import date
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from nuravolt.markets import gb
from nuravolt.markets.errors import PriceFetchError

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name):
    return json.loads((FIXTURES / f"{name}.json").read_text())


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"unexpected HTTP {self.status_code} in a test")

    def json(self):
        return self._payload


class FakeSession:
    """Serves recorded payloads and records the calls the module made."""

    def __init__(self, handler):
        self._handler = handler
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        return FakeResponse(self._handler(url, params))


def zero_volume_payload(start_times, provider="N2EXMIDP"):
    """A window where the only provider publishing is not trading."""
    return {
        "metadata": {"datasets": ["MID"]},
        "data": [
            {
                "startTime": ts,
                "dataProvider": provider,
                "settlementDate": ts[:10],
                "settlementPeriod": i + 1,
                "price": 0.00,
                "volume": 0.000,
            }
            for i, ts in enumerate(start_times)
        ],
    }


# ---------------------------------------------------------------------------
# Market index provider selection


def test_mid_picks_the_provider_that_actually_traded():
    df = gb._parse_mid_payload(load_fixture("elexon_mid_2026-07-20_partial"), "fixture")
    assert set(df["mid_data_provider"]) == {"APXMIDP"}
    assert (df["price_gbp_mwh"] > 0).all()
    assert df["price_gbp_mwh"].loc["2026-07-20T04:00:00Z"] == pytest.approx(121.89)


def test_all_zero_n2ex_payload_raises_rather_than_pricing_a_battery_at_zero():
    payload = zero_volume_payload(["2026-07-20T00:00:00Z", "2026-07-20T00:30:00Z"])
    with pytest.raises(PriceFetchError) as exc:
        gb._parse_mid_payload(payload, "fixture")
    assert "zero-volume" in str(exc.value)


def test_provider_preference_is_a_tie_break_not_a_hardcode():
    # APX trading: preferred even though another provider traded more.
    rows = [
        {"dataProvider": "APXMIDP", "price": 100.0, "volume": 10.0},
        {"dataProvider": "N2EXMIDP", "price": 55.0, "volume": 900.0},
    ]
    assert gb._select_mid_provider(rows)["dataProvider"] == "APXMIDP"

    # APX dark: the largest live volume wins, including providers we never named.
    rows = [
        {"dataProvider": "APXMIDP", "price": 0.0, "volume": 0.0},
        {"dataProvider": "N2EXMIDP", "price": 55.0, "volume": 120.0},
        {"dataProvider": "NEWMIDP", "price": 57.0, "volume": 900.0},
    ]
    assert gb._select_mid_provider(rows)["dataProvider"] == "NEWMIDP"

    # Nobody trading: no row is defensible.
    assert gb._select_mid_provider([{"dataProvider": "N2EXMIDP", "price": 0.0, "volume": 0.0}]) is None


def test_provider_slug_is_derived_not_enumerated():
    assert gb._provider_slug("APXMIDP") == "apx"
    assert gb._provider_slug("N2EXMIDP") == "n2ex"
    assert gb._provider_slug("SOMEFUTUREMIDP") == "somefuture"


# ---------------------------------------------------------------------------
# fetch_day_ahead_prices


def test_fetch_day_ahead_prices_labels_its_source_and_resolution():
    payload = load_fixture("elexon_mid_2026-07-20_partial")
    session = FakeSession(lambda url, params: payload)

    df = gb.fetch_day_ahead_prices("GB", date(2026, 7, 20), date(2026, 7, 20),
                                   use_cache=False, session=session)

    assert list(df.columns) == ["price_gbp_mwh", "mid_data_provider"]
    assert df.attrs["price_source"] == "elexon_mid_apx"
    assert df.attrs["zone"] == "GB"
    assert df.attrs["currency"] == "GBP"
    assert df.attrs["resolution_minutes"] == 30
    assert str(df.index.tz) == "UTC"
    assert df.index.is_monotonic_increasing
    assert (df["price_gbp_mwh"] > 0).all()


def test_fetch_day_ahead_prices_chunks_within_the_seven_day_api_cap():
    payload = load_fixture("elexon_mid_2026-07-20_partial")
    session = FakeSession(lambda url, params: payload)
    gb.fetch_day_ahead_prices("GB", date(2026, 7, 20), date(2026, 7, 20),
                              use_cache=False, session=session)

    assert session.calls, "expected at least one Elexon request"
    for _url, params in session.calls:
        span = date.fromisoformat(params["to"][:10]) - date.fromisoformat(params["from"][:10])
        assert span.days <= gb._MID_MAX_WINDOW_DAYS


def test_fetch_day_ahead_prices_raises_on_an_all_zero_window():
    starts = [f"2026-07-20T{h:02d}:{m:02d}:00Z" for h in range(2) for m in (0, 30)]
    session = FakeSession(lambda url, params: zero_volume_payload(starts))
    with pytest.raises(PriceFetchError):
        gb.fetch_day_ahead_prices("GB", date(2026, 7, 20), date(2026, 7, 20),
                                  use_cache=False, session=session)


def test_fetch_day_ahead_prices_has_no_synthetic_fallback():
    def blow_up(url, params):
        raise requests.ConnectionError("network down")

    session = FakeSession(blow_up)
    with pytest.raises(PriceFetchError):
        gb.fetch_day_ahead_prices("GB", date(2026, 7, 20), date(2026, 7, 20),
                                  use_cache=False, session=session)


def test_entsoe_source_is_documented_but_inactive_for_gb():
    with pytest.raises(PriceFetchError) as exc:
        gb.fetch_day_ahead_prices("GB", date(2026, 7, 20), date(2026, 7, 20), source="entsoe")
    assert "ENTSO-E" in str(exc.value)


def test_unknown_zone_is_rejected():
    with pytest.raises(ValueError):
        gb.fetch_day_ahead_prices("ES", date(2026, 7, 20), date(2026, 7, 20))


# ---------------------------------------------------------------------------
# Imbalance prices


def test_imbalance_prices_shape_and_source():
    payload = load_fixture("elexon_system_prices_2026-07-20_partial")
    session = FakeSession(lambda url, params: payload)

    df = gb.fetch_imbalance_prices("GB", date(2026, 7, 20), date(2026, 7, 20),
                                   use_cache=False, session=session)

    assert list(df.columns) == ["system_price_gbp_mwh", "niv_mwh", "price_derivation_code"]
    assert df.attrs["price_source"] == "elexon_disebsp"
    assert df.attrs["currency"] == "GBP"
    assert len(df) == 4
    # Settlement period 1 of a BST settlement date starts at 23:00 UTC the day
    # before and must survive the range filter.
    assert str(df.index[0]) == "2026-07-19 23:00:00+00:00"
    assert df["system_price_gbp_mwh"].iloc[0] == pytest.approx(113.1)
    assert df["niv_mwh"].iloc[0] < 0
    assert df["price_derivation_code"].iloc[0] == "N"


# ---------------------------------------------------------------------------
# NESO ancillary clearing prices


def test_negative_neso_clearing_price_is_returned_as_published():
    payload = load_fixture("neso_response_reserve_daily_drh")
    session = FakeSession(lambda url, params: payload)

    df = gb.fetch_ancillary_clearing_prices(date(2026, 7, 28), date(2026, 7, 29),
                                            session=session)

    assert df.attrs["price_source"] == "neso_response_reserve_daily"
    assert df.attrs["currency"] == "GBP"
    assert df.attrs["resource_id"] == gb.NESO_RESERVE_RESOURCE_ID
    drh = df[df["product"] == "DRH"]
    assert drh["clearing_price_gbp_mw_h"].min() == pytest.approx(-19.0)
    assert (drh["clearing_price_gbp_mw_h"] < 0).all(), "sign must not be flipped or abs()'d"
    assert str(df["delivery_start"].iloc[0].tz) == "UTC"


def test_neso_product_filter_and_validation():
    payload = load_fixture("neso_response_reserve_daily_drh")
    session = FakeSession(lambda url, params: payload)

    df = gb.fetch_ancillary_clearing_prices(date(2026, 7, 28), date(2026, 7, 29),
                                            products=["DRH"], session=session)
    assert set(df["product"]) == {"DRH"}

    with pytest.raises(ValueError):
        gb.fetch_ancillary_clearing_prices(date(2026, 7, 28), date(2026, 7, 29),
                                           products=["NOTAPRODUCT"], session=session)


def test_neso_product_present_in_the_data_is_accepted_even_if_undocumented():
    # The live resource carries NBR and PBR, which its own field metadata omits.
    # A filter on those must work rather than being rejected as unknown.
    assert "NBR" not in gb.NESO_PRODUCTS
    payload = {
        "success": True,
        "result": {
            "records": [
                {
                    "auctionProduct": "NBR",
                    "serviceType": "Balancing Reserve",
                    "deliveryStart": "2026-07-28T22:00:00",
                    "deliveryEnd": "2026-07-29T02:00:00",
                    "clearedVolume": 400,
                    "clearingPrice": 3.5,
                }
            ]
        },
    }
    session = FakeSession(lambda url, params: payload)
    df = gb.fetch_ancillary_clearing_prices(date(2026, 7, 28), date(2026, 7, 29),
                                            products=["NBR"], session=session)
    assert list(df["product"]) == ["NBR"]


def test_neso_truncated_page_raises_instead_of_understating_the_auction():
    payload = load_fixture("neso_response_reserve_daily_drh")
    payload["result"]["total"] = 324  # the unfiltered resource is far larger
    session = FakeSession(lambda url, params: payload)
    with pytest.raises(PriceFetchError) as exc:
        gb.fetch_ancillary_clearing_prices(date(2026, 7, 28), date(2026, 7, 29), session=session)
    assert "truncated" in str(exc.value)


def test_neso_range_outside_the_daily_resource_raises_with_a_pointer():
    payload = load_fixture("neso_response_reserve_daily_drh")
    session = FakeSession(lambda url, params: payload)
    with pytest.raises(PriceFetchError) as exc:
        gb.fetch_ancillary_clearing_prices(date(2024, 1, 1), date(2024, 1, 2), session=session)
    assert "archive" in str(exc.value)


# ---------------------------------------------------------------------------
# BM acceptances


def _stack_handler(url, params):
    if "/stack/all/bid/" in url and url.endswith("/15"):
        return load_fixture("elexon_stack_bid_2026-07-20_sp15_partial")
    if "/stack/all/offer/" in url and url.endswith("/15"):
        return load_fixture("elexon_stack_offer_2026-07-20_sp15_partial")
    return {"metadata": {"datasets": ["ISPSTACK"]}, "data": []}


def test_bm_acceptances_filter_to_the_requested_bmu():
    session = FakeSession(_stack_handler)
    df = gb.fetch_bm_acceptances("E_BHOLB-1", date(2026, 7, 20), periods=[15], session=session)

    assert len(df) == 3
    assert set(df["direction"]) == {"bid"}
    assert sorted(df["acceptance_id"]) == [68339, 68340, 68341]
    assert df["final_price_gbp_mwh"].iloc[0] == pytest.approx(110.02)
    assert (df["niv_adjusted_volume_mwh"] < 0).all()
    assert df.attrs["price_source"] == "elexon_bm_stack"
    assert df.attrs["bmu_id"] == "E_BHOLB-1"
    assert df.attrs["settlement_date"] == "2026-07-20"


def test_bm_acceptances_walk_both_stacks_across_all_settlement_periods():
    session = FakeSession(_stack_handler)
    gb.fetch_bm_acceptances("E_BHOLB-1", date(2026, 7, 20), session=session)
    assert len(session.calls) == 2 * gb.SETTLEMENT_PERIODS_PER_DAY


def test_bm_acceptances_quiet_day_is_an_empty_frame_not_an_error():
    session = FakeSession(lambda url, params: {"data": []})
    df = gb.fetch_bm_acceptances("T_PEMB-51", date(2026, 7, 20), periods=[15], session=session)
    assert df.empty
    assert list(df.columns) == gb._ACCEPTANCE_COLUMNS
    assert df.attrs["price_source"] == "elexon_bm_stack"
