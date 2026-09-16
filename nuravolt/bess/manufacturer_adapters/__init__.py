"""
BESS Manufacturer Adapters

Pre-built connectors for major BESS OEM data formats and APIs.

Supported manufacturers:
- Tesla Megapack (Powerhub API)
- Fluence (Mosaic platform)

Future:
- BYD
- Huawei LUNA
- CATL
"""

from nuravolt.bess.manufacturer_adapters.base import (
    ManufacturerAdapter,
    AdapterConfig,
    DataFormat,
)
from nuravolt.bess.manufacturer_adapters.tesla_megapack import TeslaMegapackAdapter

__all__ = [
    "ManufacturerAdapter",
    "AdapterConfig",
    "DataFormat",
    "TeslaMegapackAdapter",
]
