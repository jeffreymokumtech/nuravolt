#!/usr/bin/env python3
"""
Fetch NREL Soiling Map Data

Downloads soiling data from all 255 US sites with actual soiling ratio
measurements from NREL's Photovoltaic Module Soiling Map.

Data source: https://www.nrel.gov/pv/soiling.html
Data format: JSON at /docs/libraries/pv/soiling_data.json

Output:
- datasets/nrel_soiling_map/nrel_soiling_sites.csv - All sites with metadata
- datasets/nrel_soiling_map/nrel_soiling_monthly.csv - Monthly soiling rates
- datasets/nrel_soiling_map/nrel_soiling_raw.json - Raw JSON data
"""

import json
import requests
import pandas as pd
from pathlib import Path
from datetime import datetime


def fetch_nrel_soiling_data():
    """Fetch the soiling data JSON from NREL."""
    url = "https://www.nrel.gov/docs/libraries/pv/soiling_data.json"

    print(f"Fetching NREL soiling data from: {url}")

    response = requests.get(url, timeout=30)
    response.raise_for_status()

    data = response.json()
    print(f"Successfully fetched data for {len(data)} sites")

    return data


MONTH_MAP = {
    'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
    'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
}


def parse_iwsr_value(value) -> float | None:
    """Parse IWSR value which can be float, string like '>0.99', or None."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        # Handle values like ">0.99" - extract the numeric part
        cleaned = value.replace('>', '').replace('<', '').strip()
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def parse_site_data(data: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Parse the NREL soiling data into structured DataFrames.

    The data is a dict keyed by site ID with fields:
    - "Measurement type", "IWSR", "IWSR lower", "IWSR upper"
    - "Monthly soiling rates", "Annual IWSR", "Months in data set"
    - "Latitude", "Longitude", "Tilt", "County", "State", "Mounting"

    Returns:
        sites_df: Site-level metadata and annual soiling ratios
        monthly_df: Monthly soiling rates for each site
    """
    sites = []
    monthly_records = []

    for site_id, site in data.items():
        # Extract site metadata
        site_info = {
            'site_id': site_id,
            'latitude': site.get('Latitude'),
            'longitude': site.get('Longitude'),
            'state': site.get('State', ''),
            'county': site.get('County', ''),
            'measurement_type': site.get('Measurement type', ''),
            'tilt_degrees': site.get('Tilt'),
            'mounting': site.get('Mounting', ''),
            'months_in_dataset': site.get('Months in data set'),
        }

        # Extract annual soiling ratio (IWSR = Insolation-Weighted Soiling Ratio)
        site_info['iwsr'] = parse_iwsr_value(site.get('IWSR'))
        site_info['iwsr_lower_95'] = parse_iwsr_value(site.get('IWSR lower'))
        site_info['iwsr_upper_95'] = parse_iwsr_value(site.get('IWSR upper'))

        # Extract annual IWSR by year if available
        annual_iwsr = site.get('Annual IWSR', {})
        if isinstance(annual_iwsr, dict) and annual_iwsr:
            years = list(annual_iwsr.keys())
            site_info['years_available'] = len(years)
            site_info['year_range'] = f"{min(years)}-{max(years)}" if years else ""
        else:
            site_info['years_available'] = 0
            site_info['year_range'] = ""

        sites.append(site_info)

        # Extract monthly soiling rates
        # Can be a list of lists [[month_name, rate, lower, upper, count], ...] or a string
        # First row is header: ['Month', 'Soiling rate', 'Soiling rate lower', 'Soiling rate upper', 'Interval count']
        # Month is a string like 'Jan', 'Feb', etc.
        monthly = site.get('Monthly soiling rates')
        if isinstance(monthly, list):
            for month_data in monthly:
                if isinstance(month_data, list) and len(month_data) >= 5:
                    # Skip header row
                    if month_data[0] == 'Month':
                        continue
                    try:
                        # Convert month name to number
                        month_num = MONTH_MAP.get(month_data[0])
                        if month_num is None:
                            continue
                        monthly_records.append({
                            'site_id': site_id,
                            'latitude': site_info['latitude'],
                            'longitude': site_info['longitude'],
                            'month': month_num,
                            'soiling_rate_per_day': float(month_data[1]) if month_data[1] is not None else None,
                            'soiling_rate_lower_95': float(month_data[2]) if month_data[2] is not None else None,
                            'soiling_rate_upper_95': float(month_data[3]) if month_data[3] is not None else None,
                            'n_intervals': int(month_data[4]) if month_data[4] is not None else None,
                        })
                    except (ValueError, TypeError):
                        # Skip malformed rows
                        continue

    sites_df = pd.DataFrame(sites)
    monthly_df = pd.DataFrame(monthly_records)

    return sites_df, monthly_df


