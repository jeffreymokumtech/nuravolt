"""Unit tests for nuravolt/markets/iberia.py and the factored-out plumbing.

No network calls: the OMIE rung reads the committed CSV, and the A85 imbalance
rung is driven by a hand-built XML document.

That A85 document is NOT a recorded payload. There is no ENTSO-E token in this
environment, so it is written from the documented Balancing_MarketDocument
shape. These tests pin our parser's behaviour against that documented shape;
they cannot prove the shape itself is right. See the warning in the iberia.py
module docstring.
"""

import sys
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from nuravolt.markets import entsoe, iberia
from nuravolt.markets._cache import month_span
from nuravolt.markets.errors import PriceFetchError

A85_NS = "urn:iec62325.351:tc57wg16:451-6:balancingdocument:4:0"

# Spain settles imbalance in 15-minute periods, so the resolution is read from
# the document rather than assumed hourly.
A85_XML = f"""<?xml version="1.0" encoding="UTF-8"?>
<Balancing_MarketDocument xmlns="{A85_NS}">
  <mRID>test</mRID>
  <type>A85</type>
  <TimeSeries>
    <mRID>1</mRID>
    <businessType>A19</businessType>
    <flowDirection.direction>A01</flowDirection.direction>
    <currency_Unit.name>EUR</currency_Unit.name>
    <price_Measure_Unit.name>MWH</price_Measure_Unit.name>
    <curveType>A01</curveType>
    <controlArea_Domain.mRID codingScheme="A01">10YES-REE------0</controlArea_Domain.mRID>
    <Period>
      <timeInterval>
        <start>2026-07-20T00:00Z</start>
        <end>2026-07-20T01:00Z</end>
      </timeInterval>
      <resolution>PT15M</resolution>
      <Point><position>1</position><imbalance_Price.amount>81.25</imbalance_Price.amount></Point>
      <Point><position>2</position><imbalance_Price.amount>79.10</imbalance_Price.amount></Point>
      <Point><position>3</position><imbalance_Price.amount>-4.50</imbalance_Price.amount></Point>
      <Point><position>4</position><imbalance_Price.amount>62.00</imbalance_Price.amount></Point>
    </Period>
  </TimeSeries>
  <TimeSeries>
    <mRID>2</mRID>
    <businessType>A19</businessType>
    <flowDirection.direction>A02</flowDirection.direction>
    <curveType>A01</curveType>
    <controlArea_Domain.mRID codingScheme="A01">10YES-REE------0</controlArea_Domain.mRID>
    <Period>
      <timeInterval>
        <start>2026-07-20T00:00Z</start>
        <end>2026-07-20T01:00Z</end>
      </timeInterval>
      <resolution>PT15M</resolution>
      <Point><position>1</position><imbalance_Price.amount>70.00</imbalance_Price.amount></Point>
      <Point><position>2</position><imbalance_Price.amount>68.00</imbalance_Price.amount></Point>
      <Point><position>3</position><imbalance_Price.amount>66.00</imbalance_Price.amount></Point>
      <Point><position>4</position><imbalance_Price.amount>64.00</imbalance_Price.amount></Point>
    </Period>
  </TimeSeries>
</Balancing_MarketDocument>
""".encode()

ACK_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<Acknowledgement_MarketDocument xmlns="urn:iec62325.351:tc57wg16:451-1:acknowledgementdocument:8:0">
  <Reason><code>999</code><text>No matching data found</text></Reason>
