#!/usr/bin/env python
"""
Run a BESS audit engagement from a client data drop: no onboarding required.

Produces one or both paid deliverables plus their JSON bundles (consumed by
the Audit UI):

- Optimizer Performance Audit: realized dispatch revenue vs the
  degradation-aware perfect-foresight day-ahead benchmark.
- Warranty & Degradation Dossier: SoH forensics, rainflow cycle
  reconstruction, violation register, evidence appendix.

Examples:
    # Specimen reports from synthetic telemetry on real ES prices (sales asset)
    python scripts/run_bess_audit.py --demo

    # Client engagement from a telemetry drop
    python scripts/run_bess_audit.py \
        --telemetry drops/client_bess.parquet --zone ES \
        --capacity-kwh 2000 --power-kw 1000 --asset-name "Client BESS 1" \
        --warranty-pdf drops/warranty.pdf --report both

Prices are fetched per zone: ENTSO-E when ENTSOE_API_TOKEN is set, else
energy-charts.info (token-free), and Elexon for GB, which left the ENTSO-E
Transparency Platform after Brexit. GB comes back as 48 half-hourly settlement
periods in GBP/MWh and is never averaged down to hourly: intra-hour spread is
the thing a GB battery trades. Power sign convention is auto-detected against
prices.
"""

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from nuravolt.bess.config import BessAssetConfig, BessChemistry, WarrantyTermsConfig
from nuravolt.bess.dossier import _auto_columns, build_warranty_dossier, save_bundle
from nuravolt.bess.optimizer_audit import AuditAssetSpec, run_optimizer_audit
from nuravolt.bess.report_generator import (
    generate_optimizer_audit_pdf,
    generate_warranty_dossier_pdf,
)
from nuravolt.markets import fetch_day_ahead_prices

ZONE_TZ = {
    "ES": "Europe/Madrid", "PT": "Europe/Lisbon", "FR": "Europe/Paris",
    "BE": "Europe/Brussels", "NL": "Europe/Amsterdam", "DE-LU": "Europe/Berlin",
    "AT": "Europe/Vienna", "IT-NORTH": "Europe/Rome", "PL": "Europe/Warsaw",
    "GR": "Europe/Athens", "GB": "Europe/London",
}

ZONE_CURRENCY = {"GB": "GBP"}  # everything else on the ENTSO-E ladder clears in EUR


def fetch_prices(zone: str, start, end) -> pd.DataFrame:
    """Zone-aware price fetch, in the frame shape the audit modules read.

    GB is served by nuravolt.markets.gb (Elexon, 48 half-hourly periods in
    GBP/MWh); every other zone by the ENTSO-E client. GB's series is a market
    INDEX price, not a day-ahead auction clearing price, so captions built on
    it must say "market index price".

    nuravolt.bess.optimizer_audit reads a column literally named
    ``price_eur_mwh``, so the GB frame is renamed into that column. The values
    stay in GBP: ``attrs["currency"]`` is the authoritative label, and this
    script refuses to emit the EUR-labelled PDF for a non-EUR zone rather than
    print sterling under a euro sign.
    """
    if zone.upper() == "GB":
        from nuravolt.markets import gb

        df = gb.fetch_day_ahead_prices("GB", start, end)
        out = df.rename(columns={"price_gbp_mwh": "price_eur_mwh"})
        out.attrs.update(df.attrs)
        return out
    return fetch_day_ahead_prices(zone, start, end)


def load_telemetry(paths: list[str]) -> pd.DataFrame:
    frames = []
    for path in paths:
        p = Path(path)
        if not p.exists():
            raise SystemExit(f"telemetry file not found: {p}")
        if p.suffix.lower() in (".parquet", ".pq"):
            frames.append(pd.read_parquet(p))
        else:
            frames.append(pd.read_csv(p))
    df = pd.concat(frames, ignore_index=True)
    return df


