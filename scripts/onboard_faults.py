#!/usr/bin/env python3
"""
Fault Detection domain onboarding script.

Runs fault detection and anomaly analysis for a solar plant.

Usage:
    python scripts/onboard_faults.py --plant-id eta
"""

import argparse
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.utils.onboarding import BaseOnboarder


class FaultOnboarder(BaseOnboarder):
    """Fault Detection domain onboarding orchestrator."""

    def __init__(self, plant_id: str):
        super().__init__(plant_id, Path(__file__).parent.parent)
        self.faults_dir = self.project_root / 'public' / 'data' / 'faults' / plant_id

    def run(self) -> bool:
        """Execute fault detection onboarding."""
        self.logger.info("\n" + "="*70)
        self.logger.info("FAULT DETECTION DOMAIN ONBOARDING")
        self.logger.info("="*70)
        self.logger.info(f"Plant: {self.plant_id}")
        self.logger.info("="*70)

        cmd = [self.python_path, 'scripts/run_fault_detection.py', '--plant-id', self.plant_id]
        success = self._run_command(cmd, 'Fault detection', timeout=600)

        if success:
            self.completed_steps.add('fault_detection')
            self.logger.info("\n✅ FAULT DETECTION ONBOARDING COMPLETED SUCCESSFULLY")
        else:
            self.logger.error("\n❌ FAULT DETECTION ONBOARDING FAILED")

        return success


def main():
    parser = argparse.ArgumentParser(
        description='Fault Detection domain onboarding for solar plants',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example:
    python scripts/onboard_faults.py --plant-id eta
        """
    )
    parser.add_argument('--plant-id', required=True, help='Plant ID (e.g., eta, ribera, alpha1)')
    args = parser.parse_args()

    onboarder = FaultOnboarder(plant_id=args.plant_id)
    success = onboarder.run()
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
