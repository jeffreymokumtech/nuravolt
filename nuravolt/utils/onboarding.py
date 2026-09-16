"""Base classes and utilities for plant onboarding."""
import logging
import subprocess
import sys
from pathlib import Path
from typing import List
from datetime import datetime


class BaseOnboarder:
    """Base class for domain-specific onboarding scripts."""

    def __init__(self, plant_id: str, project_root: Path):
        self.plant_id = plant_id
        self.project_root = project_root
        self.python_path = sys.executable
        self.logger = self._setup_logger()
        self.completed_steps = set()
        self.failed_steps = []

    def _setup_logger(self) -> logging.Logger:
        """Setup logger with file and console handlers."""
        logger = logging.getLogger(f'{self.__class__.__name__}_{self.plant_id}')
        logger.setLevel(logging.INFO)

        # Clear existing handlers
        logger.handlers = []

        # Console handler
        console = logging.StreamHandler()
        console.setLevel(logging.INFO)
        console_fmt = logging.Formatter('%(message)s')
        console.setFormatter(console_fmt)
        logger.addHandler(console)

        # File handler
        log_dir = self.project_root / 'logs'
        log_dir.mkdir(exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        log_file = log_dir / f'{self.__class__.__name__.lower()}_{self.plant_id}_{timestamp}.log'

        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(logging.DEBUG)
        file_fmt = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
        file_handler.setFormatter(file_fmt)
        logger.addHandler(file_handler)

        return logger

    def _run_command(self, cmd: List[str], description: str, timeout: int = 600) -> bool:
        """Execute command and log output."""
        self.logger.info(f"\n▶️  {description}")
        self.logger.debug(f"Command: {' '.join(cmd)}")

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=True
            )

            if result.stdout:
                for line in result.stdout.splitlines():
                    self.logger.info(f"  {line}")

            return True

        except subprocess.CalledProcessError as e:
            self.logger.error(f"❌ {description} failed")
            self.logger.error(f"Exit code: {e.returncode}")
            if e.stdout:
                self.logger.error(f"STDOUT:\n{e.stdout}")
            if e.stderr:
                self.logger.error(f"STDERR:\n{e.stderr}")
            return False

        except subprocess.TimeoutExpired:
            self.logger.error(f"❌ {description} timed out after {timeout}s")
            return False

    def run(self) -> bool:
        """Execute onboarding pipeline. Must be implemented by subclass."""
        raise NotImplementedError("Subclass must implement run() method")