def synthesize_demo_telemetry(prices: pd.DataFrame, spec: AuditAssetSpec, seed: int = 7):
    """
    Synthetic but physically coherent BESS telemetry driven by real prices:
    an imperfect threshold-arbitrage operator with occasional idle days,
    summer container-temperature excursions with correlated HVAC failures,
    and weekend high-SoC dwell. Deterministic under the given seed.
    """
    rng = np.random.default_rng(seed)
    idx = pd.date_range(prices.index.min().floor("D"), prices.index.max(), freq="15min", tz="UTC")
    p = prices["price_eur_mwh"].reindex(
        prices["price_eur_mwh"].index.union(idx)).ffill().reindex(idx)

    eta = spec.eta_one_way
    dt = 0.25
    soc_kwh = 0.5 * spec.capacity_kwh
    rows = []
    for day, grp in p.groupby(p.index.date):
        perceived = grp.to_numpy() + rng.normal(0, 9, len(grp))
        lo, hi = np.percentile(perceived, 30), np.percentile(perceived, 70)
        idle_day = rng.random() < 0.08
        weekend_hold = pd.Timestamp(day).dayofweek == 5  # Saturdays: park at high SoC
        heatwave = pd.Timestamp(day).month in (6, 7, 8) and rng.random() < 0.25
        for ts, perceived_price in zip(grp.index, perceived):
            hour = ts.tz_convert("Europe/Madrid").hour
            act = 0.0
            if weekend_hold:
                if soc_kwh < 0.97 * spec.capacity_kwh:
                    act = -0.5 * spec.max_power_kw
            elif not idle_day:
                if perceived_price <= lo and soc_kwh < 0.92 * spec.capacity_kwh:
                    act = -0.8 * spec.max_power_kw
                elif perceived_price >= hi and soc_kwh > 0.10 * spec.capacity_kwh:
                    act = 0.8 * spec.max_power_kw

            soc_frac = soc_kwh / spec.capacity_kwh
            base_temp = 22 + 6 * np.sin((hour - 9) / 24 * 2 * np.pi)
            hvac_ok = 1
            if heatwave and 13 <= hour <= 18:
                base_temp += rng.uniform(12, 17)
                hvac_ok = 0
            temp = base_temp + abs(act) / spec.max_power_kw * 3 + rng.normal(0, 0.4)
            cell_v = 3.05 + 0.40 * soc_frac + rng.normal(0, 0.005)

            rows.append({
                "timestamp": ts.tz_convert(None),
                "power_kw": act,
                "soc": round(soc_frac, 4),
                "temperature_c": round(temp, 2),
                "cell_voltage_v": round(cell_v, 3),
                "hvac_status": hvac_ok,
            })
            soc_kwh += (max(-act, 0) * eta - max(act, 0) / eta) * dt
            soc_kwh = float(np.clip(soc_kwh, 0.03 * spec.capacity_kwh, 0.985 * spec.capacity_kwh))

    return pd.DataFrame(rows)