</Acknowledgement_MarketDocument>
"""


class FakeResponse:
    def __init__(self, content, status_code=200):
        self.content = content
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"unexpected HTTP {self.status_code} in a test")


class FakeSession:
    def __init__(self, content):
        self._content = content
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        return FakeResponse(self._content)


# ---------------------------------------------------------------------------
# Day-ahead ladder


def test_omie_rung_serves_the_committed_csv():
    covered = sorted(iberia.load_omie()["ES"])[0]
    curve = iberia.day_ahead_curve(date.fromisoformat(covered), "ES")
    assert curve["price_source"] == "omie"
    assert len(curve["prices_eur_mwh"]) == 24
    assert curve["zone"] == "ES"


def test_synthetic_rung_is_labelled(monkeypatch):
    monkeypatch.setattr(entsoe, "fetch_day_ahead_prices",
                        lambda *a, **k: (_ for _ in ()).throw(PriceFetchError("offline")))
    curve = iberia.day_ahead_curve(date(1990, 1, 1), "ES")
    assert curve["price_source"] == "synthetic"
    assert len(curve["prices_eur_mwh"]) == 24


def test_allow_synthetic_false_refuses_to_invent_a_curve(monkeypatch):
    monkeypatch.setattr(entsoe, "fetch_day_ahead_prices",
                        lambda *a, **k: (_ for _ in ()).throw(PriceFetchError("offline")))
    with pytest.raises(PriceFetchError):
        iberia.day_ahead_curve(date(1990, 1, 1), "ES", allow_synthetic=False)


def test_synthetic_curve_is_deterministic_per_day():
    assert iberia.synthetic_day_curve(date(2026, 3, 1)) == iberia.synthetic_day_curve(date(2026, 3, 1))


def test_hourly_rungs_declare_their_resolution():
    covered = sorted(iberia.load_omie()["ES"])[0]
    assert iberia.day_ahead_curve(date.fromisoformat(covered), "ES")["resolution_minutes"] == 60


# ---------------------------------------------------------------------------
# Sub-hourly days (the 15-minute MTU)
#
# The committed OMIE CSV ends 2026-06-03, so every later Iberian day is served
# by the live rung, and energy-charts serves ES/PT at the 15-minute MTU: 96
# values a day. Taking the first 24 of those returns 00:00 to 06:00 of the day
# while still carrying the provider's name on it. Measured on ES 2026-06-20,
# that read 92.01 to 120.55 EUR/MWh against a real daily range of -0.01 to
# 129.06, understating the arbitrage opportunity about 4.5x. These tests exist
# to keep that from coming back.

# A day shaped like a real Iberian summer one: a firm night block, a midday
# solar dip that goes negative, and an evening peak above every night value.
# The night block is deliberately the flattest part of the day, so a curve that
# reports only the first six hours reports the wrong spread by a wide margin.
QUARTER_HOURLY_DAY = (
    [92.0 + 1.2 * i for i in range(24)]   # 00:00-06:00, the window the bug returned
    + [78.0 - 0.5 * i for i in range(24)]  # 06:00-12:00, morning
    + [30.0 - 2.0 * i for i in range(24)]  # 12:00-18:00, into the solar dip
    + [60.0 + 3.0 * i for i in range(24)]  # 18:00-24:00, evening peak
)
UNCOVERED_DAY = date(1990, 1, 1)  # outside the OMIE CSV, so the live rung wins


def _price_frame(day, prices, source="energy-charts"):
    """A provider frame shaped like nuravolt.markets.entsoe returns."""
    step = max(1, iberia.MINUTES_PER_DAY // len(prices))
    start = pd.Timestamp(day, tz="UTC")
    idx = pd.DatetimeIndex([start + pd.Timedelta(minutes=step * i) for i in range(len(prices))])
    df = pd.DataFrame({"price_eur_mwh": [float(p) for p in prices]}, index=idx)
    df.index.name = "ts"
    df.attrs["price_source"] = source
    return df


def _serve(monkeypatch, prices, source="energy-charts"):
    monkeypatch.setattr(
        entsoe, "fetch_day_ahead_prices",
        lambda zone, start, end, **kw: _price_frame(start, prices, source),
    )


def test_resolution_is_derived_from_the_period_count():
    assert iberia.resolution_minutes_for(24) == 60
    assert iberia.resolution_minutes_for(48) == 30
    assert iberia.resolution_minutes_for(96) == 15


def test_a_quarter_hourly_day_keeps_every_period(monkeypatch):
    _serve(monkeypatch, QUARTER_HOURLY_DAY)
    curve = iberia.day_ahead_curve(UNCOVERED_DAY, "ES")

    assert curve["price_source"] == "energy-charts"
    assert curve["resolution_minutes"] == 15
    assert len(curve["prices_eur_mwh"]) == 96
    assert curve["prices_eur_mwh"] == [round(p, 2) for p in QUARTER_HOURLY_DAY]


def test_a_quarter_hourly_day_reports_the_whole_days_spread(monkeypatch):
    """The regression guard: the curve must not be the first six hours.

    Truncation to the first 24 values passed every shape check ever written
    against this function, because 24 EUR/MWh values with a provider label is
    exactly what a correct hourly day looks like. Only the spread catches it.
    """
    _serve(monkeypatch, QUARTER_HOURLY_DAY)
    prices = iberia.day_ahead_curve(UNCOVERED_DAY, "ES")["prices_eur_mwh"]

    assert min(prices) == pytest.approx(min(QUARTER_HOURLY_DAY))
    assert max(prices) == pytest.approx(max(QUARTER_HOURLY_DAY))

    first_six_hours = QUARTER_HOURLY_DAY[:24]
    assert min(prices) < min(first_six_hours)
    assert max(prices) > max(first_six_hours)
    # The truncated curve understated the day's spread severalfold.
    truncated_spread = max(first_six_hours) - min(first_six_hours)
    assert (max(prices) - min(prices)) > 4 * truncated_spread


def test_a_half_hourly_day_reports_thirty_minute_periods(monkeypatch):
    _serve(monkeypatch, [40.0 + i for i in range(48)])
    curve = iberia.day_ahead_curve(UNCOVERED_DAY, "ES")
    assert curve["resolution_minutes"] == 30
    assert len(curve["prices_eur_mwh"]) == 48


def test_an_hourly_day_from_the_live_rung_is_unchanged(monkeypatch):
    """Regression guard for the shape every existing caller depends on."""
    hourly = [50.0 + i for i in range(24)]
    _serve(monkeypatch, hourly)
    curve = iberia.day_ahead_curve(UNCOVERED_DAY, "ES")

    assert curve["resolution_minutes"] == 60
    assert curve["prices_eur_mwh"] == hourly


# ---------------------------------------------------------------------------
# Explicit hourly downsample


def test_hourly_downsample_is_the_mean_of_each_hours_sub_periods(monkeypatch):
    _serve(monkeypatch, QUARTER_HOURLY_DAY)
    curve = iberia.hourly_day_curve(UNCOVERED_DAY, "ES")

    assert curve["resolution_minutes"] == 60
    assert curve["downsampled_from_minutes"] == 15
    assert len(curve["prices_eur_mwh"]) == 24

    hourly = curve["prices_eur_mwh"]
    assert hourly[0] == pytest.approx(sum(QUARTER_HOURLY_DAY[0:4]) / 4)
    for hour in range(24):
        block = QUARTER_HOURLY_DAY[hour * 4:(hour + 1) * 4]
        assert hourly[hour] == pytest.approx(sum(block) / 4, abs=0.005)


def test_hourly_downsample_brackets_the_raw_day(monkeypatch):
    """Means sit inside the raw range, and still show the real shape."""
    _serve(monkeypatch, QUARTER_HOURLY_DAY)
    hourly = iberia.hourly_day_curve(UNCOVERED_DAY, "ES")["prices_eur_mwh"]

    assert min(hourly) >= min(QUARTER_HOURLY_DAY)
    assert max(hourly) <= max(QUARTER_HOURLY_DAY)
    # Averaging costs some spread; truncating cost the afternoon entirely.
    first_six_hours = QUARTER_HOURLY_DAY[:24]
    assert min(hourly) < min(first_six_hours)
    assert max(hourly) > max(first_six_hours)


def test_hourly_downsample_leaves_an_already_hourly_day_alone(monkeypatch):
    hourly = [50.0 + i for i in range(24)]
    _serve(monkeypatch, hourly)
    curve = iberia.hourly_day_curve(UNCOVERED_DAY, "ES")

    assert curve["downsampled_from_minutes"] is None
    assert curve["prices_eur_mwh"] == hourly


def test_to_hourly_never_takes_the_first_values():
    quarter_hours = [0.0, 0.0, 0.0, 0.0] + [100.0] * 92
    hourly = iberia.to_hourly(quarter_hours)
    assert hourly[0] == pytest.approx(0.0)
    assert hourly[1] == pytest.approx(100.0)
    assert len(hourly) == 24


# ---------------------------------------------------------------------------
# Ragged days


@pytest.mark.parametrize("count", [0, 23, 25, 47, 100])
def test_a_ragged_day_has_no_derivable_resolution(count):
    with pytest.raises(PriceFetchError):
        iberia.resolution_minutes_for(count)


def test_to_hourly_refuses_a_ragged_day():
    with pytest.raises(PriceFetchError):
        iberia.to_hourly([50.0] * 23)


def test_a_ragged_live_day_falls_through_instead_of_truncating(monkeypatch):
    _serve(monkeypatch, [50.0 + i for i in range(23)])
    assert iberia.entsoe_day_curve(UNCOVERED_DAY, "ES") is None

    # The ladder continues, and what it lands on says so.
    curve = iberia.day_ahead_curve(UNCOVERED_DAY, "ES")
    assert curve["price_source"] == "synthetic"
    assert len(curve["prices_eur_mwh"]) == 24


def test_a_ragged_live_day_raises_when_synthetic_is_off(monkeypatch):
    _serve(monkeypatch, [50.0 + i for i in range(23)])
    with pytest.raises(PriceFetchError):
        iberia.day_ahead_curve(UNCOVERED_DAY, "ES", allow_synthetic=False)


# ---------------------------------------------------------------------------
# Zone router compatibility (nuravolt/pipeline/market_prices.py)


def test_the_router_sees_the_quarter_hourly_shape(monkeypatch):
    """The router derives resolution from the length; the two must agree."""
    from nuravolt.pipeline import market_prices as mp

    _serve(monkeypatch, QUARTER_HOURLY_DAY)
    periods = mp.day_ahead_periods(UNCOVERED_DAY, "ES")

    assert periods["resolution_minutes"] == 15
    assert len(periods["prices"]) == 96
    assert periods["currency"] == "EUR"
    assert max(periods["prices"]) == pytest.approx(max(QUARTER_HOURLY_DAY))


# ---------------------------------------------------------------------------
# A85 imbalance prices (unverified shape, see module docstring)


def test_a85_parser_reads_both_directions_at_the_documents_resolution():
    df = iberia._parse_a85_xml(A85_XML)
    assert list(df.columns) == ["imbalance_price_up_eur_mwh", "imbalance_price_down_eur_mwh"]
    assert len(df) == 4
    assert df.attrs["resolution_minutes"] == 15
    assert str(df.index[1]) == "2026-07-20 00:15:00+00:00"
    assert df["imbalance_price_up_eur_mwh"].iloc[0] == pytest.approx(81.25)
    # A negative imbalance price is a real market outcome, not a parse error.
    assert df["imbalance_price_up_eur_mwh"].iloc[2] == pytest.approx(-4.50)


def test_a85_acknowledgement_becomes_a_price_fetch_error():
    with pytest.raises(PriceFetchError):
        iberia._parse_a85_xml(ACK_XML)


def test_fetch_imbalance_prices_labels_its_source():
    session = FakeSession(A85_XML)
    df = iberia.fetch_imbalance_prices("ES", date(2026, 7, 20), date(2026, 7, 20),
                                       api_token="test-token", session=session)
    assert df.attrs["price_source"] == "entsoe_a85"
    assert df.attrs["zone"] == "ES"
    assert df.attrs["currency"] == "EUR"
    assert df.attrs["resolution_minutes"] == 15
    _url, params = session.calls[0]
    # Imbalance is settled per control area, not across a bidding-zone border.
    assert params["documentType"] == "A85"
    assert params["controlArea_Domain"] == "10YES-REE------0"
    assert "in_Domain" not in params and "out_Domain" not in params


def test_fetch_imbalance_prices_needs_a_token(monkeypatch):
    monkeypatch.setattr(iberia, "_TOKEN", None)
    monkeypatch.delenv("ENTSOE_API_TOKEN", raising=False)
    with pytest.raises(PriceFetchError):
        iberia.fetch_imbalance_prices("ES", date(2026, 7, 20), date(2026, 7, 20))


def test_fetch_imbalance_prices_rejects_a_non_iberian_zone():
    with pytest.raises(ValueError):
        iberia.fetch_imbalance_prices("DE-LU", date(2026, 7, 20), date(2026, 7, 20))


# ---------------------------------------------------------------------------
# Shared plumbing after the refactor


def test_price_fetch_error_is_still_importable_from_entsoe():
    from nuravolt.markets.entsoe import PriceFetchError as FromEntsoe
    from nuravolt.markets import PriceFetchError as FromPackage

    assert FromEntsoe is PriceFetchError
    assert FromPackage is PriceFetchError


def test_entsoe_imbalance_forwards_iberia_and_still_refuses_the_rest():
    session = FakeSession(A85_XML)
    df = entsoe.fetch_imbalance_prices("ES", date(2026, 7, 20), date(2026, 7, 20),
                                       api_token="test-token", session=session)
    assert df.attrs["price_source"] == "entsoe_a85"

    with pytest.raises(NotImplementedError):
        entsoe.fetch_imbalance_prices("DE-LU", date(2026, 7, 20), date(2026, 7, 20))


def test_month_span_covers_partial_months():
    spans = month_span(date(2026, 1, 15), date(2026, 3, 2))
    assert spans == [
        (date(2026, 1, 1), date(2026, 2, 1)),
        (date(2026, 2, 1), date(2026, 3, 1)),
        (date(2026, 3, 1), date(2026, 4, 1)),
    ]
