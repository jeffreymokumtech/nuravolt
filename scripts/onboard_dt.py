#!/usr/bin/env python3
"""
Digital Twin domain onboarding script.

Trains hybrid physics+ML digital twin model for a solar plant.

Usage:
    python scripts/onboard_dt.py --plant-id eta
"""

import argparse
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.utils.onboarding import BaseOnboarder


class DigitalTwinOnboarder(BaseOnboarder):
    """Digital Twin domain onboarding orchestrator."""

    def __init__(self, plant_id: str):
        super().__init__(plant_id, Path(__file__).parent.parent)
        self.dt_output_dir = self.project_root / 'public' / 'data' / 'digitaltwin' / plant_id

    def run(self) -> bool:
        """Execute digital twin onboarding."""
        self.logger.info("\n" + "="*70)
        self.logger.info("DIGITAL TWIN DOMAIN ONBOARDING")
        self.logger.info("="*70)
        self.logger.info(f"Plant: {self.plant_id}")
        self.logger.info("="*70)

        cmd = [self.python_path, 'scripts/train_plant_model.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'Digital twin training', timeout=1800)

        if success:
            self.completed_steps.add('digital_twin')
            self.logger.info("\n✅ DIGITAL TWIN ONBOARDING COMPLETED SUCCESSFULLY")
        else:
            self.logger.error("\n❌ DIGITAL TWIN ONBOARDING FAILED")

        return success


def main():
    parser = argparse.ArgumentParser(
        description='Digital Twin domain onboarding for solar plants',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example:
    python scripts/onboard_dt.py --plant-id eta
        """
    )
    parser.add_argument('--plant-id', required=True, help='Plant ID (e.g., eta, ribera, alpha1)')
    args = parser.parse_args()

    onboarder = DigitalTwinOnboarder(plant_id=args.plant_id)
    success = onboarder.run()
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
