#!/usr/bin/env python
"""Quick check for specific Alpha inverters with power loss issues."""

import sys
from pathlib import Path
import polars as pl
import re

# Target inverters
TARGET_INVERTERS = ['04.099', '05.143']

def main():
    # Load data
    data_path = Path("demo_spain/emsdt_650addffb0721062b19a6636_15_00461_Inverter_Inverter Power Normalized_training.parquet")

    print(f"Loading Alpha data from {data_path}...")
    print("Using full dataset (no sampling)...")

    lf = pl.scan_parquet(data_path)

    # Get columns for target inverters
    all_columns = lf.collect_schema().names()

    needed_cols = ['timestamp']

    # Plant-level weather columns
    weather_patterns = ['irradiation', 'ambient', 'module', 'altitude', 'azimuth',
                       'luftfeuchtigkeit', 'windgeschwindigkeit', 'power by inverter']

    for col in all_columns:
        col_lower = col.lower()
        # Add weather columns
        if any(pattern in col_lower for pattern in weather_patterns):
            needed_cols.append(col)
            continue

        # Add target inverter columns
        for inv_id in TARGET_INVERTERS:
            if f'inv {inv_id}' in col_lower:
                needed_cols.append(col)
                break

    print(f"  Selected {len(needed_cols)} columns (timestamp + weather + target inverters)")

    # Collect the data
    df = lf.select(needed_cols).collect()
    print(f"  Loaded {len(df):,} rows x {len(df.columns)} columns")

    # Check if inverters exist
    for inv_id in TARGET_INVERTERS:
        inv_cols = [col for col in df.columns if f'INV {inv_id}' in col]
        print(f"\n  INV {inv_id}: Found {len(inv_cols)} columns")
        if inv_cols:
            # Show ALL column names
            print(f"    All columns:")
            for col in sorted(inv_cols):
                print(f"      - {col}")

            # Check for AC power column
            power_cols = [col for col in inv_cols if 'ac power' in col.lower() or 'ac_power' in col.lower()]
            if power_cols:
                print(f"    Power column: {power_cols[0]}")

                # Get power data statistics
                power_data = df.select(power_cols[0]).to_series()
                non_null = power_data.drop_nulls()
                if len(non_null) > 0:
                    print(f"    Power stats:")
                    print(f"      Non-null records: {len(non_null):,} / {len(power_data):,}")
                    print(f"      Mean: {non_null.mean():.2f} kW")
                    print(f"      Max: {non_null.max():.2f} kW")
                    print(f"      Zero power records: {(non_null == 0).sum():,}")

    # Run detection for each inverter
    for inv_id in TARGET_INVERTERS:
        print(f"\n{'='*60}")
        print(f"FAULT DETECTION: INV {inv_id}")
        print(f"{'='*60}")

        # Get inverter columns
        inv_cols = [col for col in df.columns if f'INV {inv_id}' in col]

        if not inv_cols:
            print(f"  ERROR: No columns found for INV {inv_id}")
            continue

        # Extract AC power, DC voltage, DC current columns
        ac_power_col = next((col for col in inv_cols if 'p_ac' in col.lower()), None)

        if not ac_power_col:
            print(f"  ERROR: No AC power column found for INV {inv_id}")
            continue

        # Find weather columns
        irr_col = next((col for col in df.columns if 'irradiation' in col.lower() and 'plant' in col.lower()), None)

        # Get DC voltage and current columns
        dc_voltage_cols = [col for col in inv_cols if 'u_dc' in col.lower()]
        dc_current_cols = [col for col in inv_cols if 'input_current' in col.lower()]

        # Prepare inverter dataframe
        select_cols = [
            pl.col('timestamp'),
            pl.col(ac_power_col).alias('ac_power'),
        ]

        if irr_col:
            select_cols.append(pl.col(irr_col).alias('poa_irradiance'))

        # Add all DC voltages and currents
        for col in dc_voltage_cols + dc_current_cols:
            select_cols.append(pl.col(col))

        inv_df = df.select(select_cols)

        print(f"\n  Processing {len(inv_df):,} records...")
        print(f"    DC voltage channels: {len(dc_voltage_cols)}")
        print(f"    DC current channels: {len(dc_current_cols)}")

        # Check for extended offline periods
        offline_records = inv_df.filter(
            (pl.col('ac_power').is_null()) | (pl.col('ac_power') == 0)
        )

        if 'poa_irradiance' in inv_df.columns:
            # Check for offline during high irradiance (daylight hours)
            daylight_offline = offline_records.filter(
                pl.col('poa_irradiance') > 200  # W/m²
            )

            if len(daylight_offline) > 0:
                print(f"\n  ⚠️  ISSUE DETECTED: Inverter offline during daylight")
                print(f"    Total offline records: {len(offline_records):,}")
                print(f"    Offline during high irradiance (>200 W/m²): {len(daylight_offline):,}")
                print(f"    % of total records offline: {len(offline_records)/len(inv_df)*100:.1f}%")
                print(f"    % of daylight hours offline: {len(daylight_offline)/len(inv_df)*100:.1f}%")

                # Show time range
                timestamps = daylight_offline.select('timestamp').to_series()
                print(f"\n  Offline period:")
                print(f"    First offline: {timestamps.min()}")
                print(f"    Last offline: {timestamps.max()}")

                # DIAGNOSTIC: Analyze DC-side during offline periods
                print(f"\n  {'='*50}")
                print(f"  DC-SIDE DIAGNOSTIC (during daylight offline)")
                print(f"  {'='*50}")

                # Sample some offline records during high irradiance
                sample_offline = daylight_offline.head(500)

                # Check DC voltages
                if dc_voltage_cols:
                    print(f"\n  DC Voltage Analysis:")
                    for voltage_col in dc_voltage_cols[:3]:  # Check first 3 strings
                        voltage_data = sample_offline.select(pl.col(voltage_col)).to_series()
                        non_null = voltage_data.drop_nulls()
                        if len(non_null) > 0:
                            avg_voltage = non_null.mean()
                            string_num = voltage_col.split('_')[-1].replace('(V)', '').strip()
                            print(f"    String {string_num}: Avg = {avg_voltage:.1f}V, " +
                                  f"Min = {non_null.min():.1f}V, Max = {non_null.max():.1f}V")
                            if avg_voltage > 400:
                                print(f"      ✓ DC voltage PRESENT (>{avg_voltage:.0f}V) → INVERTER ISSUE")
                            else:
                                print(f"      ✗ DC voltage LOW (<400V) → DC-SIDE ISSUE")

                # Check DC currents
                if dc_current_cols:
                    print(f"\n  DC Current Analysis:")
                    string_status = []
                    for current_col in dc_current_cols:
                        current_data = sample_offline.select(pl.col(current_col)).to_series()
                        non_null = current_data.drop_nulls()
                        if len(non_null) > 0:
                            avg_current = non_null.mean()
                            string_num = current_col.split('_')[-1].replace('(A)', '').strip()
                            status = "PRODUCING" if avg_current > 1.0 else "ZERO"
                            string_status.append((string_num, avg_current, status))

                    # Print current analysis
                    producing_strings = sum(1 for _, _, s in string_status if s == "PRODUCING")
                    zero_strings = sum(1 for _, _, s in string_status if s == "ZERO")

                    for string_num, avg_current, status in string_status[:4]:  # Show first 4
                        print(f"    String {string_num}: {avg_current:.2f}A ({status})")

                    print(f"\n  String Summary:")
                    print(f"    Producing strings (>1A): {producing_strings}/{len(string_status)}")
                    print(f"    Zero current strings: {zero_strings}/{len(string_status)}")

                    # Diagnosis
                    print(f"\n  🔍 DIAGNOSIS:")
                    if producing_strings > 0:
                        print(f"    → DC current detected in {producing_strings} strings")
                        print(f"    → DC voltage likely present")
                        print(f"    → AC power = 0 despite DC production")
                        print(f"    ✗ CONCLUSION: INVERTER ELECTRONICS FAILURE")
                        print(f"       - Inverter not converting DC to AC")
                        print(f"       - Possible: communication failure, MPPT issue, inverter fault")
                    elif zero_strings == len(string_status):
                        print(f"    → All strings showing zero current")
                        print(f"    → AC power = 0")
                        print(f"    ✗ CONCLUSION: DC-SIDE ISSUE or COMPLETE INVERTER SHUTDOWN")
                        print(f"       - Possible: string disconnection, combiner box issue")
                        print(f"       - Or: inverter completely offline (not tracking MPPT)")
                    else:
                        print(f"    → Mixed string performance")
                        print(f"    ⚠️  CONCLUSION: PARTIAL STRING FAILURE")

        else:
            print(f"\n  Total offline records: {len(offline_records):,} ({len(offline_records)/len(inv_df)*100:.1f}%)")

if __name__ == '__main__':
    main()