def save_data(data: dict, sites_df: pd.DataFrame, monthly_df: pd.DataFrame, output_dir: Path):
    """Save the data to files."""
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save raw JSON
    raw_path = output_dir / "nrel_soiling_raw.json"
    with open(raw_path, 'w') as f:
        json.dump(data, f, indent=2)
    print(f"Saved raw JSON: {raw_path}")

    # Save sites CSV
    sites_path = output_dir / "nrel_soiling_sites.csv"
    sites_df.to_csv(sites_path, index=False)
    print(f"Saved sites data: {sites_path} ({len(sites_df)} sites)")

    # Save monthly CSV
    monthly_path = output_dir / "nrel_soiling_monthly.csv"
    monthly_df.to_csv(monthly_path, index=False)
    print(f"Saved monthly data: {monthly_path} ({len(monthly_df)} records)")

    # Save metadata
    metadata = {
        'source': 'NREL Photovoltaic Module Soiling Map',
        'url': 'https://www.nrel.gov/pv/soiling.html',
        'fetched_at': datetime.now().isoformat(),
        'n_sites': len(sites_df),
        'n_monthly_records': len(monthly_df),
        'measurement_types': sites_df['measurement_type'].value_counts().to_dict(),
        'states_covered': sorted(sites_df['state'].dropna().unique().tolist()),
        'fields': {
            'iwsr': 'Insolation-weighted mean of all daily soiling ratios (1.0 = clean)',
            'soiling_rate_per_day': 'Soiling rate in fractional units per day (negative = loss, -0.001 = 0.1%/day loss)',
            'measurement_type': 'Soiling Station = dedicated sensor, PV System = derived from performance'
        }
    }

    metadata_path = output_dir / "README.json"
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"Saved metadata: {metadata_path}")


def print_summary(sites_df: pd.DataFrame, monthly_df: pd.DataFrame):
    """Print a summary of the downloaded data."""
    print("\n" + "="*60)
    print("NREL SOILING MAP DATA SUMMARY")
    print("="*60)

    print(f"\nTotal sites: {len(sites_df)}")
    print(f"\nMeasurement types:")
    for mtype, count in sites_df['measurement_type'].value_counts().items():
        print(f"  - {mtype}: {count}")

    print(f"\nStates covered: {sites_df['state'].nunique()}")
    print(f"Top 5 states by site count:")
    for state, count in sites_df['state'].value_counts().head(5).items():
        print(f"  - {state}: {count}")

    print(f"\nSoiling ratio statistics (IWSR):")
    print(f"  - Mean: {sites_df['iwsr'].mean():.4f}")
    print(f"  - Min:  {sites_df['iwsr'].min():.4f}")
    print(f"  - Max:  {sites_df['iwsr'].max():.4f}")

    print(f"\nMonthly data:")
    print(f"  - Total records: {len(monthly_df)}")
    if len(monthly_df) > 0:
        print(f"  - Mean soiling rate: {monthly_df['soiling_rate_per_day'].mean():.6f}/day")
        print(f"  - Max soiling rate:  {monthly_df['soiling_rate_per_day'].max():.6f}/day")
        print(f"  - Sites with monthly data: {monthly_df['site_id'].nunique()}")


def main():
    """Main entry point."""
    # Determine output directory
    script_dir = Path(__file__).parent.parent
    output_dir = script_dir / "datasets" / "nrel_soiling_map"

    print("NREL Soiling Map Data Fetcher")
    print("-" * 40)

    # Fetch data
    data = fetch_nrel_soiling_data()

    # Parse into DataFrames
    sites_df, monthly_df = parse_site_data(data)

    # Save to files
    save_data(data, sites_df, monthly_df, output_dir)

    # Print summary
    print_summary(sites_df, monthly_df)

    print("\n" + "="*60)
    print("Done! Data saved to:", output_dir)
    print("="*60)


if __name__ == "__main__":
    main()
