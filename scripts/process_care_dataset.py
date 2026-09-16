#!/usr/bin/env python3
"""
CARE Dataset Processing CLI

Downloads the CARE dataset from Zenodo and generates demo-ready JSON files
for the NuraVolt wind monitoring dashboard.

Usage:
    python scripts/process_care_dataset.py --farm A --output public/data/wind/care-portugal
    python scripts/process_care_dataset.py --generate-only --output public/data/wind/care-portugal

Options:
    --farm: Which wind farm (A=Portugal, B/C=Germany offshore). Default: A
    --output: Output directory for generated files
    --download-only: Only download, don't generate demo files
    --generate-only: Skip download, use existing cached data
    --max-files: Limit number of files to download (for testing)
    --cache-dir: Directory to cache downloaded files
    --verbose: Enable verbose logging
"""

import argparse
import logging
import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.wind.care_processor import (
    CAREDataLoader,
    CAREDemoGenerator,
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(
        description="Process CARE dataset for wind monitoring demo",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Full pipeline: download + generate
    python scripts/process_care_dataset.py --farm A --output public/data/wind/care-portugal

    # Generate demo files only (uses cached data)
    python scripts/process_care_dataset.py --generate-only --output public/data/wind/care-portugal

    # Download only (for inspection)
    python scripts/process_care_dataset.py --download-only --farm A

    # Quick test with limited files
    python scripts/process_care_dataset.py --farm A --max-files 3 --output test_output
        """
    )

    parser.add_argument(
        '--farm',
        type=str,
        choices=['A', 'B', 'C'],
        default='A',
        help="Wind farm to process. A=Portugal (5 turbines), B/C=Germany offshore"
    )
    parser.add_argument(
        '--output',
        type=str,
        default='public/data/wind/care-portugal',
        help="Output directory for generated demo files"
    )
    parser.add_argument(
        '--download-only',
        action='store_true',
        help="Only download data, skip demo file generation"
    )
    parser.add_argument(
        '--generate-only',
        action='store_true',
        help="Skip download, generate from cached data or synthetic fallback"
    )
    parser.add_argument(
        '--max-files',
        type=int,
        default=None,
        help="Limit number of files to download (for testing)"
    )
    parser.add_argument(
        '--cache-dir',
        type=str,
        default=None,
        help="Directory to cache downloaded files"
    )
    parser.add_argument(
        '-v', '--verbose',
        action='store_true',
        help="Enable verbose logging"
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    output_dir = Path(args.output)
    cache_dir = Path(args.cache_dir) if args.cache_dir else None

    logger.info(f"CARE Dataset Processor")
    logger.info(f"  Farm: {args.farm}")
    logger.info(f"  Output: {output_dir}")

    # Initialize loader
    loader = CAREDataLoader(cache_dir=cache_dir)

    # Step 1: Download (if not --generate-only)
    data_dir = None
    if not args.generate_only:
        try:
            logger.info("Downloading CARE dataset from Zenodo...")
            data_dir = loader.download_dataset(
                farm=args.farm,
                max_files=args.max_files
            )
            logger.info(f"Downloaded to: {data_dir}")

            # List available datasets
            datasets = loader.list_datasets(data_dir)
            logger.info(f"Found {len(datasets)} dataset files")
            for ds in datasets[:5]:
                logger.info(f"  - {ds.file_name} (Farm {ds.farm}, Turbine {ds.turbine_id})")
            if len(datasets) > 5:
                logger.info(f"  ... and {len(datasets) - 5} more")

        except Exception as e:
            logger.warning(f"Download failed: {e}")
            logger.info("Falling back to synthetic data generation...")
            data_dir = None

    if args.download_only:
        logger.info("Download complete (--download-only specified)")
        return

    # Step 2: Generate demo files
    logger.info("Generating demo JSON files...")

    # Use cached data directory if available
    if data_dir is None:
        data_dir = loader.cache_dir / f"farm_{args.farm}"
        if not data_dir.exists():
            data_dir.mkdir(parents=True, exist_ok=True)
            logger.info("Using synthetic data (no CARE files found)")

    generator = CAREDemoGenerator(data_dir=data_dir, farm=args.farm)
    generator.generate_all(output_dir)

    # Summary
    logger.info("\n" + "=" * 60)
    logger.info("Generation complete!")
    logger.info("=" * 60)
    logger.info(f"Output directory: {output_dir}")
    logger.info("\nGenerated files:")

    for f in sorted(output_dir.rglob("*.json")):
        rel_path = f.relative_to(output_dir)
        size_kb = f.stat().st_size / 1024
        logger.info(f"  {rel_path} ({size_kb:.1f} KB)")

    logger.info("\nTo use in the demo:")
    logger.info("  1. Add 'care-portugal' plant to public/data/portfolio_summary.json")
    logger.info("  2. Restart the dev server")
    logger.info("  3. Navigate to /demo/plant/care-portugal")


if __name__ == '__main__':
    main()