def run(args) -> None:
    zone = args.zone
    day_tz = args.day_tz or ZONE_TZ.get(zone.upper(), "UTC")
    currency = ZONE_CURRENCY.get(zone.upper(), "EUR")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    spec = AuditAssetSpec(
        capacity_kwh=args.capacity_kwh,
        max_power_kw=args.power_kw,
        round_trip_efficiency=args.efficiency,
        degradation_cost_per_kwh=args.degradation_cost,
        asset_name=args.asset_name,
    )

    if args.demo:
        end = datetime.now(timezone.utc).date() - timedelta(days=5)
        start = end - timedelta(days=args.demo_days)
        print(f"Fetching real {zone} prices {start}..{end} ...")
        prices = fetch_prices(zone, start, end)
        currency = str(prices.attrs.get("currency", currency))
        print(f"  {len(prices)} price points via {prices.attrs['price_source']} "
              f"({currency}/MWh, {prices.attrs.get('resolution_minutes', 60)} min periods)")
        print("Synthesizing specimen telemetry (imperfect operator, injected stressors) ...")
        telemetry = synthesize_demo_telemetry(prices, spec)
        specimen = True
    else:
        if not args.telemetry:
            raise SystemExit("--telemetry is required (or use --demo)")
        telemetry = load_telemetry(args.telemetry)
        specimen = args.specimen
        mapping = _auto_columns(telemetry)
        ts_col = args.timestamp_column or mapping.get("timestamp")
        if ts_col is None:
            raise SystemExit(f"could not detect a timestamp column in {list(telemetry.columns)}")
        renames = {ts_col: "timestamp"}
        for arg_name, target in (("power_column", "power_kw"), ("soc_column", "soc"),
                                 ("temp_column", "temperature_c"),
                                 ("voltage_column", "cell_voltage_v")):
            source = getattr(args, arg_name) or mapping.get(target.split("_")[0] if target != "power_kw" else "power")
            if source and source != target and source in telemetry.columns:
                renames[source] = target
        telemetry = telemetry.rename(columns=renames)
        if "power_kw" not in telemetry.columns:
            raise SystemExit("could not detect a power column; pass --power-column")
        telemetry["timestamp"] = pd.to_datetime(telemetry["timestamp"])
        t0, t1 = telemetry["timestamp"].min(), telemetry["timestamp"].max()
        print(f"Loaded {len(telemetry):,} telemetry rows {t0} .. {t1}")
        print(f"Fetching {zone} prices ...")
        prices = fetch_prices(zone, t0.date(), t1.date())
        currency = str(prices.attrs.get("currency", currency))
        print(f"  {len(prices)} price points via {prices.attrs['price_source']} "
              f"({currency}/MWh, {prices.attrs.get('resolution_minutes', 60)} min periods)")

    audit_dict = None
    if args.report in ("optimizer", "both"):
        print("Running optimizer performance audit ...")
        indexed = telemetry.set_index(pd.DatetimeIndex(pd.to_datetime(telemetry["timestamp"]), tz=None))
        audit = run_optimizer_audit(
            indexed, prices, spec,
            power_col="power_kw",
            soc_col="soc" if "soc" in telemetry.columns else None,
            power_sign=args.power_sign, day_tz=day_tz,
        )
        summary = audit.summary()
        capture = summary.get("capture_ratio")
        print(f"  days analyzed: {summary['days_analyzed']} | capture ratio: "
              f"{capture if capture is not None else 'n/a'} | annualized gap: "
              f"{currency} {summary.get('annualized_gap_eur')}")
        if audit.power_sign_flipped:
            telemetry = telemetry.assign(power_kw=-telemetry["power_kw"])
            print("  note: power sign flipped to discharge-positive for all analyses")
        audit_dict = audit.to_dict()
        # The audit's own money keys carry a legacy _eur suffix. Stamp the real
        # settlement currency alongside them so a reader of the bundle is never
        # left inferring it from the key names.
        audit_dict["summary"]["currency"] = currency
        audit_dict["summary"]["price_resolution_minutes"] = int(
            prices.attrs.get("resolution_minutes", 60))
        bundle_path = out_dir / "optimizer_audit.json"
        bundle_path.write_text(json.dumps(audit_dict, indent=2, default=str))
        print(f"  wrote {bundle_path}")
        if currency == "EUR":
            pdf_path = generate_optimizer_audit_pdf(
                audit_dict, str(out_dir / "optimizer_performance_audit.pdf"), specimen=specimen)
            print(f"  wrote {pdf_path}")
        else:
            # nuravolt/bess/report_generator.py prints every amount with a hard
            # "EUR" prefix. Emitting that for a GBP audit would put sterling
            # under a euro sign in a client deliverable, so the PDF is withheld
            # until the generator takes the currency from the bundle.
            print(f"  skipped the PDF: the optimizer report labels every amount EUR and this "
                  f"audit settles in {currency}. The JSON bundle above carries the real "
                  f"figures and their currency.")

    if args.report in ("warranty", "both"):
        print("Building warranty and degradation dossier ...")
        asset = BessAssetConfig(
            asset_id=args.asset_id,
            plant_id=args.asset_id,
            name=args.asset_name,
            chemistry=BessChemistry(args.chemistry),
            nominal_capacity_kwh=args.capacity_kwh,
            nominal_power_kw=args.power_kw,
            installation_date=(datetime.fromisoformat(args.installation_date)
                               if args.installation_date else None),
        )
        capacity_tests = None
        if args.capacity_tests:
            raw = json.loads(Path(args.capacity_tests).read_text())
            capacity_tests = [
                {**t, "test_date": datetime.fromisoformat(t["test_date"])} for t in raw
            ]
        elif args.demo:
            install = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=820)
            asset.installation_date = install
            capacity_tests = [
                {"test_date": install + timedelta(days=190),
                 "measured_capacity_kwh": args.capacity_kwh * 0.985,
                 "soh_result": 0.985, "test_type": "commissioning_retest"},
                {"test_date": install + timedelta(days=560),
                 "measured_capacity_kwh": args.capacity_kwh * 0.962,
                 "soh_result": 0.962, "test_type": "annual_capacity_test"},
            ]
        bundle = build_warranty_dossier(
            telemetry,
            asset=asset,
            terms=WarrantyTermsConfig(),
            capacity_tests=capacity_tests,
            warranty_pdf=Path(args.warranty_pdf) if args.warranty_pdf else None,
            source_files=[Path(p) for p in (args.telemetry or [])],
        )
        bundle_path = save_bundle(bundle, out_dir / "warranty_dossier.json")
        pdf_path = generate_warranty_dossier_pdf(
            bundle, str(out_dir / "warranty_degradation_dossier.pdf"), specimen=specimen)
        health = bundle["health_score"]
        print(f"  SoH {health['current_soh']:.1%} | score {health['score']}/100 "
              f"({health['risk_level']}) | violations: {len(bundle['violations'])}")
        print(f"  wrote {pdf_path} and {bundle_path}")

    print("Done.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--telemetry", nargs="+", help="Telemetry CSV/parquet file(s)")
    parser.add_argument("--demo", action="store_true",
                        help="Generate specimen reports from synthetic telemetry on real prices")
    parser.add_argument("--demo-days", type=int, default=90)
    parser.add_argument("--zone", default="ES",
                        help="Bidding zone, e.g. ES, PT, DE-LU, GB (default ES)")
    parser.add_argument("--day-tz", default=None, help="Delivery-day timezone (default from zone)")
    parser.add_argument("--report", choices=["optimizer", "warranty", "both"], default="both")
    parser.add_argument("--out", default=None, help="Output directory")
    parser.add_argument("--specimen", action="store_true",
                        help="Stamp SPECIMEN watermark (always on for --demo)")

    parser.add_argument("--asset-name", default="NV Demo BESS 1")
    parser.add_argument("--asset-id", default="nv-demo-bess-1")
    parser.add_argument("--chemistry", default="lfp", choices=["lfp", "nmc", "nca", "lto"])
    parser.add_argument("--capacity-kwh", type=float, default=2000.0)
    parser.add_argument("--power-kw", type=float, default=1000.0)
    parser.add_argument("--efficiency", type=float, default=0.88, help="Round-trip efficiency")
    parser.add_argument("--degradation-cost", type=float, default=0.005,
                        help="Cost per kWh throughput, in the zone's settlement currency")
    parser.add_argument("--installation-date", default=None, help="ISO date")
    parser.add_argument("--power-sign", default="auto",
                        choices=["auto", "discharge_positive", "charge_positive"])

    parser.add_argument("--timestamp-column", default=None)
    parser.add_argument("--power-column", default=None)
    parser.add_argument("--soc-column", default=None)
    parser.add_argument("--temp-column", default=None)
    parser.add_argument("--voltage-column", default=None)

    parser.add_argument("--warranty-pdf", default=None,
                        help="Warranty contract PDF; terms extracted via Bedrock")
    parser.add_argument("--capacity-tests", default=None,
                        help="JSON file with capacity test records")

    args = parser.parse_args()
    if args.out is None:
        if args.demo:
            args.out = str(PROJECT_ROOT / "sales-assets" / "bess-audit-specimen")
        else:
            args.out = str(PROJECT_ROOT / "backenddata" / "outputs" / "bess_audit" / args.asset_id)
    run(args)


if __name__ == "__main__":
    main()
