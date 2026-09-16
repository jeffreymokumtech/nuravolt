"""
Base Manufacturer Adapter

Abstract base class for OEM-specific data adapters.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Any

try:
    import polars as pl
except ImportError:
    pl = None


class DataFormat(Enum):
    """Supported data formats from OEM systems."""
    JSON_API = "json_api"      # REST API returning JSON
    CSV_EXPORT = "csv_export"  # CSV file export
    MODBUS_TCP = "modbus_tcp"  # Modbus TCP registers
    SNMP = "snmp"              # SNMP monitoring
    SOAP_XML = "soap_xml"      # SOAP/XML web service


@dataclass
class AdapterConfig:
    """Configuration for a manufacturer adapter."""
    manufacturer: str
    model: str
    data_format: DataFormat

    # API configuration
    api_endpoint: Optional[str] = None
    api_key: Optional[str] = None
    auth_type: str = "bearer"  # 'bearer', 'basic', 'api_key'

    # Connection settings
    timeout_seconds: int = 30
    retry_count: int = 3
    polling_interval_seconds: int = 60

    # Field mappings (OEM field name -> standard field name)
    field_mappings: Dict[str, str] = field(default_factory=dict)

    # Unit conversions (field -> (factor, offset))
    unit_conversions: Dict[str, tuple] = field(default_factory=dict)


@dataclass
class BESSReading:
    """Standardized BESS reading from any manufacturer."""
    timestamp: datetime
    soc: float  # State of charge (0-1)
    power_kw: float  # Power (positive = discharge)
    temperature_c: float  # Battery temperature

    # Optional fields
    soh: Optional[float] = None  # State of health (0-1)
    voltage_v: Optional[float] = None  # Pack voltage
    current_a: Optional[float] = None  # Pack current
    cell_voltage_min_v: Optional[float] = None
    cell_voltage_max_v: Optional[float] = None
    cell_temp_min_c: Optional[float] = None
    cell_temp_max_c: Optional[float] = None
    hvac_status: Optional[int] = None  # 0=off, 1=on
    fault_codes: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)


class ManufacturerAdapter(ABC):
    """
    Abstract base class for manufacturer-specific adapters.

    Subclasses implement OEM-specific data fetching and normalization.

    Example:
        adapter = TeslaMegapackAdapter(config)
        readings = adapter.fetch_historical(start_date, end_date)
        df = adapter.to_polars(readings)
    """

    def __init__(self, config: AdapterConfig):
        """
        Initialize the adapter.

        Args:
            config: Adapter configuration
        """
        self.config = config
        self._validate_config()

    def _validate_config(self):
        """Validate adapter configuration."""
        if not self.config.manufacturer:
            raise ValueError("Manufacturer name is required")

    @abstractmethod
    def test_connection(self) -> bool:
        """
        Test connection to the OEM system.

        Returns:
            True if connection successful
        """
        pass

    @abstractmethod
    def fetch_realtime(self) -> Optional[BESSReading]:
        """
        Fetch current/real-time reading.

        Returns:
            Latest BESSReading or None if unavailable
        """
        pass

    @abstractmethod
    def fetch_historical(
        self,
        start_date: datetime,
        end_date: datetime,
        resolution_minutes: int = 15
    ) -> List[BESSReading]:
        """
        Fetch historical readings.

        Args:
            start_date: Start of date range
            end_date: End of date range
            resolution_minutes: Data resolution

        Returns:
            List of BESSReading objects
        """
        pass

    def to_polars(self, readings: List[BESSReading]) -> "pl.DataFrame":
        """
        Convert readings to Polars DataFrame.

        Args:
            readings: List of BESSReading objects

        Returns:
            Polars DataFrame with standardized columns
        """
        if pl is None:
            raise ImportError("Polars is required")

        if not readings:
            return pl.DataFrame()

        data = {
            "timestamp": [r.timestamp for r in readings],
            "soc": [r.soc for r in readings],
            "power_kw": [r.power_kw for r in readings],
            "temperature_c": [r.temperature_c for r in readings],
            "soh": [r.soh for r in readings],
            "voltage_v": [r.voltage_v for r in readings],
            "current_a": [r.current_a for r in readings],
            "cell_voltage_min_v": [r.cell_voltage_min_v for r in readings],
            "cell_voltage_max_v": [r.cell_voltage_max_v for r in readings],
            "cell_temp_min_c": [r.cell_temp_min_c for r in readings],
            "cell_temp_max_c": [r.cell_temp_max_c for r in readings],
            "hvac_status": [r.hvac_status for r in readings],
        }

        return pl.DataFrame(data)

    def apply_field_mapping(self, raw_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Apply field name mapping to raw data.

        Args:
            raw_data: Raw data from OEM system

        Returns:
            Data with standardized field names
        """
        mapped = {}
        for oem_field, std_field in self.config.field_mappings.items():
            if oem_field in raw_data:
                mapped[std_field] = raw_data[oem_field]
        return mapped

    def apply_unit_conversion(self, field: str, value: float) -> float:
        """
        Apply unit conversion to a value.

        Args:
            field: Field name
            value: Raw value

        Returns:
            Converted value
        """
        if field in self.config.unit_conversions:
            factor, offset = self.config.unit_conversions[field]
            return value * factor + offset
        return value

    @property
    def manufacturer_name(self) -> str:
        """Get manufacturer name."""
        return self.config.manufacturer

    @property
    def model_name(self) -> str:
        """Get model name."""
        return self.config.model
